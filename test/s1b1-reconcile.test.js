import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeBase58,PUMP_FUN,PUMP_SWAP,WSOL} from '../src/s1b1/decoder.js';
import {inspectReconciliation} from '../src/s1b1/reconcile.js';

const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYS='11111111111111111111111111111111';
const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encode(hex) {
 let n=BigInt(`0x${hex}`), encoded='';
 while(n){encoded=ALPHABET[Number(n%58n)]+encoded;n/=58n;}
 return encoded;
}
const data=disc=>encode(`${disc}${'00'.repeat(16)}`);
const rawBuy=data('66063d1201daebea');
const sig='fixture-signature',pool='pool',big=9_007_199_254_740_993n;
const ix=(programId,type,info,stackHeight=2)=>({programId,stackHeight,parsed:{type,info}});
const transfer=(source,destination,mint,amount,decimals=6,program=TOKEN)=>
 ix(program,'transferChecked',{source,destination,mint,tokenAmount:{amount:String(amount),decimals}});
function fixture({pump=false,wsol=false,token22=false}={}) {
 const baseProgram=token22?TOKEN22:TOKEN,quoteMint=wsol?WSOL:'quoteMint';
 const accounts=pump?['global','protocol','baseMint',pool,'poolBase','userBase','user',SYS,
  baseProgram,'creator','event',PUMP_FUN,'globalVolume','userVolume','feeConf','feeProgram']:
  [pool,'user','config','baseMint',quoteMint,'userBase','userQuote','poolBase','poolQuote',
   'protocol','protocolATA',baseProgram,TOKEN,SYS,ATA,'event',PUMP_SWAP,'creatorATA',
   'creator','globalVolume','userVolume','feeConf','feeProgram','remaining'];
 const keys=[...new Set(['payer',...accounts,'unrelated','unrelatedATA'])];
 const candidate={programId:pump?PUMP_FUN:PUMP_SWAP,data:rawBuy,accounts,stackHeight:1};
 const baseEdge=transfer('poolBase','userBase','baseMint',big,6,baseProgram);
 const quoteEdge=pump?ix(SYS,'transfer',{source:'user',destination:pool,lamports:20}):
  transfer('userQuote','poolQuote',quoteMint,20,wsol?9:6);
 const roleBalances=[['poolBase','baseMint',pool,baseProgram,big,0n],
  ['userBase','baseMint','user',baseProgram,0n,big],
  ...pump?[]:[['userQuote',quoteMint,'user',TOKEN,30n,10n],
   ['poolQuote',quoteMint,pool,TOKEN,0n,20n]]];
 const balances=index=>roleBalances.map(([key,mint,owner,programId,...amounts])=>({
  accountIndex:keys.indexOf(key),mint,owner,programId,
  uiTokenAmount:{amount:String(amounts[index]),decimals:mint===WSOL?9:6}
 }));
 const preBalances=keys.map(()=>100_000),postBalances=[...preBalances];
 postBalances[0]-=5000;
 if(pump){postBalances[keys.indexOf('user')]-=20;postBalances[keys.indexOf(pool)]+=20;}
 if(wsol){postBalances[keys.indexOf('userQuote')]-=20;postBalances[keys.indexOf('poolQuote')]+=20;}
 return {transaction:{signatures:[sig],message:{accountKeys:keys.map(pubkey=>({pubkey,signer:pubkey==='payer'||pubkey==='user'})),
   instructions:[candidate]}},meta:{err:null,fee:5000,preBalances,postBalances,
   innerInstructions:[{index:0,instructions:[baseEdge,quoteEdge]}],
   preTokenBalances:balances(0),postTokenBalances:balances(1)}};
}
const audit=(tx,watch=pool,venue='pumpswap')=>inspectReconciliation(watch,sig,venue,tx);
const inner=t=>t.meta.innerInstructions[0].instructions;
const index=(t,key)=>t.transaction.message.accountKeys.findIndex(k=>k.pubkey===key);

