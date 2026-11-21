// SOLARIS V2.9 — PumpSwap fee-recipient *routing* evidence, NOT economic fee or fill.
// IDL snapshot: pump-fun/pump-public-docs/idl/pump_amm.json,
// blob d907b16a91f035aeb3c3182bfa0972a91bf23a86.
// All evidence from persisted jsonParsed RPC transactions; zero amounts exported.
import {createHash} from 'node:crypto';
import {decodeBase58,PUMP_SWAP,WSOL} from './decoder.js';
import {inspectV28} from './v28-order.js';

export const V29_VERSION='s1b1-v29-recipient-routing-0.1';
const SPL=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const IDL={
 '66063d1201daebea':{name:'buy',fixedAccounts:23,side:'buy'},
 '33e685a4017f83ad':{name:'sell',fixedAccounts:21,side:'sell'},
 'c62e1552b4d9e870':{name:'buy_exact_quote_in',fixedAccounts:23,side:'buy'}
};
const key=x=>typeof x==='string'?x:typeof x?.pubkey==='string'?x.pubkey:null;
const hash=x=>createHash('sha256').update(String(x||'')).digest('hex').slice(0,16);
const base=()=>({status:'v28_not_ready',instruction:'none',side:'none',
  fixedIdlAccountCount:0,observedAccountCount:0,appendedAccountCount:0,
  expectedBaseEdges:0,expectedQuoteEdges:0,officialProtocolRecipientEdges:0,
  unclassifiedRemainingRecipientEdges:0,unknownOrInvalidTransferEdges:0,
  quoteMintWSOL:false,protocolRecipientOwnerHint:'not_checked',
  remainingRecipientOwnerHint:'not_checked',
  verifiedFills:0,verifiedPrices:0,economicsAuthorized:false,liveTrading:false});
