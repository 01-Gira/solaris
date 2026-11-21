import {validateBlock} from './archive.js';
import {check,distinct,hash,integer,isAddress,isHash,isList,isSignature,micros,PROGRAM,stamp} from './contract.js';
import {decodeBase58,WSOL} from '../s1b1/decoder.js';
import {TOKEN,TOKEN_2022,SYSTEM,isNative,getCandidates} from '../s1b1/reconcile-trace.js';
import {encode58} from './wire.js';

const LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
const TOKEN_PROGRAMS=new Set([TOKEN,TOKEN_2022]);
const RECIPIENT_ROLES=new Set(['protocol','creator','buyback']);
const LAMPORT_KINDS=new Set(['native_swap','native_fee','wsol_transfer','wrap_funding','unwrap_refund','rent_deposit','rent_refund','unrelated']);

export function availableBlocks(entries,genesis){
 const slots=new Map();
 for(const entry of entries){
  const {slot}=entry.body,{identity,receipts}=validateBlock(entry.body,genesis);
  if(!slots.has(slot))slots.set(slot,new Map());
  const variants=slots.get(slot);
  if(!variants.has(identity))variants.set(identity,{...entry.body,identity,sources:new Set(),receipts:new Map(),proofs:new Map()});
  const block=variants.get(identity);block.sources.add(entry.organization);
  for(const proof of Array.isArray(entry.body.membership)?entry.body.membership:[]){
   if(!isHash(proof?.root))continue;
   const prior=block.proofs.get(proof.root);
   if(prior===null||(prior&&hash(prior)!==hash(proof)))block.proofs.set(proof.root,null);
   else block.proofs.set(proof.root,proof);
  }
  for(const [signature,receipt] of receipts){
   if(!block.receipts.has(signature))block.receipts.set(signature,new Map());
   const versions=block.receipts.get(signature),digest=hash({wire:receipt.wireDigest,meta:receipt.metaDigest});
   if(!versions.has(digest))versions.set(digest,{...receipt,sources:new Set()});
   versions.get(digest).sources.add(entry.organization);
  }
 }
 const blocks=new Map(),conflicts=new Set(),unconfirmed=new Set();
 for(const [slot,variants] of slots){
  if(variants.size!==1){conflicts.add(slot);continue;}
  const [block]=variants.values();
  if(block.sources.size>=2)blocks.set(slot,block);else unconfirmed.add(slot);
 }
 return {blocks,conflicts,unconfirmed};
}

export function confirmedReceipt(blocks,reference){
 if(!integer(reference?.slot,1)||!isSignature(reference.signature)||!isAddress(reference.blockhash))return null;
 const block=blocks.get(reference.slot);
 if(!block||block.blockhash!==reference.blockhash)return null;
 const versions=block.receipts.get(reference.signature);
 if(versions?.size!==1)return null;
 const [receipt]=versions.values();
 if(receipt.sources.size<2)return null;
 const loaded=receipt.meta.loadedAddresses;
 const writable=loaded?.writable??[],readOnly=loaded?.readonly??[];
 if(!Array.isArray(writable)||writable.length!==receipt.loadedWritable||
    !Array.isArray(readOnly)||readOnly.length!==receipt.loadedReadOnly)return null;
 const accounts=[...receipt.accounts,...writable,...readOnly];
 if(!accounts.every(isAddress)||!distinct(accounts))return null;
 return {...receipt,accounts};
}

export function invocation(receipt,reference){
 if(!receipt||!integer(reference?.outerIndex,0,255)||!integer(reference.innerIndex,-1,10000))return null;
 let instruction=receipt.instructions[reference.outerIndex];
 if(!instruction)return null;
 if(reference.innerIndex>=0){
  const groups=Array.isArray(receipt.meta.innerInstructions)?receipt.meta.innerInstructions:[];
  const scoped=groups.filter(group=>group?.index===reference.outerIndex);
  instruction=scoped.length===1&&Array.isArray(scoped[0].instructions)?scoped[0].instructions[reference.innerIndex]:null;
  if(!integer(instruction?.stackHeight,2,64)||typeof instruction.data!=='string'||instruction.data.length>4096)return null;
  const data=decodeBase58(instruction.data);
  if(!data)return null;
  instruction={...instruction,data:data.toString('hex')};
 }
 if(!integer(instruction.programIdIndex,0,receipt.accounts.length-1)||!isList(instruction.accounts,256)||
  !instruction.accounts.every(index=>integer(index,0,receipt.accounts.length-1)))return null;
 return {program:receipt.accounts[instruction.programIdIndex],accounts:instruction.accounts.map(i=>receipt.accounts[i]),
  data:instruction.data};
}

