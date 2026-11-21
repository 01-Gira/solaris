import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {fetchHydrationMetrics} from '../s4/hydration-metrics.js';
import {V2_VERSION} from './v2.js';
import {inspectV24} from './v24-subtree.js';
import {inspectReconciliation,RECONCILIATION_VERSION} from './reconcile.js';

const MINUTE=60_000,DAY=24*60*MINUTE;
const time=value=>value==null?NaN:new Date(value).getTime();
const utcDay=value=>new Date(value).toISOString().slice(0,10);
const inc=(map,key)=>map.set(key,(map.get(key)??0)+1);
const object=map=>Object.fromEntries([...map.entries()].sort(([a],[b])=>a.localeCompare(b)));
const windowFloors=Object.freeze({eventDays:30,pools:20,strictFillSignatures:200,maximumPoolFraction:0.20});

export function classifyChronology(row){
 const block=time(row.block_time),received=time(row.first_received_at),created=time(row.pool_created_at);
 const rpcBlock=row.payload?.blockTime;
 const slotValid=Number.isSafeInteger(row.payload?.slot)&&row.payload.slot>=0&&
  String(row.payload.slot)===String(row.stored_slot)&&String(row.stored_slot)===String(row.event_slot);
 if(!slotValid)return 'slot_missing_or_conflicting';
 if(!Number.isFinite(block)||!Number.isFinite(received)||!Number.isSafeInteger(rpcBlock))return 'time_missing';
 if(block!==rpcBlock*1000)return 'stored_rpc_block_time_conflict';
 if(block>received+5*MINUTE)return 'block_after_receipt';
 if(created>block+5*MINUTE)return 'provider_created_after_chain_event';
 if(received-block>30*DAY)return 'historical_requires_provenance';
 if(!Number.isFinite(created))return 'provider_created_missing';
 return 'no_conflict_detected';
}

function metrics(){
 const poolCounts=new Map(),signatures=new Set(),byDay=new Map();
 let rows=0,missingTime=0,sharedSignatures=0;
 return {add(row){
  rows++;inc(poolCounts,row.pool_address);signatures.add(row.signature);
  if(row.shared_signature)sharedSignatures++;
  const block=time(row.block_time);
  if(Number.isFinite(block))inc(byDay,utcDay(block));else missingTime++;
 },result(){
  const counts=[...poolCounts.values()].sort((a,b)=>b-a);
  return {eventRows:rows,uniquePools:poolCounts.size,uniqueSignatures:signatures.size,
   repeatedSignatureRows:rows-signatures.size,eventRowsWithSharedSignature:sharedSignatures,
   utcEventDays:byDay.size,missingBlockTimeRows:missingTime,byUtcEventDay:object(byDay),
   topPoolEventRows:counts[0]??0,topPoolFraction:rows?counts[0]/rows:null,
   topThreePoolFraction:rows?counts.slice(0,3).reduce((a,b)=>a+b,0)/rows:null};
 }};
}

