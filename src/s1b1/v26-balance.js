// SOLARIS S1b.1 V2.6: read-only balance evidence gap/root-cause report.
// Covers PumpSwap SPL token account pre/post metadata and Pump.fun SOL lamport
// availability. No value amounts, fills, price, direction, authority or PnL.
import {createHash} from 'node:crypto';
import {decodeBase58,PUMP_FUN,PUMP_SWAP} from './decoder.js';
import {inspectV25} from './v25-edges.js';

export const V26_VERSION='s1b1-v26-balance-gap-0.1';
const PROGRAMS={
 [PUMP_FUN]:{family:'pumpfun',pool:3,user:6,baseMint:2,
  roles:{user_base:5,pool_base:4}},
 [PUMP_SWAP]:{family:'pumpswap',pool:0,user:1,baseMint:3,quoteMint:4,
  roles:{user_base:5,user_quote:6,pool_base:7,pool_quote:8,fee_token_account:10}}
};
const DISCRIMINATORS={
 [PUMP_FUN]:new Set(['66063d1201daebea','33e685a4017f83ad','38fc74089edfcd5f']),
 [PUMP_SWAP]:new Set(['66063d1201daebea','33e685a4017f83ad','c62e1552b4d9e870'])
};
const TOKEN_IDS=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const SYSTEM_ID='11111111111111111111111111111111';
const pubkey=x=>typeof x==='string'?x:typeof x?.pubkey==='string'?x.pubkey:null;
function candidate(ix){
 const known=DISCRIMINATORS[ix?.programId];
 if(!known||typeof ix.data!=='string'||ix.data.length>4096)return false;
 const b=decodeBase58(ix.data);
 return !!b&&b.length>=8&&known.has(b.subarray(0,8).toString('hex'));
}
function locateCandidate(tx){
 const outer=tx?.transaction?.message?.instructions,groups=tx?.meta?.innerInstructions;
 if(!Array.isArray(outer)||!Array.isArray(groups))return null;
 const found=[];
 outer.forEach((ix,i)=>{if(candidate(ix))found.push({ix,index:i,innerIndex:-1,scope:'outer'});});
 for(const g of groups)if(Array.isArray(g?.instructions)){
  g.instructions.forEach((ix,i)=>{
   if(candidate(ix))found.push({ix,index:g.index,innerIndex:i,scope:'inner'});
  });
 }
 return found.length===1?found[0]:null;
}
function descendants(tx,c){
 const groups=tx.meta.innerInstructions.filter(g=>g?.index===c.index&&Array.isArray(g.instructions));
 if(groups.length!==1)return null;
 const instructions=groups[0].instructions;
 if(c.scope==='outer')return instructions;
 const output=[],depth=c.ix.stackHeight;
 for(let i=c.innerIndex+1;i<instructions.length;i++){
  const ix=instructions[i];
  if(ix.stackHeight<=depth)break;
  output.push(ix);
 }
 return output;
}
function roleMapping(accounts,layout){
 const map=new Map();
 for(const [role,index] of Object.entries(layout.roles)){
  const key=accounts[index];
  if(!map.has(key))map.set(key,role);
  else map.set(key,'ambiguous_shared_account');
 }
 return map;
}
function balanceAt(tx,keys,account,mint){
 const idx=keys.findIndex(k=>pubkey(k)===account);
 if(idx<0)return 'account_key_not_found';
 const pre=Array.isArray(tx.meta.preTokenBalances)?tx.meta.preTokenBalances:null;
 const post=Array.isArray(tx.meta.postTokenBalances)?tx.meta.postTokenBalances:null;
 if(!pre||!post)return 'balance_arrays_missing';
 const before=pre.filter(x=>x?.accountIndex===idx);
 const after=post.filter(x=>x?.accountIndex===idx);
 if(before.length>1||after.length>1)return 'multiple_balance_entries';
 if(before.some(x=>x.mint!==mint)||after.some(x=>x.mint!==mint))
  return 'mint_conflict';
 if(!before.length&&!after.length)return 'both_balance_entries_missing';
 if(!before.length)return 'pre_balance_missing';
 if(!after.length)return 'post_balance_missing';
 return 'both_balance_mints_match';
}
const base=()=>({status:'blocked',family:'none',v25Status:'not_evaluated',
 roleBalanceStates:{},otherTransferRolePairs:{},
 otherTokenTransferKinds:{},unmappedTransferEdges:0,
 subtreeSystemTransferInstructions:0,nativeLamportEvidence:'not_applicable',
 verifiedFills:0,economicsAuthorized:false,liveTrading:false});
