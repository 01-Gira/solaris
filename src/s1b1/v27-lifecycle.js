// SOLARIS S1b.1 V2.7 — read-only token account lifecycle + non-primary edge diagnostics.
// Presence of create / initialize / close instructions is an explanatory HINT,
// not proof of a complete token-account lifecycle, swap fill, fee or price.
import {createHash} from 'node:crypto';
import {decodeBase58,PUMP_FUN,PUMP_SWAP} from './decoder.js';
import {inspectV26} from './v26-balance.js';

export const V27_VERSION='s1b1-v27-lifecycle-0.1';
const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYS='11111111111111111111111111111111';
const TOKENS=new Set([
 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
]);
const DISCS={
 [PUMP_FUN]:new Set(['66063d1201daebea','33e685a4017f83ad','38fc74089edfcd5f']),
 [PUMP_SWAP]:new Set(['66063d1201daebea','33e685a4017f83ad','c62e1552b4d9e870'])
};
const ROLE_INDEX={
 [PUMP_FUN]:{user_base:5,pool_base:4},
 [PUMP_SWAP]:{user_base:5,pool_base:7,user_quote:6,pool_quote:8,
  protocol_fee_token_account:10,creator_vault_ata:17}
};
const GAP_STATUSES=new Set(['both_balance_entries_missing','pre_balance_missing',
 'post_balance_missing','balance_arrays_missing','account_key_not_found',
 'multiple_balance_entries','mint_conflict']);