function historicalWitness(entry,reference,blocks){
 const receipt=confirmedReceipt(blocks,reference);
 if(receipt?.outcome!=='success'||receipt.sources.has(entry.organization))return null;
 return invocation(receipt,reference);
}

export function vettedDeployments(entries,blocks,policy){
 return entries.filter(entry=>{
  const b=entry.body,ix=historicalWitness(entry,b.activation,blocks);
  const opcode=ix?.data.slice(0,8),position=opcode==='02000000'?2:opcode==='03000000'?1:null;
  return Object.values(PROGRAM).includes(b.program)&&isHash(b.binaryDigest)&&isHash(b.evidenceDigest)&&
   policy.layouts.has(`${b.program}:${b.idlDigest}`)&&policy.proofs.has(b.idlDigest)&&
   policy.proofs.has(b.binaryDigest)&&policy.proofs.has(b.evidenceDigest)&&
   integer(b.fromSlot,1)&&integer(b.untilSlot,b.fromSlot+1)&&
   b.fromSlot===b.activation?.slot+1&&ix?.program===LOADER&&position!==null&&isAddress(b.programData)&&
   ix.accounts[position]===b.program&&ix.accounts[position-1]===b.programData;
 });
}

function validCreation(ix,p){
 if(ix?.program!==PROGRAM[p.venue])return false;
 const discriminator=ix.data.slice(0,16),accounts=ix.accounts;
 if(p.venue==='pumpswap')return discriminator==='e992d18ecf6840bc'&&
  [p.address,p.baseMint,p.quoteMint,p.baseVault,p.quoteVault,p.baseTokenProgram,p.quoteTokenProgram]
   .every((key,i)=>key===accounts[[0,3,4,9,10,13,14][i]]);
 const baseProgramIndex=discriminator==='181ec828051c0777'?9:discriminator==='d6904cec5f8b31b4'?7:null;
 return baseProgramIndex!==null&&accounts[0]===p.baseMint&&accounts[2]===p.address&&accounts[3]===p.baseVault&&
  accounts[baseProgramIndex]===p.baseTokenProgram&&(p.quoteTokenProgram===SYSTEM||accounts.includes(p.quoteMint));
}

export function vettedPools(entries,blocks,proofs){
 return entries.filter(entry=>{
  const b=entry.body,created=b.creation,ix=historicalWitness(entry,created,blocks);
  return Object.hasOwn(PROGRAM,b.venue)&&proofs.has(b.evidenceDigest)&&
   [b.address,b.baseMint,b.quoteMint,b.baseVault,b.quoteVault,b.vaultOwner].every(isAddress)&&
   b.vaultOwner===b.address&&b.baseMint!==b.quoteMint&&b.baseVault!==b.quoteVault&&TOKEN_PROGRAMS.has(b.baseTokenProgram)&&
   new Set([...TOKEN_PROGRAMS,SYSTEM]).has(b.quoteTokenProgram)&&
   (b.quoteTokenProgram!==SYSTEM||b.venue==='pumpfun'&&b.quoteMint===WSOL&&b.quoteVault===b.address)&&
   integer(b.fromSlot,1)&&integer(b.untilSlot,b.fromSlot+1)&&created?.slot<=b.fromSlot&&
   validCreation(ix,b)&&
   isList(b.recipients,128)&&b.recipients.every(r=>isAddress(r?.account)&&isAddress(r.owner)&&RECIPIENT_ROLES.has(r.role))&&
   distinct(b.recipients.map(r=>r.account))&&b.recipients.every(r=>![b.address,b.baseVault,b.quoteVault].includes(r.account));
 });
}

function financialEdge(edge,mint,program,proofs){
 if(!edge||edge.mint!==mint||edge.tokenProgram!==program||!integer(edge.decimals,0,255)||
  ![edge.source,edge.destination,edge.sourceOwner,edge.destinationOwner].every(isAddress)||edge.source===edge.destination)return false;
 const [gross,credit,withheld]=[edge.debit,edge.credit,edge.withheld].map(micros);
 if(gross===null||credit===null||withheld===null||gross<=0n||credit<=0n||gross!==credit+withheld)return false;
 if(program===SYSTEM||isNative(mint,program))return edge.decimals===9&&withheld===0n;
 // Implicit Token-2022 fees need historical extension/epoch evidence even when zero.
 return program===TOKEN?withheld===0n:program===TOKEN_2022&&proofs.has(edge.tokenFeeProof);
}

