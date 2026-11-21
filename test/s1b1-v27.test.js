import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_FUN,PUMP_SWAP} from '../src/s1b1/decoder.js';
import {inspectV27,createV27Summary} from '../src/s1b1/v27-lifecycle.js';
import {runV27,v27Limit} from '../src/s1b1/v27-report.js';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(a){let n=BigInt('0x'+Buffer.from(a).toString('hex')),s='';
 while(n>0n){s=alphabet[Number(n%58n)]+s;n/=58n;}return s;}
const buy=b58([102,6,61,18,1,218,235,234,0]);
const token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ata='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const pool='watched',signature='private-signature';
const pump=['global','fee','baseMint',pool,'poolBase','userBase','user','sys','token','creator',
 'event','program','gVol','uVol','feeConf','feeProgram'];
const amm=[pool,'user','cfg','baseMint','quoteMint','userBase','userQuote','poolBase','poolQuote',
 'fee','feeATA','basePrg','quotePrg','sys','ata','event','program','creator',
 'creatorAuth','gVol','uVol','feeConf','feeProgram'];
const transfer=(src,dst,mint,height)=>({programId:token,stackHeight:height,
 parsed:{type:'transferChecked',info:{source:src,destination:dst,mint,
  tokenAmount:{amount:'912345'}}}});
function tx({program=PUMP_FUN,missing=null,close=false,create=false,extra=[]}={}){
 const accounts=program===PUMP_FUN?pump:amm;
 const inner=program===PUMP_FUN,level=inner?3:2;
 const candidate={programId:program,data:buy,accounts,stackHeight:2};
 const transfers=[transfer('poolBase','userBase','baseMint',level),
  ...(program===PUMP_SWAP?[transfer('userQuote','poolQuote','quoteMint',level)]:[]),...extra];
 const lifecycle=[
  ...(create?[{programId:ata,stackHeight:level,
   parsed:{type:'create',info:{account:missing||'userBase'}}}]:[]),
  ...(close?[{programId:token,stackHeight:level,
   parsed:{type:'closeAccount',info:{account:missing||'userBase'}}}]:[])
 ];
 const trace=inner?[candidate,...lifecycle,...transfers]:[...lifecycle,...transfers];
 const keys=[...new Set(accounts)].map(pubkey=>({pubkey,signer:pubkey==='user'}));
 const entries=(program===PUMP_FUN?[['poolBase','baseMint'],['userBase','baseMint']]:
  [['poolBase','baseMint'],['userBase','baseMint'],['poolQuote','quoteMint'],['userQuote','quoteMint']])
  .filter(([account])=>account!==missing).map(([account,mint])=>({
   accountIndex:keys.findIndex(k=>k.pubkey===account),mint}));
 return {transaction:{message:{instructions:inner?[{programId:'router'}]:[candidate],
   accountKeys:keys},signatures:[signature]},
  meta:{err:null,innerInstructions:[{index:0,instructions:trace}],
   preTokenBalances:entries,postTokenBalances:entries,preBalances:keys.map(()=>1000),
   postBalances:keys.map(()=>950)}};
}
test('account create hint exists but never claims account lifecycle proven',()=>{
 const r=inspectV27(pool,signature,tx({missing:'userBase',create:true}));
 assert.equal(r.status,'all_balance_gaps_have_lifecycle_hints');
 assert.equal(r.roleGapDetails.user_base.classification,'both_missing_create_hint_only');
 assert.equal(r.rolesWithLifecycleHints,1);
 assert.equal(r.fillVerified,false);
 assert.equal(r.nativeSolReconciled,false);
});
test('PumpSwap missing user_quote without lifecycle stays unresolved',()=>{
 const r=inspectV27(pool,signature,tx({program:PUMP_SWAP,missing:'userQuote'}));
 assert.equal(r.status,'balance_gaps_unexplained');
 assert.equal(r.roleGapDetails.user_quote.classification,'both_missing_no_lifecycle_signal');
 assert.equal(r.rolesWithoutLifecycleHints,1);
});
test('create and close hints are distinct',()=>{
 const r=inspectV27(pool,signature,tx({missing:'userBase',close:true,create:true}));
 assert.equal(r.roleGapDetails.user_base.classification,'both_missing_create_and_close_hints');
});
test('PumpSwap extra token routes are role hints, not fees',()=>{
 const r=inspectV27(pool,signature,tx({program:PUMP_SWAP,
  extra:[transfer('userQuote','feeATA','quoteMint',2),
   transfer('userQuote','otherATA','quoteMint',2)]}));
 assert.equal(r.status,'no_balance_gaps');
 assert.equal(r.extraEdgeRolePairs['user_quote->protocol_fee_token_account'],1);
 assert.equal(r.extraEdgeRolePairs['user_quote->unmapped'],1);
 assert.equal(r.extraEdgeMintEvidence.checked_quote_mint,2);
 assert.equal(r.fillVerified,false);
});
test('cross-venue watched pool fails closed',()=>{
 assert.match(inspectV27('wrong-pool',signature,tx()).status,/watched_pool_mismatch/);
});
test('aggregate only role names and hashed identifiers, no sensitive amounts',()=>{
 const a=createV27Summary();a.add({pool_address:pool,signature,venue_family:'pumpfun',
  payload:tx({missing:'userBase',create:true})});
 const report=a.result(),txt=JSON.stringify(report);
 assert.equal(report.sampledEventRows,1);
 assert.equal(report.verifiedFills,0);
 assert.ok(!txt.includes(signature));
 assert.ok(!txt.includes('"watched"'));
 assert.ok(!txt.includes('912345'));
});
test('selects bounded, read-only V2 rows',async()=>{
 const qs=[];let done=false;
 const db={query:async(q)=>{qs.push(q);if(done)return {rows:[]};done=true;
  return {rows:[{id:7,pool_address:pool,signature,venue_family:'pumpfun',payload:tx()}]};}};
 const result=await runV27(db,{limit:2});
 assert.equal(result.sampledEventRows,1);assert.equal(result.afterEventRowId,7);
 assert.ok(qs[0].includes("v.status='single_trade_candidate'"));
 assert.ok(qs.every(q=>!/(INSERT|UPDATE|DELETE)\s/i.test(q)));
});
test('invalid limit is rejected',()=>{
 assert.equal(v27Limit({}),1000);
 assert.throws(()=>v27Limit({S1B1_V27_LIMIT:10001}),/invalid_v27_limit/);
});