const key=x=>typeof x==='string'?x:typeof x?.pubkey==='string'?x.pubkey:null;
function isCandidate(ix){
 const accepted=DISCS[ix?.programId];
 if(!accepted||typeof ix.data!=='string'||ix.data.length>4096)return false;
 const data=decodeBase58(ix.data);
 return !!data&&data.length>=8&&accepted.has(data.subarray(0,8).toString('hex'));
}
function locate(tx){
 const outer=tx.transaction.message.instructions;
 const groups=tx.meta.innerInstructions;
 const found=[];
 outer.forEach((ix,index)=>{if(isCandidate(ix))found.push({ix,outerIndex:index,innerIndex:-1,scope:'outer'});});
 for(const g of groups){
  if(!Array.isArray(g?.instructions))continue;
  g.instructions.forEach((ix,innerIndex)=>{
   if(isCandidate(ix))found.push({ix,outerIndex:g.index,innerIndex,scope:'inner'});
  });
 }
 return found.length===1?found[0]:null;
}
function allInstructions(tx){
 const outer=tx.transaction.message.instructions;
 const result=outer.map((ix,index)=>({ix,scope:'outer',outerIndex:index}));
 for(const g of tx.meta.innerInstructions){
  if(!Array.isArray(g?.instructions))continue;
  for(const ix of g.instructions)
   result.push({ix,scope:'inner',outerIndex:g.index});
 }
 return result;
}
function collectLifecycleSignals(tx){
 const byAccount=new Map();
 const add=(account,signal,scope)=>{
  if(typeof account!=='string'||!account)return;
  if(!byAccount.has(account))byAccount.set(account,new Set());
  byAccount.get(account).add(signal+':'+scope);
 };
 for(const {ix,scope} of allInstructions(tx)){
  const type=ix?.parsed?.type,info=ix?.parsed?.info;
  if(typeof type!=='string'||!info||typeof info!=='object')continue;
  if(ix.programId===ATA&&['create','createIdempotent'].includes(type))
   add(info.account??info.associatedAccount,'associated_token_create',scope);
  if(ix.programId===SYS&&['createAccount','createAccountWithSeed'].includes(type))
   add(info.newAccount,'system_create',scope);
  if(TOKENS.has(ix.programId)&&['initializeAccount','initializeAccount2',
   'initializeAccount3'].includes(type))
   add(info.account,'token_initialize',scope);
  if(TOKENS.has(ix.programId)&&type==='closeAccount')
   add(info.account,'token_close',scope);
  if(TOKENS.has(ix.programId)&&type==='syncNative')
   add(info.account,'sync_native',scope);
 }
 return byAccount;
}
function lifecycleClass(balanceStatus,signals){
 if(!GAP_STATUSES.has(balanceStatus))return 'no_gap';
 const s=[...signals],created=s.some(x=>x.startsWith('associated_token_create:')||
  x.startsWith('system_create:')||x.startsWith('token_initialize:'));
 const closed=s.some(x=>x.startsWith('token_close:'));
 if(balanceStatus==='both_balance_entries_missing'){
  if(created&&closed)return 'both_missing_create_and_close_hints';
  if(created)return 'both_missing_create_hint_only';
  if(closed)return 'both_missing_close_hint_only';
  return 'both_missing_no_lifecycle_signal';
 }
 if(balanceStatus==='pre_balance_missing')
  return created?'pre_missing_create_hint':'pre_missing_no_create_hint';
 if(balanceStatus==='post_balance_missing')
  return closed?'post_missing_close_hint':'post_missing_no_close_hint';
 return 'other_balance_gap_unresolved';
}
function subtree(tx,c){
 const groups=tx.meta.innerInstructions.filter(g=>g?.index===c.outerIndex&&
  Array.isArray(g?.instructions));
 if(groups.length!==1)return [];
 const siblings=groups[0].instructions;
 if(c.scope==='outer')return siblings;
 const result=[],height=c.ix.stackHeight;
 for(let i=c.innerIndex+1;i<siblings.length;i++){
  if(siblings[i].stackHeight<=height)break;
  result.push(siblings[i]);
 }
 return result;
}
function additionalEdges(tx,c,accounts){
 if(c.ix.programId!==PUMP_SWAP)return [];
 const roleMap=new Map(Object.entries(ROLE_INDEX[PUMP_SWAP])
  .map(([name,index])=>[accounts[index],name]));
 const disc=decodeBase58(c.ix.data).subarray(0,8).toString('hex');
 const sell=disc==='33e685a4017f83ad';
 const baseExpected=sell?'user_base->pool_base':'pool_base->user_base';
 const quoteExpected=sell?'pool_quote->user_quote':'user_quote->pool_quote';
 const result=[];
 for(const ix of subtree(tx,c)){
  if(!TOKENS.has(ix?.programId))continue;
  const type=ix?.parsed?.type;
  if(!['transfer','transferChecked','transferCheckedWithFee'].includes(type))continue;
  const from=ix?.parsed?.info?.source,to=ix?.parsed?.info?.destination;
  if(typeof from!=='string'||typeof to!=='string')continue;
  const pair=(roleMap.get(from)||'unmapped')+'->'+(roleMap.get(to)||'unmapped');
  if(pair===baseExpected||pair===quoteExpected)continue;
  const mint=ix?.parsed?.info?.mint;
  const quoteMint=accounts[4];
  const mintEvidence=type==='transferChecked'&&mint===quoteMint?
   'checked_quote_mint':type==='transferChecked'?'checked_other_or_unknown_mint':
   'unchecked_or_fee_bearing';
  result.push({pair,mintEvidence});
 }
 return result;
}
const base=()=>({status:'v26_blocked',family:'none',
 balanceGapRoles:0,rolesWithLifecycleHints:0,rolesWithoutLifecycleHints:0,
 roleGapDetails:{},extraEdgeRolePairs:{},extraEdgeMintEvidence:{},
 nativeSolReconciled:false,fillVerified:false,economicsAuthorized:false,
 liveTrading:false});