export function inspectV26(poolAddress,signature,tx){
 const out=base();
 const v25=inspectV25(poolAddress,signature,tx);
 out.v25Status=v25.status;
 if(!v25.status.startsWith('expected_edges_')){
  return {...out,status:'v25_'+v25.status};
 }
 const c=locateCandidate(tx);
 if(!c)return {...out,status:'candidate_not_unique'};
 const layout=PROGRAMS[c.ix.programId],accounts=Array.isArray(c.ix.accounts)?
  c.ix.accounts.map(pubkey):null;
 if(!layout||!accounts||accounts.some(x=>!x)||accounts[layout.pool]!==poolAddress)
  return {...out,status:'candidate_accounts_not_confirmed'};
 const inner=descendants(tx,c);
 if(!inner)return {...out,status:'candidate_subtree_not_found'};
 const accountRoles=roleMapping(accounts,layout),states={};
 const keys=tx.transaction.message.accountKeys;
 if(!Array.isArray(keys))return {...out,status:'account_keys_missing'};
 const expectedRoles=layout.family==='pumpswap'?
  ['user_base','pool_base','user_quote','pool_quote']:
  ['user_base','pool_base'];
 for(const role of expectedRoles){
  const mint=role.endsWith('_quote')?accounts[layout.quoteMint]:accounts[layout.baseMint];
  states[role]=balanceAt(tx,keys,accounts[layout.roles[role]],mint);
 }
 const extraPairs={},types={};let unmapped=0,systemTransfers=0;
 for(const ix of inner){
  if(ix?.programId===SYSTEM_ID&&ix?.parsed?.type==='transfer')systemTransfers++;
  if(!TOKEN_IDS.has(ix?.programId))continue;
  const t=ix?.parsed?.type;
  if(!['transfer','transferChecked','transferCheckedWithFee'].includes(t))continue;
  const src=ix?.parsed?.info?.source,dst=ix?.parsed?.info?.destination;
  if(typeof src!=='string'||typeof dst!=='string'){
   types.unparsed_endpoints=(types.unparsed_endpoints||0)+1;continue;
  }
  const roleSrc=accountRoles.get(src)||'unmapped';
  const roleDst=accountRoles.get(dst)||'unmapped';
  const pair=roleSrc+'->'+roleDst;
  // Count only transfers not matching one of V2.5's expected directional legs.
  const buy= c.ix.data && isBuy(c.ix);
  const baseExpected=buy?'pool_base->user_base':'user_base->pool_base';
  const quoteExpected=buy?'user_quote->pool_quote':'pool_quote->user_quote';
  if(pair===baseExpected||(layout.family==='pumpswap'&&pair===quoteExpected))
   continue;
  extraPairs[pair]=(extraPairs[pair]||0)+1;
  types[t]=(types[t]||0)+1;
  if(roleSrc==='unmapped'||roleDst==='unmapped')unmapped++;
 }
 let nativeLamportEvidence='not_applicable';
 if(layout.family==='pumpfun'){
  const payer=keys.findIndex(k=>pubkey(k)===accounts[layout.user]);
  const curve=keys.findIndex(k=>pubkey(k)===accounts[layout.pool]);
  const pre=tx.meta.preBalances,post=tx.meta.postBalances;
  if(!Array.isArray(pre)||!Array.isArray(post))nativeLamportEvidence='balance_arrays_missing';
  else if(payer<0||curve<0)nativeLamportEvidence='account_key_not_found';
  else if(![pre[payer],post[payer],pre[curve],post[curve]]
   .every(x=>Number.isSafeInteger(x)&&x>=0))
   nativeLamportEvidence='missing_or_invalid_account_balances';
  else nativeLamportEvidence='transaction_lamport_snapshots_present_not_attributed';
 }
 const allConsistent=expectedRoles.every(role=>states[role]==='both_balance_mints_match');
 return {...out,family:layout.family,status:allConsistent?
  'balance_metadata_complete_not_fill':'balance_metadata_gaps_remain',
  roleBalanceStates:states,otherTransferRolePairs:extraPairs,otherTokenTransferKinds:types,
  unmappedTransferEdges:unmapped,subtreeSystemTransferInstructions:systemTransfers,
  nativeLamportEvidence};
}
function isBuy(ix){
 const b=decodeBase58(ix.data);
 if(!b||b.length<8)return false;
 const hex=b.subarray(0,8).toString('hex');
 return hex!=='33e685a4017f83ad';
}
const inc=(o,k,n=1)=>{o[k]=(o[k]||0)+n;};
const top=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,60).map(([key,eventRows])=>({key,eventRows}));
const hash=x=>createHash('sha256').update(String(x||'')).digest('hex').slice(0,16);
export function createV26Summary(){
 const status={},venue={},roleState={},pair={},tokenTypes={},sol={},examples={};
 let seen=0,extra=0,system=0;
 return {add(row){
  const r=inspectV26(row.pool_address,row.signature,row.payload);
  const v=String(row.venue_family||'unknown').slice(0,40),key=v+':'+r.status;
  seen++;extra+=Object.values(r.otherTransferRolePairs).reduce((a,b)=>a+b,0);
  system+=r.subtreeSystemTransferInstructions;
  inc(status,r.status);inc(venue,key);
  for(const [role,value] of Object.entries(r.roleBalanceStates))
   inc(roleState,r.family+':'+role+':'+value);
  for(const [name,n] of Object.entries(r.otherTransferRolePairs))
   inc(pair,r.family+':'+name,n);
  for(const [name,n] of Object.entries(r.otherTokenTransferKinds))
   inc(tokenTypes,r.family+':'+name,n);
  inc(sol,r.family+':'+r.nativeLamportEvidence);
  if((examples[key]||[]).length<2)(examples[key]??=[]).push({
   signatureSha256Prefix:hash(row.signature),poolSha256Prefix:hash(row.pool_address),
   v25Status:r.v25Status,roleBalanceStates:r.roleBalanceStates,
   nativeLamportEvidence:r.nativeLamportEvidence,
   otherTransferRolePairs:r.otherTransferRolePairs
  });
 },result(){return {
  kind:'s1b1_v26_balance_gap_audit',version:V26_VERSION,
  units:'v2_single_trade_candidate_event_rows',sampledEventRows:seen,
  byStatus:top(status),byVenueStatus:top(venue),
  byBalanceAccountRole:top(roleState),
  byOtherTransferEndpointRole:top(pair),
  byOtherTransferInstructionKind:top(tokenTypes),
  byNativeLamportEvidence:top(sol),
  summedOtherTransferInstructions:extra,
  summedSystemTransfersInCandidateSubtree:system,
  examples,
  interpretation:'Account role balance presence, foreign transfer endpoint roles and transaction-level native SOL snapshots are diagnostics only. No instruction-level economic attribution, fee treatment, amount, fill or price has been established.',
  readOnly:true,verifiedFills:0,economicsAuthorized:false,liveTrading:false
 };}};
}
