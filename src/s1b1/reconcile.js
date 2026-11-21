import {PUMP_FUN,PUMP_SWAP} from './decoder.js';
import {curveEventEvidence,getCandidates,isNative,key,systemMovement,tokenTransfer,traceTransaction} from './reconcile-trace.js';
import {getBalanceEntries,INIT_TYPES,reconcileBalances} from './reconcile-balances.js';

export const RECONCILIATION_VERSION='s1b1-instruction-reconciliation-1';
const programByVenue={pumpfun:PUMP_FUN,pumpswap:PUMP_SWAP};
const blocked=status=>({status,candidates:[],verifiedFills:0,economicsAuthorized:false,liveTrading:false});
const quantities=edge=>({gross:edge.gross,credited:edge.credited,decimals:edge.decimals});

function inspectCandidate(candidate,children,tokenEdges){
 const {node,pool,user,nativeSol,sell,quoteMint,roles,recipients}=candidate;
 const fixedRecipients=new Map(recipients);
 const [userBase,poolBase,userQuote,poolQuote]=roles;
 const primaryBase=sell?[userBase,poolBase]:[poolBase,userBase];
 const primaryQuote=sell?[poolQuote,userQuote]:[userQuote,poolQuote];
 const quoteClass=nativeSol?'native_sol':isNative(quoteMint,userQuote.program)?'wsol':'spl_quote';
 const result={outerIndex:node.outerIndex,innerIndex:node.innerIndex,quoteClass,
  base:null,quote:null,routing:{protocolAccount:0,creatorVault:0,buybackAccount:0,unidentified:0},localTokenMovements:0};
 const core=[pool,user,roles[0].mint,...roles.map(r=>r.account),...fixedRecipients.keys()];
 if(!nativeSol)core.push(quoteMint);
 if(!candidate.hasLayout||fixedRecipients.size!==recipients.length||core.some(k=>!k)||new Set(core).size!==core.length)
  return {...result,status:'unusable_account_layout'};
 const isLeg=(e,[from,to])=>e.source===from.account&&e.destination===to.account&&
  e.mint===from.mint&&e.program===from.program;
 let countBase=0,countQuote=0,unusable=false;
 for(const child of children){
  const edge=tokenEdges.get(child);
  if(edge){
   result.localTokenMovements++;
   if(edge.error||edge.gross===0n){unusable=true;continue;}
   if(isLeg(edge,primaryBase)){result.base=quantities(edge);countBase++;continue;}
   if(!nativeSol&&isLeg(edge,primaryQuote)){result.quote=quantities(edge);countQuote++;continue;}
   if(!nativeSol&&edge.source===primaryQuote[0].account&&edge.mint===quoteMint&&edge.program===userQuote.program){
    const role=fixedRecipients.get(edge.destination);
    if(role){result.routing[role]++;continue;}
   }
   result.routing.unidentified++;
  }
  if(!nativeSol)continue;
  const movement=systemMovement(child.ix);
  if(!movement||movement.creation)continue;
  const source=sell?pool:user;
  if(!sell&&movement.source===source&&movement.destination===pool&&movement.amount>0n){
   result.quote={gross:movement.amount,credited:movement.amount,decimals:9};countQuote++;
  }else if(movement.source===source&&fixedRecipients.has(movement.destination)&&movement.amount>0n){
   result.routing[fixedRecipients.get(movement.destination)]++;
  }else if([pool,user].includes(movement.source)||[pool,user].includes(movement.destination)){
   result.routing.unidentified++;
  }
 }
 if(countBase!==1)result.base=null;
 if(countQuote!==1)result.quote=null;
 const curveEvent=curveEventEvidence(candidate,children,result.base);
 const status=unusable||countBase>1||countQuote>1?'unusable_or_duplicate_transfer':
  ['conflicting','duplicate'].includes(curveEvent)?'curve_event_conflict':
  countBase!==1||countQuote!==1?'missing_primary_transfer':
  result.routing.unidentified>0||result.routing.protocolAccount>1||result.routing.creatorVault>1||result.routing.buybackAccount>1?
   'unverified_recipient_routing':'scoped_amounts_observed';
 return {...result,status,curveEvent};
}