test('PumpSwap checks both mints including non-WSOL, and keeps exact local and global evidence separate',()=>{
 const r=audit(fixture());
 assert.equal(r.status,'reconciled_diagnostic');
 assert.deepEqual(r.candidates[0].base,{gross:big,credited:big,decimals:6});
 assert.equal(r.candidates[0].quote.gross,20n);
 assert.equal(r.candidates[0].quoteClass,'spl_quote');
 assert.equal(r.tokenBalances,'matched');assert.equal(r.lamportBalances,'matched');
 assert.equal(r.verifiedFills,0);
 const tx=fixture();tx.transaction.message.instructions.push(
  {...transfer('unrelatedATA','userBase','baseMint',7,6),stackHeight:1});
 tx.meta.postTokenBalances[1].uiTokenAmount.amount=String(big+7n);
 const more=audit(tx);
 assert.equal(more.candidates[0].base.gross,big);
 assert.equal(more.tokenBalances,'matched');assert.equal(more.otherTokenMovements,1);
});

test('Pump.fun quote is a scoped System Program transfer, payout is not inferred from wallet totals',()=>{
 const tx=fixture({pump:true});
 const r=audit(tx,pool,'pumpfun');
 assert.equal(r.status,'reconciled_diagnostic');
 assert.equal(r.candidates[0].quote.gross,20n);
 assert.equal(r.networkFeeLamports,5000n);
 inner(tx).pop();
 assert.equal(audit(tx,pool,'pumpfun').candidates[0].status,'missing_primary_transfer');
});

test('distinct CPI subtrees isolate two trades and a router sibling; deduplication belongs to the cohort',()=>{
 const tx=fixture();
 const trade=tx.transaction.message.instructions[0];
 const twice=inner(tx).map(x=>({...x,stackHeight:3}));
 tx.transaction.message.instructions=[{programId:'router'}];
 tx.meta.innerInstructions[0].instructions=[{...trade,stackHeight:2},...twice,
  transfer('unrelatedATA','userBase','baseMint',7),{...trade,stackHeight:2},...twice];
 const r=audit(tx);
 assert.deepEqual(r.candidates.map(c=>[c.innerIndex,c.base.gross]),[[0,big],[4,big]]);
 assert.equal(r.otherTokenMovements,1);
 assert.equal(r.tokenBalances,'mismatch');
});

test('new PumpSwap v2 layout uses the documented token-program and buyback accounts',()=>{
 const tx=fixture(),candidate=tx.transaction.message.instructions[0];
 candidate.data=data('b817ee6167c5d33d');
 candidate.accounts.splice(9,Infinity,TOKEN,TOKEN,SYS,'userVolume','feeConf','remaining','event',PUMP_SWAP);
 inner(tx).push(transfer('userQuote','remaining','quoteMint',2));
 tx.meta.postTokenBalances[2].uiTokenAmount.amount='8';
 const r=audit(tx);
 assert.equal(r.candidates[0].routing.buybackAccount,1);
 assert.equal(r.status,'reconciled_diagnostic');assert.equal(r.verifiedFills,0);
});

test('Pump.fun v2 routes non-native quote using its own IDL even with the shared discriminator',()=>{
 const tx=fixture(),candidate=tx.transaction.message.instructions[0];
 const pools=candidate.accounts;
 candidate.data=data('b817ee6167c5d33d');candidate.programId=PUMP_FUN;
 candidate.accounts=['global','baseMint','quoteMint',TOKEN,TOKEN,ATA,'protocol','protocolATA',
  'buyback','remaining',pool,'poolBase','poolQuote','user','userBase','userQuote',
  'creator','creatorATA','sharing','globalVolume','userVolume','volumeATA','feeConf',
  'feeProgram',SYS,'event',PUMP_FUN];
 for(const pubkey of candidate.accounts.filter(key=>!pools.includes(key)))
  if(index(tx,pubkey)===-1)tx.transaction.message.accountKeys.push({pubkey});
 const missing=tx.transaction.message.accountKeys.length-tx.meta.preBalances.length;
 tx.meta.preBalances.push(...Array(missing).fill(0));tx.meta.postBalances.push(...Array(missing).fill(0));
 assert.equal(audit(tx,pool,'pumpswap').status,'cross_venue_instruction');
 const r=audit(tx,pool,'pumpfun');
 assert.equal(r.status,'reconciled_diagnostic');assert.equal(r.candidates[0].quoteClass,'spl_quote');
});

