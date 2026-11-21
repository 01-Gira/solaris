import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_SWAP,WSOL} from '../src/s1b1/decoder.js';
import {inspectV29,createV29Summary} from '../src/s1b1/v29-routing.js';
import {runV29,v29Limit} from '../src/s1b1/v29-report.js';
const alpha='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes){let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),s='';
 while(n){s=alpha[Number(n%58n)]+s;n/=58n;}return s;}
const BUY=b58([102,6,61,18,1,218,235,234,0]);
const SELL=b58([51,230,133,164,1,127,131,173,0]);
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const pool='watchpool',signature='private-sig';
function tx({sell=false,extra=true,wrongProtocol=false,wrongPool=false}={}){
 const accounts=[wrongPool?'otherPool':pool,'user','cfg','baseMint',WSOL,
  'userBase','userQuote','poolBase','poolQuote','protocolFeeOwner',
  'protocolFeeATA','basePrg','quotePrg','sys','ata','event','program',
  'creatorATA','creatorAuth','gVol','uVol','feeConf','feeProg'];
 if(sell)accounts.splice(19,2);
 accounts.push('extraRoleA','extraRoleB');
 const candidate={programId:PUMP_SWAP,data:sell?SELL:BUY,accounts};
 const srcBase=sell?'userBase':'poolBase',dstBase=sell?'poolBase':'userBase';
 const srcQuote=sell?'poolQuote':'userQuote',dstQuote=sell?'userQuote':'poolQuote';
 const transfer=(src,dst,mint)=>({programId:TOKEN,stackHeight:2,
  parsed:{type:'transferChecked',info:{source:src,destination:dst,mint,tokenAmount:{amount:'43'}}}});
 const transfers=[
  transfer(srcBase,dstBase,'baseMint'),
  transfer(srcQuote,dstQuote,WSOL),
  transfer(srcQuote,wrongProtocol?'wrongProtocolATA':'protocolFeeATA',WSOL),
  ...(extra?[transfer(srcQuote,'extraRoleB',WSOL)]:[])
 ];
 const create={programId:ATA,parsed:{type:'create',info:{account:'userQuote'}}};
 const close={programId:TOKEN,parsed:{type:'closeAccount',info:{account:'userQuote'}}};
 const keys=[...new Set(accounts)].map(pubkey=>({pubkey,signer:pubkey==='user'}));
 const bals=[['userBase','baseMint'],['poolBase','baseMint'],['poolQuote',WSOL]]
  .map(([account,mint])=>({accountIndex:keys.findIndex(k=>k.pubkey===account),mint}));
 return {transaction:{signatures:[signature],message:{instructions:[create,candidate,close],accountKeys:keys}},
  meta:{err:null,innerInstructions:[{index:1,instructions:transfers}],
   preTokenBalances:bals,postTokenBalances:bals}};
}
test('four checked edges on a buy are routing hints only',()=>{
 const r=inspectV29(pool,signature,tx());
 assert.equal(r.status,'four_structural_edges_no_fee_or_fill_proof');
 assert.equal(r.expectedBaseEdges,1);assert.equal(r.expectedQuoteEdges,1);
 assert.equal(r.officialProtocolRecipientEdges,1);
 assert.equal(r.unclassifiedRemainingRecipientEdges,1);
 assert.equal(r.appendedAccountCount,2);
 assert.equal(r.verifiedFills,0);assert.equal(r.economicsAuthorized,false);
});
test('sell layout has only 21 fixed account positions',()=>{
 const r=inspectV29(pool,signature,tx({sell:true}));
 assert.equal(r.instruction,'sell');
 assert.equal(r.fixedIdlAccountCount,21);
 assert.equal(r.status,'four_structural_edges_no_fee_or_fill_proof');
});
test('unknown remaining recipient cannot be silently promoted to economic fee',()=>{
 const r=inspectV29(pool,signature,tx({extra:false}));
 assert.equal(r.status,'partial_or_ambiguous_fee_routing');
 assert.equal(r.unclassifiedRemainingRecipientEdges,0);
});
test('incorrect recipient destination stays unverified',()=>{
 const r=inspectV29(pool,signature,tx({wrongProtocol:true}));
 assert.equal(r.status,'partial_or_ambiguous_fee_routing');
 assert.equal(r.officialProtocolRecipientEdges,0);
 assert.equal(r.unknownOrInvalidTransferEdges,1);
});
test('watched pool mismatch fails closed before any economic claim',()=>{
 const r=inspectV29(pool,signature,tx({wrongPool:true}));
 assert.match(r.status,/watched_pool_mismatch/);
 assert.equal(r.verifiedFills,0);
});
test('aggregate has no sensitive account, signature, token quantities',()=>{
 const r=createV29Summary();
 r.add({pool_address:pool,signature,venue_family:'pumpswap',payload:tx()});
 const result=r.result(),s=JSON.stringify(result);
 assert.equal(result.sampledEventRows,1);
 assert.equal(result.summedProtocolRecipientTransferInstructions,1);
 assert.equal(result.verifiedFills,0);
 assert.ok(!s.includes(signature));
 assert.ok(!s.includes('"watchpool"'));
 assert.ok(!s.includes('"43"'));
});
test('report uses bounded read-only SQL and no V1/V2 writes',async()=>{
 const sql=[];let first=true;
 const db={query:async(q)=>{sql.push(q);if(!first)return {rows:[]};first=false;
  return {rows:[{id:99,pool_address:pool,signature,venue_family:'pumpswap',payload:tx()}]};}};
 const r=await runV29(db,{limit:2});
 assert.equal(r.sampledEventRows,1);
 assert.equal(r.afterEventRowId,99);
 assert.match(sql[0],/v.status='single_trade_candidate'/);
 assert.ok(sql.every(q=>!/(INSERT|UPDATE|DELETE)\s/i.test(q)));
});
test('bounded limit fails closed',()=>{
 assert.equal(v29Limit({}),1000);
 assert.throws(()=>v29Limit({S1B1_V29_LIMIT:'10001'}),/invalid_v29_limit/);
});
