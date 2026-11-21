import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {append,artifactRecord,checkpoint,openStore,records} from '../src/forward/store.js';
import {authenticate,canonical,DAY,hash,MAINNET,manifestRecord,PROGRAM,readPolicy,signedPayload,VERSION} from '../src/forward/contract.js';
import {blockIdentity,collectArchive,rpcTransport} from '../src/forward/archive.js';
import {buildSegment} from '../src/forward/continuity.js';
import {qualifyForward} from '../src/forward/report.js';
import {encode58,verifyWire} from '../src/forward/wire.js';
import {adjudicate,availableBlocks,confirmedReceipt,vettedDeployments,vettedPools} from '../src/forward/evidence.js';
import {decodeBase58} from '../src/s1b1/decoder.js';
import {SYSTEM,TOKEN,TOKEN_2022} from '../src/s1b1/reconcile-trace.js';
import {forwardCommand} from '../src/forward/cli.js';

const bytes=x=>createHash('sha256').update(x).digest();
const address=x=>encode58(bytes(x));
const iso=t=>new Date(t).toISOString();
const genesis=address('fixture-cluster');
const loader='BPFLoaderUpgradeab1e11111111111111111111111';
const fixtureProof=artifactRecord(Buffer.from('Synthetic independent archive, execution and quote fixtures.'));
const PROOF=fixtureProof.body.sha256;
const authorityRoles={alpha:'chain',beta:'chain',history:'history',replay:'execution',survey:'census',quote:'market',
 strategy:'strategy',clock:'clock'};
const keys=Object.fromEntries(Object.keys(authorityRoles).map(id=>[id,generateKeyPairSync('ed25519')]));
const signer=generateKeyPairSync('ed25519');
const trader=encode58(signer.publicKey.export({type:'spki',format:'der'}).subarray(-32));

