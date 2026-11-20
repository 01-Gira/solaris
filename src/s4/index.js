import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRunPlan,executeS4,parseRoleSelection} from './orchestrator.js';
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 let contextFile=null,roleText=null;
 for(let i=2;i<process.argv.length;i++){
  if(process.argv[i]==='--context'){contextFile=process.argv[++i];continue;}
  if(process.argv[i]==='--agents'){roleText=process.argv[++i];continue;}
  throw new Error('unknown_arg');
 }
 if(!contextFile)throw new Error('--context <sanitized-json-file> required');
 const plan=createRunPlan(process.env,parseRoleSelection(roleText));
 try{
  const raw=await readFile(contextFile,'utf8');
  if(Buffer.byteLength(raw,'utf8')>65536)throw new Error('context_limit_64kb');
  const context=JSON.parse(raw);
  const result=await executeS4({context,plan,auditPath:
   process.env.S4_AUDIT_PATH||path.resolve('.solaris/s4-audit.ndjson')});
  console.log(JSON.stringify(result));
  if(result.results.some(x=>x.status==='AGENT_ERROR'))process.exitCode=1;
 }catch(error){
  // Do not log raw context, URLs, tokens, or Codex stderr.
  console.error(JSON.stringify({kind:'s4_failed',code:String(error?.message||'unknown').slice(0,120)}));
  process.exitCode=1;
 }
}