function scopedMovement(receipt,attempt,edge){
 const group=Array.isArray(receipt.meta.innerInstructions)&&receipt.meta.innerInstructions.filter(g=>g?.index===attempt.outerIndex);
 if(group?.length!==1||!Array.isArray(group[0].instructions))return false;
 const instructions=group[0].instructions,index=edge.movementIndex;
 const parent=attempt.innerIndex<0?1:instructions[attempt.innerIndex]?.stackHeight;
 if(!integer(parent,1,63)||!integer(index,attempt.innerIndex+1,instructions.length-1)||
  instructions[index]?.stackHeight!==parent+1||
  instructions.slice(attempt.innerIndex+1,index).some(ix=>!integer(ix?.stackHeight,parent+1,64)))return false;
 const ix=invocation(receipt,{outerIndex:attempt.outerIndex,innerIndex:index});
 if(ix?.program!==edge.tokenProgram)return false;
 const data=Buffer.from(ix.data,'hex'),amount=micros(edge.debit),withheld=micros(edge.withheld);
 if(edge.tokenProgram===SYSTEM)return data.length===12&&data.readUInt32LE(0)===2&&data.readBigUInt64LE(4)===amount&&
  ix.accounts[0]===edge.source&&ix.accounts[1]===edge.destination;
 for(const [account,owner] of [[edge.source,edge.sourceOwner],[edge.destination,edge.destinationOwner]]){
  const accountIndex=receipt.accounts.indexOf(account);
  const matches=[receipt.meta.preTokenBalances,receipt.meta.postTokenBalances].map(entries=>
   Array.isArray(entries)?entries.filter(b=>b?.accountIndex===accountIndex):[]);
  if(matches.some(rows=>rows.length>1||rows.some(row=>row.mint!==edge.mint||
    row.uiTokenAmount?.decimals!==edge.decimals||(row.owner!=null&&row.owner!==owner)||
    (row.programId!=null&&row.programId!==edge.tokenProgram))))return false;
  if(data[0]===3&&matches.some(rows=>!rows.length))return false;
 }
 if(data.length===9&&data[0]===3)return ix.accounts[0]===edge.source&&ix.accounts[1]===edge.destination&&
  data.readBigUInt64LE(1)===amount;
 if(ix.accounts[0]!==edge.source||ix.accounts[1]!==edge.mint||ix.accounts[2]!==edge.destination)return false;
 if(data.length===10&&data[0]===12)return data.readBigUInt64LE(1)===amount&&data[9]===edge.decimals;
 return edge.tokenProgram===TOKEN_2022&&data.length===19&&data[0]===26&&data[1]===1&&
  data.readBigUInt64LE(2)===amount&&data[10]===edge.decimals&&data.readBigUInt64LE(11)===withheld;
}

function completeLocalScope(receipt,attempt,claimed,tracked,lamports){
 const groups=Array.isArray(receipt.meta.innerInstructions)?receipt.meta.innerInstructions:[];
 const scoped=groups.filter(g=>g?.index===attempt.outerIndex);
 if(scoped.length!==1||!Array.isArray(scoped[0].instructions))return false;
 const children=scoped[0].instructions,parent=attempt.innerIndex<0?1:children[attempt.innerIndex]?.stackHeight;
 if(!integer(parent,1,63))return false;
 for(let i=attempt.innerIndex+1;i<children.length;i++){
  const raw=children[i];
  if(!integer(raw?.stackHeight,2,64))return false;
  if(raw.stackHeight<=parent)break;
  if(claimed.has(i))continue;
  const ix=invocation(receipt,{outerIndex:attempt.outerIndex,innerIndex:i});
  if(!ix)return false;
  if(!ix.accounts.some(a=>tracked.has(a)))continue;
  const opcode=ix.data.slice(0,2);
  if(TOKEN_PROGRAMS.has(ix.program)){
   // Harmless reads and immutable-owner initialization do not move balances.
   if(['15','16'].includes(opcode))continue;
   const close=opcode==='09'&&lamports.some(move=>move.kind==='unwrap_refund'&&move.innerIndex===i&&
    move.outerIndex===attempt.outerIndex&&ix.accounts[0]===move.source&&ix.accounts[1]===move.destination);
   if(!close)return false;
  }
  if(ix.program===SYSTEM){
   const data=Buffer.from(ix.data,'hex');
   const classified=lamports.some(move=>['wrap_funding','rent_deposit'].includes(move.kind)&&move.innerIndex===i&&
    move.outerIndex===attempt.outerIndex&&ix.accounts[0]===move.source&&ix.accounts[1]===move.destination&&
    (data.length===12&&data.readUInt32LE(0)===2||data.length===52&&data.readUInt32LE(0)===0)&&
    data.readBigUInt64LE(4)===micros(move.amount));
   if(!classified)return false;
  }
 }
 return true;
}

