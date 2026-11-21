import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_FUN,PUMP_SWAP} from '../src/s1b1/decoder.js';
import {inspectCandidateAttribution,createAttributionSummary} from '../src/s1b1/v21-attribution.js';
import {runAttributionReport,attributionLimit} from '../src/s1b1/v21-report.js';
const abc='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes){
 let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),out='';
 while(n){out=abc[Number(n%58n)]+out;n/=58n;}
 return out||'1';
}
const buy=base58([102,6,61,18,1,218,235,234,0]);
const wallet='test-signer',pool='watched-pool';
function transaction(program,accounts,{err=null,signer=true,inner=false}={}){
 const ix={programId:program,accounts,data:buy};
 return {transaction:{message:{accountKeys:[{pubkey:wallet,signer}],
   instructions:inner?[]:[ix]},signatures:['test-signature']},
   meta:{err,innerInstructions:inner?[{index:0,instructions:[ix]}]:[]}};
}
test('Pump.fun candidate at legacy pool index is only an unverified hint',()=>{
 const tx=transaction(PUMP_FUN,['global','fee','mint',pool,'unused','token-account',wallet]);
 const a=inspectCandidateAttribution(pool,'test-signature',tx);
 assert.equal(a.status,'pool_at_legacy_index_unverified');
 assert.equal(a.legacySignerHint,'legacy_signer_flag_present');
 assert.equal(a.candidateProgram,'pumpfun');
 assert.equal(a.fillVerified,false);assert.equal(a.directionVerified,false);
 assert.equal(a.economicsAuthorized,false);
});
test('PumpSwap pool hint at index zero, inner candidate, and signer flag',()=>{
 const tx=transaction(PUMP_SWAP,[pool,wallet,'cfg','mint','quote','base-token','quote-token'],{inner:true});
 const a=inspectCandidateAttribution(pool,'test-signature',tx);
 assert.equal(a.candidateScope,'inner');
 assert.equal(a.status,'pool_at_legacy_index_unverified');
 assert.equal(a.legacySignerHint,'legacy_signer_flag_present');
});
test('Meteora-associated pool does not become a Pump.fun swap',()=>{
 const tx=transaction(PUMP_FUN,['global','fee','mint','other-pool','x','y',wallet]);
 const a=inspectCandidateAttribution(pool,'test-signature',tx);
 assert.equal(a.status,'pool_absent_from_candidate');
 assert.equal(a.fillVerified,false);
});
test('pool in unrelated account position remains unverified',()=>{
 const tx=transaction(PUMP_SWAP,['different-pool',wallet,'cfg',pool,'quote','x','y']);
 const a=inspectCandidateAttribution(pool,'test-signature',tx);
 assert.equal(a.status,'pool_present_other_index');
 assert.equal(a.atLegacyPoolIndex,false);
});
test('absent parsed signer flag cannot be assumed valid',()=>{
 const tx=transaction(PUMP_SWAP,[pool,wallet,'cfg','mint','quote','x','y'],{signer:false});
 const a=inspectCandidateAttribution(pool,'test-signature',tx);
 assert.equal(a.legacySignerHint,'legacy_signer_flag_absent');
 assert.equal(a.status,'pool_at_legacy_index_unverified');
});
test('bad signature, failed tx and extra trade candidates fail closed',()=>{
 const tx=transaction(PUMP_SWAP,[pool,wallet,'cfg','mint','quote','x','y']);
 assert.equal(inspectCandidateAttribution(pool,'other-signature',tx).status,'signature_mismatch');
 assert.equal(inspectCandidateAttribution(pool,'test-signature',
  {...tx,meta:{err:{InstructionError:[0,1]}}}).status,'tx_failed');
 tx.transaction.message.instructions.push(tx.transaction.message.instructions[0]);
 assert.equal(inspectCandidateAttribution(pool,'test-signature',tx).status,'not_single_candidate');
});
test('read-only per-venue summaries avoid raw pool and signature leakage',()=>{
 const report=createAttributionSummary();
 const tx=transaction(PUMP_FUN,['global','fee','mint',pool,'unused','token-account',wallet]);
 report.add({pool_address:pool,signature:'test-signature',venue_family:'meteora',payload:tx});
 const result=report.result();
 assert.equal(result.byVenueStatus[0].key,'meteora:pool_at_legacy_index_unverified');
 assert.equal(result.verifiedFills,0);
 assert.ok(!JSON.stringify(result).includes('test-signature'));
 assert.ok(!JSON.stringify(result).includes('watched-pool'));
});
test('bounded report selects only single candidate rows without updating DB',async()=>{
 const sql=[];
 const db={query:async(q,args)=>{
  sql.push({q,args});
  return {rows:args[1]===0?[{id:25,pool_address:pool,signature:'test-signature',
    venue_family:'pumpfun',payload:transaction(PUMP_FUN,
      ['global','fee','mint',pool,'unused','token-account',wallet])}]:[]};
 }};
 const report=await runAttributionReport(db,{limit:2});
 assert.equal(report.sampledEventRows,1);
 assert.equal(report.afterEventRowId,25);
 assert.ok(sql[0].q.includes("v.status='single_trade_candidate'"));
 assert.ok(sql.every(x=>!/(INSERT|UPDATE|DELETE)\s/i.test(x.q)));
});
test('report limit is bounded',()=>{
 assert.equal(attributionLimit({}),1000);
 assert.throws(()=>attributionLimit({S1B1_V21_LIMIT:0}),/invalid_v21_limit/);
 assert.throws(()=>attributionLimit({S1B1_V21_LIMIT:10001}),/invalid_v21_limit/);
});