test('a scoped Pump.fun sell event is checked against SPL base transfer and never fills the absent native payout',()=>{
 const tx=fixture({pump:true}),candidate=tx.transaction.message.instructions[0];
 const mint=PUMP_SWAP,user=WSOL,event=Buffer.alloc(105);
 candidate.data=data('33e685a4017f83ad');
 candidate.accounts.splice(8,2,'creator',TOKEN);candidate.accounts.length=14;
 candidate.accounts[2]=mint;candidate.accounts[6]=user;
 tx.transaction.message.accountKeys[index(tx,'user')].pubkey=user;
 tx.transaction.message.accountKeys[index(tx,'baseMint')].pubkey=mint;
 for(const b of [...tx.meta.preTokenBalances,...tx.meta.postTokenBalances]){
  b.mint=mint;if(b.owner==='user')b.owner=user;
 }
 Buffer.from('e445a52e51cb9a1dbddb7fd34ee661ee','hex').copy(event);
 decodeBase58(mint).copy(event,16);event.writeBigUInt64LE(20n,48);event.writeBigUInt64LE(big,56);
 decodeBase58(user).copy(event,65);
 const eventIx={programId:PUMP_FUN,stackHeight:2,accounts:['event'],data:encode(event.toString('hex'))};
 tx.meta.innerInstructions[0].instructions=[transfer('userBase','poolBase',mint,big),eventIx];
 const r=audit(tx,pool,'pumpfun');
 assert.equal(r.candidates[0].curveEvent,'token_amount_matches_program_claim');
 assert.equal(r.candidates[0].quote,null);
 assert.equal(r.candidates[0].status,'missing_primary_transfer');
 eventIx.accounts=['unrelated'];
 assert.equal(audit(tx,pool,'pumpfun').candidates[0].status,'curve_event_conflict');
});

test('nonce withdrawal and fee payer are reconciled outside swap scope',()=>{
 const tx=fixture();
 tx.transaction.message.instructions.push(ix(SYS,'withdrawFromNonce',{
  nonceAccount:'unrelated',destination:'payer',lamports:10500
 },1));
 const nonce=index(tx,'unrelated');
 tx.meta.postBalances[nonce]-=10500;
 tx.meta.postBalances[0]+=10500;
 assert.equal(audit(tx).lamportBalances,'matched');
 tx.meta.preBalances[0]=200;
 tx.meta.postBalances[0]=5700;
 assert.equal(audit(tx).lamportBalances,'unmodeled');
});

test('explicit Token-2022 fee is subtracted only from destination credit; plain checked extension remains unproven',()=>{
 const tx=fixture({token22:true}),edge=inner(tx)[0];
 assert.equal(audit(tx).tokenBalances,'token2022_fee_unknown');
 edge.parsed.type='transferCheckedWithFee';
 edge.parsed.info.feeAmount={amount:'3',decimals:6};
 tx.meta.postTokenBalances[1].uiTokenAmount.amount=String(big-3n);
 const r=audit(tx);
 assert.equal(r.tokenBalances,'matched');assert.equal(r.candidates[0].base.credited,big-3n);
 edge.parsed.info.feeAmount.decimals=5;
 assert.equal(audit(tx).status,'incomplete_or_ambiguous');
});

