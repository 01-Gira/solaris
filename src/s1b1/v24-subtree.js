// S1b.1 V2.4 — instruction stack-subtree coverage, NOT fill attribution.
// A parsed SPL transfer inside the call stack subtree is suggestive evidence
// of execution trace structure, NOT proof of a trade, amount, wallet or price.
// All input comes from already-stored jsonParsed RPC transactions.
import {createHash} from 'node:crypto';
import {decodeBase58,PUMP_FUN,PUMP_SWAP} from './decoder.js';
export const V24_VERSION='s1b1-v24-stack-subtree-0.1';
const IDL={
 [PUMP_FUN]:{
  '66063d1201daebea':{poolIndex:3,name:'buy',minAccounts:16},
  '33e685a4017f83ad':{poolIndex:3,name:'sell',minAccounts:14},
  '38fc74089edfcd5f':{poolIndex:3,name:'buy_exact_sol_in',minAccounts:16}
 },
 [PUMP_SWAP]:{
  '66063d1201daebea':{poolIndex:0,name:'buy',minAccounts:23},
  '33e685a4017f83ad':{poolIndex:0,name:'sell',minAccounts:21},
  'c62e1552b4d9e870':{poolIndex:0,name:'buy_exact_quote_in',minAccounts:23}
 }
};
const TOKEN_PROGRAMS=new Set([
 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
]);
const TRANSFERS=new Set(['transfer','transferChecked','transferCheckedWithFee']);
const pubkey=x=>typeof x==='string'?x:typeof x?.pubkey==='string'?x.pubkey:null;
function match(ix){
 const variants=IDL[ix?.programId];
 if(!variants||typeof ix?.data!=='string'||ix.data.length>4096)return null;
 const data=decodeBase58(ix.data);
 if(!data||data.length<8)return null;
 const layout=variants[data.subarray(0,8).toString('hex')];
 return layout?{ix,layout,program:ix.programId===PUMP_FUN?'pumpfun':'pumpswap'}:null;
}
function tokenKind(ix){
 if(!TOKEN_PROGRAMS.has(ix?.programId))return null;
 const type=ix?.parsed?.type;
 return TRANSFERS.has(type)?'transfer':'other_token';
}
const base=()=>({status:'missing_metadata',scope:'none',
 candidateProgram:'none',candidateInstruction:'none',
 candidateCount:0,poolIndexMatches:false,
 candidateStackHeight:null,groupTokenInstructions:0,
 subtreeTokenInstructions:0,subtreeParsedTransfers:0,
 otherGroupParsedTransfers:0,unparsedOrNontransferSubtreeTokenInstructions:0,
 stackHeightsComplete:false,traceBoundaryValid:false,
 verifiedFills:0,verifiedDirection:false,verifiedPrices:false,
 economicsAuthorized:false,liveTrading:false});

