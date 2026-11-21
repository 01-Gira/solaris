import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_FUN,PUMP_SWAP} from '../src/s1b1/decoder.js';
import {inspectV26,createV26Summary} from '../src/s1b1/v26-balance.js';
import {runV26,v26Limit} from '../src/s1b1/v26-report.js';
const alpha='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(a){let n=BigInt('0x'+Buffer.from(a).toString('hex')),s='';while(n){s=alpha[Number(n%58n)]+s;n/=58n;}return s;}
const buy=b58([102,6,61,18,1,218,235,234,0]);
const pool='watch-pool',signature='secret-signature';
const token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const pump=['global','fee','baseMint',pool,'poolBase','userBase','user','system','token','creator','event','program','globalVol','userVol','feeConf','feeProg'];
const amm=[pool,'user','cfg','baseMint','quoteMint','userBase','userQuote','poolBase','poolQuote','fee','feeATA','basePrg','quotePrg','sys','ata','event','program','creator','creatorAuth','gVol','uVol','feeConf','feeProg'];
function leg(source,destination,mint,height=3){
 return {programId:token,stackHeight:height,parsed:{type:'transferChecked',
  info:{source,destination,mint,tokenAmount:{amount:'17'}}}};
}
function tx({program=PUMP_FUN,accounts=program===PUMP_FUN?pump:amm,
 inner=program===PUMP_FUN,omitBalanceAccount=null,additional=[],
 lamports=true}={}){
 const ix={programId:program,data:buy,accounts,stackHeight:2};
 const normal=[leg('poolBase','userBase','baseMint'),
  ...(program===PUMP_SWAP?[leg('userQuote','poolQuote','quoteMint')]:[])];
 const transfers=[...normal,...additional];
 const outer=inner?[{programId:'router'}]:[ix];
 const instr=inner?[ix,...transfers]:transfers.map(i=>({...i,stackHeight:2}));
 const keys=[...new Set(accounts)].map(pubkey=>({pubkey,signer:pubkey==='user'}));
 const roles=program===PUMP_FUN?[['poolBase','baseMint'],['userBase','baseMint']]:
  [['poolBase','baseMint'],['userBase','baseMint'],['poolQuote','quoteMint'],['userQuote','quoteMint']];
 const balances=roles.filter(([a])=>a!==omitBalanceAccount).map(([account,mint])=>({
  accountIndex:keys.findIndex(k=>k.pubkey===account),mint}));
 return {transaction:{signatures:[signature],message:{accountKeys:keys,instructions:outer}},
 meta:{err:null,innerInstructions:[{index:0,instructions:instr}],
  preTokenBalances:balances,postTokenBalances:balances,
  ...(lamports?{preBalances:keys.map(()=>1000),postBalances:keys.map(()=>950)}:{})}};
}
test('Pump.fun full token metadata and lamport snapshots are not a fill',()=>{
 const r=inspectV26(pool,signature,tx());
 assert.equal(r.status,'balance_metadata_complete_not_fill');
 assert.equal(r.nativeLamportEvidence,'transaction_lamport_snapshots_present_not_attributed');
 assert.equal(r.roleBalanceStates.user_base,'both_balance_mints_match');
 assert.equal(r.verifiedFills,0);
});
test('PumpSwap missing poolQuote role explains unavailable V2.5 balances',()=>{
 const r=inspectV26(pool,signature,tx({program:PUMP_SWAP,omitBalanceAccount:'poolQuote'}));
 assert.equal(r.status,'balance_metadata_gaps_remain');
 assert.equal(r.roleBalanceStates.pool_quote,'both_balance_entries_missing');
 assert.equal(r.roleBalanceStates.user_quote,'both_balance_mints_match');
 assert.equal(r.nativeLamportEvidence,'not_applicable');
});
test('extra fee transfers split by account role without assuming they are fees',()=>{
 const r=inspectV26(pool,signature,tx({program:PUMP_SWAP,
  additional:[leg('poolQuote','feeATA','quoteMint',2),leg('userQuote','feeATA','quoteMint',2)]}));
 assert.equal(r.status,'balance_metadata_complete_not_fill');
 assert.equal(r.otherTransferRolePairs['pool_quote->fee_token_account'],1);
 assert.equal(r.otherTransferRolePairs['user_quote->fee_token_account'],1);
 assert.equal(r.verifiedFills,0);
});
test('Pump.fun native SOL snapshots absent are not replaced with fake pricing',()=>{
 const r=inspectV26(pool,signature,tx({lamports:false}));
 assert.equal(r.nativeLamportEvidence,'balance_arrays_missing');
 assert.equal(r.verifiedFills,0);
});
test('watched pool mismatch fails closed',()=>{
 const r=inspectV26('wrong-pool',signature,tx());
 assert.equal(r.status,'v25_v24_watched_pool_mismatch');
 assert.equal(r.verifiedFills,0);
});
test('summary hashes examples and does not emit amounts or addresses',()=>{
 const s=createV26Summary();
 s.add({pool_address:pool,signature,venue_family:'pumpfun',payload:tx()});
 const report=s.result(),output=JSON.stringify(report);
 assert.equal(report.sampledEventRows,1);
 assert.equal(report.verifiedFills,0);
 assert.ok(!output.includes(signature));
 assert.ok(!output.includes(pool));
 assert.ok(!output.includes('"17"'));
});
test('read-only bounded SQL queries',async()=>{
 const queries=[];let first=true;
 const db={query:async(q)=>{queries.push(q);if(!first)return {rows:[]};
 first=false;return {rows:[{id:5,pool_address:pool,signature,venue_family:'pumpfun',payload:tx()}]};}};
 const r=await runV26(db,{limit:2});
 assert.equal(r.sampledEventRows,1);
 assert.ok(queries[0].includes("v.status='single_trade_candidate'"));
 assert.ok(queries.every(q=>!/(INSERT|UPDATE|DELETE)\s/i.test(q)));
});
test('bounded configuration',()=>{
 assert.equal(v26Limit({}),1000);
 assert.throws(()=>v26Limit({S1B1_V26_LIMIT:'10001'}),/invalid_v26_limit/);
});
