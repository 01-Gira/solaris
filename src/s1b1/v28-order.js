// SOLARIS S1b.1 V2.8 — bounded, read-only execution-order *evidence*.
// No swap fills, prices, token quantities, lamport deltas, PDA authority or PnL.
// Compare exact token-account lifecycle instruction addresses against candidate
// position in the persisted jsonParsed transaction (outer then associated CPI).
import {createHash} from 'node:crypto';
import {decodeBase58,PUMP_FUN,PUMP_SWAP,WSOL} from './decoder.js';
import {inspectV27} from './v27-lifecycle.js';

export const V28_VERSION='s1b1-v28-ordered-lifecycle-0.1';
const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM='11111111111111111111111111111111';
const TOKENS=new Set([
 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
]);
const DISCS={
 [PUMP_FUN]:new Set(['66063d1201daebea','33e685a4017f83ad','38fc74089edfcd5f']),
 [PUMP_SWAP]:new Set(['66063d1201daebea','33e685a4017f83ad','c62e1552b4d9e870'])
};
const ROLES={
 [PUMP_FUN]:{user_base:5,pool_base:4},
 [PUMP_SWAP]:{user_base:5,pool_base:7,user_quote:6,pool_quote:8}
};
const key=x=>typeof x==='string'?x:typeof x?.pubkey==='string'?x.pubkey:null;
function isCandidate(ix){
 const d=DISCS[ix?.programId];
 if(!d||typeof ix.data!=='string'||ix.data.length>4096)return false;
 const b=decodeBase58(ix.data);
 return !!b&&b.length>=8&&d.has(b.subarray(0,8).toString('hex'));
}
// Order each outer instruction and its descendants as returned by jsonParsed RPC;
// reject duplicate/malformed outer group indices, which cannot be ordered safely.
function timeline(tx){
 const outer=tx?.transaction?.message?.instructions;
 const inner=tx?.meta?.innerInstructions;
 if(!Array.isArray(outer)||!Array.isArray(inner)||outer.length>500)return null;
 const groups=new Map();
 for(const g of inner){
  if(!Number.isSafeInteger(g?.index)||g.index<0||g.index>=outer.length||
   !Array.isArray(g.instructions)||g.instructions.length>500||
   groups.has(g.index))return null;
  groups.set(g.index,g.instructions);
 }
 const result=[];
 for(let outerIndex=0;outerIndex<outer.length;outerIndex++){
  result.push({ix:outer[outerIndex],outerIndex,innerIndex:-1});
  for(const [innerIndex,ix] of (groups.get(outerIndex)||[]).entries())
   result.push({ix,outerIndex,innerIndex});
 }
 return result;
}
function operation(ix){
 const kind=ix?.parsed?.type,info=ix?.parsed?.info;
 if(typeof kind!=='string'||!info||typeof info!=='object')return null;
 if(ix.programId===ATA&&['create','createIdempotent'].includes(kind))
  return {account:info.account??info.associatedAccount,kind:'create_hint'};
 if(ix.programId===SYSTEM&&['createAccount','createAccountWithSeed'].includes(kind))
  return {account:info.newAccount,kind:'create_hint'};
 if(TOKENS.has(ix.programId)&&['initializeAccount','initializeAccount2',
  'initializeAccount3'].includes(kind))
  return {account:info.account,kind:'initialize_hint'};
 if(TOKENS.has(ix.programId)&&kind==='closeAccount')
  return {account:info.account,kind:'close_hint'};
 if(TOKENS.has(ix.programId)&&kind==='syncNative')
  return {account:info.account,kind:'sync_native_hint'};
 return null;
}
function chronology(status,events,candidatePosition){
 const beforeCreate=events.some(e=>e.kind==='create_hint'&&e.position<candidatePosition);
 const beforeInit=events.some(e=>e.kind==='initialize_hint'&&e.position<candidatePosition);
 const afterClose=events.some(e=>e.kind==='close_hint'&&e.position>candidatePosition);
 const anyCreate=events.some(e=>e.kind==='create_hint');
 const anyClose=events.some(e=>e.kind==='close_hint');
 const beforeSync=events.some(e=>e.kind==='sync_native_hint'&&e.position<candidatePosition);
 const afterSync=events.some(e=>e.kind==='sync_native_hint'&&e.position>candidatePosition);
 const evidence={status:'unresolved',createBeforeCandidate:beforeCreate,
  initializeBeforeCandidate:beforeInit,closeAfterCandidate:afterClose,
  syncNativeBeforeCandidate:beforeSync,syncNativeAfterCandidate:afterSync};
 if(status==='both_balance_entries_missing'){
  evidence.status=beforeCreate&&afterClose?'ordered_create_then_candidate_then_close_hints':
   anyCreate||anyClose?'incomplete_or_out_of_order_lifecycle_hints':
   'no_create_or_close_hints';
 }else if(status==='pre_balance_missing'){
  evidence.status=beforeCreate?'ordered_create_before_candidate_hint':
   anyCreate?'create_seen_outside_expected_order':'create_hint_absent';
 }else if(status==='post_balance_missing'){
  evidence.status=afterClose?'ordered_close_after_candidate_hint':
   anyClose?'close_seen_outside_expected_order':'close_hint_absent';
 }else evidence.status='unmodeled_balance_gap';
 return evidence;
}
function groupSubtree(tx,c){
 const groups=tx.meta.innerInstructions.filter(g=>g.index===c.outerIndex);
 if(groups.length!==1)return [];
 const siblings=groups[0].instructions;
 if(c.innerIndex===-1)return siblings;
 const result=[],height=c.ix.stackHeight;
 for(let i=c.innerIndex+1;i<siblings.length;i++){
  if(siblings[i].stackHeight<=height)break;
  result.push(siblings[i]);
 }
 return result;
}
function extrasByAccountIndex(tx,c,accounts){
 if(c.ix.programId!==PUMP_SWAP)return [];
 const bytes=decodeBase58(c.ix.data);
 const sell=bytes?.subarray(0,8).toString('hex')==='33e685a4017f83ad';
 const sourceBase=sell?accounts[5]:accounts[7],destinationBase=sell?accounts[7]:accounts[5];
 const sourceQuote=sell?accounts[8]:accounts[6],destinationQuote=sell?accounts[6]:accounts[8];
 const result=[];
 for(const ix of groupSubtree(tx,c)){
  if(!TOKENS.has(ix?.programId))continue;
  const type=ix.parsed?.type;
  if(!['transfer','transferChecked','transferCheckedWithFee'].includes(type))continue;
  const info=ix.parsed?.info;
  if(typeof info?.source!=='string'||typeof info?.destination!=='string')continue;
  if((info.source===sourceBase&&info.destination===destinationBase)||
   (info.source===sourceQuote&&info.destination===destinationQuote))continue;
  const destIndex=accounts.indexOf(info.destination);
  const sourceIndex=accounts.indexOf(info.source);
  const mintEvidence=type==='transferChecked'&&info.mint===accounts[4]?
   'checked_quote_mint':type==='transferChecked'?'checked_non_quote_mint':
   'mint_not_checked_or_fee_variant';
  result.push({destinationIndex:destIndex>=0?`candidate_index_${destIndex}`:
   'not_in_candidate_accounts',sourceIndex:sourceIndex>=0?
   `candidate_index_${sourceIndex}`:'not_in_candidate_accounts',mintEvidence});
 }
 return result;
}
export function inspectV28(poolAddress,signature,tx){
 const gate=inspectV27(poolAddress,signature,tx);
 const base={status:'v27_blocked',family:'none',quoteMintClass:'not_applicable',
  chronologyByRole:{},additionalEdgeIndices:[],verifiedFills:0,
  economicsAuthorized:false,liveTrading:false};
 if(!['no_balance_gaps','all_balance_gaps_have_lifecycle_hints',
  'mixed_lifecycle_evidence','balance_gaps_unexplained'].includes(gate.status))
  return {...base,status:'v27_'+gate.status};
 const ordered=timeline(tx);
 if(!ordered)return {...base,status:'instruction_order_unavailable'};
 const candidates=ordered.filter(e=>isCandidate(e.ix));
 if(candidates.length!==1)return {...base,status:'candidate_not_unique'};
 const candidate=candidates[0],accounts=candidate.ix.accounts?.map(key);
 if(!Array.isArray(accounts)||accounts.some(x=>!x))
  return {...base,status:'candidate_accounts_unusable'};
 const roleIndices=ROLES[candidate.ix.programId];
 if(!roleIndices)return {...base,status:'candidate_program_not_supported'};
 const family=candidate.ix.programId===PUMP_SWAP?'pumpswap':'pumpfun';
 const position=ordered.indexOf(candidate);
 const observed=new Map();
 for(let p=0;p<ordered.length;p++){
  const op=operation(ordered[p].ix);
  if(typeof op?.account!=='string')continue;
  if(!observed.has(op.account))observed.set(op.account,[]);
  observed.get(op.account).push({kind:op.kind,position:p});
 }
 const details={},extras=extrasByAccountIndex(tx,candidate,accounts);
 let gapCount=0,orderedGapCount=0;
 for(const [role,data] of Object.entries(gate.roleGapDetails)){
  if(data.classification==='no_gap')continue;
  const roleIndex=roleIndices[role];
  if(!Number.isInteger(roleIndex)||!accounts[roleIndex])continue;
  gapCount++;
  const info=chronology(data.balanceState,observed.get(accounts[roleIndex])||[],position);
  details[role]=info;
  if(info.status.startsWith('ordered_'))orderedGapCount++;
 }
 return {...base,family,chronologyByRole:details,
  quoteMintClass:family==='pumpswap'?
   accounts[4]===WSOL?'wsol_mint_confirmed':'non_wsol_quote_mint':
   'native_sol_quote_not_reconciled',
  additionalEdgeIndices:extras,
  status:gapCount===0?'no_balance_gap':
   orderedGapCount===gapCount?'ordered_lifecycle_hints_all_gap_roles':
   orderedGapCount>0?'ordered_lifecycle_hints_partial':
   'lifecycle_order_not_confirmed'};
}
const hash=x=>createHash('sha256').update(String(x||'')).digest('hex').slice(0,16);
const inc=(o,k,n=1)=>{o[k]=(o[k]||0)+n;};
const top=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,60).map(([key,eventRows])=>({key,eventRows}));
export function createV28Summary(){
 const status={},venue={},roleChrono={},mint={},extraDestination={},
  extraSource={},extraMint={},sync={},examples={};
 let seen=0;
 return {add(row){
  const result=inspectV28(row.pool_address,row.signature,row.payload),
   v=String(row.venue_family||'unknown').slice(0,40),group=v+':'+result.status;
  seen++;inc(status,result.status);inc(venue,group);
  inc(mint,result.family+':'+result.quoteMintClass);
  for(const [role,c] of Object.entries(result.chronologyByRole)){
   inc(roleChrono,result.family+':'+role+':'+c.status);
   inc(sync,result.family+':'+role+':sync_before_'+c.syncNativeBeforeCandidate);
  }
  for(const edge of result.additionalEdgeIndices){
   inc(extraDestination,result.family+':'+edge.destinationIndex);
   inc(extraSource,result.family+':'+edge.sourceIndex);
   inc(extraMint,result.family+':'+edge.mintEvidence);
  }
  if((examples[group]||[]).length<2)
   (examples[group]??=[]).push({signatureSha256Prefix:hash(row.signature),
    poolSha256Prefix:hash(row.pool_address),
    family:result.family,quoteMintClass:result.quoteMintClass,
    chronologyByRole:result.chronologyByRole,
    additionalEdgeIndices:result.additionalEdgeIndices});
 },result(){return {
  kind:'s1b1_v28_ordered_lifecycle_evidence',version:V28_VERSION,
  units:'v2_single_trade_candidate_event_rows',sampledEventRows:seen,
  byStatus:top(status),byVenueStatus:top(venue),
  byOrderedBalanceGapRole:top(roleChrono),
  byQuoteMintClass:top(mint),bySyncNativeBeforeCandidate:top(sync),
  byAdditionalDestinationCandidateIndex:top(extraDestination),
  byAdditionalSourceCandidateIndex:top(extraSource),
  byAdditionalEdgeMintEvidence:top(extraMint),examples,
  interpretation:'Instruction-order and token mint evidence may explain missing pre/post snapshots and temporary wrapped SOL accounts. Such matches are not causal proof, fee attribution, execution quantities, swap fill prices or economic authorization.',
  readOnly:true,verifiedFills:0,economicsAuthorized:false,liveTrading:false
 };}};
}
