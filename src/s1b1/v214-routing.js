// SOLARIS S1b.1 V2.14 — generalized PumpSwap routing *structural* audit.
// Audits non-WSOL quote and variable remaining-account layouts, without economic
// fee, amount, balance or fill attribution. Existing V2.9 unchanged.
import {createHash} from 'node:crypto';
import {decodeBase58,PUMP_SWAP,WSOL} from './decoder.js';
import {inspectV28} from './v28-order.js';

export const V214_VERSION='s1b1-v214-generalized-routing-0.1';
const SPL=new Set([
 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
]);
const IDL={
 '66063d1201daebea':{instruction:'buy',side:'buy',fixed:23},
 '33e685a4017f83ad':{instruction:'sell',side:'sell',fixed:21},
 'c62e1552b4d9e870':{instruction:'buy_exact_quote_in',side:'buy',fixed:23}
};
const key=x=>typeof x==='string'?x:typeof x?.pubkey==='string'?x.pubkey:null;
const hash=x=>createHash('sha256').update(String(x||'')).digest('hex').slice(0,16);
const inc=(obj,k,n=1)=>{obj[k]=(obj[k]||0)+n;};
const top=(obj,n=60)=>Object.entries(obj).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,n).map(([key,eventRows])=>({key,eventRows}));
function locate(tx){
 const outer=tx?.transaction?.message?.instructions,inner=tx?.meta?.innerInstructions;
 if(!Array.isArray(outer)||!Array.isArray(inner)||outer.length>500)return null;
 const found=[];
 const check=(ix,outerIndex,innerIndex)=>{
  if(ix?.programId!==PUMP_SWAP||typeof ix.data!=='string'||ix.data.length>4096)return;
  const raw=decodeBase58(ix.data);if(!raw||raw.length<8)return;
  const layout=IDL[raw.subarray(0,8).toString('hex')];
  if(layout)found.push({ix,outerIndex,innerIndex,layout});
 };
 outer.forEach((ix,i)=>check(ix,i,-1));
 for(const group of inner){
  if(!Number.isSafeInteger(group?.index)||group.index<0||group.index>=outer.length||
     !Array.isArray(group.instructions)||group.instructions.length>500)return null;
  group.instructions.forEach((ix,i)=>check(ix,group.index,i));
 }
 return found.length===1?found[0]:null;
}
function subtree(tx,c){
 const groups=tx.meta.innerInstructions.filter(g=>g?.index===c.outerIndex&&Array.isArray(g.instructions));
 if(groups.length!==1)return null;
 if(c.innerIndex===-1)return groups[0].instructions;
 const sib=groups[0].instructions,depth=c.ix.stackHeight;
 if(!Number.isSafeInteger(depth)||depth<=0)return null;
 const res=[];
 for(let i=c.innerIndex+1;i<sib.length;i++){
  const h=sib[i]?.stackHeight;
  if(!Number.isSafeInteger(h)||h<=0)return null;
  if(h<=depth)break;
  res.push(sib[i]);
 }
 return res;
}
function transfer(ix){
 if(!SPL.has(ix?.programId))return null;
 const kind=ix?.parsed?.type;
 if(!['transfer','transferChecked','transferCheckedWithFee'].includes(kind))return null;
 const x=ix.parsed?.info;
 if(kind!=='transferChecked'||typeof x?.source!=='string'||
   typeof x?.destination!=='string'||typeof x?.mint!=='string'||
   !/^[1-9]\d*$/.test(String(x?.tokenAmount?.amount??x?.amount??'')))
  return {valid:false};
 return {valid:true,source:x.source,destination:x.destination,mint:x.mint};
}
const initial=()=>({status:'v28_blocked',instruction:'none',quoteClass:'not_applicable',
  fixedAccountCount:0,appendedAccountCount:0,sourceIndexHints:{},
  protocolEdges:0,creatorVaultEdges:0,remainingAccountEdges:0,
  baseEdges:0,quoteEdges:0,unexpectedTransferEdges:0,
  accountAliases:false,verifiedFills:0,economicsAuthorized:false,liveTrading:false});