function settings(overrides={}){
 const raw={version:VERSION,network:'fixture',genesis,layouts:[{program:PROGRAM.pumpswap,idlDigest:PROOF}],
  authorities:Object.entries(authorityRoles).map(([id,role])=>({id,organization:id,roles:[role],
   publicKey:keys[id].publicKey.export({format:'pem',type:'spki'})})),...overrides};
 return {raw,policy:readPolicy(raw)};
}
function signed(policy,kind,issuer,body){
 const payload=signedPayload({kind,issuer,policy:policy.digest,body});
 return {...payload,signature:sign(null,Buffer.from(canonical(payload)),keys[issuer].privateKey).toString('base64')};
}
async function tempStore(t){
 const root=await mkdtemp(join(tmpdir(),'solaris-forward-test-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,dir:await openStore(join(root,'store'),{create:true})};
}
function wire(id,program,ixAccounts,data,{v0=false,extraKeys=[]}={}){
 const accounts=[...new Set([trader,...ixAccounts,...extraKeys,program])];
 const signedMessage=Buffer.concat([Buffer.from([...(v0?[128]:[]),1,0,0,accounts.length]),
  ...accounts.map(decodeBase58),bytes(id),Buffer.from([1,accounts.indexOf(program),ixAccounts.length,
   ...ixAccounts.map(account=>accounts.indexOf(account)),data.length]),data,...(v0?[Buffer.from([0])]:[])]);
 const signature=sign(null,signedMessage,signer.privateKey);
 return {wire:Buffer.concat([Buffer.from([1]),signature,signedMessage]).toString('base64'),signature:encode58(signature),accounts};
}
function receipt(tx,meta={err:null,fee:5000}){
 return {wire:tx.wire,signature:tx.signature,outcome:meta.err===null?'success':'failed',fee:String(meta.fee),meta,metaDigest:hash(meta)};
}
function block(slot,parent,time,transactions=[]){
 return {slot,parentSlot:parent,genesis,blockhash:address(`slot:${slot}`),previousBlockhash:address(`slot:${parent}`),
  blockTime:iso(time),roster:transactions.map(r=>r.signature),transactions};
}
const ref=(block,tx)=>({slot:block.slot,blockhash:block.blockhash,signature:tx.signature,outerIndex:0,innerIndex:-1});

function poolFixture(label,{native=false,token22=false}={}){
 const p={address:address(`${label}:pool`),venue:'pumpswap',baseMint:address(`${label}:base`),
  quoteMint:address(`${label}:quote`),baseVault:address(`${label}:baseVault`),quoteVault:address(`${label}:quoteVault`),
  baseTokenProgram:token22?TOKEN_2022:TOKEN,quoteTokenProgram:TOKEN,recipients:[],evidenceDigest:PROOF};
 p.vaultOwner=p.address;
 if(native){p.venue='pumpfun';p.quoteMint='So11111111111111111111111111111111111111112';p.quoteVault=p.address;p.quoteTokenProgram=SYSTEM;}
 const creation=native?[p.baseMint,address('mint-authority'),p.address,p.baseVault,address(`${label}:global`),trader,
  SYSTEM,p.baseTokenProgram]:[p.address,address(`${label}:global`),trader,p.baseMint,p.quoteMint,address('lpMint'),
  address('userBase'),address('userQuote'),address('userLP'),p.baseVault,p.quoteVault,SYSTEM,TOKEN_2022,p.baseTokenProgram,TOKEN];
 const tx=wire(`create:${label}`,PROGRAM[p.venue],creation,Buffer.from(native?'d6904cec5f8b31b4':'e992d18ecf6840bc','hex'));
 return {p,tx};
}
function transferBytes(amount,decimals,fee){
 const data=Buffer.alloc(fee===undefined?10:19);
 if(fee===undefined){data[0]=12;data.writeBigUInt64LE(BigInt(amount),1);data[9]=decimals;}
 else{data[0]=26;data[1]=1;data.writeBigUInt64LE(BigInt(amount),2);data[10]=decimals;data.writeBigUInt64LE(BigInt(fee),11);}
 return data;
}
function observedTrade(p,id,{wrongCpi=false,extraCpi=false,fee=0}={}){
 const baseUser=address('userBase'),quoteUser=address('userQuote');
 const native=p.quoteTokenProgram===SYSTEM;
 const ixAccounts=native?[address('global'),address('protocol'),p.baseMint,p.address,p.baseVault,baseUser,trader,SYSTEM,
  address('creator'),p.baseTokenProgram,address('event'),PROGRAM.pumpfun,address('feeCfg'),address('feeProgram')]:
  [p.address,trader,address('global'),p.baseMint,p.quoteMint,baseUser,quoteUser,p.baseVault,p.quoteVault,address('protocol'),
   address('protocolAta'),p.baseTokenProgram,p.quoteTokenProgram,SYSTEM,address('ata'),address('event'),PROGRAM.pumpswap,
   address('creatorAta'),address('creator'),address('globalVolume'),address('userVolume'),address('feeCfg'),address('feeProgram')];
 const tx=wire(id,PROGRAM[p.venue],ixAccounts,Buffer.from(`${native?'33e685a4017f83ad':'66063d1201daebea'}${'00'.repeat(16)}`,'hex'));
 const edge=(mint,program,source,destination,sourceOwner,destinationOwner,debit,credit,decimals,movementIndex)=>
  ({mint,tokenProgram:program,source,destination,sourceOwner,destinationOwner,debit:String(debit),credit:String(credit),
   withheld:String(debit-credit),decimals,movementIndex,tokenFeeProof:PROOF});
 const base=native?edge(p.baseMint,p.baseTokenProgram,baseUser,p.baseVault,trader,p.address,10,10-fee,6,0):
  edge(p.baseMint,p.baseTokenProgram,p.baseVault,baseUser,p.address,trader,10,10-fee,6,0);
 const quote=native?edge(p.quoteMint,SYSTEM,p.address,trader,p.address,trader,20,20,9,null):
  edge(p.quoteMint,p.quoteTokenProgram,quoteUser,p.quoteVault,trader,p.address,20,20,6,1);
 const cpi=[base,...native?[]:[quote]].map(e=>({programIdIndex:tx.accounts.indexOf(e.tokenProgram),
  accounts:[e.source,e.mint,e.destination,e.sourceOwner].map(a=>tx.accounts.indexOf(a)),
  data:encode58(transferBytes(wrongCpi?BigInt(e.debit)+1n:e.debit,e.decimals,e.tokenProgram===TOKEN_2022?e.withheld:undefined)),stackHeight:2}));
 if(extraCpi)cpi.push(cpi[0]);
 const lamports=tx.accounts.map(()=>100000),after=[...lamports];after[0]-=5000;
 const lamportMovements=[];
 if(native){
  after[0]+=20;after[tx.accounts.indexOf(p.address)]-=20;
  lamportMovements.push({kind:'native_swap',source:p.address,destination:trader,amount:'20',evidenceDigest:PROOF});
 }
 const meta={err:null,fee:5000,preBalances:lamports,postBalances:after,
  innerInstructions:[{index:0,instructions:cpi}]};
 const w=receipt(tx,meta);
 return {w,tx,fill:{decision:'accept',method:'independent-replay-v1',trader,replayDigest:PROOF,ownerProof:PROOF,feeProof:PROOF,
  ...{wireDigest:verifyWire(w.wire,w.signature).wireDigest,metaDigest:w.metaDigest},side:native?'sell':'buy',
  quoteMode:native?'native-replay':'token-replay',base,quote,recipientTransfers:[],networkFee:'5000',feePayer:trader,lamportMovements}};
}

test('signed wire checks reject forged bytes and leading signature substitutions, and support v0',()=>{
 const a=wire('a',SYSTEM,[trader],Buffer.from([1]),{v0:true}),b=wire('b',SYSTEM,[trader],Buffer.from([1]));
 assert.equal(verifyWire(a.wire,a.signature).accounts[0],trader);
 assert.throws(()=>verifyWire(a.wire,b.signature),/wire_signature_mismatch/);
 const modified=Buffer.from(b.wire,'base64');modified[modified.length-1]^=1;
 assert.throws(()=>verifyWire(modified.toString('base64'),b.signature),/invalid_transaction_signature/);
});

test('private store appends idempotently, pins replay and detects tampering',async t=>{
 const {root,dir}=await tempStore(t),{policy}=settings();
 await assert.rejects(openStore(root,{create:true}),{code:'EEXIST'});
 const a=await append(dir,fixtureProof);
 assert.equal(await append(dir,fixtureProof),a);
 const point=await checkpoint(dir);
 await append(dir,{version:VERSION,kind:'capture',body:{policy:policy.digest}});
 assert.equal((await qualifyForward(dir,policy)).unsignedRpcCaptures,1);
 assert.equal((await qualifyForward(dir,policy,{checkpoint:point})).unsignedRpcCaptures,0);
 await writeFile(join(dir,`${a}.json`),'{}');
 await assert.rejects(qualifyForward(dir,policy),/evidence_integrity_failure/);
});

test('role, organization quorum, network and chain parent tampering fail closed',()=>{
 const {policy}=settings(),body=block(10,9,0),single=signed(policy,'block','alpha',body);
 assert.throws(()=>authenticate({...single,body:{...body,slot:11}},policy),/invalid_attestation/);
 const untrusted=signed(policy,'block','history',body);
 assert.throws(()=>authenticate(untrusted,policy),/invalid_attestation/);
 const a=authenticate(single,policy);
 assert.equal(availableBlocks([a,{...a,issuer:'alias'}],genesis).blocks.size,0);
 const other=authenticate(signed(policy,'block','beta',{...body,blockhash:address('fork')}),policy);
 assert.equal(availableBlocks([a,other],genesis).conflicts.size,1);
 assert.throws(()=>buildSegment(genesis,[blockIdentity(body),blockIdentity(block(12,11,DAY))]),/segment_parent_discontinuity/);
 assert.throws(()=>settings({network:'mainnet'}),/invalid_trust_policy/);
});

test('archive spends durable weighted budgets, paces calls, preserves unresolved slots and stops on 429',async t=>{
 const {dir}=await tempStore(t),{policy}=settings();
 let now=Date.parse('2026-10-01T12:00:00Z');const at=[];
 const transport=async(method,params)=>{
  at.push(now);
  if(method==='getGenesisHash')return {status:'available',value:genesis};
  if(params[0]===1)return {status:'missing',reason:'no_finalized_block'};
  return {status:'rate_limited',waitMs:600000};
 };
 const options={policy,source:'alpha',requests:[1,2,3].map(slot=>({slot,signatures:[]})),transport,now:()=>now,
  sleep:async ms=>{now+=ms;}};
 const first=await collectArchive(dir,options);
 assert.equal(first.requests,3);assert.equal(first.units,9);assert.equal(first.counts.missing,1);
 assert.equal(first.counts.rate_limited,1);assert.equal(first.counts.deferred,1);
 assert.deepEqual(at.map(x=>x-at[0]),[0,1000,2000]);
 const second=await collectArchive(dir,{...options,source:'beta'});
 assert.equal(second.requests,0);assert.equal(second.counts.deferred,3);
 now+=600000;
 assert.equal((await collectArchive(dir,{...options,maxUnits:4})).requests,1);
 assert.equal((await qualifyForward(dir,policy)).sourceEvidence.unresolvedCaptureGaps,9);
 assert.throws(()=>rpcTransport('http://example.invalid'),/https_archival_endpoint_required/);
 await assert.rejects(rpcTransport('https://example.invalid')('sendTransaction',[],1),/rpc_method_not_allowed/);
});

test('standalone archival getBlock adapter captures unsigned evidence, never promotes it',async t=>{
 const {dir}=await tempStore(t),{policy}=settings();
 const tx=wire('fetch',SYSTEM,[trader],Buffer.from([1])),time=Date.parse('2026-10-01T12:00:00Z');let now=time;
 const transport=rpcTransport('https://archive.invalid/fixture',async(_url,opt)=>{
  const request=JSON.parse(opt.body);
  const result=request.method==='getGenesisHash'?genesis:{parentSlot:9,blockhash:address('slot:10'),
   previousBlockhash:address('slot:9'),blockTime:time/1000,...request.params[1].transactionDetails==='signatures'?
    {signatures:[tx.signature]}:{transactions:[{transaction:[tx.wire,'base64'],meta:{err:null,fee:5000}}]}};
  if(request.method==='getBlock')assert.equal(request.params[1].commitment,'finalized');
  return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
 });
 const run=await collectArchive(dir,{policy,source:'alpha',requests:[{slot:10,signatures:[tx.signature]}],transport,
  now:()=>now,sleep:async ms=>{now+=ms;}});
 assert.equal(run.counts.available,1);assert.equal(run.counts.unresolvedWitnesses,0);
 assert.equal(run.units,21);
 const report=await qualifyForward(dir,policy);
 assert.equal(report.unsignedRpcCaptures,1);assert.equal(report.sourceEvidence.agreedBlocks,0);
 assert.ok(!JSON.stringify(report).includes(tx.signature));
});

test('a requested witness gap survives header agreement until both archives supply the receipt',async t=>{
 const {dir}=await tempStore(t),{policy}=settings();
 const tx=wire('gap',SYSTEM,[trader],Buffer.from([1])),body=block(10,9,1000,[receipt(tx)]);
 const header={...body,transactions:[]};
 await append(dir,{version:VERSION,kind:'capture_gap',body:{policy:policy.digest,slot:10,signature:tx.signature,status:'unavailable'}});
 for(const issuer of ['alpha','beta'])await append(dir,signed(policy,'block',issuer,header));
 assert.equal((await qualifyForward(dir,policy)).sourceEvidence.unresolvedCaptureGaps,1);
 await append(dir,signed(policy,'block','alpha',body));
 assert.equal((await qualifyForward(dir,policy)).sourceEvidence.unresolvedCaptureGaps,1);
 await append(dir,signed(policy,'block','beta',body));
 assert.equal((await qualifyForward(dir,policy)).sourceEvidence.unresolvedCaptureGaps,0);
});

function executionContext({native=false,fee=0,wrongCpi=false,extraCpi=false,wrongProgram=false}={}){
 const {policy}=settings({layouts:[{program:PROGRAM[native?'pumpfun':'pumpswap'],idlDigest:PROOF}]}),t=Date.parse('2026-10-01');
 const fixture=poolFixture('checked',{native,token22:fee>0}),p=fixture.p;
 const programData=address('program-data');
 const upgrade=wire('upgrade',loader,wrongProgram?[programData,address('different-program'),PROGRAM[p.venue]]:
  [programData,PROGRAM[p.venue]],Buffer.from('03000000','hex'));
 const a=block(1,0,t-DAY,[receipt(upgrade)]),b=block(2,1,t-1000,[receipt(fixture.tx)]);
 const trade=observedTrade(p,'checked-trade',{wrongCpi,extraCpi,fee});
 const c=block(3,2,t+1000,[trade.w]);
 const sourceEntries=[a,b,c].flatMap(x=>['alpha','beta'].map(id=>authenticate(signed(policy,'block',id,x),policy)));
 const blocks=availableBlocks(sourceEntries,genesis).blocks,proofs=new Set([PROOF]);
 const deployment=authenticate(signed(policy,'deployment','history',{program:PROGRAM[p.venue],programData,idlDigest:PROOF,
  binaryDigest:PROOF,evidenceDigest:PROOF,activation:ref(a,upgrade),fromSlot:2,untilSlot:50}),policy);
 const poolEntry=authenticate(signed(policy,'pool','history',{...p,creation:ref(b,fixture.tx),fromSlot:2,untilSlot:50}),policy);
 const deployments=vettedDeployments([deployment],blocks,{...policy,proofs});
 const pools=vettedPools([poolEntry],blocks,proofs);
 const attempt=ref(c,trade.tx),witness=confirmedReceipt(blocks,attempt);
 const fill=authenticate(signed(policy,'fill','replay',{...trade.fill,...attempt,deployment:deployment.digest,poolProof:poolEntry.digest}),policy);
 const run=(entry=fill,stored=pools[0],pinned=deployments)=>adjudicate(entry,attempt,stored,pinned,witness,new Set(['alpha','beta']),proofs);
 return {run,fill,pools,deployments,attempt};
}

test('instruction-level adjudication checks witnesses, economic owners, Token-2022 fee, and native sell lamports',()=>{
 const fee=executionContext({fee:2});assert.equal(fee.run(),'verified');
 const normal=executionContext();assert.equal(normal.run(),'verified');
 const native=executionContext({native:true});assert.equal(native.run(),'verified');
 assert.equal(executionContext({wrongCpi:true}).run(),'instruction_amount_unproven');
 assert.equal(executionContext({extraCpi:true}).run(),'unaccounted_instruction_activity');
 assert.equal(executionContext({wrongProgram:true}).run(),'deployment_unverified');
 assert.equal(normal.run({...normal.fill,organization:'alpha'}),'untrusted_adjudication');
 assert.equal(normal.run({...normal.fill,body:{...normal.fill.body,feePayer:address('not payer')}}),'lamport_replay_disagrees');
 assert.equal(normal.run({...normal.fill,body:{...normal.fill.body,base:{...normal.fill.body.base,sourceOwner:address('wrong owner')}}}),
  'unverified_economic_owners');
 assert.equal(normal.run(normal.fill,normal.pools[0],[]),'deployment_unverified');
 assert.equal(fee.run({...fee.fill,body:{...fee.fill.body,base:{...fee.fill.body.base,credit:'7',withheld:'3'}}}),
  'instruction_amount_unproven');
 assert.equal(native.run({...native.fill,body:{...native.fill.body,lamportMovements:[]}}),'lamport_replay_disagrees');
 const original=native.fill.body,move=original.lamportMovements[0];
 assert.equal(native.run({...native.fill,body:{...original,quote:{...original.quote,debit:'10',credit:'10'},
  lamportMovements:[{...move,amount:'10'},{...move,amount:'10',kind:'unrelated'}]}}),'lamport_replay_disagrees');
});

async function replayFixture(dir){
 const {policy,raw}=settings(),start=Date.parse('2026-08-01T00:00:00Z');
 const assets=Array.from({length:40},(_,i)=>poolFixture(`asset-${i}`));
 const windows={};
 for(const [i,name] of ['development','forward'].entries())windows[name]={from:iso(start+i*31*DAY),until:iso(start+(i*31+30)*DAY),
  pools:assets.slice(i*20,(i+1)*20).map(({p})=>({address:p.address,baseMint:p.baseMint,quoteMint:p.quoteMint,venue:p.venue}))};
 const plan={version:VERSION,policy:policy.digest,study:'replay-fixture',strategy:PROOF,selection:PROOF,feeModel:PROOF,exclusions:PROOF,
  maxQuoteAgeMs:10000,maxObservedLatencyMs:2000,horizonMs:3000,windows};
 await append(dir,fixtureProof);
 const manifest=await append(dir,manifestRecord(plan,policy));
 const add=(kind,issuer,body)=>append(dir,signed(policy,kind,issuer,body));
 const addBlock=x=>Promise.all(['alpha','beta'].map(id=>add('block',id,x)));
 await add('timestamp','clock',{subject:manifest,at:iso(start-DAY)});
 const programData=address('program data');
 const upgrade=wire('upgrade',loader,[programData,PROGRAM.pumpswap],Buffer.from('03000000','hex'));
 const a=block(1,0,start-4*DAY,[receipt(upgrade)]);
 await addBlock(a);
 const deployment=await add('deployment','history',{program:PROGRAM.pumpswap,programData,binaryDigest:PROOF,idlDigest:PROOF,evidenceDigest:PROOF,
  activation:ref(a,upgrade),fromSlot:2,untilSlot:999});
 for(let i=0;i<2;i++){
  const local=assets.slice(i*20,(i+1)*20);
  const setup=block(2+i,1+i,start-(3-i)*DAY,local.map(({tx})=>receipt(tx)));
  await addBlock(setup);
  for(const item of local)item.proof=await add('pool','history',{...item.p,creation:ref(setup,item.tx),fromSlot:setup.slot,untilSlot:999});
 }
 let parent=3,nextSlot=4,firstForwardQuote,firstForwardDecision;
 for(const [i,name] of ['development','forward'].entries()){
  const local=assets.slice(i*20,(i+1)*20),attempts=[],lo=Date.parse(windows[name].from),hi=Date.parse(windows[name].until);
  const chain=[],head=block(nextSlot++,parent,lo-1000);chain.push(head);parent=head.slot;
  for(let d=0;d<30;d++){
   const when=lo+d*DAY+10000,trades=[];
   for(let j=0;j<(d<20?7:6);j++){
    const id=`${name}-${d}-${j}`,pool=local[(d+j)%local.length];
    const trade=observedTrade(pool.p,id);trades.push({id,pool,...trade});
   }
   const row=block(nextSlot++,parent,when,trades.map(x=>x.w));chain.push(row);parent=row.slot;
   for(const trade of trades){
    const {id,pool,tx,fill}=trade;
    const attempt={id,pool:pool.p.address,side:'buy',decisionAt:iso(when-200),status:'success',evidenceDigest:PROOF,...ref(row,tx)};
    attempts.push(attempt);
    const q={plan:manifest,attempt:id,pool:pool.p.address,side:'buy',requestAt:iso(when-1000),sourceAt:iso(when-900),
     receivedAt:iso(when-700),validUntil:iso(when+1000),captureDigest:PROOF,stateDigest:PROOF,routeDigest:PROOF,status:'observed',
     inputMint:pool.p.quoteMint,outputMint:pool.p.baseMint,inputAmount:'20',outputAmount:'10',liquidity:'5000',priceImpactBps:100};
    const quote=await add('quote','quote',q);
    if(name==='forward'&&!firstForwardQuote)firstForwardQuote=q;
    await add('timestamp','clock',{subject:quote,at:iso(when-300)});
    const decision=await add('decision','strategy',{plan:manifest,attempt:id,pool:pool.p.address,side:'buy',
     decisionAt:attempt.decisionAt,quote});
    if(name==='forward'&&!firstForwardDecision)firstForwardDecision=decision;
    await add('timestamp','clock',{subject:decision,at:iso(when-250)});
    await add('fill','replay',{...fill,...ref(row,tx),plan:manifest,attempt:id,deployment,poolProof:pool.proof});
   }
  }
  const tail=block(nextSlot++,parent,hi);chain.push(tail);parent=tail.slot;
  const segment=buildSegment(genesis,chain.map(blockIdentity));
  await Promise.all(['alpha','beta'].map(id=>add('segment',id,segment.body)));
  for(const [index,row] of chain.entries())await addBlock({...row,membership:[segment.proof(index)]});
  await add('census','survey',{plan:manifest,window:name,segment:hash(segment.body),scannedAt:iso(hi+DAY),evidenceDigest:PROOF,attempts});
 }
 return {policy,raw,manifest,asOf:iso(start+70*DAY),firstForwardQuote,firstForwardDecision,plan};
}

test('full two-window replay reaches every evidence floor in fixtures, blocks real promotion and detects conflicting market evidence',async t=>{
 const {dir,root}=await tempStore(t);
 const fixture=await replayFixture(dir),{policy,manifest,asOf}=fixture;
 const pin=await checkpoint(dir),path=join(root,'policy.json');
 await writeFile(path,JSON.stringify(fixture.raw));
 const first=await forwardCommand('report',[dir,path,manifest,asOf,pin]);
 assert.equal(first.verdict,'BLOCKED_EXTERNAL_EVIDENCE');
 assert.deepEqual(first.outstanding,['realNetwork']);
 assert.equal(first.verifiedFills,0);assert.equal(first.fixtureAdjudications,400);
 assert.equal(first.eligibleHoldoutSignatures,0);
 assert.equal(first.windows.forward.strictUtcEventDays,30);
 assert.equal(first.windows.forward.strictPools,20);
 assert.equal(first.windows.forward.strictEligibleSignatures,200);
 assert.deepEqual(first.overlaps,{signatures:0,decisionIds:0});
 assert.equal(first.economicsAuthorized,false);
 const preOutcome=[];
 for await(const {digest,record} of records(dir))if(record.kind!=='checkpoint'&&
   !(record.kind==='timestamp'&&record.body.subject===fixture.firstForwardDecision))preOutcome.push(digest);
 const late=await append(dir,signed(policy,'timestamp','clock',{subject:fixture.firstForwardDecision,
  at:fixture.firstForwardQuote.validUntil}));
 preOutcome.push(late);
 const incomplete=await append(dir,{version:VERSION,kind:'checkpoint',body:{records:preOutcome}});
 const unsealed=await qualifyForward(dir,policy,{manifest,asOf,checkpoint:incomplete});
 assert.equal(unsealed.windows.forward.missingOrInvalidDecisionCommitments,1);
 assert.equal(unsealed.windows.forward.strictEligibleSignatures,199);
 await append(dir,signed(policy,'quote','quote',{...fixture.firstForwardQuote,receivedAt:iso(Date.parse(fixture.firstForwardQuote.validUntil)+1)}));
 const second=await qualifyForward(dir,policy,{manifest,asOf});
 assert.equal(second.windows.forward.byQuote.conflicting_quotes,1);
 assert.equal(second.windows.forward.gates.decisionTimeInputs,'BLOCKED');
 assert.equal(second.windows.forward.gates.sampleFloor,'BLOCKED');
 assert.deepEqual(await qualifyForward(dir,policy,{manifest,asOf,checkpoint:pin}),first);
 assert.throws(()=>manifestRecord({...fixture.plan,windows:{...fixture.plan.windows,
  forward:{...fixture.plan.windows.forward,pools:fixture.plan.windows.development.pools}}},policy),/non_disjoint_or_invalid_pool/);
 const all=[];for await(const item of records(dir))all.push(item);
 const unsigned=all.find(item=>item.record.kind==='manifest');
 assert.ok(unsigned&&first.manifest===unsigned.digest);
});

test('an unconfigured real-network store has zero established evidence and remains blocked',async t=>{
 const {dir}=await tempStore(t),policy=readPolicy({version:VERSION,network:'mainnet',genesis:MAINNET,authorities:[],layouts:[]});
 const r=await qualifyForward(dir,policy,{asOf:'2026-11-21T00:00:00.000Z'});
 assert.equal(r.verdict,'BLOCKED_EXTERNAL_EVIDENCE');assert.equal(r.verifiedFills,0);
 assert.equal(r.gates.independentSources,'BLOCKED');assert.equal(r.gates.frozenDesign,'BLOCKED');
});
