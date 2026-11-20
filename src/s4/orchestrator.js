import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm,appendFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ROLE_NAMES,RESPONSE_SCHEMA,createPrompt,sanitizeResearchContext,validateDecision,S4_VERSION} from './policy.js';

// Codex CLI is expected to be authenticated through ChatGPT login on the HOST.
// This process intentionally does NOT accept OPENAI_API_KEY or any other paid API fallback.
export function createRunPlan(env=process.env,roles=ROLE_NAMES){
 if((env.S4_AI_BACKEND||'codex')!=='codex')throw new Error('S4 only supports codex backend');
 if(env.S4_PAID_API_FALLBACK==='true'||env.S4_PAID_API_FALLBACK==='1')
  throw new Error('paid_api_fallback_forbidden');
 if(env.S4_LIVE_TRADING_ENABLED==='true'||env.S4_LIVE_TRADING_ENABLED==='1')
  throw new Error('live_trading_forbidden');
 if(!Array.isArray(roles)||roles.length<1||roles.length>5||
    new Set(roles).size!==roles.length||!roles.every(x=>ROLE_NAMES.includes(x)))
  throw new Error('invalid_agent_roles');
 const dry=env.S4_DRY_RUN!=='0';
 const enabled=env.S4_CODEX_ENABLED==='1';
 if(!dry&&!enabled)throw new Error('codex_enable_flag_required');
 const timeout=Number(env.S4_TIMEOUT_MS||120000);
 if(!Number.isInteger(timeout)||timeout<15000||timeout>300000)
  throw new Error('S4_TIMEOUT_MS must be 15000..300000');
 return {backend:'codex',dryRun:dry,enabled,
  roles,timeoutMs:timeout,maxCalls:dry?0:roles.length,concurrency:1,
  paidApiFallback:false,liveTrading:false,economicsAuthorized:false};
}
export function codexChildEnv(env=process.env){
 // Deliberately do not pass DATABASE_URL, OPENAI_API_KEY, RPC_URL or shell secrets.
 // HOME/CODEX_HOME are required for existing ChatGPT login; use dedicated OS account
 // and a locked-down CODEX_HOME for stronger filesystem isolation.
 return Object.fromEntries(Object.entries({
  PATH:env.PATH||'/usr/bin:/bin',
  HOME:env.HOME,
  CODEX_HOME:env.CODEX_HOME,
  TMPDIR:env.TMPDIR,
  LANG:'C.UTF-8',TERM:'dumb',NO_COLOR:'1'
 }).filter(([,v])=>typeof v==='string'&&v.length>0));
}
// Fail closed if the Codex CLI is authenticated with an API key instead of
// ChatGPT. `codex login status` is a local check, not a billable model request.
export async function assertChatGPTLogin({spawnImpl=spawn,env=process.env}={}){
 const output=await new Promise((resolve,reject)=>{
  const child=spawnImpl('codex',['login','status'],{env:codexChildEnv(env),stdio:['ignore','pipe','pipe']});
  let bytes=0,data='',terminated=false;
  const timer=setTimeout(()=>{terminated=true;child.kill('SIGKILL');},15000);
  const collect=chunk=>{
   bytes+=chunk.length;
   if(bytes>4096){terminated=true;child.kill('SIGKILL');return;}
   data+=chunk.toString('utf8');
  };
  child.stdout?.on('data',collect);child.stderr?.on('data',collect);
  child.on('error',e=>{clearTimeout(timer);reject(new Error('codex_login_check_failed:'+e?.code));});
  child.on('close',code=>{
   clearTimeout(timer);
   if(terminated||code!==0)reject(new Error('codex_login_not_available'));
   else resolve(data);
  });
 });
 if(!/\bLogged in using ChatGPT\b/i.test(output))throw new Error('codex_chatgpt_login_required');
 return true;
}

