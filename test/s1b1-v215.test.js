import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_SWAP,WSOL} from '../src/s1b1/decoder.js';
import {inspectV215,createV215Summary} from '../src/s1b1/v215-amounts.js';
import {runV215,v215Limit} from '../src/s1b1/v215-report.js';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes){let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),s='';
 while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}return s;}
const BUY=b58([102,6,61,18,1,218,235,234,0]);
const SELL=b58([51,230,133,164,1,127,131,173,0]);
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const pool='poolOnlyForFixture',signature='secretFixtureSignature';
const checked=(source,destination,mint,amount)=>({
 programId:TOKEN,stackHeight:2,parsed:{type:'transferChecked',
  info:{source,destination,mint,tokenAmount:{amount:String(amount),decimals:6}}}
});
function fixture({quoteMint=WSOL,side='buy',badBalance=false,
 wrongMint=false,fee=true}={}){
 const a=[pool,'user','config','baseMint',quoteMint,'userBase','userQuote',
  'poolBase','poolQuote','protocolOwner','protocolAccount','baseProgram',
  'quoteProgram','sys','ata','event','program','creatorVault',
  'creatorAuthority','volumeGlobal','volumeUser','feeConfig','feeProgram'];
 if(side==='sell')a.splice(19,2);
 a.push('extra1','extra2');
 const fromBase=side==='buy'?'poolBase':'userBase',
  toBase=side==='buy'?'userBase':'poolBase';
 const fromQuote=side==='buy'?'userQuote':'poolQuote',
  toQuote=side==='buy'?'poolQuote':'userQuote';
 const transfers=[
  checked(fromBase,toBase,'baseMint',100),
  checked(fromQuote,toQuote,quoteMint,100),
  checked(fromQuote,'protocolAccount',quoteMint,10),
  checked(fromQuote,'extra2',quoteMint,10)
 ];
 if(wrongMint)transfers[0].parsed.info.mint='differentMint';
 const keys=[...new Set(a)].map(pubkey=>({pubkey,signer:pubkey==='user'}));
 const rawRoleAmounts=side==='buy'?
  {userBase:[100,200],poolBase:[500,400],userQuote:[500,380],poolQuote:[100,200]}:
  {userBase:[200,100],poolBase:[400,500],userQuote:[100,200],poolQuote:[500,380]};
 const balances=(position)=>Object.entries(rawRoleAmounts).map(([account,values])=>({
  accountIndex:keys.findIndex(k=>k.pubkey===account),
  mint:account.includes('Base')?'baseMint':quoteMint,
  owner:account.startsWith('user')?'user':'poolAuthority',
  uiTokenAmount:{amount:String(values[position]+(badBalance&&account==='poolBase'&&position===1?1:0)),
   decimals:6}
 }));
 return {transaction:{signatures:[signature],message:{
   accountKeys:keys,instructions:[{programId:PUMP_SWAP,data:side==='buy'?BUY:SELL,accounts:a}]
  }},meta:{err:null,fee:fee?5000:null,innerInstructions:[{index:0,instructions:transfers}],
   preTokenBalances:balances(0),postTokenBalances:balances(1)}};
}
test('read-only V2.15 whole-transaction amounts can reconcile but never prove fills',()=>{
 const r=inspectV215(pool,signature,fixture());
 assert.equal(r.status,'four_role_transaction_balance_consistent_not_fill');
 assert.equal(r.matchedRoleCount,4);assert.equal(r.missingRoleBalanceCount,0);
 assert.equal(r.transactionFeeLamportsRecorded,true);
 assert.equal(r.netSwapAmountVerified,false);
 assert.equal(r.verifiedFills,0);assert.equal(r.economicsAuthorized,false);
});
test('quote mint agnostic for transaction balance comparison',()=>{
 const r=inspectV215(pool,signature,fixture({quoteMint:'SPLquoteMint'}));
 assert.equal(r.status,'four_role_transaction_balance_consistent_not_fill');
 assert.equal(r.quoteClass,'non_wsol');assert.equal(r.verifiedFills,0);
});
test('account delta disagreement is not promoted to fill',()=>{
 const r=inspectV215(pool,signature,fixture({badBalance:true}));
 assert.equal(r.status,'balance_delta_disagrees_with_tx_checked_transfers');
 assert.equal(r.verifiedFills,0);
});
test('wrong mint in primary base transfer stays blocked upstream',()=>{
 const r=inspectV215(pool,signature,fixture({wrongMint:true}));
 assert.match(r.status,/v214_/);
 assert.equal(r.netSwapAmountVerified,false);
});
test('invalid signer signature and failed transaction never reconcile',()=>{
 const tx=fixture();tx.transaction.signatures=['incorrect'];
 assert.match(inspectV215(pool,signature,tx).status,/v214_|rpc_signature_not_proven/);
 const tx2=fixture();tx2.meta.err={InstructionError:[0,{Custom:1}]};
 assert.match(inspectV215(pool,signature,tx2).status,/v214_|rpc_transaction_failed/);
});
test('aggregates omit amounts, account identities, and signature',()=>{
 const reporter=createV215Summary();
 reporter.add({pool_address:pool,signature,payload:fixture()});
 const out=reporter.result(),serialized=JSON.stringify(out);
 assert.equal(out.sampledEventRows,1);
 assert.equal(out.structurallyEligibleCandidateRows,1);
 assert.equal(out.verifiedFills,0);
 assert.ok(!serialized.includes(signature));
 assert.ok(!serialized.includes('"poolOnlyForFixture"'));
 assert.ok(!serialized.includes('"5000"'));
});
test('readonly bounded report consumes only V2 candidate classifications',async()=>{
 const sql=[];let n=0;
 const db={query:async(q,params)=>{
  sql.push(q);
  return ++n===1?{rows:[{id:44,pool_address:pool,signature,payload:fixture()}]}:{rows:[]};
 }};
 const r=await runV215(db,{limit:2});
 assert.equal(r.sampledEventRows,1);assert.equal(r.afterEventRowId,44);
 assert.match(sql[0],/v.status='single_trade_candidate'/);
 assert.ok(sql.every(q=>!/(INSERT|UPDATE|DELETE|TRUNCATE)\s/i.test(q)));
});
test('guard large and malformed run limits',()=>{
 assert.equal(v215Limit({}),3000);
 assert.throws(()=>v215Limit({S1B1_V215_LIMIT:0}),/invalid_v215_limit/);
 assert.throws(()=>v215Limit({S1B1_V215_LIMIT:100001}),/invalid_v215_limit/);
});