export function inspectV27(poolAddress,signature,tx){
 const v26=inspectV26(poolAddress,signature,tx);
 const out=base();
 if(!['balance_metadata_complete_not_fill','balance_metadata_gaps_remain']
  .includes(v26.status))return {...out,status:'v26_'+v26.status};
 if(!tx?.transaction?.message||!Array.isArray(tx.meta?.innerInstructions))
  return {...out,status:'incomplete_transaction_metadata'};
 const c=locate(tx);
 if(!c)return {...out,status:'candidate_not_unique'};
 const accounts=Array.isArray(c.ix.accounts)?c.ix.accounts.map(key):null;
 const roles=ROLE_INDEX[c.ix.programId];
 if(!accounts||!roles||accounts.some(x=>!x))
  return {...out,status:'accounts_not_resolved'};
 const family=c.ix.programId===PUMP_FUN?'pumpfun':'pumpswap';
 const lifecycle=collectLifecycleSignals(tx);
 const results={},extraPairs={},extraMint={};
 let gap=0,withHints=0,withoutHints=0;
 for(const [role,balanceState] of Object.entries(v26.roleBalanceStates)){
  if(!Object.hasOwn(roles,role))continue;
  const account=accounts[roles[role]];
  const signals=lifecycle.get(account)||new Set();
  const classification=lifecycleClass(balanceState,signals);
  results[role]={balanceState,classification,
   // Signals are instruction-presence only, never proof of account creation.
   lifecycleSignals:[...signals].sort()};
  if(classification!=='no_gap'){
   gap++;
   if(signals.size>0)withHints++;else withoutHints++;
  }
 }
 for(const e of additionalEdges(tx,c,accounts)){
  extraPairs[e.pair]=(extraPairs[e.pair]||0)+1;
  extraMint[e.mintEvidence]=(extraMint[e.mintEvidence]||0)+1;
 }
 return {...out,status:gap===0?'no_balance_gaps':
  withHints===gap?'all_balance_gaps_have_lifecycle_hints':
  withHints>0?'mixed_lifecycle_evidence':'balance_gaps_unexplained',
  family,balanceGapRoles:gap,rolesWithLifecycleHints:withHints,
  rolesWithoutLifecycleHints:withoutHints,roleGapDetails:results,
  extraEdgeRolePairs:extraPairs,extraEdgeMintEvidence:extraMint};
}
const hash=x=>createHash('sha256').update(String(x||'')).digest('hex').slice(0,16);
const inc=(o,k,n=1)=>{o[k]=(o[k]||0)+n;};
const top=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,60).map(([key,eventRows])=>({key,eventRows}));
export function createV27Summary(){
 const statuses={},venue={},roleGap={},signal={},extra={},mintEvidence={},
  examples={};
 let seen=0,unexplained=0;
 return {add(row){
  const r=inspectV27(row.pool_address,row.signature,row.payload),
   v=String(row.venue_family||'unknown').slice(0,40),k=v+':'+r.status;
  seen++;unexplained+=r.rolesWithoutLifecycleHints;
  inc(statuses,r.status);inc(venue,k);
  for(const [role,detail] of Object.entries(r.roleGapDetails)){
   inc(roleGap,r.family+':'+role+':'+detail.balanceState+':'+detail.classification);
   for(const s of detail.lifecycleSignals)inc(signal,r.family+':'+role+':'+s);
  }
  for(const [pair,n] of Object.entries(r.extraEdgeRolePairs))
   inc(extra,r.family+':'+pair,n);
  for(const [name,n] of Object.entries(r.extraEdgeMintEvidence))
   inc(mintEvidence,r.family+':'+name,n);
  if((examples[k]||[]).length<2)(examples[k]??=[]).push({
   signatureSha256Prefix:hash(row.signature),
   poolSha256Prefix:hash(row.pool_address),
   roleGapDetails:r.roleGapDetails,extraEdgeRolePairs:r.extraEdgeRolePairs
  });
 },result(){return {
  kind:'s1b1_v27_lifecycle_evidence',version:V27_VERSION,
  units:'v2_single_trade_candidate_event_rows',sampledEventRows:seen,
  byStatus:top(statuses),byVenueStatus:top(venue),
  byRoleBalanceGapAndLifecycle:top(roleGap),
  byRoleLifecycleSignal:top(signal),
  byAdditionalEdgeRole:top(extra),
  byAdditionalEdgeMintEvidence:top(mintEvidence),
  balanceGapRolesWithoutLifecycleSignals:unexplained,examples,
  interpretation:'Create/close/initialize instructions in the same transaction are lifecycle hints, not proof the missing token balance was caused by temporary account creation or closure. Additional checked quote-mint edges may point to fee-recipient or creator-vault account roles but are not verified fees. No amounts/fills/quotes or native SOL attribution.',
  readOnly:true,verifiedFills:0,economicsAuthorized:false,liveTrading:false
 };}};
}
