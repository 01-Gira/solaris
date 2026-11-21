import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {writeFile} from 'node:fs/promises';
import {append,checkpoint,importArtifact,openStore,readJson} from './store.js';
import {authenticate,check,hash,integer,isList,manifestRecord,readPolicy,VERSION} from './contract.js';
import {collectArchive,rpcTransport,validateBlock} from './archive.js';
import {buildSegment,validSegment} from './continuity.js';
import {qualifyForward} from './report.js';

const output=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
const argumentCount={init:[1,1],artifact:[2,2],freeze:[3,3],import:[3,3],checkpoint:[1,1],
 report:[2,5],watch:[3,5],capture:[4,4],segment:[2,3],policy:[1,1],'launch-ledger':[4,5]};

export async function forwardCommand(command,args,{env=process.env,emit=output,sleep=delay}={}){
 check(Object.hasOwn(argumentCount,command)&&integer(args.length,...argumentCount[command]),'invalid_forward_command');
 if(command==='policy'){
  const policy=readPolicy(await readJson(args[0]));
  return {policy:policy.digest,network:policy.network,authorities:policy.authorities.size,approvedLayouts:policy.layouts.size};
 }
 if(command==='segment'){
  const [policyFile,headerFile,index]=args,policy=readPolicy(await readJson(policyFile));
  const segment=buildSegment(policy.genesis,await readJson(headerFile));
  return {kind:'unsigned_chain_segment',body:segment.body,membership:index===undefined?null:segment.proof(Number(index))};
 }
 const [location,second,third,fourth,fifth]=args;
 const dir=await openStore(location,{create:command==='init'});
 if(command==='init')return {status:'initialized_private_evidence_store',version:VERSION};
 if(command==='artifact')return {artifact:await importArtifact(dir,second)};
 if(command==='checkpoint')return {checkpoint:await checkpoint(dir)};
 const policy=readPolicy(await readJson(second));
 if(command==='freeze'){
  const plan=manifestRecord(await readJson(third),policy);
  return {manifest:await append(dir,plan),status:'clock_attestation_required'};
 }
 if(command==='import'){
  const input=await readJson(third),bundle=Array.isArray(input)?input:[input];
  check(isList(bundle,256)&&bundle.length>0,'invalid_evidence_bundle');
  for(const record of bundle){
   const entry=authenticate(record,policy);
   if(entry.kind==='block')validateBlock(entry.body,policy.genesis);
   if(entry.kind==='segment')check(validSegment(entry.body,policy.genesis),'invalid_chain_segment');
  }
  for(const record of bundle)await append(dir,record);
  return {status:'imported_authenticated_evidence',records:bundle.length};
 }
 if(command==='capture'){
  const request=await readJson(fourth);
  check(env.SOLARIS_ARCHIVE_FREE_ACCESS==='yes','free_archival_access_not_confirmed');
  return collectArchive(dir,{policy,source:third,requests:request.slots,maxRequests:request.maxRequests,
   retries:request.retries,maxUnits:request.maxUnits,transport:rpcTransport(env.SOLARIS_FREE_ARCHIVAL_RPC_URL)});
 }
 const opts={manifest:third==='-'?undefined:third};
 if(command==='launch-ledger'){
  const {launchDrafts,asOf}=await qualifyForward(dir,policy,{...opts,asOf:fifth,includeLaunchDrafts:true});
  await writeFile(fourth,`${JSON.stringify({manifest:third,asOf,kind:'unsigned_launch_outcomes',bodies:launchDrafts},null,2)}\n`,
   {flag:'wx',mode:0o600});
  return {status:'unsigned_outcomes_require_attestation',drafts:launchDrafts.length};
 }
 if(command==='report')return qualifyForward(dir,policy,{...opts,asOf:fourth==='-'?undefined:fourth,checkpoint:fifth});
 const interval=fourth===undefined?60:Number(fourth),checks=fifth===undefined?10:Number(fifth);
 check(integer(interval,30,3600)&&integer(checks,1,120),'invalid_monitor_bounds');
 let previous;
 for(let i=0;i<checks;i++){
  if(i>0)await sleep(interval*1000);
  const report=await qualifyForward(dir,policy,opts);
  const {asOf,...state}=report,digest=hash(state);
  if(digest!==previous)emit(report);
  previous=digest;
  if(report.verdict!=='BLOCKED_EXTERNAL_EVIDENCE')break;
 }
 return null;
}

const SAFE_ERROR=/^[a-z][a-z0-9_]{1,80}$/;
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 forwardCommand(process.argv[2],process.argv.slice(3)).then(result=>{if(result)output(result);}).catch(error=>{
  const message=error?.code??error?.message;
  output({verdict:'FAIL_TECHNICAL',code:SAFE_ERROR.test(message??'')?message:'forward_workflow_error'});
  process.exitCode=1;
 });
}