function provenLamports(receipt,fill,required,proofs){
 const pre=receipt.meta.preBalances,post=receipt.meta.postBalances,keys=receipt.accounts;
 if(!isList(pre,256)||!isList(post,256)||pre.length!==keys.length||post.length!==keys.length||
  !pre.every(x=>integer(x))||!post.every(x=>integer(x))||!isList(fill.lamportMovements,1024)||
  fill.networkFee!==receipt.fee||fill.feePayer!==keys[0]||BigInt(pre[0])<micros(receipt.fee))return false;
 const balances=new Map(keys.map((account,i)=>[account,BigInt(pre[i])]));
 balances.set(keys[0],balances.get(keys[0])-micros(receipt.fee));
 const matching=new Map(),nativeEndpoints=new Map();
 for(const [kind,edge] of required)if(kind.startsWith('native_'))nativeEndpoints.set(`${edge.source}:${edge.destination}`,kind);
 for(const movement of fill.lamportMovements){
  const amount=micros(movement?.amount);
  if(!LAMPORT_KINDS.has(movement?.kind)||!proofs.has(movement.evidenceDigest)||
   amount===null||amount<=0n||!balances.has(movement.source)||!balances.has(movement.destination)||
   movement.source===movement.destination||balances.get(movement.source)<amount)return false;
  const nativeKind=nativeEndpoints.get(`${movement.source}:${movement.destination}`);
  if(nativeKind&&movement.kind!==nativeKind)return false;
  balances.set(movement.source,balances.get(movement.source)-amount);
  balances.set(movement.destination,balances.get(movement.destination)+amount);
  const key=`${movement.kind}:${movement.source}:${movement.destination}:${amount}`;
  matching.set(key,(matching.get(key)??0)+1);
 }
 for(const [kind,edge] of required){
  const key=`${kind}:${edge.source}:${edge.destination}:${micros(edge.debit)}`;
  if(!matching.get(key))return false;
  matching.set(key,matching.get(key)-1);
 }
 if([...matching].some(([key,count])=>key.startsWith('native_')&&count>0))return false;
 return keys.every((account,i)=>balances.get(account)===BigInt(post[i]));
}

