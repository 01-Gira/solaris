import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_SWAP,PUMP_FUN} from '../src/s1b1/decoder.js';
import {inspectProvenance,createProvenanceSummary} from '../src/s1b1/v212-provenance.js';
import {runV212,v212Limit} from '../src/s1b1/v212-report.js';
const row=(over={})=>({
 pool_address:'watched-pool',signature:'private-signature',source:'live',
 status:'failed_onchain',venue_family:'pumpswap',
 tx_error:{InstructionError:[0,{Custom:6040}]},
 outer_instructions:[{programId:PUMP_SWAP,data:'',accounts:[]}],
 log_messages:[`Program ${PUMP_SWAP} failed: custom program error: 0x1798`],
 first_received_at:'2026-11-21T03:00:00Z',
 block_time:'2026-11-21T02:59:00Z',pool_created_at:'2026-11-20T12:00:00Z',
 inner_groups:[],account_keys:[],
 ...over
});
test('6040 is anchored to PumpSwap outer instruction and logs',()=>{
 const a=inspectProvenance(row());
 assert.equal(a.error6040,true);
 assert.equal(a.programEvidence,'outer_and_failed_log_pumpswap');
 assert.equal(a.outerFailureProgram,'pumpswap');
 assert.equal(a.failedLogEvidence,'pumpswap_failed_6040_log');
 assert.equal(a.verifiedFills,0);
});
test('venue named PumpSwap does not prove 6040 belongs to PumpSwap',()=>{
 const a=inspectProvenance(row({
  outer_instructions:[{programId:PUMP_FUN}],
  log_messages:[`Program ${PUMP_FUN} failed: custom program error: 0x1798`]
 }));
 assert.equal(a.programEvidence,'other_outer_program_unattributed');
 assert.equal(a.failedLogEvidence,'other_program_failed_6040_log');
});
test('nested failure logs remain explicitly distinct',()=>{
 const a=inspectProvenance(row({outer_instructions:[{programId:'router'}]}));
 assert.equal(a.programEvidence,'nested_pumpswap_failed_log');
});
test('missing logs do not assert emitting program solely from venue',()=>{
 const a=inspectProvenance(row({log_messages:null}));
 assert.equal(a.programEvidence,'outer_pumpswap_log_not_confirmed');
});
test('old tx pool created later does not prove observed pool involvement',()=>{
 const a=inspectProvenance(row({
  status:'single_trade_candidate',tx_error:null,source:'backfill',
  first_received_at:'2026-11-21T03:00:00Z',
  block_time:'2024-08-25T12:00:00Z',
  pool_created_at:'2026-11-21T00:00:00Z',
  outer_instructions:[{programId:PUMP_FUN,accounts:['other','account','mint','other-pool'],data:'11111111'}],
  account_keys:[{pubkey:'watched-pool'}]
 }));
 assert.equal(a.historical,true);
 assert.equal(a.oldPoolDateRelation,'pool_created_after_tx_blocktime');
 assert.equal(a.oldPoolReference,'watched_pool_in_message_keys_only');
});
test('valid older pool observed recently is only historical age',()=>{
 const a=inspectProvenance(row({
  status:'single_trade_candidate',tx_error:null,
  block_time:'2024-08-25T12:00:00Z',
  pool_created_at:'2024-08-01T00:00:00Z'
 }));
 assert.equal(a.oldPoolDateRelation,'pool_created_no_later_than_tx');
});
test('summary only displays anonymized fingerprints and count evidence',()=>{
 const a=createProvenanceSummary();
 a.add(row());
 a.add(row({signature:'older-private-signature',
  block_time:'2024-08-25T12:00:00Z',pool_created_at:'2026-11-21T00:00:00Z',
  source:'backfill'}));
 const v=a.result(),s=JSON.stringify(v);
 assert.equal(v.sampledEventRows,2);
 assert.equal(v.error6040EventRows,2);
 assert.equal(v.historicalAgeGt30dEventRows,1);
 assert.ok(!s.includes('"watched-pool"'));
 assert.ok(!s.includes('older-private-signature'));
 assert.equal(v.economicsAuthorized,false);
});
test('bounded DB runner only queries previously classified candidate rows',async()=>{
 const queries=[];let done=false;
 const db={query:async(q,params)=>{
  queries.push(q);if(done)return {rows:[]};done=true;
  return {rows:[{id:42,...row()}]};
 }};
 const result=await runV212(db,{limit:2});
 assert.equal(result.sampledEventRows,1);
 assert.equal(result.afterEventRowId,42);
 assert.ok(queries[0].includes('v.candidate_version=$1'));
 assert.ok(queries.every(q=>!/(INSERT|UPDATE|DELETE)\s/i.test(q)));
});
test('limits bound memory and DB work',()=>{
 assert.equal(v212Limit({}),10000);
 assert.throws(()=>v212Limit({S1B1_V212_LIMIT:0}),/invalid_v212_limit/);
 assert.throws(()=>v212Limit({S1B1_V212_LIMIT:100001}),/invalid_v212_limit/);
});
