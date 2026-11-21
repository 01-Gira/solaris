// S1b.1 V2.3: READ-ONLY group-level token transfer trace diagnostics.
// Parsed transfers co-located with a candidate are NOT attributable fills.
// No per-instruction amount, price, signer authority or PnL is asserted.
import {createHash} from 'node:crypto';
import {decodeBase58,PUMP_FUN,PUMP_SWAP} from './decoder.js';
export const V23_VERSION='s1b1-v23-trace-0.1';
const TOKEN_IDS=new Set([
 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
]);
const DISCS={
 [PUMP_FUN]:new Set(['66063d1201daebea','33e685a4017f83ad','38fc74089edfcd5f']),
 [PUMP_SWAP]:new Set(['66063d1201daebea','33e685a4017f83ad','c62e1552b4d9e870'])
};
const TRANSFERS=new Set(['transfer','transferChecked','transferCheckedWithFee']);
const OTHER_MOVES=new Set(['mintTo','mintToChecked','burn','burnChecked','closeAccount','syncNative']);
function candidate(ix){
 if(!DISCS[ix?.programId]||typeof ix.data!=='string'||ix.data.length>4096)return false;
 const bytes=decodeBase58(ix.data);
 return !!bytes&&bytes.length>=8&&DISCS[ix.programId].has(bytes.subarray(0,8).toString('hex'));
}
export function inspectV23(tx,signature){
 const base={status:'missing_metadata',scope:'none',parentProgram:'none',
  candidateCount:0,groupTokenInstructions:0,parsedTransfers:0,
  parsedOtherMoves:0,unparsedTokenInstructions:0,
  stackHeightOnCandidate:false,tokenBalancesAvailable:false,
  verifiedFills:0,economicsAuthorized:false,liveTrading:false};
 if(!tx?.meta||!tx?.transaction?.message)return base;
 if(Array.isArray(tx.transaction.signatures)&&!tx.transaction.signatures.includes(signature))
  return {...base,status:'signature_mismatch'};
 if(tx.meta.err!==null&&tx.meta.err!==undefined)return {...base,status:'failed_onchain'};
 const outer=tx.transaction.message.instructions;
 if(!Array.isArray(outer))return {...base,status:'outer_instructions_missing'};
 const groups=Array.isArray(tx.meta.innerInstructions)?tx.meta.innerInstructions:[];
 const hits=[];
 for(let i=0;i<outer.length;i++)if(candidate(outer[i]))
  hits.push({ix:outer[i],scope:'outer',index:i});
 for(const g of groups)if(Array.isArray(g?.instructions)){
  for(const ix of g.instructions)if(candidate(ix))
   hits.push({ix,scope:'inner',index:g.index});
 }
 if(hits.length!==1)return {...base,status:'not_single_candidate',candidateCount:hits.length};
 const c=hits[0];
 if(!Number.isSafeInteger(c.index)||c.index<0||c.index>=outer.length)
  return {...base,status:'invalid_outer_index',candidateCount:1};
 const selected=groups.filter(g=>g?.index===c.index&&Array.isArray(g?.instructions));
 const instructions=selected.flatMap(g=>g.instructions);
 const tokens=instructions.filter(ix=>TOKEN_IDS.has(ix?.programId));
 let parsedTransfers=0,parsedOtherMoves=0,unparsedTokenInstructions=0;
 for(const ix of tokens){
  const kind=typeof ix?.parsed?.type==='string'?ix.parsed.type:null;
  if(TRANSFERS.has(kind))parsedTransfers++;
  else if(OTHER_MOVES.has(kind))parsedOtherMoves++;
  else unparsedTokenInstructions++;
 }
 const details={...base,candidateCount:1,scope:c.scope,
  parentProgram:c.scope==='inner'?String(outer[c.index]?.programId||'unknown').slice(0,100):'self',
  groupTokenInstructions:tokens.length,parsedTransfers,
  parsedOtherMoves,unparsedTokenInstructions,
  stackHeightOnCandidate:Number.isInteger(c.ix.stackHeight),
  tokenBalancesAvailable:Array.isArray(tx.meta.preTokenBalances)&&Array.isArray(tx.meta.postTokenBalances)};
 if(selected.length>1)return {...details,status:'duplicate_outer_groups'};
 if(c.scope==='inner'&&selected.length===0)return {...details,status:'inner_group_not_found'};
 if(tokens.length===0)return {...details,status:'no_token_instructions_in_group'};
 if(parsedTransfers===0)return {...details,status:unparsedTokenInstructions?
  'unparsed_token_instructions':'no_parsed_transfer_in_group'};
 return {...details,status:'transfers_colocated_not_attributed'};
}
const hash=x=>createHash('sha256').update(String(x||'')).digest('hex').slice(0,16);
const increment=(o,k)=>{o[k]=(o[k]||0)+1;};
const top=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,50).map(([key,eventRows])=>({key,eventRows}));
export function createV23Summary(){
 const status={},venue={},scope={},parent={},stack={},examples={};let count=0;
 return {add(row){
  const r=inspectV23(row.payload,row.signature);
  const v=String(row.venue_family||'unknown').slice(0,40);
  count++;increment(status,r.status);
  increment(venue,v+':'+r.status);
  increment(scope,r.scope+':'+r.status);
  increment(parent,r.parentProgram+':'+r.status);
  increment(stack,r.scope+':stackHeight_'+r.stackHeightOnCandidate);
  const key=v+':'+r.status;
  if((examples[key]||[]).length<2)(examples[key]??=[]).push({
   signatureSha256Prefix:hash(row.signature),
   poolSha256Prefix:hash(row.pool_address),
   parentProgram:r.parentProgram,scope:r.scope,
   groupTokenInstructions:r.groupTokenInstructions,
   parsedTransfers:r.parsedTransfers,
   unparsedTokenInstructions:r.unparsedTokenInstructions
  });
 },result(){return {
  kind:'s1b1_v23_transfer_trace',version:V23_VERSION,
  units:'v2_single_trade_candidate_event_rows',sampledEventRows:count,
  byStatus:top(status),byVenueStatus:top(venue),
  byScopeStatus:top(scope),byParentStatus:top(parent),
  byStackHeightPresence:top(stack),examples,
  interpretation:'SPL token instructions and parsed transfers in the same outer instruction group are co-located only. They do not establish which CPI caused a transfer, per-instruction amounts, signer authority, actual fills or prices.',
  readOnly:true,verifiedFills:0,economicsAuthorized:false,liveTrading:false
 };}};
}
