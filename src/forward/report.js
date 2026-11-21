import {artifactDigest,checkpointEntries,records} from './store.js';
import {authenticate,check,FLOORS,hash,integer,isAddress,isHash,isId,isList,isSignature,micros,ROLE,stamp,validateManifest,VERSION} from './contract.js';
import {adjudicate,availableBlocks,confirmedReceipt,vettedDeployments,vettedPools} from './evidence.js';
import {agreedSegments,included} from './continuity.js';

const NAMES=['development','forward'];
const STATUS=new Set(['success','failed','missing','unavailable','not_landed']);
const GAP_STATUS=new Set(['missing','unavailable','rate_limited','deferred']);
const inc=(object,key)=>{object[key]=(object[key]??0)+1;};
const isBetween=(t,start,end)=>t!==null&&t>=start&&t<end;
const mark=x=>x?'PASS':'BLOCKED';
const day=date=>date.slice(0,10);
const group=(array,key)=>{
 const index=new Map();
 for(const entry of array){
  const id=key(entry);
  if(!index.has(id))index.set(id,[]);
  index.get(id).push(entry);
 }
 return index;
};
const distinctBodies=entries=>[...new Map(entries.map(entry=>[hash(entry.body),entry])).values()];
const shortHash=value=>hash(value).slice(0,16);

function sealedAt(index,subject,from,until,exclude){
 let earliest=null;
 for(const entry of index.get(subject)??[]){
  const time=stamp(entry.body.at);
  if(!exclude.has(entry.organization)&&isBetween(time,from,until)&&(earliest===null||time<earliest))earliest=time;
 }
 return earliest;
}
const timestamped=(...args)=>sealedAt(...args)!==null;

function quoteStatus(attempt,quotes,context){
 const {timestamps,plan,chainOrganizations,clockExcluded,window,proofs}=context;
 const rows=distinctBodies(quotes.filter(row=>!chainOrganizations.has(row.organization)&&row.organization!==attempt.organization));
 if(!rows.length)return {status:'missing_quote'};
 if(rows.length!==1)return {status:'conflicting_quotes'};
 const [entry]=rows,q=entry.body,decision=stamp(attempt.decisionAt);
 const requestAt=stamp(q.requestAt),sourceAt=stamp(q.sourceAt),receivedAt=stamp(q.receivedAt);
 const quoteAt=sealedAt(timestamps,entry.digest,receivedAt,decision+1,clockExcluded);
 if(requestAt===null||sourceAt===null||receivedAt===null||requestAt<stamp(window.from)||
  requestAt>receivedAt||sourceAt>receivedAt||receivedAt>decision||decision-sourceAt>plan.maxQuoteAgeMs||
  receivedAt-requestAt>plan.maxObservedLatencyMs||q.pool!==attempt.pool||q.side!==attempt.side||!proofs.has(q.captureDigest)||
  quoteAt===null)
  return {status:'stale_future_or_unsealed_quote'};
 if(q.status==='no_route'||q.status==='unavailable')return {digest:entry.digest,organization:entry.organization,quoteAt,
  status:attempt.status==='success'?'missing_executable_quote':'observed_quote_failure'};
 const asset=window.pools.find(pool=>pool.address===attempt.pool);
 const [inMint,outMint]=q.side==='buy'?[asset.quoteMint,asset.baseMint]:[asset.baseMint,asset.quoteMint];
 if(q.status!=='observed'||!proofs.has(q.stateDigest)||!proofs.has(q.routeDigest)||q.inputMint!==inMint||q.outputMint!==outMint||
  !(micros(q.inputAmount)>0n)||!(micros(q.outputAmount)>0n)||!integer(q.priceImpactBps,0,10000)||
  !(micros(q.liquidity)>0n)||stamp(q.validUntil)===null||stamp(q.validUntil)<decision)return {status:'invalid_quote_inputs'};
 return {status:'point_in_time_quote',digest:entry.digest,organization:entry.organization,quoteAt};
}

