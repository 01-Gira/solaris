import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCohortSummary} from '../src/s1b1/v210-cohort.js';
import {runCohortReport,cohortLimit} from '../src/s1b1/v210-report.js';

function sample(){
 return createCohortSummary({
  total_event_rows:'10',hydrated_event_rows:'8',v2_classified_event_rows:'5'});
}
const row=(id,pool,signature,status,venue='pumpfun',block='2026-11-21T00:00:00Z')=>({
 id,pool_address:pool,signature,status,venue_family:venue,
 source:'backfill',first_received_at:'2026-11-21T02:00:00Z',
 block_time:block
});
test('cohort audit accounts for repeat observations of one pool and signature',()=>{
 const a=sample();
 a.add(row(1,'pool-one','sig-a','single_trade_candidate'));
 a.add(row(2,'pool-one','sig-b','single_trade_candidate'));
 a.add(row(3,'pool-one','sig-a','ambiguous'));
 a.add(row(4,'pool-two','sig-c','no_known_program','meteora','2026-11-20T00:00:00Z'));
 a.add(row(5,'pool-three','sig-d','failed_onchain','pumpswap'));
 const result=a.result();
 assert.equal(result.sampledClassifiedEventRows,5);
 assert.equal(result.uniquePools,3);
 assert.equal(result.uniqueSignatures,4);
 assert.equal(result.concentration.topPoolEventRows,3);
 assert.equal(result.concentration.topPoolFraction,0.6);
 assert.equal(result.concentration.top3PoolFraction,1);
 assert.equal(result.timeCoverage.distinctBlockDays,2);
 assert.equal(result.timeCoverage.earliestBlockDay,'2026-11-20');
 assert.equal(result.timeCoverage.latestBlockDay,'2026-11-21');
 assert.equal(result.sampling.sampledAllV2ClassifiedRows,true);
 assert.equal(result.sampling.unclassifiedHydratedEventRows,3);
 assert.equal(result.readiness,'EVIDENCE_DIVERSITY_NOT_ESTABLISHED');
 assert.equal(result.verifiedFills,0);
 assert.equal(result.economicsAuthorized,false);
 assert.equal(result.liveTrading,false);
 assert.ok(!JSON.stringify(result).includes('sig-a'));
 assert.ok(!JSON.stringify(result).includes('pool-one'));
});
test('time gaps and early sample coverage are explicitly reported',()=>{
 const a=createCohortSummary({
  total_event_rows:100,hydrated_event_rows:90,v2_classified_event_rows:80});
 a.add(row(1,'p1','s1','single_trade_candidate','pumpfun',null));
 const r=a.result();
 assert.equal(r.timeCoverage.missingBlockTimeEventRows,1);
 assert.equal(r.sampling.sampledAllV2ClassifiedRows,false);
 assert.equal(r.sampling.fractionOfClassifiedSampled,1/80);
 assert.equal(r.sampling.fractionOfHydratedClassified,80/90);
});
test('reject invalid counts and missing cohort identifiers',()=>{
 assert.throws(()=>createCohortSummary({
  total_event_rows:-1,hydrated_event_rows:1,v2_classified_event_rows:1}),
 /invalid_coverage_count/);
 const a=sample();
 assert.throws(()=>a.add(row(1,'','s1','unknown')),/invalid_cohort_row/);
});
test('bounded reporting only issues SELECT queries and advances by event ID',async()=>{
 const queries=[];
 const items=[
  row(5,'pool-a','sig-a','single_trade_candidate'),
  row(6,'pool-b','sig-b','no_known_program')
 ];
 const db={query:async(sql,params)=>{
  queries.push({sql,params});
  if(sql.includes('AS total_event_rows'))
   return {rows:[{total_event_rows:'20',
    hydrated_event_rows:'12',v2_classified_event_rows:'2'}]};
  return {rows:items.filter(x=>x.id>params[1]).slice(0,params[2])};
 }};
 const result=await runCohortReport(db,{limit:3});
 assert.equal(result.sampledClassifiedEventRows,2);
 assert.equal(result.uniquePools,2);
 assert.equal(result.afterEventRowId,6);
 assert.equal(queries.length,3);
 assert.ok(queries.every(q=>/SELECT/i.test(q.sql)));
 assert.ok(queries.every(q=>!/(UPDATE|DELETE|INSERT|TRUNCATE)\s/i.test(q.sql)));
 assert.ok(queries[1].sql.includes('v.candidate_version=$1'));
});
test('limit is bounded and defaults to census of current first 10000',()=>{
 assert.equal(cohortLimit({}),10000);
 assert.equal(cohortLimit({S1B1_V210_LIMIT:'100000'}),100000);
 assert.throws(()=>cohortLimit({S1B1_V210_LIMIT:'100001'}),/invalid_v210_limit/);
 assert.throws(()=>cohortLimit({S1B1_V210_LIMIT:'0'}),/invalid_v210_limit/);
});
