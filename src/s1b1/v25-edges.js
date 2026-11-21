// S1b.1 V2.5 — read-only token-account/transfer reconciliation diagnostics.
// WARNING: matched trace legs are NOT fills. No trade output, price, PnL, or wallet authority.
// Account mappings pinned to public pump-fun/pump-public-docs legacy IDLs as in V2.2.
// Never multiply "transfer count" by price, nor use whole-tx balance deltas as a swap price.
import {createHash} from 'node:crypto';
import {decodeBase58,PUMP_FUN,PUMP_SWAP} from './decoder.js';
import {inspectV24} from './v24-subtree.js';

export const V25_VERSION='s1b1-v25-token-edges-0.1';
const TOKEN_PROGRAMS=new Set([
 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
]);
const LAYOUTS={
 [PUMP_FUN]:{
  '66063d1201daebea':{name:'buy',side:'BUY',pool:3,baseMint:2,
   userBase:5,poolBase:4,min:16},
  '33e685a4017f83ad':{name:'sell',side:'SELL',pool:3,baseMint:2,
   userBase:5,poolBase:4,min:14},
  '38fc74089edfcd5f':{name:'buy_exact_sol_in',side:'BUY',pool:3,baseMint:2,
   userBase:5,poolBase:4,min:16}
 },
 [PUMP_SWAP]:{
  '66063d1201daebea':{name:'buy',side:'BUY',pool:0,baseMint:3,quoteMint:4,
   userBase:5,userQuote:6,poolBase:7,poolQuote:8,min:23},
  '33e685a4017f83ad':{name:'sell',side:'SELL',pool:0,baseMint:3,quoteMint:4,
   userBase:5,userQuote:6,poolBase:7,poolQuote:8,min:21},
  'c62e1552b4d9e870':{name:'buy_exact_quote_in',side:'BUY',pool:0,baseMint:3,quoteMint:4,
   userBase:5,userQuote:6,poolBase:7,poolQuote:8,min:23}
 }
};
const pubkey=x=>typeof x==='string'?x:typeof x?.pubkey==='string'?x.pubkey:null;
const rawAmount=x=>typeof x==='string'&&/^\d+$/.test(x)&&BigInt(x)>0n;
function identify(ix){
 const variants=LAYOUTS[ix?.programId];
 if(!variants||typeof ix.data!=='string'||ix.data.length>4096)return null;
 const bytes=decodeBase58(ix.data);
 if(!bytes||bytes.length<8)return null;
 const layout=variants[bytes.subarray(0,8).toString('hex')];
 return layout?{layout,ix,family:ix.programId===PUMP_FUN?'pumpfun':'pumpswap'}:null;
}
function findCandidate(tx){
 const outer=tx.transaction.message.instructions,groups=tx.meta.innerInstructions,hits=[];
 for(let index=0;index<outer.length;index++){
  const m=identify(outer[index]);
  if(m)hits.push({...m,outerIndex:index,scope:'outer',innerIndex:-1});
 }
 for(const g of groups){
  if(!Array.isArray(g?.instructions))continue;
  g.instructions.forEach((ix,index)=>{
   const m=identify(ix);
   if(m)hits.push({...m,outerIndex:g.index,scope:'inner',innerIndex:index});
  });
 }
 return hits.length===1?hits[0]:null;
}
function strictTransfer(ix){
 if(!TOKEN_PROGRAMS.has(ix?.programId))return null;
 const type=ix.parsed?.type;
 const info=ix.parsed?.info;
 if(!info||typeof info!=='object')return {status:'unparsed'};
 const source=info.source,destination=info.destination;
 if(typeof source!=='string'||typeof destination!=='string')
  return {status:'unparsed'};
 if(type!=='transferChecked')return {status:'unverified',source,destination};
 const amount=info.tokenAmount?.amount??info.amount;
 if(!rawAmount(amount)||typeof info.mint!=='string')
  return {status:'unverified',source,destination};
 return {status:'checked',source,destination,mint:info.mint};
}
function expectedLegs(accounts,layout,family){
 const expected=[];
 const baseSource=layout.side==='BUY'?accounts[layout.poolBase]:accounts[layout.userBase];
 const baseDestination=layout.side==='BUY'?accounts[layout.userBase]:accounts[layout.poolBase];
 expected.push({kind:'base',source:baseSource,destination:baseDestination,
  mint:accounts[layout.baseMint],
  endpoints:[accounts[layout.userBase],accounts[layout.poolBase]]});
 if(family==='pumpswap'){
  expected.push({kind:'quote',
   source:layout.side==='BUY'?accounts[layout.userQuote]:accounts[layout.poolQuote],
   destination:layout.side==='BUY'?accounts[layout.poolQuote]:accounts[layout.userQuote],
   mint:accounts[layout.quoteMint],
   endpoints:[accounts[layout.userQuote],accounts[layout.poolQuote]]});
 }
 return expected;
}
function balanceMintEvidence(tx,accounts,expected){
 const keys=tx.transaction?.message?.accountKeys;
 if(!Array.isArray(keys))return 'unavailable';
 const balances=[...(Array.isArray(tx.meta.preTokenBalances)?tx.meta.preTokenBalances:[]),
  ...(Array.isArray(tx.meta.postTokenBalances)?tx.meta.postTokenBalances:[])];
 let observed=0;
 for(const leg of expected){
  for(const pub of leg.endpoints){
   const index=keys.findIndex(x=>pubkey(x)===pub);
   if(index<0)return 'unavailable';
   const entries=balances.filter(x=>x?.accountIndex===index);
   if(entries.length===0)return 'unavailable';
   if(entries.some(x=>x.mint!==leg.mint))return 'conflicting';
   observed++;
  }
 }
 return observed===expected.length*2?'consistent':'unavailable';
}
function subtreeInstructions(tx,c){
 const groups=tx.meta.innerInstructions;
 const group=groups.find(g=>g?.index===c.outerIndex);
 const inner=group.instructions;
 if(c.scope==='outer')return inner;
 const height=c.ix.stackHeight;
 const matches=[];
 for(let i=c.innerIndex+1;i<inner.length;i++){
  if(inner[i].stackHeight<=height)break;
  matches.push(inner[i]);
 }
 return matches;
}
const defaultResult=()=>({
 status:'missing_metadata',candidateProgram:'none',candidateInstruction:'none',scope:'none',
 baseLegs:0,quoteLegs:0,unverifiedExpectedEdges:0,
 wrongMintExpectedEdges:0,otherSubtreeTransfers:0,unparsedTokenInstructions:0,
 balanceMintConsistency:'unavailable',quoteType:'unknown',
 matchedTransferLegs:0,verifiedFills:0,verifiedDirection:false,
 verifiedPrice:false,economicsAuthorized:false,liveTrading:false
});
export function inspectV25(poolAddress,signature,tx){
 const base=defaultResult();
 const gate=inspectV24(poolAddress,signature,tx);
 if(gate.status!=='subtree_transfers_present_unattributed')
  return {...base,status:'v24_'+gate.status};
 const c=findCandidate(tx);
 if(!c)return {...base,status:'candidate_not_unique'};
 const a=Array.isArray(c.ix.accounts)?c.ix.accounts.map(pubkey):null;
 const info={...base,candidateProgram:c.family,candidateInstruction:c.layout.name,
  scope:c.scope,quoteType:c.family==='pumpfun'?'native_sol_not_reconciled':'spl_quote'};
 if(!a||a.length<c.layout.min||a.some(x=>!x))
  return {...info,status:'candidate_accounts_unusable'};
 if(a[c.layout.pool]!==poolAddress)return {...info,status:'watched_pool_mismatch'};
 // Reject reused account for both base/quote, or user/pool account identical.
 const expected=expectedLegs(a,c.layout,c.family);
 if(expected.some(x=>x.endpoints[0]===x.endpoints[1])||
   (expected.length===2&&(expected[0].mint===expected[1].mint||
    expected[0].endpoints.some(x=>expected[1].endpoints.includes(x)))))
  return {...info,status:'expected_account_roles_conflict'};
 const balances=balanceMintEvidence(tx,a,expected);
 const descendants=subtreeInstructions(tx,c);
 const counts={base:0,quote:0},unknownExpected=new Set(),
  wrongMintExpected=new Set();
 let other=0,unparsed=0;
 for(const ix of descendants){
  const t=strictTransfer(ix);
  if(!t)continue;
  if(t.status==='unparsed'){unparsed++;continue;}
  const sameDirection=expected.find(x=>x.source===t.source&&x.destination===t.destination);
  const reversed=expected.find(x=>x.destination===t.source&&x.source===t.destination);
  if(!sameDirection){
   if(reversed)wrongMintExpected.add(reversed.kind); // includes wrong direction
   else other++;
   continue;
  }
  if(t.status!=='checked'){unknownExpected.add(sameDirection.kind);continue;}
  if(t.mint!==sameDirection.mint){wrongMintExpected.add(sameDirection.kind);continue;}
  counts[sameDirection.kind]++;
 }
 const result={...info,baseLegs:counts.base,quoteLegs:counts.quote,
  matchedTransferLegs:counts.base+counts.quote,
  unverifiedExpectedEdges:unknownExpected.size,
  wrongMintExpectedEdges:wrongMintExpected.size,
  otherSubtreeTransfers:other,unparsedTokenInstructions:unparsed,
  balanceMintConsistency:balances};
 if(wrongMintExpected.size)return {...result,status:'contradictory_expected_edges'};
 if(counts.base>1||counts.quote>1)return {...result,status:'multiple_expected_edges_ambiguous'};
 if(unknownExpected.size||unparsed)return {...result,status:'unverified_or_unparsed_transfer_edges'};
 if(balances==='conflicting')return {...result,status:'token_balance_mint_conflict'};
 if(!counts.base)return {...result,status:'no_checked_base_edge'};
 if(c.family==='pumpswap'&&!counts.quote)return {...result,status:'quote_edge_missing'};
 return {...result,status:balances==='consistent'?
  'expected_edges_with_balance_mint_hints':'expected_edges_without_balance_mint_hints'};
}
const hash=x=>createHash('sha256').update(String(x||'')).digest('hex').slice(0,16);
const inc=(o,k)=>{o[k]=(o[k]||0)+1;};
const top=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,50).map(([key,eventRows])=>({key,eventRows}));
export function createV25Summary(){
 const byStatus={},byVenue={},byProgram={},balance={},other={},examples={};
 let count=0,checkedBase=0,checkedQuote=0,unverified=0;
 return {add(row){
  const r=inspectV25(row.pool_address,row.signature,row.payload);
  count++;checkedBase+=r.baseLegs;checkedQuote+=r.quoteLegs;
  unverified+=r.unverifiedExpectedEdges;
  const venue=String(row.venue_family||'unknown').slice(0,40),key=venue+':'+r.status;
  inc(byStatus,r.status);inc(byVenue,key);
  inc(byProgram,r.candidateProgram+':'+r.status);
  inc(balance,r.balanceMintConsistency);
  inc(other,r.otherSubtreeTransfers>0?'other_transfers_present':'no_other_transfers');
  if((examples[key]||[]).length<2)(examples[key]??=[]).push({
   signatureSha256Prefix:hash(row.signature),poolSha256Prefix:hash(row.pool_address),
   program:r.candidateProgram,instruction:r.candidateInstruction,
   scope:r.scope,baseLegs:r.baseLegs,quoteLegs:r.quoteLegs,
   balanceMintConsistency:r.balanceMintConsistency,
   otherSubtreeTransfers:r.otherSubtreeTransfers
  });
 },result(){return {
  kind:'s1b1_v25_token_account_edges',version:V25_VERSION,
  units:'v2_single_trade_candidate_event_rows',sampledEventRows:count,
  byStatus:top(byStatus),byVenueStatus:top(byVenue),
  byProgramStatus:top(byProgram),byBalanceMintConsistency:top(balance),
  byOtherSubtreeTransferPresence:top(other),
  checkedBaseEdgeInstructions:checkedBase,checkedQuoteEdgeInstructions:checkedQuote,
  unverifiedExpectedEdgeGroups:unverified,examples,
  interpretation:'Expected account endpoints and mint hints in checked transfer descendants do not prove executed swap amounts, fees, PDA authority, native SOL quote leg, price, or real fills. No values or executable directions are exported.',
  readOnly:true,verifiedFills:0,economicsAuthorized:false,liveTrading:false
 };}};
}
