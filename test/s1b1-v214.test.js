import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_SWAP,WSOL} from '../src/s1b1/decoder.js';
import {inspectV214,createV214Summary} from '../src/s1b1/v214-routing.js';
import {runV214,v214Limit} from '../src/s1b1/v214-report.js';
const ALPH='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes){let v=BigInt('0x'+Buffer.from(bytes).toString('hex')),s='';
 while(v){s=ALPH[Number(v%58n)]+s;v/=58n;}return s;}
const DATA={buy:b58([102,6,61,18,1,218,235,234,0]),
 sell:b58([51,230,133,164,1,127,131,173,0]),
 buy_exact_quote_in:b58([198,46,211,219,54,38,175,135,0])};
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const pool='watchedPool',signature='sensitive-signature';
const transfer=(source,destination,mint,kind='transferChecked')=>({
 programId:TOKEN,stackHeight:2,parsed:{type:kind,info:{
 source,destination,mint,tokenAmount:{amount:'199',decimals:6}}}});
function fixture({side='buy',quoteMint=WSOL,appended=2,creator=false,
 badSource=false,malformed=false,wrongPool=false}={}){
 const accounts=[wrongPool?'notWatched':pool,'user','config','baseMint',quoteMint,
  'userBase','userQuote','poolBase','poolQuote','protocolOwner','protocolAta',
  'baseProgram','quoteProgram','sys','ata','event','pumpProgram','creatorAta',
  'creatorOwner','volumeGlobal','volumeUser','feeConf','feeProgram'];
 if(side==='sell')accounts.splice(19,2);
 for(let i=0;i<appended;i++)accounts.push('appended'+i);
 const candidate={programId:PUMP_SWAP,data:DATA[side],accounts};
 const fromBase=side==='sell'?'userBase':'poolBase',toBase=side==='sell'?'poolBase':'userBase';
 const fromQuote=side==='sell'?'poolQuote':'userQuote',
  toQuote=side==='sell'?'userQuote':'poolQuote';
 const extras=[transfer(fromQuote,'protocolAta',quoteMint)];
 if(creator)extras.push(transfer(fromQuote,'creatorAta',quoteMint));
 if(appended>0)extras.push(transfer(fromQuote,'appended'+(appended-1),quoteMint));
 if(badSource)extras.push(transfer('otherAccount','appended0',quoteMint));
 if(malformed)extras.push(transfer(fromQuote,'appended0',quoteMint,'transfer'));
 const instructions=[transfer(fromBase,toBase,'baseMint'),
  transfer(fromQuote,toQuote,quoteMint),...extras];
 const keys=[...new Set([...accounts,'otherAccount'])].map(pubkey=>({pubkey,signer:pubkey==='user'}));
 const bals=[['userBase','baseMint'],['poolBase','baseMint'],
  ['userQuote',quoteMint],['poolQuote',quoteMint]].map(([account,mint])=>({
   accountIndex:keys.findIndex(x=>x.pubkey===account),mint}));
 return {transaction:{signatures:[signature],message:{instructions:[candidate],accountKeys:keys}},
  meta:{err:null,innerInstructions:[{index:0,instructions}],
   preTokenBalances:bals,postTokenBalances:bals}};
}
test('non-WSOL quote with three appended accounts is structural, never a fill',()=>{
 const r=inspectV214(pool,signature,fixture({quoteMint:'SPLquoteMint',appended:3,creator:true}));
 assert.equal(r.quoteClass,'non_wsol');
 assert.equal(r.appendedAccountCount,3);
 assert.equal(r.status,'known_and_remaining_structural_edges_no_fee_or_fill_proof');
 assert.equal(r.baseEdges,1);assert.equal(r.quoteEdges,1);
 assert.equal(r.protocolEdges,1);assert.equal(r.creatorVaultEdges,1);
 assert.equal(r.remainingAccountEdges,1);assert.equal(r.verifiedFills,0);
 assert.equal(r.economicsAuthorized,false);
});
test('WSOL and two trailing accounts remain supported',()=>{
 const r=inspectV214(pool,signature,fixture());
 assert.equal(r.status,'known_and_remaining_structural_edges_no_fee_or_fill_proof');
 assert.equal(r.quoteClass,'wsol');
 assert.equal(r.appendedAccountCount,2);
});
test('sell uses 21-account IDL layout',()=>{
 const r=inspectV214(pool,signature,fixture({side:'sell',appended:7}));
 assert.equal(r.instruction,'sell');
 assert.equal(r.fixedAccountCount,21);
 assert.equal(r.appendedAccountCount,7);
 assert.equal(r.status,'known_and_remaining_structural_edges_no_fee_or_fill_proof');
});
test('discriminator for buy_exact_quote_in is accepted',()=>{
 const r=inspectV214(pool,signature,fixture({side:'buy_exact_quote_in',quoteMint:'quote2'}));
 assert.equal(r.instruction,'buy_exact_quote_in');
 assert.equal(r.quoteClass,'non_wsol');
});
test('mismatch, malformed and unexpected transfers fail closed',()=>{
 assert.match(inspectV214(pool,signature,fixture({wrongPool:true})).status,/watched_pool_mismatch/);
 assert.equal(inspectV214(pool,signature,fixture({badSource:true})).status,
  'partial_or_ambiguous_structural_routing');
 assert.equal(inspectV214(pool,signature,fixture({malformed:true})).status,
  'partial_or_ambiguous_structural_routing');
 const t=fixture();t.transaction.signatures=['different'];
 assert.match(inspectV214(pool,signature,t).status,/signature_mismatch|signature_unconfirmed|v28_/);
});
test('aggregate never leaks signature, raw quantity or account names',()=>{
 const x=createV214Summary();
 x.add({pool_address:pool,signature,venue_family:'pumpswap',payload:fixture()});
 const r=x.result(),s=JSON.stringify(r);
 assert.equal(r.sampledEventRows,1);assert.equal(r.verifiedFills,0);
 assert.ok(!s.includes(signature));assert.ok(!s.includes('"watchedPool"'));
 assert.ok(!s.includes('"199"'));
});
test('database report bounded to previous candidate rows and read-only SQL',async()=>{
 const queries=[];let call=0;
 const db={query:async(sql,params)=>{
  queries.push({sql,params});return ++call===1?
   {rows:[{id:9,pool_address:pool,signature,venue_family:'pumpswap',payload:fixture()}]}:
   {rows:[]};}};
 const r=await runV214(db,{limit:2});
 assert.equal(r.sampledEventRows,1);assert.equal(r.afterEventRowId,9);
 assert.ok(queries[0].sql.includes("v.status='single_trade_candidate'"));
 assert.ok(queries.every(x=>!/(INSERT|UPDATE|DELETE|TRUNCATE)\s/i.test(x.sql)));
});
test('limits enforced',()=>{
 assert.equal(v214Limit({}),3000);
 assert.throws(()=>v214Limit({S1B1_V214_LIMIT:100001}),/invalid_v214_limit/);
 assert.throws(()=>v214Limit({S1B1_V214_LIMIT:0}),/invalid_v214_limit/);
});
