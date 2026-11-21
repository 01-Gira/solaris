import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_FUN,PUMP_SWAP} from '../src/s1b1/decoder.js';
import {inspectV23,createV23Summary} from '../src/s1b1/v23-trace.js';
import {runV23,v23Limit} from '../src/s1b1/v23-report.js';
const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(a){let n=BigInt('0x'+Buffer.from(a).toString('hex')),s='';while(n){s=chars[Number(n%58n)]+s;n/=58n;}return s;}
const buy=b58([102,6,61,18,1,218,235,234,0]),sig='private-signature';
const token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function tx({inner=true,transfer=true,error=null,kind='transferChecked'}={}){
 const candidate={programId:PUMP_FUN,data:buy,stackHeight:2};
 const outer=inner?[{programId:'parent-router'}]:[candidate];
 const items=[...(inner?[candidate]:[]),
  ...(transfer?[{programId:token,parsed:{type:kind,info:{amount:'123456789'}},stackHeight:3}]:[])];
 return {transaction:{signatures:[sig],message:{instructions:outer}},
  meta:{err:error,innerInstructions:[{index:0,instructions:items}],
   preTokenBalances:[],postTokenBalances:[]}};
}
test('inner CPI with parsed SPL transfers is colocation only, not a fill',()=>{
 const r=inspectV23(tx(),sig);
 assert.equal(r.status,'transfers_colocated_not_attributed');
 assert.equal(r.scope,'inner');assert.equal(r.parentProgram,'parent-router');
 assert.equal(r.parsedTransfers,1);assert.equal(r.verifiedFills,0);
 assert.equal(r.economicsAuthorized,false);
});
test('no transfer, unparsed transfer, and token mint are not attributed',()=>{
 assert.equal(inspectV23(tx({transfer:false}),sig).status,'no_token_instructions_in_group');
 assert.equal(inspectV23(tx({kind:'mintTo'}),sig).status,'no_parsed_transfer_in_group');
 const t=tx({transfer:false});
 t.meta.innerInstructions[0].instructions.push({programId:token,data:'123'});
 assert.equal(inspectV23(t,sig).status,'unparsed_token_instructions');
});
test('outside-group transfers never count',()=>{
 const t=tx({transfer:false});
 t.transaction.message.instructions.push({programId:'other-router'});
 t.meta.innerInstructions.push({index:1,instructions:[{programId:token,parsed:{type:'transfer'}}]});
 const r=inspectV23(t,sig);
 assert.equal(r.groupTokenInstructions,0);
 assert.equal(r.status,'no_token_instructions_in_group');
});
test('wrong signatures, failed-onchain, multiple candidates remain blocked',()=>{
 assert.equal(inspectV23(tx(),'other').status,'signature_mismatch');
 assert.equal(inspectV23(tx({error:{InstructionError:[0,'Custom']}}),sig).status,'failed_onchain');
 const t=tx();t.meta.innerInstructions[0].instructions.push({programId:PUMP_SWAP,data:buy});
 assert.equal(inspectV23(t,sig).status,'not_single_candidate');
});
test('report redacts full signature and does not leak token quantities',()=>{
 const s=createV23Summary();s.add({pool_address:'pool-secret',signature:sig,venue_family:'pumpfun',payload:tx()});
 const result=s.result();
 assert.equal(result.sampledEventRows,1);
 assert.equal(result.verifiedFills,0);
 assert.ok(!JSON.stringify(result).includes(sig));
 assert.ok(!JSON.stringify(result).includes('123456789'));
});
test('DB runner uses a read-only candidate selection query',async()=>{
 let once=false;const queries=[];
 const client={query:async(q,params)=>{
  queries.push(q);if(once)return {rows:[]};once=true;
  return {rows:[{id:4,pool_address:'pool',signature:sig,venue_family:'pumpfun',payload:tx()}]};
 }};
 const r=await runV23(client,{limit:2});
 assert.equal(r.sampledEventRows,1);
 assert.equal(r.afterEventRowId,4);
 assert.ok(queries[0].includes("v.status='single_trade_candidate'"));
 assert.ok(queries.every(q=>!/(INSERT|UPDATE|DELETE)\s/i.test(q)));
});
test('bound report limit',()=>{
 assert.equal(v23Limit({}),1000);
 assert.throws(()=>v23Limit({S1B1_V23_LIMIT:'10001'}),/invalid_v23_limit/);
});
