// S1b.1 V2.11 — read-only candidate independence and chain-metadata integrity audit.
// Status/error counts are diagnostic; no fill, economics, or trading authorization.
import {createHash} from 'node:crypto';
export const QUALITY_VERSION='s1b1-v211-cohort-quality-0.1';
const hash=x=>createHash('sha256').update(String(x||'')).digest('hex').slice(0,16);
const add=(map,key,n=1)=>map.set(key,(map.get(key)||0)+n);
const rank=(map,n=40)=>[...map.entries()]
 .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,n).map(([key,eventRows])=>({key,eventRows}));
const asTime=v=>{
 if(v===null||v===undefined)return null;
 const x=v instanceof Date?v.getTime():new Date(v).getTime();
 return Number.isFinite(x)?x:null;
};
const safeKey=x=>{
 const s=String(x??'unknown');
 return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s)?s:'other';
};
export function errorFamily(error){
 if(error===null||error===undefined)return 'none';
 if(typeof error==='string')return 'string_error_redacted';
 if(typeof error==='object'&&!Array.isArray(error)){
  if(Array.isArray(error.InstructionError)){
   const [,detail]=error.InstructionError;
   if(typeof detail==='string')return 'InstructionError:'+safeKey(detail);
   if(detail&&typeof detail==='object'&&!Array.isArray(detail)){
    const keys=Object.keys(detail);
    if(keys.length===1){
     const k=safeKey(keys[0]),v=detail[keys[0]];
     if(k==='Custom'&&Number.isSafeInteger(v)&&v>=0&&v<=4294967295)
      return 'InstructionError:Custom:'+v;
     return 'InstructionError:'+k;
    }
   }
   return 'InstructionError:other';
  }
  const keys=Object.keys(error);
  return keys.length===1?'Error:'+safeKey(keys[0]):'Error:other';
 }
 return 'unrecognized_error_shape';
}
function concentration(counts){
 const values=[...counts.values()].sort((a,b)=>b-a);
 const total=values.reduce((a,b)=>a+b,0);
 const squares=values.reduce((a,b)=>a+b*b,0);
 return {eventRows:total,uniquePools:values.length,
  topPoolFraction:total?values[0]/total:null,
  top3PoolFraction:total?values.slice(0,3).reduce((a,b)=>a+b,0)/total:null,
  effectivePoolsByEventConcentration:squares?Number((total*total/squares).toFixed(3)):0};
}
const day=v=>{const t=asTime(v);return t===null?null:new Date(t).toISOString().slice(0,10);};
export function createQualitySummary(){
 const statuses=new Map(),byVenue=new Map(),candidateByDay=new Map(),
  failuresByError=new Map(),failureByVenueError=new Map(),olderBySource=new Map(),
  flags=new Map(),candidatePools=new Map(),failurePools=new Map(),
  allPools=new Map(),failPoolReasons=new Map(),examples=[];
 let rows=0,candidates=0,failures=0,olderEvents=0;
 const oldExamples=[];
 return {add(row){
  const signature=String(row.signature||''),pool=String(row.pool_address||'');
  if(!signature||!pool)throw Error('invalid_quality_row');
  const status=String(row.status||'unknown'),venue=String(row.venue_family||'unknown').slice(0,40);
  const source=String(row.source||'unknown').slice(0,25);
  rows++;add(statuses,status);add(byVenue,venue+':'+status);add(allPools,pool);
  const received=asTime(row.first_received_at),block=asTime(row.block_time);
  const firstSeen=asTime(row.pool_first_seen_at),created=asTime(row.pool_created_at);
  const txSlot=Number(row.tx_slot),eventSlot=Number(row.event_slot);
  const payloadSlot=row.payload_slot===null?null:Number(row.payload_slot);
  const payloadTime=row.payload_block_time===null?null:Number(row.payload_block_time);
  const payloadSigs=row.payload_signatures;
  if(!Array.isArray(payloadSigs)||!payloadSigs.includes(signature))
   add(flags,'payload_signature_missing_or_mismatch');
  if(!Number.isSafeInteger(txSlot)||!Number.isSafeInteger(eventSlot)||txSlot!==eventSlot)
   add(flags,'event_transaction_slot_mismatch');
  if(payloadSlot!==null&&(!Number.isSafeInteger(payloadSlot)||payloadSlot!==txSlot))
   add(flags,'payload_transaction_slot_mismatch');
  if(block!==null&&Number.isSafeInteger(payloadTime)&&
   Math.abs(block-payloadTime*1000)>2000)
   add(flags,'stored_blocktime_payload_blocktime_mismatch');
  if(block===null)add(flags,'blocktime_missing');
  if(received===null)add(flags,'event_received_at_missing');
  if(block!==null&&received!==null){
   if(block>received+5*60_000)add(flags,'blocktime_after_receipt_gt_5min');
   if(received-block>30*86_400_000){
    olderEvents++;add(olderBySource,source+':'+venue);
    if(oldExamples.length<6)oldExamples.push({
     signatureSha256Prefix:hash(signature),poolSha256Prefix:hash(pool),
     blockDay:day(row.block_time),receivedDay:day(row.first_received_at),
     firstSeenDay:day(row.pool_first_seen_at),createdDay:day(row.pool_created_at),
     venue,source,status
    });
   }
  }
  if(block!==null&&created!==null&&created>block+5*60_000)
   add(flags,'pool_created_at_after_tx_blocktime_gt_5min');
  if(block!==null&&firstSeen!==null&&firstSeen<block-5*60_000)
   add(flags,'pool_discovered_before_tx_blocktime_gt_5min');
  const metaErr=row.payload_meta_error??null;
  const storedErr=row.tx_error??null;
  if(JSON.stringify(metaErr)!==JSON.stringify(storedErr))
   add(flags,'stored_error_payload_error_mismatch');
  if(status==='failed_onchain'){
   failures++;add(failurePools,pool);
   const error=errorFamily(metaErr);
   add(failuresByError,error);add(failureByVenueError,venue+':'+error);
   add(failPoolReasons,pool+':'+error);
   if(metaErr===null)add(flags,'failed_label_without_meta_error');
  }else if(metaErr!==null){
   add(flags,'nonfailed_label_with_meta_error');
  }
  if(status==='single_trade_candidate'){
   candidates++;add(candidatePools,pool);add(candidateByDay,day(row.block_time)||'unknown');
  }
 },result(){
  const topFailedPools=[...failurePools.entries()]
   .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
   .slice(0,8).map(([pool,n])=>({
    poolSha256Prefix:hash(pool),eventRows:n,
    errorFamilies:rank(new Map([...failPoolReasons.entries()]
     .filter(([k])=>k.startsWith(pool+':')).map(([k,v])=>[k.slice(pool.length+1),v])),6)
   }));
  const topCandidatePools=[...candidatePools.entries()]
   .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
   .slice(0,8).map(([pool,n])=>({poolSha256Prefix:hash(pool),eventRows:n}));
  return {
   kind:'s1b1_v211_cohort_quality_audit',version:QUALITY_VERSION,
   units:'v2_classified_pool_signature_event_rows',sampledEventRows:rows,
   uniquePools:allPools.size,candidateRows:candidates,failedOnchainRows:failures,
   candidatePoolConcentration:concentration(candidatePools),
   failedPoolConcentration:concentration(failurePools),
   byStatus:rank(statuses),byVenueStatus:rank(byVenue),
   candidateByBlockDay:rank(candidateByDay,100),
   failedByErrorFamily:rank(failuresByError),
   failedByVenueErrorFamily:rank(failureByVenueError,60),
   integrityFlags:rank(flags),oldBackfillAgeGt30dEventRows:olderEvents,
   oldBySourceVenue:rank(olderBySource),
   topFailedPools,topCandidatePools,oldExamples,
   interpretation:'Classifications are grouped observations, not independent executed swaps. Failed_onchain means Solana transaction failure, not strategy loss. Historical block times and pool metadata differences are integrity flags/hints requiring signature-level verification, not automatically errors.',
   evidenceDiversityAuthorized:false,verifiedFills:0,
   economicsAuthorized:false,liveTrading:false,readOnly:true
  };
 }};
}
