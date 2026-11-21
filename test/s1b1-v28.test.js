import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_SWAP,WSOL} from '../src/s1b1/decoder.js';
import {inspectV28,createV28Summary} from '../src/s1b1/v28-order.js';
import {runV28,v28Limit} from '../src/s1b1/v28-report.js';

const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(a){let v=BigInt('0x'+Buffer.from(a).toString('hex')),out='';
 while(v){out=chars[Number(v%58n)]+out;v/=58n;}return out;}
const data=b58([102,6,61,18,1,218,235,234,0]);
const token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ata='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const pool='watchpool',sig='secret-signature';
const accounts=[pool,'user','cfg','baseMint',WSOL,'userBase','userQuote',
 'poolBase','poolQuote','fee','feeATA','basePrg','quotePrg','sys','ata',
 'event','program','creator','creatorAuth','gVol','uVol','feeConf','feeProg'];
const checked=(src,dst,mint)=>({
 programId:token,stackHeight:2,
 parsed:{type:'transferChecked',info:{source:src,destination:dst,mint,
 tokenAmount:{amount:'9999'}}}
});
function fixture({createFirst=true,closeLast=true,quoteMint=WSOL,missingQuote=true}={}){
 const a=[...accounts];a[4]=quoteMint;
 const candidate={programId:PUMP_SWAP,data,accounts:a};
 const create={programId:ata,parsed:{type:'create',info:{account:'userQuote'}}};
 const close={programId:token,parsed:{type:'closeAccount',info:{account:'userQuote'}}};
 const sync={programId:token,parsed:{type:'syncNative',info:{account:'userQuote'}}};
 const outer=createFirst?[create,sync,candidate,close]:
  [close,sync,candidate,create];
 if(!closeLast&&createFirst){outer.splice(3,1);outer.unshift(close);}
 const candidateIndex=outer.indexOf(candidate);
 const keys=[...new Set(a)].map(pubkey=>({pubkey,signer:pubkey==='user'}));
 const roles=[['userBase','baseMint'],['poolBase','baseMint'],['poolQuote',quoteMint],
  ...(!missingQuote?[['userQuote',quoteMint]]:[])];
 const balance=roles.map(([account,mint])=>({accountIndex:keys.findIndex(x=>x.pubkey===account),mint}));
 return {transaction:{signatures:[sig],message:{instructions:outer,accountKeys:keys}},
  meta:{err:null,innerInstructions:[{index:candidateIndex,instructions:[
   checked('poolBase','userBase','baseMint'),
   checked('userQuote','poolQuote',quoteMint)
  ]}],preTokenBalances:balance,postTokenBalances:balance}};
}
test('ordered PumpSwap create before swap and close after is a hint not a fill',()=>{
 const r=inspectV28(pool,sig,fixture());
 assert.equal(r.status,'ordered_lifecycle_hints_all_gap_roles');
 assert.equal(r.chronologyByRole.user_quote.status,'ordered_create_then_candidate_then_close_hints');
 assert.equal(r.quoteMintClass,'wsol_mint_confirmed');
 assert.equal(r.chronologyByRole.user_quote.syncNativeBeforeCandidate,true);
 assert.equal(r.verifiedFills,0);
 assert.equal(r.economicsAuthorized,false);
});
test('wrong order refuses positive lifecycle conclusion',()=>{
 const r=inspectV28(pool,sig,fixture({createFirst:false}));
 assert.equal(r.status,'lifecycle_order_not_confirmed');
 assert.equal(r.chronologyByRole.user_quote.status,'incomplete_or_out_of_order_lifecycle_hints');
 assert.equal(r.verifiedFills,0);
});
test('close before candidate is not close-after proof',()=>{
 const r=inspectV28(pool,sig,fixture({closeLast:false}));
 assert.equal(r.status,'lifecycle_order_not_confirmed');
});
test('non-WSOL quote mint is explicitly separated',()=>{
 const r=inspectV28(pool,sig,fixture({quoteMint:'otherMint'}));
 assert.equal(r.quoteMintClass,'non_wsol_quote_mint');
 assert.equal(r.status,'ordered_lifecycle_hints_all_gap_roles');
});
test('without a balance gap the report does not infer a lifecycle',()=>{
 const r=inspectV28(pool,sig,fixture({missingQuote:false}));
 assert.equal(r.status,'no_balance_gap');
});
test('watched pool mismatch and duplicate candidate fail closed',()=>{
 assert.match(inspectV28('different-pool',sig,fixture()).status,/watched_pool_mismatch/);
 const t=fixture();
 t.transaction.message.instructions.push(t.transaction.message.instructions[2]);
 assert.match(inspectV28(pool,sig,t).status,/candidate_not_unique/);
});
test('summary redacts addresses and quantities',()=>{
 const r=createV28Summary();
 r.add({pool_address:pool,signature:sig,venue_family:'pumpswap',payload:fixture()});
 const o=r.result(),s=JSON.stringify(o);
 assert.equal(o.sampledEventRows,1);
 assert.equal(o.verifiedFills,0);
 assert.ok(!s.includes(sig));
 assert.ok(!s.includes('"watchpool"'));
 assert.ok(!s.includes('9999'));
});
test('bounded DB report does no updates',async()=>{
 let seen=false;const sql=[];
 const db={query:async(q)=>{sql.push(q);
  if(seen)return {rows:[]};seen=true;
  return {rows:[{id:4,signature:sig,pool_address:pool,venue_family:'pumpswap',payload:fixture()}]};
 }};
 const report=await runV28(db,{limit:2});
 assert.equal(report.sampledEventRows,1);
 assert.equal(report.afterEventRowId,4);
 assert.match(sql[0],/v.status='single_trade_candidate'/);
 assert.ok(sql.every(q=>!/(INSERT|UPDATE|DELETE)\s/i.test(q)));
});
test('bounded limit',()=>{
 assert.equal(v28Limit({}),1000);
 assert.throws(()=>v28Limit({S1B1_V28_LIMIT:'10001'}),/invalid_v28_limit/);
});
