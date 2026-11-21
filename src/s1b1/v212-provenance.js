// S1b.1 V2.12 — root-cause provenance, NOT swap or economic evidence.
// Confirms whether a 6040 error belongs to PumpSwap or another program.
// Separately checks why 2024 RPC transactions were associated with recently
// discovered pools. Uses existing JSON-parsed transactions, no network calls.
import {createHash} from 'node:crypto';
import {PUMP_FUN,PUMP_SWAP,decodeBase58} from './decoder.js';

export const V212_VERSION='s1b1-v212-error-provenance-0.1';
const hash=value=>createHash('sha256').update(String(value||'')).digest('hex').slice(0,16);
const inc=(map,key,n=1)=>map.set(key,(map.get(key)||0)+n);
const top=(map,limit=40)=>[...map.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,limit).map(([key,eventRows])=>({key,eventRows}));
const dateMs=value=>{
 if(value===null||value===undefined)return null;
 const d=value instanceof Date?value.getTime():new Date(value).getTime();
 return Number.isFinite(d)?d:null;
};
const day=ms=>ms===null?null:new Date(ms).toISOString().slice(0,10);
const keyOf=x=>typeof x==='string'?x:typeof x?.pubkey==='string'?x.pubkey:null;
function custom6040(error){
 const args=error?.InstructionError;
 return Array.isArray(args)&&args.length===2&&
  Number.isSafeInteger(args[0])&&args[0]>=0&&
  args[1]&&typeof args[1]==='object'&&args[1].Custom===6040?
  args[0]:null;
}
function failedLogs6040(messages){
 if(!Array.isArray(messages))return {pumpswap:false,other:false,matched:0};
 const pattern=/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: custom program error: 0x1798$/i;
 let pumpswap=false,other=false,matched=0;
 for(const line of messages.slice(0,2000)){
  if(typeof line!=='string')continue;
  const m=line.match(pattern);
  if(!m)continue;
  matched++;
  if(m[1]===PUMP_SWAP)pumpswap=true;
  else other=true;
 }
 return {pumpswap,other,matched};
}
const decodeKnown=(ix)=>{
 const programId=ix?.programId;
 if(programId!==PUMP_FUN&&programId!==PUMP_SWAP)return null;
 if(typeof ix?.data!=='string'||ix.data.length>4096)return null;
 const bytes=decodeBase58(ix.data);
 if(!bytes||bytes.length<8)return null;
 const d=bytes.subarray(0,8).toString('hex');
 const known=programId===PUMP_FUN?
  ['66063d1201daebea','33e685a4017f83ad','38fc74089edfcd5f']:
  ['66063d1201daebea','33e685a4017f83ad','c62e1552b4d9e870'];
 return known.includes(d)?{index:programId===PUMP_FUN?3:0,
  program:programId===PUMP_FUN?'pumpfun':'pumpswap'}:null;
};
function watchedPoolEvidence(pool,row){
 const outer=Array.isArray(row.outer_instructions)?row.outer_instructions:[];
 const inner=Array.isArray(row.inner_groups)?row.inner_groups:[];
 const keys=Array.isArray(row.account_keys)?row.account_keys:[];
 let seenInAnyInstruction=false,atKnownPoolIndex=false,programFamily='none';
 const check=ix=>{
  if(!Array.isArray(ix?.accounts))return;
  const accounts=ix.accounts.map(keyOf);
  if(accounts.includes(pool))seenInAnyInstruction=true;
  const known=decodeKnown(ix);
  if(known&&accounts[known.index]===pool){
   atKnownPoolIndex=true;programFamily=known.program;
  }
 };
 outer.forEach(check);
 inner.forEach(g=>{if(Array.isArray(g?.instructions))g.instructions.forEach(check);});
 return {inTransactionAccountKeys:keys.some(k=>keyOf(k)===pool),
  inAnyParsedInstruction:seenInAnyInstruction,
  atKnownTradePoolIndex:atKnownPoolIndex,
  knownProgramFamily:programFamily};
}
export function inspectProvenance(row){
 const result={error6040:false,programEvidence:'not_6040',
  outerFailureProgram:'not_evaluated',failedLogEvidence:'not_evaluated',
  historical:false,historicalAgeDays:null,observedPoolVenue:'unknown',
  oldPoolDateRelation:'not_historical',oldPoolReference:'not_historical',
  knownPoolInstructionFamily:'none',
  verifiedFills:0,economicsAuthorized:false,liveTrading:false};
 const status=String(row.status||'unknown'),venue=String(row.venue_family||'unknown').slice(0,40);
 result.observedPoolVenue=venue;
 const index=custom6040(row.tx_error);
 if(status==='failed_onchain'&&index!==null){
  const outer=Array.isArray(row.outer_instructions)?row.outer_instructions:[];
  const atIndex=index<outer.length?outer[index]:null;
  const outerProgram=keyOf(atIndex?.programId);
  const evidence=failedLogs6040(row.log_messages);
  result.error6040=true;
  result.outerFailureProgram=outerProgram===PUMP_SWAP?'pumpswap':
   outerProgram===PUMP_FUN?'pumpfun':
   outerProgram?'other_program':'outer_program_missing';
  result.failedLogEvidence=evidence.pumpswap?
   'pumpswap_failed_6040_log':
   evidence.other?'other_program_failed_6040_log':'failed_6040_log_missing';
  result.programEvidence=outerProgram===PUMP_SWAP?
   (evidence.pumpswap?'outer_and_failed_log_pumpswap':'outer_pumpswap_log_not_confirmed'):
   evidence.pumpswap?'nested_pumpswap_failed_log':
   outerProgram?'other_outer_program_unattributed':'outer_program_missing';
 }
 const received=dateMs(row.first_received_at),block=dateMs(row.block_time);
 if(received!==null&&block!==null&&received-block>30*86_400_000){
  result.historical=true;result.historicalAgeDays=Math.floor((received-block)/86_400_000);
  const created=dateMs(row.pool_created_at);
  result.oldPoolDateRelation=created===null?'creation_time_unavailable':
   created>block+5*60_000?'pool_created_after_tx_blocktime':
   'pool_created_no_later_than_tx';
  const match=watchedPoolEvidence(String(row.pool_address||''),row);
  result.oldPoolReference=match.atKnownTradePoolIndex?
   'watched_pool_at_supported_trade_instruction_index':
   match.inAnyParsedInstruction?'watched_pool_in_other_instruction_account':
   match.inTransactionAccountKeys?'watched_pool_in_message_keys_only':
   'watched_pool_not_found_in_parsed_accounts';
  result.knownPoolInstructionFamily=match.knownProgramFamily;
 }
 return result;
}
export function createProvenanceSummary(){
 const program=new Map(),byVenueProgram=new Map(),log=new Map(),outer=new Map(),
  oldRelation=new Map(),oldReference=new Map(),oldSource=new Map(),
  historicalPools=new Map(),codePools=new Map(),oldByStatus=new Map();
 let scanned=0,c6040=0,old=0;const samples=[];
 return {add(row){
  if(typeof row?.pool_address!=='string'||!row.pool_address||
     typeof row.signature!=='string'||!row.signature)
   throw Error('invalid_v212_row');
  const r=inspectProvenance(row),venue=String(row.venue_family||'unknown').slice(0,40);
  scanned++;
  if(r.error6040){
   c6040++;inc(program,r.programEvidence);
   inc(byVenueProgram,venue+':'+r.programEvidence);
   inc(log,r.failedLogEvidence);
   inc(outer,r.outerFailureProgram);
   inc(codePools,row.pool_address);
  }
  if(r.historical){
   old++;inc(oldRelation,r.oldPoolDateRelation);
   inc(oldReference,r.oldPoolReference);
   inc(oldSource,String(row.source||'unknown')+':'+venue);
   inc(oldByStatus,String(row.status||'unknown'));
   inc(historicalPools,row.pool_address);
   if(samples.length<6)samples.push({
    poolSha256Prefix:hash(row.pool_address),
    signatureSha256Prefix:hash(row.signature),
    venue,source:String(row.source||'unknown').slice(0,20),
    status:String(row.status||'unknown').slice(0,40),
    blockDay:day(dateMs(row.block_time)),
    receivedDay:day(dateMs(row.first_received_at)),
    createdDay:day(dateMs(row.pool_created_at)),
    oldPoolDateRelation:r.oldPoolDateRelation,
    oldPoolReference:r.oldPoolReference,
    knownPoolInstructionFamily:r.knownPoolInstructionFamily
   });
  }
 },result(){
  return {kind:'s1b1_v212_error_provenance_audit',version:V212_VERSION,
   sampledEventRows:scanned,error6040EventRows:c6040,
   byError6040ProgramEvidence:top(program),
   byVenueError6040ProgramEvidence:top(byVenueProgram),
   byError6040OuterProgram:top(outer),
   byError6040FailedLogs:top(log),
   error6040UniqueWatchedPools:codePools.size,
   error6040TopPoolSha256Prefixes:[...codePools.entries()]
    .sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map(([pool,eventRows])=>({poolSha256Prefix:hash(pool),eventRows})),
   historicalAgeGt30dEventRows:old,historicalUniqueWatchedPools:historicalPools.size,
   historicalPoolCreatedVsBlockDay:top(oldRelation),
   historicalPoolReferenceEvidence:top(oldReference),
   historicalBySourceVenue:top(oldSource),
   historicalByStatus:top(oldByStatus),historicalExamples:samples,
   interpretation:'PumpSwap IDL names Custom 6040 BuySlippageBelowMinBaseAmountOut only if the failing program is PumpSwap. A watched-pool venue does not identify the failing program. Historical RPC signatures and pool-created metadata must be interpreted separately: first-seen time is discovery, not creation. Presence in account keys is not proof of a swap for that watched pool.',
   verifiedFills:0,economicsAuthorized:false,liveTrading:false,readOnly:true};
 }};
}
