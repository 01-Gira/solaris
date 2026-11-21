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
 const outputMode=env.S4_CODEX_OUTPUT_MODE||'structured';
 if(!['structured','validated_json'].includes(outputMode))
  throw new Error('S4_CODEX_OUTPUT_MODE must be structured or validated_json');
 const timeout=Number(env.S4_TIMEOUT_MS||120000);
 if(!Number.isInteger(timeout)||timeout<15000||timeout>300000)
  throw new Error('S4_TIMEOUT_MS must be 15000..300000');
 return {backend:'codex',dryRun:dry,enabled,
  roles,timeoutMs:timeout,outputMode,maxCalls:dry?0:roles.length,concurrency:1,
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

// Classify CLI stderr without ever exposing the raw output: it may contain auth
// metadata, local paths, model output, or private account details.
// Match diagnostic *errors*, not the mere occurrence of --output-schema
// in a generic CLI usage banner. Raw output is NEVER returned or written.
export function classifyCodexFailure(output=''){
 const text=String(output).slice(-16384).toLowerCase();
 if(/unexpected argument|unrecognized option|unknown option|invalid value for|found argument .*wasn't expected|usage:\s*codex/.test(text))
  return 'CLI_ARGUMENT_OR_VERSION';
 if(/invalid schema for response_format|invalid schema for.*codex_output_schema|output schema file.*(not valid json|failed to read)|schema validation failed|unsupported (response.?format|json.?schema)|additionalproperties.*required/.test(text))
  return 'STRUCTURED_OUTPUT_SCHEMA';
 if(/usage limit|quota|rate.limit|too many requests|exceeded your|error 429|status.?429/.test(text))
  return 'CHATGPT_USAGE_OR_RATE_LIMIT';
 if(/token_invalidated|authentication|not logged in|login required|sign.in|unauthorized|status.?401|error 401|invalid.*token|refresh.token|access.denied|status.?403/.test(text))
  return 'CODEX_AUTH_OR_ACCESS';
 if(/model.*(not found|not available|does not exist|unsupported|access)|unsupported model|unknown model/.test(text))
  return 'MODEL_NOT_AVAILABLE';
 if(/permission denied|operation not permitted|sandbox|eacces|eperm/.test(text))
  return 'LOCAL_SANDBOX_OR_PERMISSION';
 if(/config.toml|failed to parse config|invalid config|model_provider|config error/.test(text))
  return 'CODEX_LOCAL_CONFIGURATION';
 if(/certificate|tls|dns|proxy|network|connection refused|connection reset|unable to connect|fetch failed|timed out/.test(text))
  return 'NETWORK_OR_TLS';
 return 'UNCLASSIFIED';
}

export function parseRoleSelection(input){
 if(!input)return [...ROLE_NAMES];
 const roles=input.split(',').map(x=>x.trim());
 if(!roles.length||!roles.every(x=>ROLE_NAMES.includes(x))||new Set(roles).size!==roles.length)
  throw new Error('invalid_agent_roles');
 return roles;
}
export async function runCodexAgent({role,context,priorDecisions=[],timeoutMs=120000,outputMode='structured',
  spawnImpl=spawn,env=process.env}){
 if(!ROLE_NAMES.includes(role))throw new Error('invalid_role');
 if(!['structured','validated_json'].includes(outputMode))throw new Error('invalid_codex_output_mode');
 await assertChatGPTLogin({spawnImpl,env});
 const workspace=await mkdtemp(path.join(os.tmpdir(),'solaris-s4-codex-'));
 const schemaPath=path.join(workspace,'schema.json');
 const answerPath=path.join(workspace,'answer.json');
 const prompt=createPrompt(role,context,priorDecisions);
 // Do not copy the repository, private env files or raw transactions to workspace.
 try{
  await writeFile(schemaPath,JSON.stringify(RESPONSE_SCHEMA),{mode:0o600});
  // validated_json is manual opt-in, NOT an automatic retry/fallback.
  // Strict validateDecision is mandatory in both modes, so unconstrained
  // text can never become a trusted research decision or execution.
  const args=['--ask-for-approval','never','exec','--sandbox','read-only',
    '--skip-git-repo-check',
    ...(outputMode==='structured'?['--output-schema',schemaPath]:[]),
    '--output-last-message',answerPath,'-'];
  const outcome=await new Promise((resolve,reject)=>{
   const child=spawnImpl('codex',args,{
    cwd:workspace,env:codexChildEnv(env),stdio:['pipe','pipe','pipe']});
   let outputBytes=0,terminated=false,diagnosticOutput='';
   const timer=setTimeout(()=>{terminated=true;child.kill('SIGKILL');},timeoutMs);
   // Read only for bounded, allowlisted *error classification*. Never print,
   // persist, or return raw Codex output: it may contain secrets/local paths.
   const drain=chunk=>{
    outputBytes+=chunk.length;
    diagnosticOutput=(diagnosticOutput+chunk.toString('utf8')).slice(-16384);
    if(outputBytes>1024*1024){terminated=true;child.kill('SIGKILL');}
   };
   child.stdout?.on('data',drain);child.stderr?.on('data',drain);
   child.on('error',error=>{clearTimeout(timer);reject(new Error('codex_spawn_failed:'+error?.code));});
   child.on('close',code=>{
    clearTimeout(timer);
    if(terminated)reject(new Error('codex_timeout_or_output_limit'));
    else if(code!==0)reject(new Error('codex_exited_nonzero:'+code+':'+classifyCodexFailure(diagnosticOutput)));
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
    const decision=await agentRunner({role,context:sanitized,priorDecisions:prior,timeoutMs:plan.timeoutMs,outputMode:plan.outputMode});
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
  maxCalls:plan.maxCalls,outputMode:plan.outputMode,completed:results.filter(x=>x.status==='RESEARCH_ONLY').length,
  results,economicsAuthorized:false,liveTrading:false,paidApiFallback:false,
  contextSha256:contextHash,auditPath:audit};
}