export function inspectV214(poolAddress,signature,tx){
 const out=initial();
 const gate=inspectV28(poolAddress,signature,tx);
 if(gate.family!=='pumpswap')return {...out,status:gate.family==='pumpfun'?'not_pumpswap':'v28_'+gate.status};
 if(!['ordered_lifecycle_hints_all_gap_roles','no_balance_gap',
    'ordered_lifecycle_hints_partial','lifecycle_order_not_confirmed'].includes(gate.status))
  return {...out,status:'v28_'+gate.status};
 const candidate=locate(tx);
 if(!candidate)return {...out,status:'candidate_unavailable_or_ambiguous'};
 const a=Array.isArray(candidate.ix?.accounts)?candidate.ix.accounts.map(key):null;
 const layout=candidate.layout;
 if(!a||a.some(x=>!x)||a.length<layout.fixed||a.length>128)
  return {...out,status:'candidate_account_shape_unusable'};
 const appended=a.length-layout.fixed;
 const basis={...out,instruction:layout.instruction,fixedAccountCount:layout.fixed,
  appendedAccountCount:appended,quoteClass:a[4]===WSOL?'wsol':'non_wsol'};
 if(a[0]!==poolAddress)return {...basis,status:'watched_pool_mismatch'};
 // At minimum the essential 10 IDL roles must not alias. No full authorization implied.
 const roles=[a[0],a[1],a[3],a[4],a[5],a[6],a[7],a[8],a[10],a[17]];
 if(roles.some(x=>!x)||new Set(roles).size!==roles.length)
  return {...basis,status:'account_role_aliasing',accountAliases:true};
 const traces=subtree(tx,candidate);
 if(!traces)return {...basis,status:'subtree_missing'};
 const sourceBase=layout.side==='buy'?a[7]:a[5],destBase=layout.side==='buy'?a[5]:a[7];
 const sourceQuote=layout.side==='buy'?a[6]:a[8],destQuote=layout.side==='buy'?a[8]:a[6];
 const remaining=new Set(a.slice(layout.fixed));
 let base=0,quote=0,protocol=0,creator=0,extra=0,unknown=0;
 const srcIndices={};
 for(const ix of traces){
  const t=transfer(ix);
  if(t===null)continue;
  if(!t.valid){unknown++;continue;}
  if(t.source===sourceBase&&t.destination===destBase&&t.mint===a[3]){
   base++;continue;
  }
  if(t.source===sourceQuote&&t.destination===destQuote&&t.mint===a[4]){
   quote++;continue;
  }
  if(t.source!==sourceQuote||t.mint!==a[4]){unknown++;continue;}
  const i=a.indexOf(t.source);
  inc(srcIndices,i<0?'not_in_candidate_accounts':'candidate_index_'+i);
  if(t.destination===a[10])protocol++;
  else if(t.destination===a[17])creator++;
  else if(remaining.has(t.destination))extra++;
  else unknown++;
 }
 const result={...basis,baseEdges:base,quoteEdges:quote,protocolEdges:protocol,
  creatorVaultEdges:creator,remainingAccountEdges:extra,
  unexpectedTransferEdges:unknown,sourceIndexHints:srcIndices};
 if(base!==1||quote!==1||unknown>0||protocol>1||creator>1)
  return {...result,status:'partial_or_ambiguous_structural_routing'};
 // No fee/amount claims regardless of observed role and transfer count.
 if(extra===0&&creator===0&&protocol===0)
  return {...result,status:'base_quote_edges_only_no_fee_or_fill_proof'};
 return {...result,status:'known_and_remaining_structural_edges_no_fee_or_fill_proof'};
}
export function createV214Summary(){
 const byStatus={},byQuote={},byInstruction={},byAppended={},bySource={};
 const byProtocol={},byCreator={},byRemaining={},examples={};
 let rows=0,base=0,quote=0,protocol=0,creator=0,remaining=0,unknown=0;
 return {add(row){
  const r=inspectV214(row.pool_address,row.signature,row.payload);
  rows++;base+=r.baseEdges;quote+=r.quoteEdges;protocol+=r.protocolEdges;
  creator+=r.creatorVaultEdges;remaining+=r.remainingAccountEdges;
  unknown+=r.unexpectedTransferEdges;
  inc(byStatus,r.status);inc(byQuote,r.quoteClass+':'+r.status);
  inc(byInstruction,r.instruction+':'+r.status);
  if(r.instruction!=='none'){
   inc(byAppended,r.instruction+':appended_'+r.appendedAccountCount);
   inc(byProtocol,r.quoteClass+':protocol_edges_'+r.protocolEdges);
   inc(byCreator,r.quoteClass+':creator_edges_'+r.creatorVaultEdges);
   inc(byRemaining,r.quoteClass+':remaining_edges_'+r.remainingAccountEdges);
  }
  for(const [role,n] of Object.entries(r.sourceIndexHints))
   inc(bySource,r.quoteClass+':'+role,n);
  if((examples[r.status]||[]).length<3)(examples[r.status]??=[]).push({
    poolSha256Prefix:hash(row.pool_address),
    signatureSha256Prefix:hash(row.signature),
    instruction:r.instruction,quoteClass:r.quoteClass,
    appendedAccountCount:r.appendedAccountCount,
    baseEdges:r.baseEdges,quoteEdges:r.quoteEdges,
    protocolEdges:r.protocolEdges,creatorVaultEdges:r.creatorVaultEdges,
    remainingAccountEdges:r.remainingAccountEdges,
    unexpectedTransferEdges:r.unexpectedTransferEdges
  });
 },result(){
  return {kind:'s1b1_v214_generalized_pumpswap_routing',version:V214_VERSION,
   sampledEventRows:rows,byStatus:top(byStatus),byQuoteClassStatus:top(byQuote),
   byInstructionStatus:top(byInstruction),byAppendedAccountCount:top(byAppended),
   byQuoteSourceIndex:top(bySource),
   byProtocolEdgeCount:top(byProtocol),byCreatorVaultEdgeCount:top(byCreator),
   byRemainingEdgeCount:top(byRemaining),
   summedBaseEdges:base,summedQuoteEdges:quote,summedProtocolEdges:protocol,
   summedCreatorVaultEdges:creator,summedRemainingAccountEdges:remaining,
   summedUnexpectedTransferEdges:unknown,examples,
   interpretation:'Generalized structural routing recognizes quote mint from the candidate account, official protocol index 10 and creator vault index 17, and explicitly unnamed remaining accounts. Transfer counts and token mint do not prove fees, amounts, executable fills, or net profit.',
   readOnly:true,verifiedFills:0,economicsAuthorized:false,liveTrading:false
  };
 }};
}