function parseCandidate(ix){
 if(ix?.programId!==PUMP_SWAP||typeof ix.data!=='string'||ix.data.length>4096)return null;
 const b=decodeBase58(ix.data);
 if(!b||b.length<8)return null;
 const disc=b.subarray(0,8).toString('hex');
 return IDL[disc]?{ix,layout:IDL[disc]}:null;
}
function locate(tx){
 const outer=tx.transaction.message.instructions,groups=tx.meta.innerInstructions;
 if(!Array.isArray(outer)||!Array.isArray(groups))return null;
 const found=[];
 outer.forEach((ix,i)=>{const c=parseCandidate(ix);
  if(c)found.push({...c,scope:'outer',outerIndex:i,innerIndex:-1});});
 for(const g of groups)if(Array.isArray(g?.instructions)){
  g.instructions.forEach((ix,i)=>{const c=parseCandidate(ix);
   if(c)found.push({...c,scope:'inner',outerIndex:g.index,innerIndex:i});});
 }
 return found.length===1?found[0]:null;
}
function subtree(tx,c){
 const groups=tx.meta.innerInstructions.filter(g=>g?.index===c.outerIndex&&
  Array.isArray(g.instructions));
 if(groups.length!==1)return null;
 const siblings=groups[0].instructions;
 if(c.scope==='outer')return siblings;
 const depth=c.ix.stackHeight,output=[];
 for(let i=c.innerIndex+1;i<siblings.length;i++){
  if(siblings[i].stackHeight<=depth)break;
  output.push(siblings[i]);
 }
 return output;
}
function ownerHint(tx,account,expectedOwner){
 const keys=tx.transaction.message.accountKeys;
 if(!Array.isArray(keys))return 'metadata_missing';
 const index=keys.findIndex(k=>key(k)===account);
 if(index<0)return 'account_key_missing';
 const pre=Array.isArray(tx.meta.preTokenBalances)?tx.meta.preTokenBalances:[];
 const post=Array.isArray(tx.meta.postTokenBalances)?tx.meta.postTokenBalances:[];
 const all=[...pre,...post].filter(x=>x?.accountIndex===index);
 const values=[...new Set(all.map(x=>x?.owner).filter(x=>typeof x==='string'))];
 if(values.length===0)return 'owner_metadata_missing';
 if(values.length>1)return 'multiple_owner_metadata_values';
 if(!expectedOwner)return 'owner_present_identity_not_authorized';
 return values[0]===expectedOwner?'owner_matches_idl_authority_hint':
  'owner_differs_from_idl_authority';
}
function classifyTransfer(ix,expected){
 if(!SPL.has(ix?.programId))return null;
 const type=ix?.parsed?.type;
 if(!['transfer','transferChecked','transferCheckedWithFee'].includes(type))
  return null;
 const p=ix.parsed?.info;
 if(type!=='transferChecked'||typeof p?.source!=='string'||
   typeof p?.destination!=='string'||typeof p?.mint!=='string'||
   typeof (p.tokenAmount?.amount??p.amount)!=='string'||
   !/^[1-9]\d*$/.test(p.tokenAmount?.amount??p.amount))
  return 'unverified_transfer';
 const match=expected.find(e=>e.source===p.source&&
  e.destination===p.destination&&e.mint===p.mint);
 return match?match.kind:'unmapped_or_mint_mismatch_transfer';
}
export function inspectV29(poolAddress,signature,tx){
 const result=base(),gate=inspectV28(poolAddress,signature,tx);
 if(gate.family!=='pumpswap')return {...result,
  status:gate.family==='pumpfun'?'not_pumpswap':'v28_'+gate.status};
 if(!['ordered_lifecycle_hints_all_gap_roles','no_balance_gap',
  'ordered_lifecycle_hints_partial','lifecycle_order_not_confirmed']
  .includes(gate.status))return {...result,status:'v28_'+gate.status};
 const c=locate(tx);
 if(!c)return {...result,status:'candidate_not_unique'};
 const a=Array.isArray(c.ix.accounts)?c.ix.accounts.map(key):null;
 if(!a||a.some(x=>!x))return {...result,status:'accounts_unusable'};
 const expectedCount=c.layout.fixedAccounts;
 const r={...result,instruction:c.layout.name,side:c.layout.side,
  fixedIdlAccountCount:expectedCount,observedAccountCount:a.length,
  appendedAccountCount:a.length-expectedCount,
  quoteMintWSOL:a[4]===WSOL};
 if(a[0]!==poolAddress)return {...r,status:'watched_pool_mismatch'};
 if(!r.quoteMintWSOL)return {...r,status:'non_wsol_quote'};
 if(a.length!==expectedCount+2)return {...r,status:'remaining_accounts_shape_unverified'};
 // Appended account(s) are not assigned economic meaning by the official IDL.
 const last=a[expectedCount+1],protocol=a[10];
 const srcBase=c.layout.side==='buy'?a[7]:a[5],
  destBase=c.layout.side==='buy'?a[5]:a[7],
  srcQuote=c.layout.side==='buy'?a[6]:a[8],
  destQuote=c.layout.side==='buy'?a[8]:a[6];
 if(new Set([protocol,last,a[5],a[6],a[7],a[8]]).size!==6)
  return {...r,status:'account_role_aliasing'};
 const expected=[
  {kind:'base',source:srcBase,destination:destBase,mint:a[3]},
  {kind:'quote',source:srcQuote,destination:destQuote,mint:a[4]},
  {kind:'protocol',source:srcQuote,destination:protocol,mint:a[4]},
  {kind:'remaining',source:srcQuote,destination:last,mint:a[4]}
 ];
 const trace=subtree(tx,c);
 if(!trace)return {...r,status:'subtree_missing'};
 const counts={base:0,quote:0,protocol:0,remaining:0};
 let invalid=0;
 for(const ix of trace){
  const classification=classifyTransfer(ix,expected);
  if(classification===null)continue;
  if(Object.hasOwn(counts,classification))counts[classification]++;
  else invalid++;
 }
 const details={...r,
  expectedBaseEdges:counts.base,expectedQuoteEdges:counts.quote,
  officialProtocolRecipientEdges:counts.protocol,
  unclassifiedRemainingRecipientEdges:counts.remaining,
  unknownOrInvalidTransferEdges:invalid,
  protocolRecipientOwnerHint:ownerHint(tx,protocol,a[9]),
  remainingRecipientOwnerHint:ownerHint(tx,last,null)};
 if(counts.base===1&&counts.quote===1&&counts.protocol===1&&
  counts.remaining===1&&invalid===0)
  return {...details,status:'four_structural_edges_no_fee_or_fill_proof'};
 return {...details,status:'partial_or_ambiguous_fee_routing'};
}
const inc=(obj,key,n=1)=>{obj[key]=(obj[key]||0)+n;};
const top=obj=>Object.entries(obj).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,60).map(([key,eventRows])=>({key,eventRows}));
export function createV29Summary(){
 const byStatus={},byVenue={},byInstr={},byOwner={},byRemaining={},examples={};
 let rows=0,protocol=0,remaining=0,ambiguous=0;
 return {add(row){
  const r=inspectV29(row.pool_address,row.signature,row.payload),
   v=String(row.venue_family||'unknown').slice(0,40);
  rows++;protocol+=r.officialProtocolRecipientEdges;
  remaining+=r.unclassifiedRemainingRecipientEdges;ambiguous+=r.unknownOrInvalidTransferEdges;
  inc(byStatus,r.status);inc(byVenue,v+':'+r.status);
  inc(byInstr,r.instruction+':'+r.status);
  inc(byOwner,r.protocolRecipientOwnerHint);
  inc(byRemaining,r.remainingRecipientOwnerHint);
  const group=v+':'+r.status;
  if((examples[group]||[]).length<2)(examples[group]??=[]).push({
   signatureSha256Prefix:hash(row.signature),poolSha256Prefix:hash(row.pool_address),
   instruction:r.instruction,side:r.side,appendedAccountCount:r.appendedAccountCount,
   protocolRecipientOwnerHint:r.protocolRecipientOwnerHint,
   remainingRecipientOwnerHint:r.remainingRecipientOwnerHint,
   officialProtocolRecipientEdges:r.officialProtocolRecipientEdges,
   unclassifiedRemainingRecipientEdges:r.unclassifiedRemainingRecipientEdges
  });
 },result(){return {
  kind:'s1b1_v29_pumpswap_recipient_evidence',version:V29_VERSION,
  units:'v2_single_trade_candidate_event_rows',sampledEventRows:rows,
  byStatus:top(byStatus),byVenueStatus:top(byVenue),
  byInstructionStatus:top(byInstr),
  byOfficialProtocolRecipientOwnerHint:top(byOwner),
  byRemainingAccountRecipientOwnerHint:top(byRemaining),
  summedProtocolRecipientTransferInstructions:protocol,
  summedUnknownRemainingRecipientTransferInstructions:remaining,
  summedOtherOrUnverifiedTransferInstructions:ambiguous,examples,
  interpretation:'Official PumpSwap IDL account 10 is protocol_fee_recipient_token_account, but an edge to that account does not prove economic fees or their amount. Extra two trailing accounts are outside the pinned IDL and remain unknown roles. Do not treat routing patterns as fills, prices or fee accounting.',
  readOnly:true,verifiedFills:0,economicsAuthorized:false,liveTrading:false
 };}};
}
