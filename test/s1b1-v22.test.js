import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_FUN,PUMP_SWAP} from '../src/s1b1/decoder.js';
import {inspectAuthorityEvidence,createAuthoritySummary} from '../src/s1b1/v22-authority.js';
import {runAuthorityReport,authorityLimit} from '../src/s1b1/v22-report.js';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes){
 let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),s='';
 while(n>0n){s=alphabet[Number(n%58n)]+s;n/=58n;}
 return s;
}
const data=b58([102,6,61,18,1,218,235,234,0]);
const pool='watched',user='agent',signature='sig';
const pumpAccounts=['g','fee','mint',pool,'abc','ata',user,
 'system','token','creator','event','program','globalVol','userVol','feeConf','feeProg'];
function fixture({program=PUMP_FUN,accounts=pumpAccounts,scope='inner',outerProgram='router',
 signer=false,err=null}={}){
 const ix={programId:program,accounts,data};
 return {transaction:{message:{accountKeys:[{pubkey:user,signer}],
  instructions:scope==='inner'?[{programId:outerProgram,data:'',accounts:[]}]:[ix]},signatures:[signature]},
  meta:{err,innerInstructions:scope==='inner'?[{index:0,instructions:[ix]}]:[]}};
}
test('V2.2 evaluates official-IDL index and signer flag separately',()=>{
 const a=inspectAuthorityEvidence(pool,signature,fixture());
 assert.equal(a.status,'idl_index_match_authority_unverified');
 assert.equal(a.authority,'user_not_tx_signer');
 assert.equal(a.scope,'inner');
 assert.equal(a.outerInstructionProgram,'router');
 assert.equal(a.idlAccountsPresent,true);
 assert.equal(a.verifiedFill,false);
 assert.equal(a.economicsAuthorized,false);
});
test('transaction signer present does not authorize a fill',()=>{
 const a=inspectAuthorityEvidence(pool,signature,fixture({scope:'outer',signer:true}));
 assert.equal(a.authority,'user_tx_signer_confirmed');
 assert.equal(a.status,'idl_index_match_authority_unverified');
 assert.equal(a.verifiedPrice,false);
});
test('incomplete account list remains unverified',()=>{
 const a=inspectAuthorityEvidence(pool,signature,fixture({accounts:pumpAccounts.slice(0,7)}));
 assert.equal(a.status,'idl_account_count_short');
 assert.equal(a.idlAccountsPresent,false);
});
test('pool mismatch is explicit and never a valid fill',()=>{
 const a=inspectAuthorityEvidence('different',signature,fixture());
 assert.equal(a.status,'watched_pool_mismatch');
 assert.equal(a.verifiedFill,false);
});
test('PumpSwap IDL account check uses pool index zero',()=>{
 const accounts=[pool,user,'config','base','quote','userBase','userQuote','poolBase',
  'poolQuote','fee','feeATA','baseProgram','quoteProgram','sys','ata','event','program',
  'coinCreator','creatorAuth','globalVol','userVol','feeConfig','feeProgram'];
 const a=inspectAuthorityEvidence(pool,signature,fixture({program:PUMP_SWAP,accounts,signer:true,scope:'outer'}));
 assert.equal(a.status,'idl_index_match_authority_unverified');
 assert.equal(a.candidateProgram,'pumpswap');
 assert.equal(a.idlAccountCount,23);
});
test('failed transaction and signature mismatch do not proceed',()=>{
 assert.equal(inspectAuthorityEvidence(pool,'not-sig',fixture()).status,'signature_mismatch');
 assert.equal(inspectAuthorityEvidence(pool,signature,fixture({err:{InstructionError:[0,'Custom']}})).status,'transaction_failed');
});
test('summary is read-only and redacts full signature and pool',()=>{
 const sum=createAuthoritySummary();
 sum.add({pool_address:pool,signature,venue_family:'pumpfun',payload:fixture()});
 const o=sum.result();
 assert.equal(o.sampledEventRows,1);
 assert.equal(o.byAuthority[0].key,'user_not_tx_signer');
 assert.equal(o.verifiedFills,0);
 assert.ok(!JSON.stringify(o).includes('"watched"'));
 assert.ok(!JSON.stringify(o).includes('"sig"'));
});
test('bounded SQL reads candidate rows only',async()=>{
 const calls=[];let done=false;
 const client={query:async(q,args)=>{
  calls.push(q);if(done)return {rows:[]};
  done=true;
  return {rows:[{id:1,pool_address:pool,signature,venue_family:'pumpfun',payload:fixture()}]};
 }};
 const report=await runAuthorityReport(client,{limit:2});
 assert.equal(report.sampledEventRows,1);
 assert.ok(calls[0].includes("v.status='single_trade_candidate'"));
 assert.ok(calls.every(q=>!/(INSERT|UPDATE|DELETE)\s/i.test(q)));
});
test('limits fail closed',()=>{
 assert.equal(authorityLimit({}),1000);
 assert.throws(()=>authorityLimit({S1B1_V22_LIMIT:0}),/invalid_v22_limit/);
});