export function inspectV24(poolAddress,signature,tx){
 const result=base();
 if(!tx?.meta||!tx?.transaction?.message)return result;
 if(Array.isArray(tx.transaction.signatures)&&
    !tx.transaction.signatures.includes(signature))
   return {...result,status:'signature_mismatch'};
 if(tx.meta.err!==undefined&&tx.meta.err!==null)
   return {...result,status:'failed_onchain'};
 const outer=tx.transaction.message.instructions;
 const groups=tx.meta.innerInstructions;
 if(!Array.isArray(outer)||!Array.isArray(groups))
  return {...result,status:'missing_instruction_trace'};
 const candidates=[];
 outer.forEach((ix,index)=>{const m=match(ix);if(m)candidates.push({...m,scope:'outer',outerIndex:index,innerIndex:-1});});
 for(const group of groups){
  if(!Array.isArray(group?.instructions))continue;
  group.instructions.forEach((ix,innerIndex)=>{
   const m=match(ix);
   if(m)candidates.push({...m,scope:'inner',outerIndex:group.index,innerIndex});
  });
 }
 if(candidates.length!==1)return {...result,status:'not_single_candidate',
   candidateCount:candidates.length};
 const c=candidates[0],details={...result,candidateCount:1,scope:c.scope,
  candidateProgram:c.program,candidateInstruction:c.layout.name};
 const accounts=Array.isArray(c.ix.accounts)?c.ix.accounts.map(pubkey):null;
 if(!accounts||accounts.length<c.layout.minAccounts||accounts.some(x=>!x))
  return {...details,status:'candidate_accounts_unusable'};
 if(accounts[c.layout.poolIndex]!==poolAddress)
  return {...details,status:'watched_pool_mismatch'};
 const matched={...details,poolIndexMatches:true};
 if(!Number.isSafeInteger(c.outerIndex)||c.outerIndex<0||c.outerIndex>=outer.length)
  return {...matched,status:'invalid_outer_index'};
 const matchingGroups=groups.filter(g=>g?.index===c.outerIndex&&Array.isArray(g?.instructions));
 if(matchingGroups.length!==1)return {...matched,
  status:matchingGroups.length===0?'missing_inner_group':'duplicate_inner_groups'};
 const siblings=matchingGroups[0].instructions;
 if(siblings.length>500)return {...matched,status:'instruction_limit_exceeded'};
 if(!siblings.every(ix=>Number.isInteger(ix?.stackHeight)&&ix.stackHeight>=2&&ix.stackHeight<=64))
  return {...matched,status:'incomplete_stack_heights'};
 const candidateHeight=c.scope==='outer'?1:c.ix.stackHeight;
 if(c.scope==='inner'&&(!Number.isSafeInteger(candidateHeight)||
   candidateHeight<2||candidateHeight>64||
   c.innerIndex<0||c.innerIndex>=siblings.length))
  return {...matched,status:'invalid_candidate_stack'};
 // For a parsed inner candidate, descendants are consecutive later instructions
 // with strictly greater stack heights, until the next sibling/ancestor.
 const descendantIndices=new Set();
 if(c.scope==='outer'){
  for(let i=0;i<siblings.length;i++)descendantIndices.add(i);
 }else{
  for(let i=c.innerIndex+1;i<siblings.length;i++){
   if(siblings[i].stackHeight<=candidateHeight)break;
   descendantIndices.add(i);
  }
 }
 // Reject structurally impossible transitions as unverified.
 // Within a direct list of inner instructions, nested stack depths cannot jump >1.
 let valid=true,previous=1;
 for(const ix of siblings){
  if(ix.stackHeight>previous+1){valid=false;break;}
  previous=ix.stackHeight;
 }
 if(!valid)return {...matched,status:'invalid_stack_depth_transition',
  candidateStackHeight:candidateHeight};
 let subtreeToken=0,subtreeTransfers=0,otherTransfers=0,otherToken=0,
  allTokens=0;
 for(let i=0;i<siblings.length;i++){
  const kind=tokenKind(siblings[i]);
  if(!kind)continue;
  allTokens++;
  if(descendantIndices.has(i)){
   subtreeToken++;
   if(kind==='transfer')subtreeTransfers++;
   else otherToken++;
  }else if(kind==='transfer')otherTransfers++;
 }
 const counts={...matched,candidateStackHeight:candidateHeight,
  groupTokenInstructions:allTokens,subtreeTokenInstructions:subtreeToken,
  subtreeParsedTransfers:subtreeTransfers,otherGroupParsedTransfers:otherTransfers,
  unparsedOrNontransferSubtreeTokenInstructions:otherToken,
  stackHeightsComplete:true,traceBoundaryValid:true};
 if(subtreeTransfers===0)
  return {...counts,status:otherTransfers>0?'only_outside_subtree_transfers':
   'no_parsed_transfers_under_candidate'};
 return {...counts,status:'subtree_transfers_present_unattributed'};
}
const hash=s=>createHash('sha256').update(String(s||'')).digest('hex').slice(0,16);
const inc=(o,k)=>{o[k]=(o[k]||0)+1;};
const top=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,50).map(([key,eventRows])=>({key,eventRows}));
export function createV24Summary(){
 const status={},venue={},scope={},outside={},examples={};let seen=0,subtree=0,other=0;
 return {add(row){
  const r=inspectV24(row.pool_address,row.signature,row.payload),
   v=String(row.venue_family||'unknown').slice(0,40),k=v+':'+r.status;
  seen++;subtree+=r.subtreeParsedTransfers;other+=r.otherGroupParsedTransfers;
  inc(status,r.status);inc(venue,k);inc(scope,r.scope+':'+r.status);
  inc(outside,r.otherGroupParsedTransfers>0?'with_other_group_transfers':'no_other_group_transfers');
  if((examples[k]||[]).length<2)(examples[k]??=[]).push({
   signatureSha256Prefix:hash(row.signature),
   poolSha256Prefix:hash(row.pool_address),
   program:r.candidateProgram,scope:r.scope,status:r.status,
   candidateStackHeight:r.candidateStackHeight,
   subtreeParsedTransfers:r.subtreeParsedTransfers,
   otherGroupParsedTransfers:r.otherGroupParsedTransfers
  });
 },result(){return {kind:'s1b1_v24_stack_subtree_audit',
   version:V24_VERSION,units:'v2_single_trade_candidate_event_rows',
   sampledEventRows:seen,byStatus:top(status),byVenueStatus:top(venue),
   byScopeStatus:top(scope),byOtherGroupTransfers:top(outside),
   summedSubtreeTransferInstructions:subtree,
   summedOtherGroupTransferInstructions:other,examples,
   interpretation:'Parsed SPL transfer instructions descending from a trade candidate in the stack trace remain unverified, cannot be assigned an amount to an actual swap without token-account/authority reconciliation, and are not execution fills. Missing/invalid stack heights fail closed.',
   readOnly:true,verifiedFills:0,economicsAuthorized:false,liveTrading:false};
 }};
}