function committedDecision(attempt,quote,context){
 const {decisions,timestamps,clockExcluded,chainOrganizations,plan,window}=context;
 const candidates=distinctBodies((decisions.get(attempt.id)??[]).filter(row=>!chainOrganizations.has(row.organization)&&
  row.organization!==attempt.organization&&row.organization!==quote.organization));
 if(candidates.length!==1||!quote.digest)return false;
 const [entry]=candidates,decision=stamp(attempt.decisionAt);
 return entry.body.quote===quote.digest&&entry.body.pool===attempt.pool&&entry.body.side===attempt.side&&
  entry.body.decisionAt===attempt.decisionAt&&timestamped(timestamps,entry.digest,
   Math.max(stamp(window.from),decision-plan.maxQuoteAgeMs,quote.quoteAt),decision+1,clockExcluded);
}

function chainCoverage(census,context){
 const {window,segments,chainOrganizations,asOf,sourceConflicts,blockConflicts,proofs}=context;
 const selected=[];let invalid=0;
 for(const [digest,reports] of group(census,x=>x.body.segment)){
  const segment=segments.get(digest);
  const valid=distinctBodies(reports.filter(row=>!chainOrganizations.has(row.organization)));
  if(!segment||valid.length!==1){invalid++;continue;}
  const [row]=valid,scanned=stamp(row.body.scannedAt);
  if(scanned===null||scanned<stamp(segment.lastTime)||scanned>asOf||
    !proofs.has(row.body.evidenceDigest)||!isList(row.body.attempts,10000)){
   invalid++;continue;
  }
  selected.push({segment,row});
 }
 selected.sort((a,b)=>a.segment.firstSlot-b.segment.firstSlot);
 const gaps=[];
 for(let i=1;i<selected.length;i++){
  const prior=selected[i-1].segment,current=selected[i].segment;
  if(current.parentSlot!==prior.lastSlot||current.parentHash!==prior.lastHash||stamp(current.firstTime)<stamp(prior.lastTime))
   gaps.push({afterSlot:prior.lastSlot,beforeSlot:current.firstSlot});
 }
 const earliest=stamp(selected[0]?.segment.firstTime),latest=stamp(selected.at(-1)?.segment.lastTime);
 const atStart=earliest!==null&&earliest<stamp(window.from);
 const atEnd=latest!==null&&latest>=stamp(window.until)&&asOf>=stamp(window.until);
 const first=selected[0]?.segment.firstSlot,last=selected.at(-1)?.segment.lastSlot;
 const conflicting=sourceConflicts.filter(segment=>segment.firstSlot<=last&&segment.lastSlot>=first).length;
 const conflictingBlocks=[...blockConflicts].filter(slot=>slot>=first&&slot<=last).length;
 return {selected,complete:atStart&&atEnd&&invalid===0&&gaps.length===0&&conflicting===0&&conflictingBlocks===0,
  summary:{confirmedSegments:selected.length,uncertifiedOrConflictingCensuses:invalid,unresolvedRanges:gaps.length,
   firstGapRanges:gaps.slice(0,20),conflictingSegments:conflicting,conflictingBlocks,startAnchorPresent:atStart,endAnchorPresent:atEnd,
   finalizedBlocks:selected.reduce((total,x)=>total+x.segment.blockCount,0)}};
}

function attemptRecord(attempt,organization,window,pools,segment,proofs){
 const time=stamp(attempt?.decisionAt);
 if(!isId(attempt?.id)||!pools.has(attempt.pool)||!['buy','sell'].includes(attempt.side)||!STATUS.has(attempt.status)||
  !isBetween(time,stamp(window.from),stamp(window.until))||!proofs.has(attempt.evidenceDigest))return null;
 if(['success','failed'].includes(attempt.status)){
  if(!isSignature(attempt.signature)||!isAddress(attempt.blockhash)||!integer(attempt.slot,segment.firstSlot,segment.lastSlot)||
   !integer(attempt.outerIndex,0,255)||!integer(attempt.innerIndex,-1,10000))return null;
 }else if(attempt.signature!==undefined&&!isSignature(attempt.signature))return null;
 return {...attempt,organization,segment};
}

