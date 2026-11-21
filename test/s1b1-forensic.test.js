import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_FUN,PUMP_SWAP} from '../src/s1b1/decoder.js';
import {inspectTransaction,createForensicReport} from '../src/s1b1/forensics.js';
import {forensicLimit,generateForensicReport} from '../src/s1b1/forensic-report.js';

const fixture={
 transaction:{message:{instructions:[
  {programId:'OtherDex111111111111111111111111111111111'},
  {programId:PUMP_SWAP,data:'AQIDBAUGBwg='}] }},
 meta:{err:null,innerInstructions:[{index:1,instructions:[
  {programId:PUMP_FUN,data:'not-a-base58'},
  {programId:PUMP_SWAP,data:'1'}]}]}
};
test('forensics inspect both outer and inner instructions without assuming swaps',()=>{
 const x=inspectTransaction(fixture);
 assert.equal(x.instructionCount,4);
 assert.equal(x.recognizedProgramInstructions,3);
 assert.equal(x.knownOuter,1);
 assert.equal(x.knownInner,2);
 assert.equal(x.onchainFailed,false);
 assert.ok(x.programIds.includes(PUMP_SWAP));
 assert.ok(x.programIds.includes('OtherDex111111111111111111111111111111111'));
});
test('forensics report status and public program presence, but no raw payload or signature',()=>{
 const acc=createForensicReport();
 acc.add({pool_address:'pool-a',signature:'private-transaction-signature',
  status:'unsupported_dex',reason:'no_supported_dex_instruction',venue_family:'raydium',
  payload:fixture});
 acc.add({pool_address:'pool-b',signature:'private-transaction-signature',
  status:'ambiguous',reason:'multiple_dex_instructions',venue_family:'pumpfun',payload:fixture});
 const r=acc.result();
 assert.equal(r.sampledEventRows,2);
 assert.equal(r.uniqueSignatures,1);
 assert.equal(r.byStatusReason[0].eventRows,1);
 assert.ok(r.byProgramPresence.some(x=>x.key==='ambiguous:'+PUMP_SWAP&&x.eventRows===1));
 assert.equal(r.economicsAuthorized,false);
 assert.ok(!JSON.stringify(r).includes('private-transaction-signature'));
 assert.ok(!JSON.stringify(r).includes('AQIDBAUGBwg='));
});
test('failed-on-chain labels are checked against independent meta.err',()=>{
 const a=createForensicReport();
 a.add({pool_address:'x',signature:'y',status:'failed_onchain',reason:'meta_err_present',
  payload:{meta:{err:null}}});
 a.add({pool_address:'x',signature:'z',status:'failed_onchain',reason:'meta_err_present',
  payload:{meta:{err:{InstructionError:[0,'Custom']}}}});
 assert.equal(a.result().failedLabelWithoutMetaErrorRows,1);
});
test('invalid bounded configuration fails closed',()=>{
 assert.equal(forensicLimit({}),1000);
 assert.equal(forensicLimit({S1B1_FORENSIC_LIMIT:'10000'}),10000);
 assert.throws(()=>forensicLimit({S1B1_FORENSIC_LIMIT:'10001'}),/invalid_forensic_limit/);
});
test('SQL reads a finite sample and never updates or writes to database',async()=>{
 const calls=[];
 const rows=[{id:10,pool_address:'x',signature:'s1',status:'unsupported_dex',reason:'no_supported_dex_instruction',payload:{meta:{err:null}}},
  {id:11,pool_address:'x',signature:'s2',status:'ambiguous',reason:'multiple_dex_instructions',payload:{meta:{err:null}}}];
 const db={query:async(sql,params)=>{
  calls.push({sql,params});
  return {rows:rows.filter(r=>r.id>params[0]).slice(0,params[2])};
 }};
 const report=await generateForensicReport(db,{limit:2});
 assert.equal(report.sampledEventRows,2);
 assert.equal(report.afterEventRowId,11);
 assert.equal(calls.length,1);
 assert.match(calls[0].sql,/JOIN onchain_trade_decodes/);
 assert.doesNotMatch(calls[0].sql,/UPDATE|DELETE|INSERT/i);
});