export function parseRoleSelection(input){
 if(!input)return [...ROLE_NAMES];
 const roles=input.split(',').map(x=>x.trim());
 if(!roles.length||!roles.every(x=>ROLE_NAMES.includes(x))||new Set(roles).size!==roles.length)
  throw new Error('invalid_agent_roles');
 return roles;
}
export async function runCodexAgent({role,context,priorDecisions=[],timeoutMs=120000,
  spawnImpl=spawn,env=process.env}){
 if(!ROLE_NAMES.includes(role))throw new Error('invalid_role');
 await assertChatGPTLogin({spawnImpl,env});
 const workspace=await mkdtemp(path.join(os.tmpdir(),'solaris-s4-codex-'));
 const schemaPath=path.join(workspace,'schema.json');
 const answerPath=path.join(workspace,'answer.json');
 const prompt=createPrompt(role,context,priorDecisions);
 // Do not copy the repository, private env files or raw transactions to workspace.
 try{
  await writeFile(schemaPath,JSON.stringify(RESPONSE_SCHEMA),{mode:0o600});
  const args=['exec','--sandbox','read-only','--ask-for-approval','never',
    '--skip-git-repo-check','--output-schema',schemaPath,
    '--output-last-message',answerPath,'-'];
  const outcome=await new Promise((resolve,reject)=>{
   const child=spawnImpl('codex',args,{
    cwd:workspace,env:codexChildEnv(env),stdio:['pipe','pipe','pipe']});
   let outputBytes=0,terminated=false;
   const timer=setTimeout(()=>{terminated=true;child.kill('SIGKILL');},timeoutMs);
   // Discard stdout/stderr; do not persist user data or CLI auth warnings.
   const drain=chunk=>{
    outputBytes+=chunk.length;
    if(outputBytes>1024*1024){terminated=true;child.kill('SIGKILL');}
   };
   child.stdout?.on('data',drain);child.stderr?.on('data',drain);
   child.on('error',error=>{clearTimeout(timer);reject(new Error('codex_spawn_failed:'+error?.code));});
   child.on('close',code=>{
    clearTimeout(timer);
    if(terminated)reject(new Error('codex_timeout_or_output_limit'));
    else if(code!==0)reject(new Error('codex_exited_nonzero:'+code));
    else resolve(true);
   });
   child.stdin?.on('error',()=>{});
   child.stdin?.end(prompt);
  });
  if(!outcome)throw new Error('codex_execution_failed');
  const raw=await readFile(answerPath,'utf8');
  if(Buffer.byteLength(raw,'utf8')>32768)throw new Error('codex_result_too_large');
  let decision;
  try{decision=JSON.parse(raw);}catch{throw new Error('codex_invalid_json');}
  return decision; // The orchestrator validates once at the shared trust boundary.
 }finally{
  await rm(workspace,{recursive:true,force:true}).catch(()=>{});
 }
}
export async function appendAudit(filename,entry){
 const directory=path.dirname(filename);
 await mkdir(directory,{recursive:true,mode:0o700});
 await appendFile(filename,JSON.stringify(entry)+'\n',{encoding:'utf8',mode:0o600});
}
export async function executeS4({context,plan,agentRunner=runCodexAgent,auditPath}){
 const sanitized=sanitizeResearchContext(context);
 const contextHash=createHash('sha256').update(JSON.stringify(sanitized)).digest('hex');
 const runId=randomUUID();
 const audit=auditPath||path.resolve('.solaris/s4-audit.ndjson');
 const prior=[],results=[];
 for(const role of plan.roles){
  let outcome;
  if(plan.dryRun){
   outcome={status:'DRY_RUN',role,reason:'codex_not_invoked'};
  }else{
   try{
    const decision=await agentRunner({role,context:sanitized,priorDecisions:prior,timeoutMs:plan.timeoutMs});
    // Revalidate at the trust boundary, even if the agent adapter was replaced.
    const validated=validateDecision(role,decision,sanitized);
    prior.push(validated);
    outcome={status:'RESEARCH_ONLY',role,decision:validated};
   }catch(error){
    outcome={status:'AGENT_ERROR',role,reason:String(error?.message||'unknown').slice(0,120)};
   }
  }
  results.push(outcome);
  await appendAudit(audit,{runId,at:new Date().toISOString(),version:S4_VERSION,
   role,status:outcome.status,contextSha256:contextHash,
   outcome:outcome.status==='RESEARCH_ONLY'?{
    recommendation:outcome.decision.recommendation,
    confidence:outcome.decision.confidence,
    evidence_ids:outcome.decision.evidence_ids,
    summary:outcome.decision.summary,
    unknowns:outcome.decision.unknowns,
    next_research_step:outcome.decision.next_research_step
   }:{reason:outcome.reason},economicsAuthorized:false,
   liveTrading:false,paidApiFallback:false});
 }
 return {runId,version:S4_VERSION,mode:plan.dryRun?'DRY_RUN':'CODEX_CHATGPT',
  maxCalls:plan.maxCalls,completed:results.filter(x=>x.status==='RESEARCH_ONLY').length,
  results,economicsAuthorized:false,liveTrading:false,paidApiFallback:false,
  contextSha256:contextHash,auditPath:audit};
}