export function createQualificationSummary(){
 const examined=metrics(),reconciled=metrics(),legacySingle=metrics(),legacyHistorical=metrics();
 const byAudit=new Map(),byTxError=new Map(),byChronology=new Map(),byLegacy=new Map(),
  byV24=new Map(),byTokenBalance=new Map(),byLamportBalance=new Map(),byLocal=new Map(),
  bySource=new Map(),legacyHistoricalByOutcome=new Map(),byCurveEvent=new Map();
 let conflicts=0,networkFeeRecorded=0,rowsWithLifecycle=0,scopedAmountCandidates=0,
  rowsWithOtherTokenMovements=0,rowsWithMultipleTradeInstructions=0,provenanceExcludedReconciledRows=0;
 return {add(row){
  examined.add(row);inc(bySource,row.source==='live'||row.source==='backfill'?row.source:'unknown');
  const chronology=classifyChronology(row);
  const errorClass=['success','failed','unknown'].includes(row.error_class)?row.error_class:'unknown';
  inc(byChronology,chronology);inc(byTxError,errorClass);
  if(row.error_conflict)conflicts++;
  if(row.legacy_status)inc(byLegacy,row.legacy_status);
  if(row.legacy_status==='single_trade_candidate'){
   legacySingle.add(row);
   inc(byV24,inspectV24(row.pool_address,row.signature,row.payload).status);
  }
  if(time(row.first_received_at)-time(row.block_time)>30*DAY){
   legacyHistorical.add(row);
   inc(legacyHistoricalByOutcome,`${errorClass}:${row.legacy_status??'unclassified'}`);
  }
  const report=inspectReconciliation(row.pool_address,row.signature,row.venue_family,row.payload);
  const venue=['pumpfun','pumpswap','meteora','raydium'].includes(row.venue_family)?row.venue_family:'other';
  inc(byAudit,`${venue}:${report.status}`);
  if(report.tokenBalances)inc(byTokenBalance,`${venue}:${report.tokenBalances}`);
  if(report.lamportBalances)inc(byLamportBalance,`${venue}:${report.lamportBalances}`);
  if(report.networkFeeLamports!=null)networkFeeRecorded++;
  if(report.lifecycleRoles>0)rowsWithLifecycle++;
  if(report.otherTokenMovements>0)rowsWithOtherTokenMovements++;
  if(report.candidates.length+(report.otherRecognizedTradeInstructions??0)>1)rowsWithMultipleTradeInstructions++;
  for(const c of report.candidates){
   inc(byLocal,`${venue}:${c.quoteClass}:${c.status}`);
   if(c.curveEvent&&c.curveEvent!=='not_applicable')inc(byCurveEvent,c.curveEvent);
   if(c.status==='scoped_amounts_observed')scopedAmountCandidates++;
  }
  if(report.status==='reconciled_diagnostic'){
   if(chronology==='no_conflict_detected'&&!row.error_conflict&&errorClass==='success')reconciled.add(row);
   else provenanceExcludedReconciledRows++;
  }
 },result(){
  return {examined:examined.result(),reconciledWithLocalProvenance:reconciled.result(),
   previousV2SingleCandidates:legacySingle.result(),historicalOlderThan30Days:legacyHistorical.result(),
   byRpcOutcome:object(byTxError),transactionErrorStorageConflicts:conflicts,
   bySource:object(bySource),byChronology:object(byChronology),previousV2ByStatus:object(byLegacy),
   historicalByOutcomeAndPreviousV2Status:object(legacyHistoricalByOutcome),previousV2SingleTraceV24:object(byV24),
   byReconciliation:object(byAudit),byTokenBalance:object(byTokenBalance),byLamportBalance:object(byLamportBalance),
   byInstructionLocalEvidence:object(byLocal),byNativeCurveEventClaim:object(byCurveEvent),
   scopedAmountCandidates,networkFeeRecorded,rowsWithLifecycle,
   rowsWithOtherTokenMovements,rowsWithMultipleTradeInstructions,provenanceExcludedReconciledRows};
 }};
}

export function reportLimit(value=100000){
 const limit=Number(value);
 if(!Number.isSafeInteger(limit)||limit<1||limit>100000)throw Error('invalid_qualification_limit');
 return limit;
}

