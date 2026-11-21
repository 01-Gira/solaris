import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createQualitySummary,errorFamily} from '../src/s1b1/v211-quality.js';
import {runQualityReport,qualityLimit} from '../src/s1b1/v211-report.js';

const row=(i,pool,signature,status,overrides={})=>({
 id:i,pool_address:pool,signature,status,venue_family:'pumpswap',
 source:'live',
 first_received_at:'2026-11-21T03:00:00Z',
 block_time:'2026-11-21T02:59:00Z',
 pool_first_seen_at:'2026-11-21T02:58:00Z',
 pool_created_at:'2026-11-20T00:00:00Z',
 event_slot:345,tx_slot:345,
 payload_slot:'345',payload_block_time:String(Date.parse('2026-11-21T02:59:00Z')/1000),
 payload_signatures:[signature],payload_meta_error:null,tx_error:null,
 ...overrides
});
test('same pool failures are not independent strategy losses',()=>{
 const a=createQualitySummary();
 for(let i=0;i<5;i++){
  const err={InstructionError:[0,{Custom:6001}]};
  a.add(row(i+1,'failing-pool','sig-'+i,'failed_onchain',{
   payload_meta_error:err,tx_error:err
  }));
 }
 a.add(row(6,'trading-pool','sig-good','single_trade_candidate',{
  venue_family:'pumpfun'
 }));
 const r=a.result();
 assert.equal(r.sampledEventRows,6);
 assert.equal(r.failedOnchainRows,5);
 assert.equal(r.candidateRows,1);
 assert.equal(r.failedPoolConcentration.uniquePools,1);
 assert.equal(r.failedPoolConcentration.topPoolFraction,1);
 assert.equal(r.failedByErrorFamily[0].key,'InstructionError:Custom:6001');
 assert.equal(r.integrityFlags.length,0);
 assert.equal(r.verifiedFills,0);
 assert.equal(r.economicsAuthorized,false);
});
test('historical blocks are flagged as age not automatically declared invalid',()=>{
 const a=createQualitySummary();
 a.add(row(1,'historical-pool','historical-sig','single_trade_candidate',{
  block_time:'2024-08-25T12:00:00Z',payload_block_time:String(Date.parse('2024-08-25T12:00:00Z')/1000),
  source:'backfill',pool_first_seen_at:'2026-11-20T00:00:00Z',
  pool_created_at:'2024-08-01T00:00:00Z'
 }));
 const r=a.result();
 assert.equal(r.oldBackfillAgeGt30dEventRows,1);
 assert.equal(r.oldBySourceVenue[0].key,'backfill:pumpswap');
 assert.equal(r.oldExamples[0].blockDay,'2024-08-25');
 assert.equal(r.oldExamples[0].receivedDay,'2026-11-21');
 assert.equal(r.integrityFlags.length,0);
});
test('slot, signature, error and block-time integrity errors are separate flags',()=>{
 const a=createQualitySummary();
 a.add(row(1,'p','s','single_trade_candidate',{
  event_slot:500,payload_slot:'400',
  payload_signatures:['different'],payload_block_time:'0',
  tx_error:{InstructionError:[0,'Custom']},
  payload_meta_error:{InstructionError:[0,{Custom:1}]},
  pool_created_at:'2026-11-22T00:00:00Z'
 }));
 const keys=a.result().integrityFlags.map(x=>x.key);
 for(const flag of ['event_transaction_slot_mismatch',
  'payload_transaction_slot_mismatch','payload_signature_missing_or_mismatch',
  'stored_blocktime_payload_blocktime_mismatch',
  'stored_error_payload_error_mismatch','nonfailed_label_with_meta_error',
  'pool_created_at_after_tx_blocktime_gt_5min'])
  assert.ok(keys.includes(flag),flag);
});
test('error family aggregation does not leak arbitrary error strings',()=>{
 assert.equal(errorFamily({InstructionError:[0,{Custom:42}]}),'InstructionError:Custom:42');
 assert.equal(errorFamily({InstructionError:[0,'InvalidAccountData']}),
  'InstructionError:InvalidAccountData');
 assert.equal(errorFamily({Something:'private-credential'}),'Error:Something');
 assert.equal(errorFamily('private-rpc-or-wallet'), 'string_error_redacted');
});
test('report emits hashed identifiers only',()=>{
 const a=createQualitySummary();
 a.add(row(1,'secret-pool','secret-signature','failed_onchain',{
  payload_meta_error:{InstructionError:[0,{Custom:3}]},
  tx_error:{InstructionError:[0,{Custom:3}]}
 }));
 const value=JSON.stringify(a.result());
 assert.ok(!value.includes('secret-pool'));
 assert.ok(!value.includes('secret-signature'));
 assert.equal(a.result().liveTrading,false);
});
test('SQL runs through V2 event rows, bounded, without writes',async()=>{
 const queries=[];
 let n=0;
 const db={query:async(sql,params)=>{
  queries.push({sql,params});
  n++;
  return n===1?{rows:[row(5,'p','s','single_trade_candidate')]}:{rows:[]};
 }};
 const result=await runQualityReport(db,{limit:2});
 assert.equal(result.sampledEventRows,1);
 assert.equal(result.afterEventRowId,5);
 assert.equal(queries.length,2);
 assert.ok(queries[0].sql.includes('v.candidate_version=$1'));
 assert.ok(queries.every(x=>!/(INSERT|UPDATE|DELETE|TRUNCATE)\s/i.test(x.sql)));
});
test('configuration bound prevents unbounded auditing',()=>{
 assert.equal(qualityLimit({}),10000);
 assert.equal(qualityLimit({S1B1_V211_LIMIT:'100000'}),100000);
 assert.throws(()=>qualityLimit({S1B1_V211_LIMIT:'100001'}),/invalid_v211_limit/);
 assert.throws(()=>qualityLimit({S1B1_V211_LIMIT:'0'}),/invalid_v211_limit/);
});