function measureWindow(name,context){
 const {plan,manifest,blocks,censuses,fills,quotes,poolProofs,deployments,captureGaps,proofs}=context,window=plan.windows[name];
 const coverage=chainCoverage(censuses.filter(x=>x.body.plan===manifest&&x.body.window===name),{...context,window});
 const pools=new Map(window.pools.map(pool=>[pool.address,pool]));
 const poolProofsForWindow=group(poolProofs.filter(entry=>{
  const pool=pools.get(entry.body.address);
  return pool&&['venue','baseMint','quoteMint'].every(k=>pool[k]===entry.body[k]);
 }),entry=>entry.body.address);
 const attempts=[],byState={},byQuote={},byAdjudication={},byDay={},byPool={};
 const seen=new Set(),invocations=new Set(),strict=[];
 let invalid=0,missingReceipts=0,memberFailures=0,unadjudicated=0,quoteGaps=0,decisionGaps=0,purged=0;
 for(const {segment,row} of coverage.selected){
  for(const value of row.body.attempts){
   const attempt=attemptRecord(value,row.organization,window,pools,segment,proofs);
   if(!attempt||seen.has(attempt.id)||stamp(attempt.decisionAt)>stamp(row.body.scannedAt)||
    stamp(attempt.decisionAt)<stamp(segment.firstTime)||stamp(attempt.decisionAt)>stamp(segment.lastTime)){
    invalid++;continue;
   }
   if(['success','failed'].includes(attempt.status)){
    const invocationId=`${attempt.signature}:${attempt.outerIndex}:${attempt.innerIndex}`;
    if(invocations.has(invocationId)){invalid++;continue;}
    invocations.add(invocationId);
   }
   seen.add(attempt.id);attempts.push(attempt);
  }
 }
 const uncensusedDecisions=[...context.decisions.values()].filter(group=>group.some(entry=>{
  const d=entry.body,time=stamp(d.decisionAt);
  return !context.chainOrganizations.has(entry.organization)&&!seen.has(d.attempt)&&pools.has(d.pool)&&
   isBetween(time,stamp(window.from),stamp(window.until))&&timestamped(context.timestamps,entry.digest,
    Math.max(stamp(window.from),time-plan.maxQuoteAgeMs),time+1,context.clockExcluded);
 })).length;
 const attemptedSignatures=new Set(attempts.flatMap(a=>a.signature?[a.signature]:[]));
 for(const attempt of attempts){
  inc(byState,attempt.status);
  const eventDay=day(attempt.decisionAt),poolHash=shortHash(attempt.pool);
  const dateCounts=byDay[eventDay]??={attempts:0,strictSignatures:0};dateCounts.attempts++;
  const poolCounts=byPool[poolHash]??={attempts:0,strictSignatures:0};poolCounts.attempts++;
  const quote=quoteStatus(attempt,quotes.get(attempt.id)??[],{...context,window});inc(byQuote,quote.status);
  const usableQuote=quote.status==='point_in_time_quote'||quote.status==='observed_quote_failure';
  if(!usableQuote)quoteGaps++;
  const decision=committedDecision(attempt,quote,{...context,window});
  if(!decision)decisionGaps++;
  if(!['success','failed'].includes(attempt.status))continue;
  const block=blocks.get(attempt.slot),receipt=confirmedReceipt(blocks,attempt);
  const inTime=block&&stamp(block.blockTime)>=stamp(attempt.decisionAt)&&stamp(block.blockTime)<stamp(window.until);
  if(!included(block,attempt.segment)||!inTime){memberFailures++;continue;}
  if(!receipt||receipt.outcome!==attempt.status){missingReceipts++;continue;}
  if(attempt.status==='failed')continue;
  const poolsAtSlot=distinctBodies((poolProofsForWindow.get(attempt.pool)??[]).filter(x=>
   x.body.fromSlot<=attempt.slot&&x.body.untilSlot>attempt.slot));
  const adjudications=distinctBodies(fills.get(attempt.id)??[]);
  const adjudication=adjudications.length>1?'conflicting_adjudications':
   adjudications[0]?.body.side!==attempt.side&&adjudications[0]?.body.decision==='accept'?'adjudication_side_conflict':
    adjudicate(adjudications[0],attempt,poolsAtSlot.length===1?poolsAtSlot[0]:null,deployments,receipt,context.chainOrganizations,proofs);
  inc(byAdjudication,adjudication);
  if(adjudication!=='verified'&&adjudication!=='reviewer_rejected')unadjudicated++;
  if(adjudication!=='verified')continue;
  if(stamp(block.blockTime)+plan.horizonMs>=stamp(window.until)){purged++;continue;}
  if(quote.status==='point_in_time_quote'&&decision)strict.push({signature:attempt.signature,pool:attempt.pool,
   day:day(block.blockTime),decision:attempt.id});
 }
 const rawStrictSignatures=new Set(strict.map(x=>x.signature));
 const membership=new Map();
 for(const item of strict){
  if(!membership.has(item.signature))membership.set(item.signature,new Set());
  membership.get(item.signature).add(item.pool);
 }
 const unique=new Map();
 for(const item of strict)if(membership.get(item.signature).size===1&&!unique.has(item.signature))unique.set(item.signature,item);
 for(const item of unique.values()){
  const dateCounts=byDay[item.day]??={attempts:0,strictSignatures:0};dateCounts.strictSignatures++;
  byPool[shortHash(item.pool)].strictSignatures++;
 }
 const strictDays=new Set([...unique.values()].map(x=>x.day)).size;
 const strictPools=new Set([...unique.values()].map(x=>x.pool)).size;
 const topPool=Math.max(0,...Object.values(byPool).map(x=>x.strictSignatures));
 const openAttempts=(byState.missing??0)+(byState.unavailable??0);
 const recovery=context.gaps.filter(x=>coverage.selected.some(({segment})=>
  integer(x.body.slot,segment.firstSlot,segment.lastSlot)&&!blocks.has(x.body.slot))).length;
 // A certified segment may cover a provably skipped slot. An explicit source gap still
 // needs a resolution (a dual receipt or a gap attestation tied to adjacent Merkle leaves).
 const unresolvedRecovery=context.gaps.filter(x=>coverage.selected.some(({segment})=>
  integer(x.body.slot,segment.firstSlot,segment.lastSlot))&&!context.resolvedGaps.has(x.body.slot)).length;
 const captureCounts={};
 for(const capture of captureGaps)if(coverage.selected.some(({segment})=>
  integer(capture.body.slot,segment.firstSlot,segment.lastSlot))&&unresolvedCapture(capture,blocks,context.resolvedGaps))
  inc(captureCounts,GAP_STATUS.has(capture.body.status)?capture.body.status:'unknown');
 const poolIdentityMissing=window.pools.filter(p=>!(poolProofsForWindow.get(p.address)?.length)).length;
 return {attemptedSignatures,decisionIds:seen,segments:coverage.selected.map(x=>x.segment),
  output:{attempts:attempts.length,byState,byUtcDay:byDay,byPool,byQuote,byAdjudication,
   registeredPools:pools.size,missingPoolIdentity:poolIdentityMissing,invalidOrDuplicateAttempts:invalid,
   missingFinalizedReceipts:missingReceipts,invalidBlockMembershipOrChronology:memberFailures,
   missingOrInvalidQuotes:quoteGaps,missingOrInvalidDecisionCommitments:decisionGaps,uncensusedDecisions,
   missingOrInvalidAdjudications:unadjudicated,
   purgedBoundaryFills:purged,verifiedAdjudicatedInstructions:byAdjudication.verified??0,
   strictEligibleSignatures:unique.size,ambiguousAcrossPools:rawStrictSignatures.size-unique.size,
   strictUtcEventDays:strictDays,strictPools,topPoolPercent:unique.size?100*topPool/unique.size:null,
   continuity:{...coverage.summary,openAttestedGaps:unresolvedRecovery,attestedGapRowsWithoutBlock:recovery,
    unresolvedCaptureGaps:captureCounts},
   gates:{chainContinuity:mark(coverage.complete&&!unresolvedRecovery&&!Object.keys(captureCounts).length),
    venueAndPoolIdentity:mark(poolIdentityMissing===0&&(!byAdjudication.pool_identity_unverified)&&(!byAdjudication.deployment_unverified)),
    completeAttemptCensus:mark(coverage.complete&&!invalid&&!openAttempts&&!missingReceipts&&!memberFailures&&!uncensusedDecisions),
    independentAdjudication:mark(attempts.length>0&&!unadjudicated&&unique.size>=FLOORS.signatures),
    decisionTimeInputs:mark(attempts.length>0&&!quoteGaps&&!decisionGaps),
    sampleFloor:mark(strictDays>=FLOORS.eventDays&&strictPools>=FLOORS.pools&&unique.size>=FLOORS.signatures&&
      topPool*100<=FLOORS.maxPoolPercent*unique.size)}}};
}

