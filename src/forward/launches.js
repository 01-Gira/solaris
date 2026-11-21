import {hash,integer,isAddress,isList,isSignature,recordObject,stamp} from './contract.js';
import {connectedSegments,included} from './continuity.js';
import {confirmedReceipt,creationIdentity,invocation,observedReceiptVariants} from './evidence.js';
import {WSOL} from '../s1b1/decoder.js';

const WINDOWS=['development','forward'];
const OBSERVED=new Set(['observed','failed','unavailable']);
const isGap=row=>row.status==='missing'||row.status==='unavailable';
const keysMatch=(value,keys)=>recordObject(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const identityKey=row=>`${row.slot}:${row.signature}:${row.outerIndex}:${row.innerIndex}`;
const inc=(object,key)=>{object[key]=(object[key]??0)+1;};
function groupBy(entries,key){
 const groups=new Map();
 for(const item of entries){
  const id=key(item);
  if(!groups.has(id))groups.set(id,[]);
  groups.get(id).push(item);
 }
 return groups;
}

function validLaunch(row,segment,venues){
 if(!integer(row?.slot,segment.firstSlot,segment.lastSlot))return false;
 if(isGap(row))return keysMatch(row,['status','slot']);
 return keysMatch(row,['status','slot','signature','blockhash','outerIndex','innerIndex','venue','address','baseMint','quoteMint'])&&
  ['created','failed'].includes(row.status)&&isSignature(row.signature)&&isAddress(row.blockhash)&&
  integer(row.outerIndex,0,255)&&integer(row.innerIndex,-1,10000)&&venues.includes(row.venue)&&
  [row.address,row.baseMint,row.quoteMint].every(isAddress)&&row.baseMint!==row.quoteMint;
}

function clockedQuorum(witnesses,from,context){
 const organizations=new Map(),choices=new Map();
 for(const witness of witnesses??[]){
  const at=context.seal(witness.digest,from,context.asOf+1);
  if(at===null)continue;
  choices.set(witness.digest,{organization:witness.organization,at});
  const prior=organizations.get(witness.organization);
  if(!prior||at<prior.at||at===prior.at&&witness.digest<prior.digest)organizations.set(witness.organization,{digest:witness.digest,at});
 }
 const witnessesByTime=[...organizations.values()].sort((a,b)=>a.at-b.at||a.digest.localeCompare(b.digest));
 return witnessesByTime.length>=2?{at:witnessesByTime[1].at,digests:witnessesByTime.slice(0,2).map(x=>x.digest).sort(),choices}:null;
}

function agreedScan(entries,segment,context){
 const archive=clockedQuorum(segment.witnesses,stamp(segment.lastTime),context);
 if(!archive)return null;
 const votes=new Map();
 for(const entry of entries){
  const b=entry.body,observed=stamp(b.scannedAt);
  if(!context.censusOrganizations.has(entry.organization)||!keysMatch(b,['plan','window','segment','scannedAt','evidenceDigest','launches'])||
   !context.proofs.has(b.evidenceDigest)||observed===null||observed<stamp(segment.lastTime)||
   !isList(b.launches,10000)||!b.launches.every(row=>validLaunch(row,segment,context.universe.venues)))continue;
  const at=context.seal(entry.digest,Math.max(observed,archive.at),context.asOf+1);
  if(at===null)continue;
  const launchKeys=b.launches.map(row=>isGap(row)?`gap:${row.slot}`:identityKey(row));
  if(new Set(launchKeys).size!==launchKeys.length)continue;
  const launches=b.launches.map(row=>[hash(row),row]).sort(([a],[b])=>a.localeCompare(b));
  const root=hash({segment:segment.digest,launches:launches.map(([digest])=>digest)});
  if(!votes.has(root))votes.set(root,{root,launches,organizations:new Map()});
  const organizations=votes.get(root).organizations;
  organizations.set(entry.organization,Math.min(at,organizations.get(entry.organization)??Infinity));
 }
 if(votes.size!==1)return null;
 const [vote]=votes.values();
 const times=[...vote.organizations.values()].sort((a,b)=>a-b);
 return times.length>=2?{...vote,sealedAt:times[1]}:null;
}

// Possible create invocations catch omissions, including receipts without agreement.
function witnessedLaunches(blocks,venues){
 const bySlot=new Map();
 for(const [slot,block] of blocks){
  const launches=new Set();
  for(const signature of block.receipts.keys())for(const receipt of observedReceiptVariants(block,signature)){
   const instructions=receipt.instructions.map((_ix,outerIndex)=>({outerIndex,innerIndex:-1}));
   for(const group of Array.isArray(receipt.meta.innerInstructions)?receipt.meta.innerInstructions:[])
    if(Array.isArray(group?.instructions))group.instructions.forEach((_ix,innerIndex)=>instructions.push({outerIndex:group.index,innerIndex}));
   for(const position of instructions){
    const ix=creationIdentity(invocation(receipt,position));
    if(ix&&venues.includes(ix.venue))launches.add(identityKey({slot,signature,...position}));
   }
  }
  if(launches.size)bySlot.set(slot,{time:stamp(block.blockTime),launches:[...launches]});
 }
 return bySlot;
}

function verifyLaunch(row,segment,window,context){
 if(isGap(row))return {reason:`launch_${row.status}`};
 const {blocks,poolByCreation}=context,block=blocks.get(row.slot);
 const time=stamp(block?.blockTime);
 if(!included(block,segment)||time<window.start||time>=window.end)return {reason:'launch_block_or_window_unverified'};
 const receipt=confirmedReceipt(blocks,row),ix=invocation(receipt,row),identity=creationIdentity(ix);
 if(!identity||identity.venue!==row.venue||identity.address!==row.address||identity.baseMint!==row.baseMint||
  (identity.quoteMint===undefined?row.quoteMint!==WSOL&&!ix.accounts.includes(row.quoteMint):identity.quoteMint!==row.quoteMint)||
  receipt?.outcome!==(row.status==='created'?'success':'failed'))return {time,reason:'creation_receipt_unverified'};
 const order=block.roster.indexOf(row.signature);
 const archive=clockedQuorum(receipt.witnesses,time,context);
 if(!archive)return {time,order,reason:'unsealed_finalized_creation'};
 if(row.status==='failed')return {time,order,archive};
 const proofs=(poolByCreation.get(identityKey(row))??[]).filter(proof=>proof.body.creation.blockhash===row.blockhash&&
  ['venue','address','baseMint','quoteMint'].every(key=>proof.body[key]===row[key]));
 if(!proofs.length)return {time,order,archive,reason:'independent_creation_proof_missing'};
 const sealedProofs=proofs.map(proof=>({digest:proof.digest,at:context.seal(proof.digest,time,context.asOf+1)}))
  .filter(proof=>proof.at!==null).sort((a,b)=>a.at-b.at||a.digest.localeCompare(b.digest));
 return sealedProofs.length?{time,order,proofs:sealedProofs,archive}:{time,order,archive,reason:'unsealed_independent_creation_proof'};
}

function discoveryFor(launch,time,context){
 const candidates=[];let unsealed=false;
 const deadline=time+context.universe.maxDiscoveryDelayMs;
 for(const entry of context.discoveries.get(launch)??[]){
  const b=entry.body,observed=stamp(b.observedAt);
  if(entry.issuer!==context.universe.issuers.discovery||!keysMatch(b,['plan','launch','status','observedAt','evidenceDigest'])||
   !OBSERVED.has(b.status)||!context.proofs.has(b.evidenceDigest)||observed===null||observed<time)continue;
  const at=context.seal(entry.digest,observed,Math.min(context.asOf,deadline)+1);
  if(at===null){unsealed=true;continue;}
  candidates.push({entry,at});
 }
 candidates.sort((a,b)=>a.at-b.at||a.entry.digest.localeCompare(b.entry.digest));
 if(candidates.length>1&&candidates[1].at===candidates[0].at)return {reason:'conflicting_discovery'};
 if(!candidates.length)return {reason:'missing_timely_discovery',lateDiscoveryEvidence:unsealed,retryUntil:deadline};
 return {discovery:candidates[0],reason:candidates[0].entry.body.status==='observed'?null:`discovery_${candidates[0].entry.body.status}`};
}

function outcome(row,launch,window,segment,scan,verified,prefix,context){
 const {time,proofs}=verified,{universe,asOf}=context;
 let reason=verified.reason;
 let at=prefix.at,discovery=null,lateDiscoveryEvidence=false;
 const deadline=Math.min((time??stamp(segment.lastTime))+universe.maxAdmissionDelayMs,window.end-1);
 if(!reason&&row.status==='failed')reason='failed_creation';
 if(!reason){
  if(!universe.quoteMints.includes(row.quoteMint))reason='excluded_quote_mint';
  else if(context.excluded.has(row.baseMint))reason='excluded_base_mint';
  else{
   const duplicate=context.usedPools.has(row.address)?'duplicate_pool':
    context.usedMints.has(row.baseMint)?'duplicate_base_mint':null;
   // An eligible creation reserves its pool and mint even if discovery or enrollment subsequently fails.
   context.usedPools.add(row.address);context.usedMints.add(row.baseMint);
   reason=duplicate;
  }
 }
 // Decide using the evidence available by the deadline, even if more valid evidence is later imported.
 if(!isGap(row)&&(verified.reason||!prefix.complete||prefix.at>deadline)){
  if(asOf<=deadline)return {pending:true};
  reason='missing_timely_launch_evidence';at=deadline+1;
 }
 if(!reason){
  const result=discoveryFor(launch,time,context);
  discovery=result.discovery;
  lateDiscoveryEvidence=result.lateDiscoveryEvidence===true;
  if(result.retryUntil!==undefined&&asOf<result.retryUntil&&asOf<=deadline)return {pending:true};
  else if(result.reason){reason=result.reason;at=Math.max(at,discovery?.at??Math.min(result.retryUntil??at,deadline));}
  else at=Math.max(at,discovery.at);
 }
 const body={plan:context.manifest,window:window.name,segment:segment.digest,scan:scan.root,launch,
  result:reason?'rejected':'admitted',reason:reason??'first_eligible_creation',discovery:discovery?.entry.digest??null,
  archiveReceipts:reason==='missing_timely_launch_evidence'?[]:verified.archive?.digests??[],poolProof:null};
 const prior=(context.outcomes.get(launch)??[]).filter(entry=>entry.body.window===window.name&&
  entry.issuer===universe.issuers.enrollment&&context.seal(entry.digest,0,asOf+1)!==null);
 const alreadyAdmitted=prior.some(entry=>entry.body.result==='admitted');
 if(!reason){
  const priorProof=prior.length===1&&prior[0].body.poolProof;
  if(!alreadyAdmitted&&asOf>deadline){body.result='rejected';body.reason='missing_timely_admission';at=deadline+1;}
  else{
   const proof=proofs.find(proof=>proof.digest===priorProof)??proofs[0];
   body.poolProof=proof.digest;at=Math.max(at,proof.at);
   const pair=prior.length===1&&prior[0].body.archiveReceipts;
   if(Array.isArray(pair)&&pair.length===2&&pair[0]<pair[1]){
    const [a,b]=pair.map(digest=>verified.archive.choices.get(digest));
    if(a&&b&&a.organization!==b.organization){body.archiveReceipts=pair;at=Math.max(at,a.at,b.at);}
   }
  }
 }
 const matching=prior.length===1&&hash(prior[0].body)===hash(body);
 const seal=matching?context.seal(prior[0].digest,at,body.result==='admitted'?Math.min(asOf,deadline)+1:asOf+1):null;
 const valid=seal!==null;
 return {body,valid,lateDiscoveryEvidence,conflicting:prior.length>1||prior.length===1&&!valid,
  admission:valid&&body.result==='admitted'?{address:row.address,baseMint:row.baseMint,quoteMint:row.quoteMint,
   venue:row.venue,admittedAt:seal,admission:prior[0].digest}:null};
}

export function evaluateLaunches(context){
 const {plan,segments,sourceConflicts,blockConflicts,blocks,asOf,seal}=context,universe=plan.universe;
 const known=witnessedLaunches(blocks,universe.venues),drafts=[],result={};
 const indexes={...context,universe,seal,discoveries:groupBy(context.discoveries,x=>x.body.launch),
  outcomes:groupBy(context.outcomes,x=>x.body.launch),poolByCreation:groupBy(context.poolProofs,x=>identityKey(x.body.creation)),
  excluded:new Set(universe.excludedBaseMints),usedPools:new Set(),usedMints:new Set()};
 const ordered=[...segments.values()].sort((a,b)=>a.firstSlot-b.firstSlot);
 for(const name of WINDOWS){
  const bounds=plan.windows[name],window={name,start:stamp(bounds.from),end:stamp(bounds.until)};
  const first=ordered.findIndex(s=>stamp(s.lastTime)>=window.start&&stamp(s.firstTime)<window.end);
  let end=first;
  if(first>=0)while(end+1<ordered.length&&stamp(ordered[end].lastTime)<window.end)end++;
  const start=first>0&&stamp(ordered[first].firstTime)>=window.start?first-1:first;
  const chosen=first<0?[]:ordered.slice(start,end+1);
  const scans=groupBy(context.scans.filter(x=>x.body.window===name),x=>x.body.segment);
  const scanSegments=new Set(),admitted=[],byReason={},byEvidenceGap={};
  let missingScans=0,unverifiedLaunches=0,missingOutcomes=0,conflictingOutcomes=0,pending=0,omitted=0,lateDiscoveryEvidence=0;
  let prefix={complete:context.frozen&&stamp(chosen[0]?.firstTime)!==null&&stamp(chosen[0].firstTime)<window.start,at:0};
  if(name==='forward'){
   prefix={complete:prefix.complete&&result.development.completePrefix&&
    connectedSegments(result.development.segments,chosen,segments,blockConflicts),at:result.development.prefixAt};
  }
  let parent;
  for(const segment of chosen){
   if(parent&&(segment.parentSlot!==parent.lastSlot||segment.parentHash!==parent.lastHash||
     stamp(segment.firstTime)<stamp(parent.lastTime)))prefix.complete=false;
   parent=segment;
   if([...blockConflicts].some(slot=>integer(slot,segment.firstSlot,segment.lastSlot))||
    sourceConflicts.some(x=>x.firstSlot<=segment.lastSlot&&x.lastSlot>=segment.firstSlot))prefix.complete=false;
   const scan=agreedScan(scans.get(segment.digest)??[],segment,indexes);
   if(!scan){prefix.complete=false;missingScans++;continue;}
   scanSegments.add(segment.digest);prefix.at=Math.max(prefix.at,scan.sealedAt);
   const launched=new Set(scan.launches.filter(([,row])=>!isGap(row)).map(([,row])=>identityKey(row)));
   for(const [slot,entry] of known)if(integer(slot,segment.firstSlot,segment.lastSlot)&&entry.time>=window.start&&entry.time<window.end){
    const missing=entry.launches.filter(key=>!launched.has(key)).length;
    if(missing){prefix.complete=false;omitted+=missing;}
   }
   const validated=scan.launches.map(([launch,row])=>({launch,row,verified:verifyLaunch(row,segment,window,indexes)}));
   if(validated.some(x=>x.verified.reason))prefix.complete=false;
   for(const {verified} of validated)prefix.at=Math.max(prefix.at,verified.archive?.at??0,verified.proofs?.[0]?.at??0);
   validated.sort((a,b)=>a.row.slot-b.row.slot||(a.verified.order??0)-(b.verified.order??0)||
    (a.row.outerIndex??0)-(b.row.outerIndex??0)||(a.row.innerIndex??0)-(b.row.innerIndex??0)||a.launch.localeCompare(b.launch));
   for(const {launch,row,verified} of validated){
    if(verified.reason){unverifiedLaunches++;inc(byEvidenceGap,verified.reason);}
    const evaluated=outcome(row,launch,window,segment,scan,verified,prefix,indexes);
    if(evaluated.pending){pending++;continue;}
    if(evaluated.lateDiscoveryEvidence)lateDiscoveryEvidence++;
    inc(byReason,evaluated.body.reason);
    if(!evaluated.valid){
     missingOutcomes++;if(evaluated.conflicting)conflictingOutcomes++;
     else drafts.push(evaluated.body);
    }
    if(evaluated.admission)admitted.push(evaluated.admission);
   }
  }
  const completePrefix=prefix.complete&&asOf>=window.end&&stamp(parent?.lastTime)!==null&&stamp(parent.lastTime)>=window.end;
  result[name]={admitted,scanSegments,segments:chosen,prefixAt:prefix.at,completePrefix,
   complete:completePrefix&&!omitted&&!missingOutcomes&&!conflictingOutcomes&&!pending,
   summary:{admitted:admitted.length,byReason,byEvidenceGap,missingScanQuorums:missingScans,omittedWitnessedLaunches:omitted,
    unverifiedLaunches,missingOutcomeSeals:missingOutcomes,conflictingOutcomes,pending,lateDiscoveryEvidence,completePrefix}};
 }
 return {windows:result,drafts};
}
