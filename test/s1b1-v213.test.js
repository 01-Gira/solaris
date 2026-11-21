import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectProviderCohort,createProviderCohortSummary} from '../src/s1b1/v213-provider.js';
import {runV213,v213Limit} from '../src/s1b1/v213-report.js';

const item=(x={})=>({
 pool_address:'sensitive-pool-address',
 historical_event_rows:'29',failed_onchain_rows:'23',
 successful_tx_event_rows:'6',unknown_tx_error_event_rows:'0',earliest_historical_block:'2024-08-25T03:00:00Z',
 latest_historical_block:'2024-08-26T01:00:00Z',
 pool_first_seen_at:'2026-11-21T00:00:00Z',
 current_provider_created:'2026-11-21T00:00:00Z',
 earliest_provider_created:'2026-11-21T00:00:00Z',
 latest_provider_created:'2026-11-21T00:00:00Z',
 snapshot_count:'2',comparable_creation_snapshot_count:'2',distinct_creation_values:'1',...x
});
test('provider creation is not authoritative on-chain creation',()=>{
 const x=inspectProviderCohort(item());
 assert.equal(x.historicalEventRows,29);
 assert.equal(x.chronology,'current_provider_created_after_oldest_historical_block');
 assert.equal(x.earliestComparison,'earliest_snapshot_creation_after_oldest_historical_block');
 assert.equal(x.sourceVariation,'provider_created_value_stable_in_multiple_snapshots');
 assert.equal(x.adjudication,'provider_chain_creation_conflict_requires_external_proof');
 assert.equal(x.immutableChainProvenanceVerified,false);
 assert.equal(x.verifiedFills,0);
});
test('changing provider creation values is explicitly classified',()=>{
 const x=inspectProviderCohort(item({
  distinct_creation_values:'2',
  earliest_provider_created:'2024-08-25T01:00:00Z',
  latest_provider_created:'2026-11-21T00:00:00Z'
 }));
 assert.equal(x.sourceVariation,'provider_created_value_changed_across_snapshots');
 assert.equal(x.earliestComparison,'earliest_snapshot_creation_not_after_oldest_historical_block');
});
test('missing provider metadata does not infer date validity',()=>{
 const x=inspectProviderCohort(item({
  current_provider_created:null,
  earliest_provider_created:null,latest_provider_created:null,
  distinct_creation_values:'0',comparable_creation_snapshot_count:'0'
 }));
 assert.equal(x.adjudication,'provider_creation_metadata_unavailable');
 assert.equal(x.sourceVariation,'insufficient_comparable_provider_snapshots');
});
test('single provider snapshot cannot establish historical stability',()=>{
 const r=inspectProviderCohort(item({snapshot_count:'1',
  comparable_creation_snapshot_count:'1'}));
 assert.equal(r.sourceVariation,'insufficient_comparable_provider_snapshots');
 assert.equal(r.providerSnapshotCount,1);
});
test('event partition cannot silently mislabel successful JSON null as failure',()=>{
 assert.throws(()=>inspectProviderCohort(item({failed_onchain_rows:'29',successful_tx_event_rows:'6'})),
  /invalid_v213_status_partition/);
});
test('privacy-safe summary preserves historical count',()=>{
 const sum=createProviderCohortSummary();
 sum.add(item());
 const r=sum.result(),serialized=JSON.stringify(r);
 assert.equal(r.historicalPoolCount,1);
 assert.equal(r.historicalEventRows,29);
 assert.equal(r.failedOnchainEventRows,23);
 assert.equal(r.successfulTransactionEventRows,6);
 assert.equal(r.unknownTransactionErrorEventRows,0);
 assert.equal(r.verifiedFills,0);
 assert.equal(r.economicsAuthorized,false);
 assert.ok(!serialized.includes('sensitive-pool-address'));
 assert.equal(r.pools[0].successfulTransactionEventRows,6);
});
test('rejects invalid counts and malformed pool',()=>{
 assert.throws(()=>inspectProviderCohort(item({
  historical_event_rows:'-4'})),/invalid_v213_counts/);
 assert.throws(()=>inspectProviderCohort(item({
  pool_address:''})),/invalid_v213_row/);
});
test('runV213 reads bounded immutable snapshot evidence without writes',async()=>{
 let calls=0;const queries=[];
 const db={query:async(sql,params)=>{
  queries.push({sql,params});calls++;
  if(calls===1)return {rows:[item({pool_address:'pool-a'})]};
  return {rows:[]};
 }};
 const r=await runV213(db,{limit:2});
 assert.equal(r.historicalPoolCount,1);
 assert.equal(r.historicalEventRows,29);
 assert.equal(queries.length,2);
 assert.ok(queries[0].sql.includes('pool_snapshots'));
 assert.ok(queries[0].sql.includes("t.tx_error <> 'null'::jsonb"));
 assert.ok(queries[0].sql.includes("t.tx_error = 'null'::jsonb"));
 assert.ok(queries[0].sql.includes("interval '30 days'"));
 assert.ok(queries.every(x=>!/(UPDATE|INSERT|DELETE|TRUNCATE)\s/i.test(x.sql)));
});
test('bound queries to 10,000 historical pools',()=>{
 assert.equal(v213Limit({}),1000);
 assert.throws(()=>v213Limit({S1B1_V213_LIMIT:0}),/invalid_v213_limit/);
 assert.throws(()=>v213Limit({S1B1_V213_LIMIT:10001}),/invalid_v213_limit/);
});