function connectedCohorts(windows,segments,conflicts){
 if(windows.length!==2||!windows.every(w=>w.segments.length>0))return false;
 const development=windows[0].segments,forward=windows[1].segments;
 const knownForward=new Set(forward.map(s=>s.digest));
 if(development.some(s=>knownForward.has(s.digest)))return true;
 const first=forward[0];let tip=development.at(-1);
 if(tip.lastSlot>=first.firstSlot||[...conflicts].some(slot=>slot>tip.lastSlot&&slot<first.firstSlot))return false;
 const children=group([...segments.values()],s=>`${s.parentSlot}:${s.parentHash}`);
 while(tip.lastSlot<first.firstSlot){
  const next=children.get(`${tip.lastSlot}:${tip.lastHash}`)??[];
  if(next.length!==1||stamp(next[0].firstTime)<stamp(tip.lastTime))return false;
  tip=next[0];
  if(tip.digest===first.digest)return true;
 }
 return false;
}

function explicitlyResolvedGaps(blocks,gaps,segments){
 const resolved=new Set(blocks.keys());
 for(const gap of gaps){
  const {slot,before,after,segment}=gap.body;
  const child=blocks.get(after),parent=blocks.get(before),chunk=segments.get(segment);
  if(integer(slot,1)&&parent&&child&&before<slot&&slot<after&&child.parentSlot===before&&
   child.previousBlockhash===parent.blockhash&&included(child,chunk)&&included(parent,chunk)&&
   child.sources.has(gap.organization)&&gap.body.status==='skipped')resolved.add(slot);
 }
 return resolved;
}

