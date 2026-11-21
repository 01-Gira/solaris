import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_FUN,PUMP_SWAP} from '../src/s1b1/decoder.js';
import {inspectV24,createV24Summary} from '../src/s1b1/v24-subtree.js';
import {runV24,v24Limit} from '../src/s1b1/v24-report.js';
const digits='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(array){let n=BigInt('0x'+Buffer.from(array).toString('hex')),s='';
 while(n>0n){s=digits[Number(n%58n)]+s;n/=58n;}return s;}
const buy=b58([102,6,61,18,1,218,235,234,0]);
const token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const pool='watch-pool',sig='sensitive-signature';
const accounts=['global','fee','mint',pool,'curveAta','userAta','user',
 'system','token','creator','event','program','globalVolume','userVolume','feeConfig','feeProgram'];
const candidate=(height=2)=>({programId:PUMP_FUN,data:buy,accounts,stackHeight:height});
const transfer=(height=3)=>({programId:token,stackHeight:height,parsed:{type:'transferChecked',info:{amount:'987654321'}}});
function tx(inner=[candidate(),transfer()],{outerCandidate=false,err=null}={}){
 return {transaction:{signatures:[sig],message:{instructions:outerCandidate?
  [{...candidate(1)}]:[{programId:'outer-router'}]}},
  meta:{err,innerInstructions:[{index:0,instructions:inner}],
   preTokenBalances:[],postTokenBalances:[]}};
}
test('inner candidate subtree has one parsed descendant without fill claims',()=>{
 const r=inspectV24(pool,sig,tx());
 assert.equal(r.status,'subtree_transfers_present_unattributed');
 assert.equal(r.subtreeParsedTransfers,1);
 assert.equal(r.otherGroupParsedTransfers,0);
 assert.equal(r.poolIndexMatches,true);
 assert.equal(r.traceBoundaryValid,true);
 assert.equal(r.verifiedFills,0);
 assert.equal(r.economicsAuthorized,false);
});
test('sibling token transfer at same depth is excluded from candidate subtree',()=>{
 const r=inspectV24(pool,sig,tx([
  candidate(2),transfer(3),{programId:'other-sibling',stackHeight:2},transfer(3)
 ]));
 assert.equal(r.subtreeParsedTransfers,1);
 assert.equal(r.otherGroupParsedTransfers,1);
});
test('only adjacent sibling transfers are never attributed to candidate',()=>{
 const r=inspectV24(pool,sig,tx([
  transfer(2),candidate(2),{programId:'next-sibling',stackHeight:2},transfer(3)
 ]));
 assert.equal(r.status,'only_outside_subtree_transfers');
 assert.equal(r.subtreeParsedTransfers,0);
 assert.equal(r.otherGroupParsedTransfers,2);
});
test('outer direct candidate includes its inner group only',()=>{
 const t=tx([transfer(2)],{outerCandidate:true});
 const r=inspectV24(pool,sig,t);
 assert.equal(r.scope,'outer');
 assert.equal(r.status,'subtree_transfers_present_unattributed');
 assert.equal(r.candidateStackHeight,1);
});
test('cross venue watched pool mismatch blocks subtree claims',()=>{
 const r=inspectV24('different-pool',sig,tx());
 assert.equal(r.status,'watched_pool_mismatch');
 assert.equal(r.subtreeParsedTransfers,0);
});
test('missing stackHeight and structurally impossible height jump fail closed',()=>{
 const noStack=tx([candidate(2),{...transfer(3),stackHeight:undefined}]);
 assert.equal(inspectV24(pool,sig,noStack).status,'incomplete_stack_heights');
 assert.equal(inspectV24(pool,sig,tx([candidate(3),transfer(4)])).status,
  'invalid_stack_depth_transition');
});
test('no transfer, failure, and signature mismatch fail closed',()=>{
 assert.equal(inspectV24(pool,sig,tx([candidate()])).status,
  'no_parsed_transfers_under_candidate');
 assert.equal(inspectV24(pool,'wrong',tx()).status,'signature_mismatch');
 assert.equal(inspectV24(pool,sig,tx([candidate(),transfer()],{
  err:{InstructionError:[0,'Custom']}})).status,'failed_onchain');
});
test('report suppresses raw signature, pool and quantities',()=>{
 const summary=createV24Summary();
 summary.add({signature:sig,pool_address:pool,venue_family:'pumpfun',payload:tx()});
 const r=summary.result();
 assert.equal(r.sampledEventRows,1);
 assert.equal(r.verifiedFills,0);
 assert.ok(!JSON.stringify(r).includes(sig));
 assert.ok(!JSON.stringify(r).includes(pool));
 assert.ok(!JSON.stringify(r).includes('987654321'));
});
test('SQL reads V2 candidates without any UPDATE/DELETE/INSERT',async()=>{
 const queries=[];let done=false;
 const db={query:async(q,args)=>{queries.push(q);if(done)return {rows:[]};
  done=true;return {rows:[{id:4,signature:sig,pool_address:pool,
   venue_family:'pumpfun',payload:tx()}]};}};
 const result=await runV24(db,{limit:2});
 assert.equal(result.sampledEventRows,1);
 assert.equal(result.afterEventRowId,4);
 assert.match(queries[0],/v.status='single_trade_candidate'/);
 assert.ok(queries.every(q=>!/(UPDATE|DELETE|INSERT)\s/i.test(q)));
});
test('limit remains bounded',()=>{
 assert.equal(v24Limit({}),1000);
 assert.throws(()=>v24Limit({S1B1_V24_LIMIT:'10001'}),/invalid_v24_limit/);
});