test('ordered ATA initialization, wrap, sync and closure reconcile temporary WSOL with rent and fee kept separate',()=>{
 const tx=fixture({wsol:true}),keys=tx.transaction.message.accountKeys;
 const ata='userQuote',a=index(tx,ata),user=index(tx,'user'),vault=index(tx,'poolQuote');
 const trade=tx.transaction.message.instructions[0];
 tx.transaction.message.instructions=[ix(ATA,'create',{account:ata,wallet:'user',mint:WSOL},1),
  ix(SYS,'transfer',{source:'user',destination:ata,lamports:30},1),
  ix(TOKEN,'syncNative',{account:ata},1),trade,
  ix(TOKEN,'closeAccount',{account:ata,destination:'user',owner:'user'},1)];
 tx.meta.innerInstructions[0].index=3;
 tx.meta.innerInstructions.unshift({index:0,instructions:[
  ix(SYS,'createAccount',{source:'user',newAccount:ata,owner:TOKEN,lamports:80}),
  ix(TOKEN,'initializeAccount3',{account:ata,owner:'user',mint:WSOL})]});
 tx.meta.preTokenBalances=tx.meta.preTokenBalances.filter(x=>x.accountIndex!==a);
 tx.meta.postTokenBalances=tx.meta.postTokenBalances.filter(x=>x.accountIndex!==a);
 tx.meta.preBalances[a]=tx.meta.postBalances[a]=0;
 tx.meta.postBalances[user]=tx.meta.preBalances[user]-20;
 assert.equal(keys[vault].pubkey,'poolQuote');
 const r=audit(tx);
 assert.equal(r.tokenBalances,'matched');assert.equal(r.lamportBalances,'matched');
 assert.equal(r.lifecycleRoles,1);assert.equal(r.networkFeeLamports,5000n);
 tx.meta.innerInstructions[0].instructions.pop();
 assert.equal(audit(tx).tokenBalances,'native_sync_or_reserve_unproven');
});

test('fail closed on missing or conflicting evidence and preserve unsupported venues',()=>{
 const controls=[
  [t=>{t.meta.err={InstructionError:[0,'custom']};},'failed_onchain'],
  [t=>{delete t.meta.err;},'transaction_status_unknown'],
  [t=>{t.transaction.signatures.unshift('other');},'signature_mismatch'],
  [t=>{t.meta.innerInstructions=null;},'incomplete_trace'],
  [t=>{t.meta.innerInstructions.push(t.meta.innerInstructions[0]);},'incomplete_trace'],
  [t=>{t.meta.logMessages=['Log truncated'];},'incomplete_trace'],
  [t=>{t.meta.logMessages={truncated:true};},'incomplete_trace'],
  [t=>{t.transaction.message.accountKeys.push({pubkey:'poolBase'});},'nonunique_account_mapping'],
  [t=>{inner(t).push(inner(t)[0]);},'incomplete_or_ambiguous'],
  [t=>{inner(t)[0].parsed.info.tokenAmount.decimals=undefined;},'incomplete_or_ambiguous'],
  [t=>{inner(t).push(transfer('userQuote','unrelatedATA','quoteMint',1));},'incomplete_or_ambiguous'],
  [t=>{inner(t).push(transfer('userQuote','remaining','quoteMint',1));},'incomplete_or_ambiguous'],
  [t=>{t.meta.postTokenBalances=[];},'incomplete_or_ambiguous'],
  [t=>{t.meta.postTokenBalances[0].owner='impostor';},'incomplete_or_ambiguous'],
  [t=>{t.meta.preTokenBalances[0].programId=TOKEN22;},'incomplete_or_ambiguous'],
  [t=>{t.transaction.message.instructions.push({programId:TOKEN,data:'unknown'});},'incomplete_or_ambiguous'],
 ];
 for(const [mutate,status] of controls){const tx=fixture();mutate(tx);assert.equal(audit(tx).status,status,mutate.toString());}
 assert.equal(audit(fixture(),'wrong-pool').status,'watched_pool_mismatch');
 assert.equal(audit(fixture(),pool,'meteora').status,'unsupported_venue');
 assert.equal(audit(fixture({pump:true}),pool,'pumpswap').status,'cross_venue_instruction');
 const wrongNativeDecimals=fixture({wsol:true});
 inner(wrongNativeDecimals)[1].parsed.info.tokenAmount.decimals=6;
 assert.equal(audit(wrongNativeDecimals).candidates[0].quote,null);
});
