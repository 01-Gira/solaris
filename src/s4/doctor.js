// S4 doctor performs only local Codex CLI help/version/auth checks.
// It never sends an AI request or reads DB/wallet/API credentials.
import {spawn} from 'node:child_process';
import {codexChildEnv,assertChatGPTLogin} from './orchestrator.js';

export async function localCliCheck(args,{spawnImpl=spawn,env=process.env,timeoutMs=10000}={}){
 return await new Promise((resolve,reject)=>{
  let bytes=0,output='',timedOut=false;
  const child=spawnImpl('codex',args,{env:codexChildEnv(env),stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
  const collect=chunk=>{
   bytes+=chunk.length;
   if(bytes>131072){timedOut=true;child.kill('SIGKILL');}
   output=(output+chunk.toString('utf8')).slice(-131072);
  };
  child.stdout?.on('data',collect);child.stderr?.on('data',collect);
  child.on('error',e=>{clearTimeout(timer);reject(new Error('CODEX_CLI_UNAVAILABLE_'+(e?.code||'UNKNOWN')));});
  child.on('close',code=>{
   clearTimeout(timer);
   if(timedOut)reject(new Error('CODEX_CLI_HELP_TIMEOUT'));
   else if(code!==0)reject(new Error('CODEX_CLI_HELP_EXIT_'+code));
   else resolve(output);
  });
 });
}
export async function diagnoseS4({spawnImpl=spawn,env=process.env}={}){
 const result={kind:'s4_codex_doctor',modelCalls:0,paidApiFallback:false,
  liveTrading:false,chatgptLogin:false,requiredCliFlags:false,status:'BLOCKED'};
 try{
  const [globalHelp,execHelp]=await Promise.all([
   localCliCheck(['--help'],{spawnImpl,env}),
   localCliCheck(['--ask-for-approval','never','exec','--help'],{spawnImpl,env})
  ]);
  const hasGlobal=/--ask-for-approval/.test(globalHelp);
  const required=['--sandbox','--output-schema','--output-last-message','--skip-git-repo-check'];
  const hasExec=required.every(flag=>execHelp.includes(flag));
  if(!hasGlobal||!hasExec){result.reason='CLI_FLAGS_UNSUPPORTED';return result;}
  result.requiredCliFlags=true;
  await assertChatGPTLogin({spawnImpl,env});
  result.chatgptLogin=true;
  result.status='PREFLIGHT_PASS_MODEL_NOT_TESTED';
  result.reason='CLI_HELP_AND_CHATGPT_LOGIN_VALID';
 }catch(error){
  const reason=String(error?.message||'unknown');
  result.reason=/^CODEX_CLI_(?:UNAVAILABLE|HELP_)/.test(reason)?reason:
    /codex_chatgpt_login_required/.test(reason)?'CHATGPT_LOGIN_REQUIRED':
    /codex_login_not_available/.test(reason)?'CODEX_LOGIN_NOT_AVAILABLE':'PREFLIGHT_FAILED';
 }
 return result;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const result=await diagnoseS4();
 process.stdout.write(JSON.stringify(result)+'\n');
 if(result.status==='BLOCKED')process.exitCode=1;
}