function unresolvedCapture(capture,blocks,skips){
 const {slot,signature}=capture.body;
 if(!signature)return !skips.has(slot);
 const block=blocks.get(slot);
 if(!block)return !skips.has(slot);
 return block.roster.includes(signature)&&!confirmedReceipt(blocks,{slot,signature,blockhash:block.blockhash});
}

export async function qualifyForward(dir,policy,{manifest,checkpoint,asOf=new Date().toISOString()}={}){
 check(stamp(asOf)!==null&&(manifest===undefined||isHash(manifest)),'invalid_qualification_scope');
 const groups={},captureGaps=[],proofs=new Set();let plan=null,captures=0,invalidRecords=0;
 const entries=checkpoint?await checkpointEntries(dir,checkpoint):undefined;
 for await(const item of records(dir,entries)){
  const {record}=item;
  if(record.kind==='artifact'){proofs.add(artifactDigest(record));continue;}
  if(record.kind==='manifest'&&item.digest===manifest){plan=validateManifest(record.body,policy);continue;}
  if(record.kind==='capture'&&record.body.policy===policy.digest)captures++;
  if(record.kind==='capture_gap'&&record.body.policy===policy.digest)captureGaps.push(record);
  if(!Object.hasOwn(ROLE,record.kind))continue;
  if(record.policy!==policy.digest)continue;
  try{
   const entry=authenticate(record,policy);
   (groups[entry.kind]??=[]).push(entry);
  }catch{invalidRecords++;}
 }
 const chainOrganizations=new Set([...policy.authorities.values()].filter(x=>x.roles.includes('chain')).map(x=>x.organization));
 const clockExcluded=new Set([...policy.authorities.values()].filter(x=>x.roles.some(role=>role!=='clock')).map(x=>x.organization));
 const timestamps=group(groups.timestamp??[],x=>x.body.subject);
 const frozen=plan&&[plan.strategy,plan.selection,plan.feeModel,plan.exclusions].every(x=>proofs.has(x))&&
  timestamped(timestamps,manifest,0,Math.min(stamp(plan.windows.development.from),stamp(asOf)+1),clockExcluded);
 const available=availableBlocks(groups.block??[],policy.genesis);
 const segments=agreedSegments(groups.segment??[],policy.genesis);
 const independentHistory=entry=>!chainOrganizations.has(entry.organization);
 const deployments=vettedDeployments((groups.deployment??[]).filter(independentHistory),available.blocks,{...policy,proofs});
 const poolProofs=vettedPools((groups.pool??[]).filter(independentHistory),available.blocks,proofs);
 const forPlan=entries=>entries?.filter(x=>x.body.plan===manifest)??[];
 const resolvedGaps=explicitlyResolvedGaps(available.blocks,groups.gap??[],segments.confirmed);
 const inPlan=plan?NAMES.map(name=>measureWindow(name,{plan,manifest,timestamps,chainOrganizations,clockExcluded,proofs,poolProofs,deployments,
  blocks:available.blocks,segments:segments.confirmed,sourceConflicts:segments.conflicts,blockConflicts:available.conflicts,
  asOf:stamp(asOf),captureGaps,decisions:group(forPlan(groups.decision),x=>x.body.attempt),
  gaps:groups.gap??[],resolvedGaps,
  censuses:forPlan(groups.census),fills:group(forPlan(groups.fill),x=>x.body.attempt),quotes:group(forPlan(groups.quote),x=>x.body.attempt)})):[];
 const overlaps=inPlan.length?{
  signatures:[...inPlan[0].attemptedSignatures].filter(key=>inPlan[1].attemptedSignatures.has(key)).length,
  decisionIds:[...inPlan[0].decisionIds].filter(key=>inPlan[1].decisionIds.has(key)).length}:null;
 const both=gate=>inPlan.length===2&&inPlan.every(result=>result.output.gates[gate]==='PASS');
 const gates={independentSources:mark(chainOrganizations.size>=2&&segments.confirmed.size>0),
  frozenDesign:mark(frozen),cohortIsolation:mark(overlaps&&overlaps.signatures===0&&overlaps.decisionIds===0),
  sharedFinalizedChain:mark(connectedCohorts(inPlan,segments.confirmed,available.conflicts)),
  historicalState:mark(deployments.length>0&&both('venueAndPoolIdentity')),
  independentFills:mark(both('independentAdjudication')),
  decisionTimeCoverage:mark(both('decisionTimeInputs')),windowSampleFloors:mark(both('sampleFloor')),
  evidenceIntegrity:invalidRecords?'FAIL':'PASS',realNetwork:mark(policy.network==='mainnet')};
 const windows=Object.fromEntries(inPlan.map((result,i)=>[NAMES[i],result.output]));
 const outstanding=Object.entries(gates).filter(([,status])=>status!=='PASS').map(([key])=>key);
 for(const [window,result] of Object.entries(windows))for(const [gate,value] of Object.entries(result.gates))
  if(value!=='PASS')outstanding.push(`${window}.${gate}`);
 if(!plan)outstanding.push('forward_manifest_and_signed_evidence_required');
 const total=inPlan.reduce((n,result)=>n+result.output.verifiedAdjudicatedInstructions,0);
 const eligible=frozen&&overlaps?.signatures===0&&overlaps?.decisionIds===0&&policy.network==='mainnet'&&
  invalidRecords===0&&outstanding.length===0?inPlan[1].output.strictEligibleSignatures:0;
 const verifiedSignatures=new Set(inPlan.flatMap(result=>[...result.attemptedSignatures]));
 return {version:VERSION,asOf,network:policy.network,manifest:manifest??null,checkpoint:checkpoint??null,requirements:FLOORS,gates,windows,
  verdict:invalidRecords?'FAIL_TECHNICAL':outstanding.length?'BLOCKED_EXTERNAL_EVIDENCE':'RESEARCH_READY',
  verifiedFills:policy.network==='mainnet'&&frozen&&invalidRecords===0&&overlaps?.signatures===0?total:0,
  fixtureAdjudications:policy.network==='fixture'?total:0,eligibleHoldoutSignatures:eligible,overlaps,
  observedDistinctSignatures:verifiedSignatures.size,unsignedRpcCaptures:captures,
  sourceEvidence:{agreedBlocks:available.blocks.size,conflictingBlocks:available.conflicts.size,
   singleSourceBlocks:available.unconfirmed.size,agreedSegments:segments.confirmed.size,
   unresolvedCaptureGaps:captureGaps.filter(x=>unresolvedCapture(x,available.blocks,resolvedGaps)).length,
   validatedDeployments:deployments.length,validatedPoolProofs:poolProofs.length},
  outstanding,economicsAuthorized:false,liveTrading:false};
}