export function adjudicate(entry,attempt,pool,deployments,receipt,blockOrganizations,proofs){
 const f=entry?.body;
 if(!f)return 'missing_adjudication';
 if(!['accept','reject'].includes(f.decision)||f.method!=='independent-replay-v1'||!proofs.has(f.replayDigest)||
  blockOrganizations.has(entry.organization)||entry.organization===attempt.organization)return 'untrusted_adjudication';
 if(!receipt||receipt.outcome!=='success'||f.wireDigest!==receipt.wireDigest||f.metaDigest!==receipt.metaDigest||
  f.blockhash!==attempt.blockhash||f.signature!==attempt.signature||f.slot!==attempt.slot||
  f.outerIndex!==attempt.outerIndex||f.innerIndex!==attempt.innerIndex)return 'unbound_execution_witness';
 if(f.decision==='reject')return ['unsupported','ambiguous','insufficient_evidence','conflicting'].includes(f.reason)?
  'reviewer_rejected':'invalid_rejection_reason';
 if(![f.ownerProof,f.feeProof].every(x=>proofs.has(x))||!isAddress(f.trader))return 'untrusted_adjudication';
 const program=PROGRAM[pool?.body.venue],at=attempt.slot;
 const relevant=deployments.filter(entry=>entry.body.program===program&&entry.body.fromSlot<=at&&entry.body.untilSlot>at);
 if(relevant.length!==1||relevant[0].digest!==f.deployment||relevant[0].organization===entry.organization)
  return 'deployment_unverified';
 if(!pool||pool.organization===entry.organization||f.poolProof!==pool.digest)return 'pool_identity_unverified';
 const p=pool.body,ix=invocation(receipt,attempt);
 if(ix?.program!==program||!ix.accounts.includes(p.address)||!ix.accounts.includes(p.baseMint)||!ix.accounts.includes(f.trader))
  return 'instruction_scope_unverified';
 const [layout]=getCandidates([{ix:{programId:ix.program,accounts:ix.accounts,data:encode58(Buffer.from(ix.data,'hex'))}}]);
 if(!layout?.hasLayout||layout.pool!==p.address||layout.user!==f.trader||layout.sell!==(f.side==='sell')||
  layout.roles[0].mint!==p.baseMint||layout.roles[0].program!==p.baseTokenProgram||layout.roles[1].account!==p.baseVault||
  (p.quoteTokenProgram===SYSTEM?!layout.nativeSol:layout.nativeSol||layout.quoteMint!==p.quoteMint||
   layout.roles[2].program!==p.quoteTokenProgram||layout.roles[3].account!==p.quoteVault))return 'unsupported_or_conflicting_layout';
 if(!['buy','sell'].includes(f.side)||f.trader===p.vaultOwner||
  !financialEdge(f.base,p.baseMint,p.baseTokenProgram,proofs)||!financialEdge(f.quote,p.quoteMint,p.quoteTokenProgram,proofs)||
  !isList(f.recipientTransfers,128))return 'invalid_scoped_amounts';
 const quoteUser=layout.nativeSol?f.trader:layout.roles[2].account;
 const legs=[[f.base,p.baseVault,layout.roles[0].account,f.side==='sell'],[f.quote,p.quoteVault,quoteUser,f.side==='buy']];
 for(const [edge,vault,userAccount,userPays] of legs){
  if(userPays?(edge.source!==userAccount||edge.destination!==vault||edge.sourceOwner!==f.trader||edge.destinationOwner!==p.vaultOwner):
    (edge.destination!==userAccount||edge.source!==vault||edge.sourceOwner!==p.vaultOwner||edge.destinationOwner!==f.trader))
   return 'unverified_economic_owners';
  if(!receipt.accounts.includes(edge.source)||!receipt.accounts.includes(edge.destination))return 'unverified_economic_owners';
 }
 const native=p.quoteTokenProgram===SYSTEM,wsol=isNative(p.quoteMint,p.quoteTokenProgram);
 if(f.quoteMode!==(native?'native-replay':wsol?'wsol-replay':'token-replay'))return 'unsupported_quote_accounting';
 const spentIndices=new Set();
 const checkMovement=edge=>{
  // A directly debited curve payout requires the signed replay and full lamport model.
  if(edge.tokenProgram===SYSTEM&&f.side==='sell'&&edge.movementIndex===null)return true;
  if(spentIndices.has(edge.movementIndex)||!scopedMovement(receipt,attempt,edge))return false;
  spentIndices.add(edge.movementIndex);return true;
 };
 if(!checkMovement(f.base)||!checkMovement(f.quote))return 'instruction_amount_unproven';
 const lamports=[];
 if(native||wsol)lamports.push([native?'native_swap':'wsol_transfer',f.quote]);
 const paidRecipients=new Set();
 for(const edge of f.recipientTransfers){
  if(!financialEdge(edge,p.quoteMint,p.quoteTokenProgram,proofs)||paidRecipients.has(edge.destination)||
   !p.recipients.some(r=>r.account===edge.destination&&r.owner===edge.destinationOwner&&r.role===edge.role)||
   edge.source!==f.quote.source||edge.sourceOwner!==f.quote.sourceOwner||edge.decimals!==f.quote.decimals||
   !receipt.accounts.includes(edge.destination)||!checkMovement(edge))return 'unverified_recipient';
  paidRecipients.add(edge.destination);
  if(native||wsol)lamports.push([native?'native_fee':'wsol_transfer',edge]);
 }
 const tracked=new Set([p.address,f.trader,p.baseVault,p.quoteVault,layout.roles[0].account,quoteUser,
  ...p.recipients.map(r=>r.account)]);
 if(!Array.isArray(f.lamportMovements)||!completeLocalScope(receipt,attempt,spentIndices,tracked,f.lamportMovements))
  return 'unaccounted_instruction_activity';
 if(!provenLamports(receipt,f,lamports,proofs))return 'lamport_replay_disagrees';
 return 'verified';
}
