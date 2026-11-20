import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase58, decodeObservedTransaction, ratioToDecimal, PUMP_FUN, PUMP_SWAP, WSOL } from '../src/s1b1/decoder.js';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) { let n=BigInt('0x'+Buffer.from(buf).toString('hex'));let s='';while(n>0n){s=alphabet[Number(n%58n)]+s;n/=58n;}for(const b of buf){if(b!==0)break;s='1'+s;}return s||'1'; }
const pool='Pool1111111111111111111111111111111111';
const wallet='Wallet11111111111111111111111111111111';
const mint='Mint111111111111111111111111111111111';
const baseAcc='UserBase111111111111111111111111111111';
const quoteAcc='UserQuote1111111111111111111111111111';
const sig='S'.repeat(85);
const buy=b58([102,6,61,18,1,218,235,234,0]);
const sell=b58([51,230,133,164,1,127,131,173,0]);
function balances(idx,m,pre,post,decimals=6){return [{accountIndex:idx,mint:m,owner:wallet,uiTokenAmount:{amount:String(pre),decimals}}, {accountIndex:idx,mint:m,owner:wallet,uiTokenAmount:{amount:String(post),decimals}}];}
function swapTx({side='BUY',program=PUMP_SWAP, quoteMint=WSOL,version=1,baseChange=500n,quoteChange=-10000000n,wrongSigner=false}={}){
 const keys=[pool,wallet,'cfg',mint,quoteMint,baseAcc,quoteAcc].map(x=>({pubkey:x,signer:x===wallet&&!wrongSigner}));
 const accounts=keys.map(k=>k.pubkey);
 const instr={programId:program,accounts, data:side==='BUY'?buy:sell};
 const bb=balances(5,mint,1000n,1000n+baseChange);
 const qb=balances(6,quoteMint,20000000n,20000000n+quoteChange,9);
 return {version, meta:{err:null,preTokenBalances:[bb[0],qb[0]],postTokenBalances:[bb[1],qb[1]]},
    transaction:{message:{accountKeys:keys,instructions:[instr]}}};
}
test('base58 discriminator conversion is lossless',()=>assert.equal(decodeBase58(buy).subarray(0,8).toString('hex'), Buffer.from([102,6,61,18,1,218,235,234]).toString('hex')));
test('invalid base58 is fail closed',()=>assert.equal(decodeBase58('0$'),null));
test('exact fixed-point price uses BigInt',()=>assert.equal(ratioToDecimal(10000000n,9,500n,6),'20'));
test('PumpSwap v1 BUY matches wallet-owned token/WSOL deltas',()=>{const d=decodeObservedTransaction(pool,sig,swapTx());assert.equal(d.status,'matched_quote_delta');assert.equal(d.side,'BUY');assert.equal(d.priceSol,'20');assert.equal(d.quoteAmountRaw,'10000000');});
test('PumpSwap SELL matches reverse deltas',()=>{const d=decodeObservedTransaction(pool,sig,swapTx({side:'SELL',baseChange:-500n,quoteChange:10000000n}));assert.equal(d.status,'matched_quote_delta');assert.equal(d.side,'SELL');});
test('PumpSwap non-WSOL quote has no SOL price',()=>{const d=decodeObservedTransaction(pool,sig,swapTx({quoteMint:'OtherQuoteMint'}));assert.equal(d.status,'matched_quote_delta');assert.equal(d.priceSol,null);assert.equal(d.priceQuotePerBase,'20');});
test('transaction failed on-chain is never a swap',()=>{const tx=swapTx();tx.meta.err={InstructionError:[0,'Custom']}; const d=decodeObservedTransaction(pool,sig,tx);assert.equal(d.status,'failed_onchain');assert.equal(d.side,null);});
test('missing wallet signature is ambiguous',()=>{const d=decodeObservedTransaction(pool,sig,swapTx({wrongSigner:true}));assert.equal(d.status,'ambiguous');assert.equal(d.priceSol,null);});
test('multiple DEX instructions cannot be priced from net deltas',()=>{const tx=swapTx();tx.transaction.message.instructions.push(tx.transaction.message.instructions[0]);assert.equal(decodeObservedTransaction(pool,sig,tx).reason,'multiple_dex_instructions');});
test('conflicting balance owners are not accepted as price',()=>{const tx=swapTx();tx.meta.preTokenBalances[0].owner='OtherWallet';assert.equal(decodeObservedTransaction(pool,sig,tx).status,'ambiguous');});
test('wrong watched pool is not labeled a swap',()=>{const d=decodeObservedTransaction('UnknownPool',sig,swapTx());assert.equal(d.status,'unrelated_pool');});
test('Pump.fun legacy trade may have proven direction but no fabricated price',()=>{const tx=swapTx({program:PUMP_FUN});tx.transaction.message.instructions[0].accounts=[ 'global','fee',mint,pool,'bondingAta',baseAcc,wallet];const d=decodeObservedTransaction(pool,sig,tx);assert.equal(d.status,'direction_only');assert.equal(d.side,'BUY');assert.equal(d.priceSol,null);});
test('unsupported unknown instruction discriminator does not guess a side',()=>{const tx=swapTx();tx.transaction.message.instructions[0].data=b58([1,2,3,4,5,6,7,8,0]);const d=decodeObservedTransaction(pool,sig,tx);assert.equal(d.status,'unsupported_variant');assert.equal(d.side,null);});
test('unrecognized program is not a trade',()=>{const tx=swapTx();tx.transaction.message.instructions[0].programId='AnotherProgram';assert.equal(decodeObservedTransaction(pool,sig,tx).status,'unsupported_dex');});
test('missing WSOL balance falls back to direction_only',()=>{const tx=swapTx();tx.meta.preTokenBalances.pop();tx.meta.postTokenBalances.pop();assert.equal(decodeObservedTransaction(pool,sig,tx).status,'direction_only');});
test('signature mismatch fails closed',()=>{const tx=swapTx();tx.transaction.signatures=['different'];assert.equal(decodeObservedTransaction(pool,sig,tx).reason,'signature_mismatch');});
test('token balance without any proven owner is not attributed',()=>{const tx=swapTx();delete tx.meta.preTokenBalances[0].owner;delete tx.meta.postTokenBalances[0].owner;assert.equal(decodeObservedTransaction(pool,sig,tx).status,'ambiguous');});
