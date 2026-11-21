// Read-only S1b.1 forensic aggregation. This does not infer swap direction,
// fills, price or transaction-level economics from raw instruction presence.
import {createHash} from 'node:crypto';
import {decodeBase58,PUMP_FUN,PUMP_SWAP} from './decoder.js';

export const KNOWN_DEX_PROGRAMS=new Set([PUMP_FUN,PUMP_SWAP]);
const hash=text=>createHash('sha256').update(String(text||'')).digest('hex').slice(0,16);
const increment=(o,key,n=1)=>{o[key]=(o[key]||0)+n;};
function boundedInstructions(tx){
 if(!tx||typeof tx!=='object')return [];
 const outer=Array.isArray(tx.transaction?.message?.instructions)?
  tx.transaction.message.instructions:[];
 const inner=Array.isArray(tx.meta?.innerInstructions)?tx.meta.innerInstructions:[];
 const all=outer.map(ix=>({ix,scope:'outer'}));
 for(const group of inner){
  if(Array.isArray(group?.instructions)){
   for(const ix of group.instructions)all.push({ix,scope:'inner'});
  }
 }
 return all.slice(0,500).map(({ix,scope})=>{
  const programId=typeof ix?.programId==='string'&&ix.programId.length<=100?
   ix.programId:null;
  const known=KNOWN_DEX_PROGRAMS.has(programId);
  const raw=known&&typeof ix?.data==='string'&&ix.data.length<=256?decodeBase58(ix.data):null;
  return {programId,known,scope,discriminator:raw&&raw.length>=8?
   raw.subarray(0,8).toString('hex'):null};
 });
}
export function inspectTransaction(tx){
 const instructions=boundedInstructions(tx);
 const known=instructions.filter(x=>x.known);
 return {
  instructionCount:instructions.length,
  hasTransactionMeta:tx?.meta!==undefined&&tx?.meta!==null,
  onchainFailed:tx?.meta?.err!==undefined&&tx?.meta?.err!==null,
  outerCount:instructions.filter(x=>x.scope==='outer').length,
  innerCount:instructions.filter(x=>x.scope==='inner').length,
  recognizedProgramInstructions:known.length,
  knownOuter:known.filter(x=>x.scope==='outer').length,
  knownInner:known.filter(x=>x.scope==='inner').length,
  programIds:[...new Set(instructions.map(x=>x.programId).filter(Boolean))],
  knownDiscriminators:[...new Set(known.map(x=>
   x.programId+':'+(x.discriminator||'missing_or_invalid')).filter(Boolean))]
 };
}
export function createForensicReport(){
 const statusReason={},programPresence={},knownMultiplicity={},venueStatus={},
  knownDiscriminators={},instructionCounts={},examples={};
 let scanned=0,missingPayload=0,failedMetadataMismatch=0;
 const signatures=new Set();
 function add(row){
  scanned++;
  const status=String(row.status||'unknown').slice(0,40);
  const reason=String(row.reason||'unspecified').slice(0,80);
  const key=status+':'+reason;
  increment(statusReason,key);
  const venue=String(row.venue_family||'unknown').slice(0,40);
  increment(venueStatus,venue+':'+status);
  const tx=inspectTransaction(row.payload);
  if(!tx.hasTransactionMeta)missingPayload++;
  if(status==='failed_onchain'&&!tx.onchainFailed)failedMetadataMismatch++;
  increment(knownMultiplicity,status+':'+tx.recognizedProgramInstructions);
  increment(instructionCounts,status+':'+(tx.instructionCount===0?'0':tx.instructionCount===1?'1':'2+'));
  for(const program of tx.programIds)increment(programPresence,status+':'+program);
  for(const disc of tx.knownDiscriminators)increment(knownDiscriminators,status+':'+disc);
  signatures.add(row.signature);
  if((examples[status]||[]).length<3){
   (examples[status]??=[]).push({
    signatureSha256Prefix:hash(row.signature),poolSha256Prefix:hash(row.pool_address),
    venue,programIds:tx.programIds.slice(0,12),
    instructionCount:tx.instructionCount,
    outerCount:tx.outerCount,innerCount:tx.innerCount,
    recognizedProgramInstructions:tx.recognizedProgramInstructions
   });
  }
 }
 const top=(counts,max=40)=>Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
  .slice(0,max).map(([key,events])=>({key,eventRows:events}));
 return {add,result:()=>({
  kind:'s1b1_forensic_report',version:'s1b1-forensic-v1',
  units:'decoded_event_rows_sampled_not_all_chain_transactions',
  sampledEventRows:scanned,uniqueSignatures:signatures.size,
  missingTransactionMetadataRows:missingPayload,
  failedLabelWithoutMetaErrorRows:failedMetadataMismatch,
  byStatusReason:top(statusReason),byVenueStatus:top(venueStatus),
  byProgramPresence:top(programPresence,60),
  byKnownProgramInstructionCount:top(knownMultiplicity),
  byInstructionCount:top(instructionCounts),
  knownProgramDiscriminatorPresence:top(knownDiscriminators),
  examplesByStatus:examples,
  interpretation:'Program presence and decode labels do not establish a valid swap, direction, executed quantity, fill or profitability. Sample is ordered by event row ID and is not an unbiased venue-wide sample.',
  readOnly:true,economicsAuthorized:false,liveTrading:false
 })};
}
