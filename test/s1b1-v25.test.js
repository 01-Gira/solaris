import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_FUN,PUMP_SWAP} from '../src/s1b1/decoder.js';
import {inspectV25,createV25Summary} from '../src/s1b1/v25-edges.js';
import {runV25,v25Limit} from '../src/s1b1/v25-report.js';
const alpha='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=a=>{let n=BigInt('0x'+Buffer.from(a).toString('hex')),s='';while(n){s=alpha[Number(n%58n)]+s;n/=58n;}return s;};
const buy=b58([102,6,61,18,1,218,235,234,0]);
const token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const pool='watched-pool',signature='confidential-signature';
const pump=['global','fee','baseMint',pool,'poolBase','userBase','user','system',
 'token','creator','event','program','globalVol','userVol','feeConf','feeProg'];
const amm=[pool,'user','cfg','baseMint','quoteMint','userBase','userQuote',
 'poolBase','poolQuote','fee','feeATA','basePrg','quotePrg','sys','ata',
 'event','program','creator','creatorAuth','gVol','uVol','feeConf','feeProg'];
const transfer=(src,dst,mint,opts={})=>({
 programId:token,stackHeight:opts.stackHeight??3,
 parsed:{type:opts.type??'transferChecked',info:{
  source:src,destination:dst,mint,tokenAmount:{amount:'1000'}}}
});
function tx({program=PUMP_FUN,accounts=pump,inner=true,transfers=null,balances=true}={}){
 const ix={programId:program,data:buy,accounts,stackHeight:2};
 const legs=transfers??[transfer('poolBase','userBase','baseMint')];
 const outer=inner?[{programId:'router'}]:[ix];
 const trace=inner?[ix,...legs]:legs.map(x=>({...x,stackHeight:2}));
 const keys=[...new Set(accounts)].map(pubkey=>({pubkey,signer:pubkey==='user'}));
 const roleAccounts=program===PUMP_FUN?['poolBase','userBase']:['poolBase','userBase','poolQuote','userQuote'];
 const roleMints=program===PUMP_FUN?['baseMint','baseMint']:
  ['baseMint','baseMint','quoteMint','quoteMint'];
 return {transaction:{signatures:[signature],message:{instructions:outer,accountKeys:keys}},
  meta:{err:null,innerInstructions:[{index:0,instructions:trace}],
   preTokenBalances:balances?roleAccounts.map((p,i)=>({
    accountIndex:keys.findIndex(x=>x.pubkey===p),mint:roleMints[i]})):[],
   postTokenBalances:balances?roleAccounts.map((p,i)=>({
    accountIndex:keys.findIndex(x=>x.pubkey===p),mint:roleMints[i]})):[]}};
}
test('Pump.fun checked base edge with consistent balance mint is only a hint',()=>{
 const r=inspectV25(pool,signature,tx());
 assert.equal(r.status,'expected_edges_with_balance_mint_hints');
 assert.equal(r.baseLegs,1);
 assert.equal(r.quoteType,'native_sol_not_reconciled');
 assert.equal(r.verifiedFills,0);
 assert.equal(r.verifiedPrice,false);
});
test('PumpSwap requires both independently typed base and quote edges',()=>{
 const t=tx({program:PUMP_SWAP,accounts:amm,inner:false,
  transfers:[transfer('poolBase','userBase','baseMint'),
   transfer('userQuote','poolQuote','quoteMint')]});
 const r=inspectV25(pool,signature,t);
 assert.equal(r.status,'expected_edges_with_balance_mint_hints');
 assert.equal(r.baseLegs,1);assert.equal(r.quoteLegs,1);
 assert.equal(r.verifiedFills,0);
});
test('wrong watched pool and mismatched mint fail closed',()=>{
 assert.equal(inspectV25('other-pool',signature,tx()).status,'v24_watched_pool_mismatch');
 const r=inspectV25(pool,signature,tx({
  transfers:[transfer('poolBase','userBase','wrongMint')]}));
 assert.equal(r.status,'contradictory_expected_edges');
});
test('unchecked and duplicate transfer edges remain ambiguous',()=>{
 const unchecked=tx({transfers:[transfer('poolBase','userBase','baseMint',{type:'transfer'})]});
 assert.equal(inspectV25(pool,signature,unchecked).status,'unverified_or_unparsed_transfer_edges');
 const dup=tx({transfers:[
  transfer('poolBase','userBase','baseMint'),
  transfer('poolBase','userBase','baseMint')]});
 assert.equal(inspectV25(pool,signature,dup).status,'multiple_expected_edges_ambiguous');
});
test('transaction balance metadata is a hint, not mandatory or a fill',()=>{
 const r=inspectV25(pool,signature,tx({balances:false}));
 assert.equal(r.status,'expected_edges_without_balance_mint_hints');
 assert.equal(r.balanceMintConsistency,'unavailable');
 assert.equal(r.verifiedFills,0);
});
test('no base transfer and extraneous subtree transfers do not pass as expected edges',()=>{
 const r=inspectV25(pool,signature,tx({
  transfers:[transfer('fee','creator','baseMint')]}));
 assert.equal(r.status,'no_checked_base_edge');
 assert.equal(r.otherSubtreeTransfers,1);
});
test('reports never export raw quantities, signatures, pool keys or live prices',()=>{
 const s=createV25Summary();
 s.add({signature,pool_address:pool,venue_family:'pumpfun',payload:tx()});
 const r=s.result(),str=JSON.stringify(r);
 assert.equal(r.checkedBaseEdgeInstructions,1);
 assert.equal(r.verifiedFills,0);
 assert.ok(!str.includes(signature));
 assert.ok(!str.includes(pool));
 assert.ok(!str.includes('1000'));
});
test('database reads bounded V2 candidates only',async()=>{
 const sql=[];let first=true;
 const db={query:async(q,args)=>{
  sql.push(q);if(!first)return {rows:[]};first=false;
  return {rows:[{id:3,pool_address:pool,signature,
   venue_family:'pumpfun',payload:tx()}]};
 }};
 const r=await runV25(db,{limit:2});
 assert.equal(r.sampledEventRows,1);
 assert.equal(r.afterEventRowId,3);
 assert.ok(sql[0].includes("v.status='single_trade_candidate'"));
 assert.ok(sql.every(q=>!/(INSERT|UPDATE|DELETE)\s/i.test(q)));
});
test('bounded limits reject invalid values',()=>{
 assert.equal(v25Limit({}),1000);
 assert.throws(()=>v25Limit({S1B1_V25_LIMIT:'10001'}),/invalid_v25_limit/);
});