export async function runQualification(db,{limit=100000}={}){
 limit=reportLimit(limit);
 await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='60s'");
  const hydration=await fetchHydrationMetrics(db);
  if(!hydration)throw Error('qualification_hydration_missing');
  const {rows:[schema]}=await db.query(`SELECT now() AS snapshot_at,
    (SELECT count(*) FROM onchain_trade_candidate_v2 WHERE candidate_version=$1) AS v2_rows,
    (SELECT count(*) FROM onchain_trade_candidate_v2 WHERE verified_fill OR economics_authorized) AS candidate_gate_violations,
    (SELECT count(*) FROM s3_research_runs WHERE economics_authorized) AS s3_gate_violations,
    (SELECT status FROM s3_research_runs ORDER BY id DESC LIMIT 1) AS current_s3_status,
    (SELECT count(*) FROM onchain_recovery_audits WHERE status='error') AS recovery_error_runs,
    (SELECT count(*) FROM onchain_recovery_audits WHERE status IN ('bounded','seeded_limited')) AS bounded_recovery_runs,
    (SELECT count(*) FROM onchain_pool_events WHERE tx_status='resolved' AND NOT EXISTS
      (SELECT 1 FROM onchain_transactions t WHERE t.signature=onchain_pool_events.signature)) AS resolved_without_payload`,[V2_VERSION]);
  const summary=createQualificationSummary();
  const {rows:shared}=await db.query(`SELECT signature FROM onchain_pool_events
    GROUP BY signature HAVING count(*)>1`);
  const sharedSignatures=new Set(shared.map(row=>row.signature));
  let after='0',scanned=0;
  while(scanned<limit){
   const {rows}=await db.query(`SELECT e.id,e.pool_address,e.signature,e.slot AS event_slot,e.first_received_at,e.source,
       t.slot AS stored_slot,t.block_time,t.payload,p.pool_created_at,p.venue_family,v.status AS legacy_status,
       CASE WHEN t.tx_error IS NULL THEN 'unknown' WHEN t.tx_error='null'::jsonb THEN 'success' ELSE 'failed' END AS error_class,
       (t.payload #> '{meta,err}') IS DISTINCT FROM t.tx_error AS error_conflict
     FROM onchain_pool_events e JOIN onchain_transactions t ON t.signature=e.signature
     JOIN pools p ON p.pool_address=e.pool_address
     LEFT JOIN onchain_trade_candidate_v2 v ON v.pool_address=e.pool_address AND v.signature=e.signature AND v.candidate_version=$1
     WHERE e.id>$2 ORDER BY e.id LIMIT $3`,[V2_VERSION,after,Math.min(100,limit-scanned)]);
   if(!rows.length)break;
   for(const row of rows)summary.add({...row,shared_signature:sharedSignatures.has(row.signature)});
   after=rows.at(-1).id;scanned+=rows.length;
  }
  const result=summary.result(),gateViolations=Number(schema.candidate_gate_violations)+Number(schema.s3_gate_violations);
  const completeReplay=scanned===hydration.hydrated_event_rows;
  await db.query('COMMIT');
  return {kind:'solaris_research_qualification',version:RECONCILIATION_VERSION,snapshotAt:schema.snapshot_at,
   readOnly:true,limit,lastScannedEventId:after,completeReplay,hydration,
   storedV2EventRows:Number(schema.v2_rows),currentS3Status:schema.current_s3_status,
   recovery:{boundedRuns:Number(schema.bounded_recovery_runs),errorRuns:Number(schema.recovery_error_runs),
    inconsistentResolvedRows:Number(schema.resolved_without_payload)},
   ...result,independentHoldout:{eligibleRows:0,minimumPerWindow:windowFloors,manifestAvailable:false},
   gates:{
    replay:completeReplay?'PASS':'BLOCKED',
    storedEconomicsGuard:gateViolations===0?'PASS':'FAIL',
    independentChainProvenance:'BLOCKED',sourceCoverage:'BLOCKED',strictFills:'BLOCKED',
    independentHoldout:'BLOCKED',decisionTimeInputs:'BLOCKED'
   },verifiedFills:0,economicsAuthorized:false,liveTrading:false,
   verdict:gateViolations===0?'BLOCKED_EXTERNAL_EVIDENCE':'FAIL_TECHNICAL'};
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
}

async function main(){
 if(!process.env.DATABASE_URL)throw Error('missing_database_url');
 const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
 await db.connect();
 try{console.log(JSON.stringify(await runQualification(db,{limit:reportLimit(process.env.SOLARIS_QUALIFICATION_LIMIT)})));}
 finally{await db.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(e=>{
  console.error(JSON.stringify({kind:'solaris_qualification_error',
   code:['invalid_qualification_limit','missing_database_url'].includes(e.message)?e.message:e.code??'QUALIFICATION_ERROR'}));
  process.exitCode=1;
 });
