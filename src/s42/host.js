// S4.2A host-only one-shot coordinator. Codex runs on Mac under ChatGPT login.
// Docker is only a narrow DB bridge; no Codex credentials/host HOME are mounted.
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRunPlan,runCodexAgent,appendAudit} from '../s4/orchestrator.js';
import {validateDecision} from '../s4/policy.js';
import {prepareTask,boundedDailyLimit} from './policy.js';

export function parseArgs(argv){
 const options={command:null,context:null,taskId:null,maxSteps:1,dailyLimit:5};
 if(!['submit','run','status'].includes(argv[0]))throw new Error('expected_submit_run_or_status');
 options.command=argv[0];
 for(let i=1;i<argv.length;i++){
  const flag=argv[i],v=argv[++i];
  if(!v)throw new Error('missing_cli_value');
  if(flag==='--context')options.context=v;
  else if(flag==='--task')options.taskId=Number(v);
  else if(flag==='--max-steps')options.maxSteps=Number(v);
  else if(flag==='--daily-limit')options.dailyLimit=boundedDailyLimit(v);
  else throw new Error('unknown_cli_arg');
 }
 if(options.command==='submit'&&!options.context)throw new Error('context_required');
 if(options.command==='run'&&!options.taskId)throw new Error('task_required');
 if(options.command==='status'&&!options.taskId)throw new Error('task_required');
 if(!Number.isSafeInteger(options.maxSteps)||options.maxSteps<1||options.maxSteps>5)
  throw new Error('invalid_max_steps');
 if(options.taskId!==null&&(!Number.isSafeInteger(options.taskId)||options.taskId<1))
  throw new Error('invalid_task_id');
 return options;
}
export async function invokeBridge(command,input,{spawnImpl=spawn,timeoutMs=60000}={}){
 return new Promise((resolve,reject)=>{
  const args=['-f','compose.yaml','-f','compose.s4.yaml','run','--rm','-T',
   's4-context','node','src/s42/bridge.js',command];
  const child=spawnImpl('docker-compose',args,{stdio:['pipe','pipe','pipe'],env:process.env});
  let stdout='',n=0,ended=false;
  const fail=e=>{if(ended)return;ended=true;clearTimeout(timer);reject(e);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');fail(new Error('bridge_timeout'));},timeoutMs);
  child.stdout?.on('data',chunk=>{
   n+=chunk.length;
   if(n>131072){child.kill('SIGKILL');fail(new Error('bridge_output_too_large'));}
   else stdout+=chunk.toString();
  });
  // Stderr may include Docker paths or private errors; deliberately discard.
  child.stderr?.on('data',()=>{});
  child.on('error',()=>fail(new Error('bridge_spawn_failed')));
  child.on('close',code=>{
   if(ended)return;ended=true;clearTimeout(timer);
   if(code!==0)return reject(new Error('bridge_failed'));
   try{const v=JSON.parse(stdout.trim());resolve(v);}
   catch{reject(new Error('bridge_invalid_json'));}
  });
  child.stdin?.on('error',()=>{});
  child.stdin?.end(JSON.stringify(input));
 });
}
export async function readContext(filename){
 const raw=await readFile(filename,'utf8');
 if(Buffer.byteLength(raw)>65536)throw new Error('context_limit_64kb');
 const value=JSON.parse(raw);
 return prepareTask(value).evidence;
}
export async function runTask({taskId,maxSteps=1,dailyLimit=5,bridge=invokeBridge,
 agentRunner=runCodexAgent,plan=createRunPlan(process.env)}){
 // Explicit opt-in is required beyond legacy S4 flags.
 if(process.env.S42_CODEX_ENABLED!=='1'||plan.dryRun||!plan.enabled)
  throw new Error('s42_codex_explicit_enable_required');
 if(plan.paidApiFallback||plan.liveTrading)throw new Error('unsafe_plan');
 const results=[];
 for(let i=0;i<maxSteps;i++){
  const reserved=await bridge('reserve',{taskId,dailyLimit});
  if(reserved.status!=='RESERVED'){
   results.push({status:reserved.status});
   break;
  }
  const {role,context,priorDecisions}=reserved;
  // A reserved quota slot is never automatically refunded, including crashes.
  let decision=null,errorCode=null;
  try{
   decision=await agentRunner({role,context,priorDecisions,
    timeoutMs:plan.timeoutMs,outputMode:plan.outputMode,model:plan.model});
   validateDecision(role,decision,context);
  }catch(error){
   // Never allow a raw CLI diagnostic to reach the bridge or terminal.
   errorCode=/^codex_exited_nonzero:\d+:([A-Z_]+)$/.exec(error?.message||'')?.[1]||
    'AGENT_ERROR';
  }
  const finished=await bridge('finish',{taskId,role,decision,errorCode});
  await appendAudit(path.resolve('.solaris/s42-audit.ndjson'),{
   at:new Date().toISOString(),taskId,role,status:finished.decisionStatus,
   errorCode,contextSha256:reserved.contextSha256,
   economicsAuthorized:false,liveTrading:false,paidApiFallback:false});
  results.push({role,status:finished.decisionStatus,taskStatus:finished.status,errorCode});
  if(errorCode||finished.status!=='running')break;
 }
 return {kind:'s42_run',taskId,results,economicsAuthorized:false,
  liveTrading:false,paidApiFallback:false};
}
async function main(){
 const opts=parseArgs(process.argv.slice(2));
 if(opts.command==='submit'){
  const context=await readContext(opts.context);
  return invokeBridge('submit',{context});
 }
 if(opts.command==='status')return invokeBridge('status',{taskId:opts.taskId});
 // Must assert opt-in before reservation or any quota usage.
 if(process.env.S42_CODEX_ENABLED!=='1'||process.env.S4_CODEX_ENABLED!=='1'||
  process.env.S4_DRY_RUN!=='0')throw new Error('s42_codex_explicit_enable_required');
 const plan=createRunPlan(process.env);
 return runTask({taskId:opts.taskId,maxSteps:opts.maxSteps,dailyLimit:opts.dailyLimit,plan});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().then(result=>console.log(JSON.stringify(result))).catch(error=>{
  const allowed=new Set(['expected_submit_run_or_status','context_required','task_required',
   'invalid_max_steps','invalid_task_id','invalid_daily_codex_budget',
   's42_codex_explicit_enable_required','unsafe_plan','bridge_failed',
   'bridge_timeout','bridge_spawn_failed','bridge_invalid_json','bridge_output_too_large',
   'context_limit_64kb','unknown_cli_arg','missing_cli_value']);
  console.error(JSON.stringify({kind:'s42_failed',code:allowed.has(error?.message)?
   error.message:'COORDINATOR_ERROR'}));process.exitCode=1;
 });
