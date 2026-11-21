import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_FUN,PUMP_SWAP} from '../src/s1b1/decoder.js';
import {v2CandidateAnalysis,V2_VERSION} from '../src/s1b1/v2.js';
import {runV2,v2Limit} from '../src/s1b1/v2-run.js';
const encode=bytes=>{const alpha='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 let v=BigInt('0x'+Buffer.from(bytes).toString('hex')),s='';
 while(v>0n){s=alpha[Number(v%58n)]+s;v/=58n;}
 return s||'1';};
const buy=encode([102,6,61,18,1,218,235,234,0]);
const other=encode([1,2,3,4,5,6,7,8,0]);
const tx=(ix,inner=[],err=null)=>({meta:{err,innerInstructions:inner.length?[{index:0,instructions:inner}]:[]},
 transaction:{message:{instructions:ix}}});
test('one exact known buy discriminator is candidate only, not verified fill',()=>{
 const c=v2CandidateAnalysis(tx([{programId:PUMP_FUN,data:buy}]));
 assert.equal(c.version,V2_VERSION);
 assert.equal(c.status,'single_trade_candidate');
 assert.equal(c.tradeCandidateCount,1);
 assert.equal(c.hasOuterCandidate,true);
 assert.equal(c.verifiedFill,false);
 assert.equal(c.verifiedDirection,false);
 assert.equal(c.economicsAuthorized,false);
});
test('event or unknown discriminator cannot be called trade',()=>{
 const c=v2CandidateAnalysis(tx([{programId:PUMP_FUN,data:other}]));
 assert.equal(c.status,'unverified_program_usage');
 assert.equal(c.tradeCandidateCount,0);
 assert.equal(c.unknownKnownProgramInstructionCount,1);
});
test('inner and outer exact candidates are tracked, multiple are not flattened into a fill',()=>{
 const c=v2CandidateAnalysis(tx([{programId:PUMP_SWAP,data:buy}],
  [{programId:PUMP_FUN,data:buy}]));
 assert.equal(c.status,'multiple_trade_candidates');
 assert.equal(c.tradeCandidateCount,2);
 assert.equal(c.hasOuterCandidate,true);
 assert.equal(c.hasInnerCandidate,true);
 assert.equal(c.verifiedPrice,false);
});
test('unknown program is not assumed to be a swap, failed tx overrides candidates',()=>{
 assert.equal(v2CandidateAnalysis(tx([{programId:'MeteoraUnverified',data:buy}])).status,'no_known_program');
 assert.equal(v2CandidateAnalysis(tx([{programId:PUMP_FUN,data:buy}],[],{InstructionError:[0,1]})).status,'failed_onchain');
 assert.equal(v2CandidateAnalysis(null).status,'unknown');
});
test('V2 quota is bounded and independent of V1',()=>{
 assert.equal(v2Limit({}),1000);
 assert.throws(()=>v2Limit({S1B1_V2_LIMIT:'10001'}),/invalid_v2_limit/);
 assert.throws(()=>v2Limit({S1B1_V2_LIMIT:'0'}),/invalid_v2_limit/);
});
test('DB runner only inserts into V2 table without overwriting existing V1',async()=>{
 const sql=[],raw=tx([{programId:PUMP_FUN,data:buy}]);let emitted=false;
 const client={query:async(q,params)=>{
  sql.push(q);
  if(q.includes('SELECT e.pool_address')){
   if(emitted)return {rows:[]};
   emitted=true;return {rows:[{pool_address:'p',signature:'s',payload:raw}]};
  }
  return {rows:[]};
 }};
 const r=await runV2(client,{limit:2});
 assert.equal(r.processed,1);
 assert.equal(r.byStatus.single_trade_candidate,1);
 assert.equal(r.verifiedFills,0);
 assert.ok(sql.some(s=>s.includes('INSERT INTO onchain_trade_candidate_v2')));
 assert.ok(!sql.some(s=>/UPDATE\s+onchain_trade_decodes|DELETE\s+FROM\s+onchain_trade_decodes/i.test(s)));
});