export function inspectReconciliation(pool,signature,venue,tx){
 if(!Object.hasOwn(programByVenue,venue))return blocked('unsupported_venue');
 if(!tx?.meta||!tx.transaction?.message)return blocked('transaction_metadata_missing');
 if(tx.meta.err===undefined)return blocked('transaction_status_unknown');
 if(tx.meta.err!==null)return blocked('failed_onchain');
 if(!signature||tx.transaction.signatures?.[0]!==signature||!Array.isArray(tx.transaction.signatures))
  return blocked('signature_mismatch');
 const trace=traceTransaction(tx);
 if(!trace)return blocked('incomplete_trace');
 const candidates=getCandidates(trace);
 const venueCandidates=candidates.filter(c=>c.node.ix.programId===programByVenue[venue]);
 if(!venueCandidates.length)return blocked(candidates.length?'cross_venue_instruction':'unsupported_or_no_trade_instruction');
 const matched=venueCandidates.filter(c=>c.pool===pool);
 if(!matched.length)return blocked(venueCandidates.some(c=>!c.pool||!c.hasLayout)?
  'unusable_account_layout':'watched_pool_mismatch');
 const keys=Array.isArray(tx.transaction.message.accountKeys)?tx.transaction.message.accountKeys.map(key):[];
 if(!keys.length||keys.some(k=>typeof k!=='string'||!k)||new Set(keys).size!==keys.length)
  return blocked('nonunique_account_mapping');
 if(matched.some(c=>!c.hasLayout||[c.user,c.pool,...c.roles.map(r=>r.account)].some(a=>!keys.includes(a))))
  return blocked('unusable_account_layout');
 const roles=new Map();
 for(const role of matched.flatMap(c=>c.roles)){
  const previous=roles.get(role.account);
  if(previous&&(previous.mint!==role.mint||previous.program!==role.program||previous.owner!==role.owner))
   return blocked('nonunique_account_mapping');
  roles.set(role.account,role);
 }
 const pre=getBalanceEntries(tx.meta.preTokenBalances,keys),post=getBalanceEntries(tx.meta.postTokenBalances,keys);
 const identities=new Map();
 for(const [account,before] of pre??[]){
  const after=post?.get(account);
  if(after&&before.mint===after.mint&&before.program===after.program&&before.decimals===after.decimals)
   identities.set(account,before);
 }
 for(const {ix} of trace){
  const info=ix.parsed?.info;
  if(INIT_TYPES.has(ix.parsed?.type)&&identities.has(info?.account)){
   // Transaction endpoints cannot resolve unchecked transfers across a reinitialization.
   identities.delete(info.account);
  }
 }
 const transfers=new Map(),children=new Map(matched.map(c=>[c.node,[]]));
 const messageKeys=new Set(keys);
 let otherTokenMovements=0;
 for(const node of trace){
  let edge=tokenTransfer(node.ix,identities);
  if(edge&&!edge.error&&[edge.source,edge.destination,edge.mint].some(k=>!messageKeys.has(k)))
   edge={error:'unusable_token_transfer'};
  if(edge)transfers.set(node,edge);
  const scope=children.get(node.parent);
  if(scope)scope.push(node);
  else if(edge)otherTokenMovements++;
 }
 const local=matched.map(c=>inspectCandidate(c,children.get(c.node),transfers));
 const balances=reconcileBalances(tx,keys,trace,[...roles.values()],pre,post,transfers);
 const status=local.every(c=>c.status==='scoped_amounts_observed'&&c.base.credited!==null&&c.quote.credited!==null)&&
  balances.tokenBalances==='matched'&&balances.lamportBalances==='matched'?'reconciled_diagnostic':'incomplete_or_ambiguous';
 return {...blocked(status),...balances,candidates:local,otherTokenMovements,
  otherRecognizedTradeInstructions:candidates.length-matched.length};
}
