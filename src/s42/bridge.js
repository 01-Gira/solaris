// Container-only database bridge. Host Codex never receives database DSNs.
// Each invocation performs one bounded action and exits. stdin is <=64KiB.
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {prepareTask,boundedDailyLimit,validateBridgeCommand} from './policy.js';
import {validateDecision,ROLE_NAMES} from '../s4/policy.js';

export async function transact(db,fn){
 const client=await db.connect();
 try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
 catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
 finally{client.release();}
}
const publicTask=row=>({id:Number(row.id),status:row.status,
 taskKey:row.task_key,contextSha256:row.context_sha256,
 roles:row.roles,createdAt:row.created_at,blockedReason:row.blocked_reason});
export async function submitTask(db,input){
 const task=prepareTask(input.context,input.roles||ROLE_NAMES);
 return transact(db,async tx=>{
  const {rows}=await tx.query(`INSERT INTO s42_research_tasks
   (task_key,context_sha256,evidence,roles)
   VALUES($1,$2,$3::jsonb,$4::jsonb)
   ON CONFLICT(task_key) DO UPDATE SET updated_at=s42_research_tasks.updated_at
   RETURNING id,status,task_key,context_sha256,roles,created_at,blocked_reason`,
   [task.taskKey,task.contextSha256,JSON.stringify(task.evidence),JSON.stringify(task.roles)]);
  const row=rows[0];
  for(let i=0;i<task.roles.length;i++){
   await tx.query(`INSERT INTO s42_agent_steps(task_id,role,ordinal)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[row.id,task.roles[i],i]);
  }
  return {kind:'s42_submit',task:publicTask(row),deduplicated:row.status!=='queued'||
   (await tx.query('SELECT count(*)::int AS n FROM s42_progress_events WHERE task_id=$1',[row.id])).rows[0].n>0};
 });
}
export async function reserveStep(db,input){
 const taskId=Number(input.taskId),limit=boundedDailyLimit(input.dailyLimit||5);
 if(!Number.isSafeInteger(taskId)||taskId<1)throw new Error('invalid_task_id');
 return transact(db,async tx=>{
  const r=await tx.query('SELECT * FROM s42_research_tasks WHERE id=$1 FOR UPDATE',[taskId]);
  const task=r.rows[0];
  if(!task)throw new Error('task_not_found');
  if(!['queued','running'].includes(task.status))
   return {kind:'s42_reserve',status:'NOT_RUNNABLE',task:publicTask(task)};
  const all=(await tx.query('SELECT * FROM s42_agent_steps WHERE task_id=$1 ORDER BY ordinal',[taskId])).rows;
  if(all.some(x=>x.status==='reserved'))
   return {kind:'s42_reserve',status:'ALREADY_RESERVED',task:publicTask(task)};
  if(all.some(x=>x.status==='error'))
   return {kind:'s42_reserve',status:'BLOCKED',task:publicTask(task)};
  const next=all.find(x=>x.status==='pending');
  if(!next){
   await tx.query("UPDATE s42_research_tasks SET status='completed',updated_at=now() WHERE id=$1",[taskId]);
   return {kind:'s42_reserve',status:'COMPLETED',task:publicTask({...task,status:'completed'})};
  }
  // Do not skip failed or incomplete earlier roles.
  if(all.some(x=>x.ordinal<next.ordinal&&x.status!=='completed'))
   throw new Error('invalid_step_sequence');
  const budget=await tx.query(`INSERT INTO s42_daily_call_budget(day_utc,calls_reserved)
   VALUES((now() AT TIME ZONE 'UTC')::date,0)
   ON CONFLICT(day_utc) DO UPDATE SET calls_reserved=s42_daily_call_budget.calls_reserved
   RETURNING calls_reserved`);
  if(budget.rows[0].calls_reserved>=limit)
   return {kind:'s42_reserve',status:'DAILY_BUDGET_EXHAUSTED',limit,task:publicTask(task)};
  await tx.query(`UPDATE s42_daily_call_budget SET calls_reserved=calls_reserved+1
   WHERE day_utc=(now() AT TIME ZONE 'UTC')::date`);
  await tx.query(`UPDATE s42_agent_steps SET status='reserved',reserved_at=now()
    WHERE task_id=$1 AND role=$2`,[taskId,next.role]);
  await tx.query(`UPDATE s42_research_tasks SET status='running',updated_at=now() WHERE id=$1`,[taskId]);
  await tx.query(`INSERT INTO s42_progress_events(task_id,role,kind,details)
    VALUES($1,$2,'agent_reserved',$3::jsonb)`,[taskId,next.role,JSON.stringify({dailyLimit:limit})]);
  const prior=all.filter(x=>x.status==='completed').map(x=>x.decision);
  return {kind:'s42_reserve',status:'RESERVED',taskId,role:next.role,
   contextSha256:task.context_sha256,priorDecisions:prior,context:task.evidence};
 });
}
export async function finishStep(db,input){
 const taskId=Number(input.taskId),role=input.role;
 if(!Number.isSafeInteger(taskId)||taskId<1||!ROLE_NAMES.includes(role))
  throw new Error('invalid_step_identity');
 return transact(db,async tx=>{
  const t=(await tx.query('SELECT * FROM s42_research_tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
  if(!t||t.status!=='running')throw new Error('task_not_running');
  const step=(await tx.query('SELECT * FROM s42_agent_steps WHERE task_id=$1 AND role=$2 FOR UPDATE',[taskId,role])).rows[0];
  if(!step||step.status!=='reserved')throw new Error('step_not_reserved');
  let decision=null,errorCode=null;
  if(input.errorCode){
   errorCode=String(input.errorCode).replace(/[^A-Z0-9_]/gi,'_').slice(0,80)||'AGENT_ERROR';
  }else{
   decision=validateDecision(role,input.decision,t.evidence);
  }
  await tx.query(`UPDATE s42_agent_steps
   SET status=$3,decision=$4::jsonb,error_code=$5,completed_at=now()
   WHERE task_id=$1 AND role=$2`,
   [taskId,role,errorCode?'error':'completed',decision?JSON.stringify(decision):null,errorCode]);
  const remain=(await tx.query(`SELECT count(*)::int AS remaining
   FROM s42_agent_steps WHERE task_id=$1 AND role<>$2 AND status<>'completed'`,
   [taskId,role])).rows[0].remaining;
  const done=!!errorCode||remain===0;
  const status=errorCode?'blocked':done?'completed':'running';
  await tx.query(`UPDATE s42_research_tasks
   SET status=$2,blocked_reason=$3,updated_at=now() WHERE id=$1`,
   [taskId,status,errorCode]);
  await tx.query(`INSERT INTO s42_progress_events(task_id,role,kind,details)
   VALUES($1,$2,$3,$4::jsonb)`,
   [taskId,role,errorCode?'agent_error':'agent_completed',JSON.stringify({
    recommendation:decision?.recommendation||null,errorCode})]);
  return {kind:'s42_finish',taskId,role,status,decisionStatus:errorCode?'AGENT_ERROR':'RESEARCH_ONLY',
   economicsAuthorized:false,liveTrading:false};
 });
}
export async function taskStatus(db,input){
 const taskId=Number(input.taskId);
 if(!Number.isSafeInteger(taskId)||taskId<1)throw new Error('invalid_task_id');
 const task=(await db.query(`SELECT id,status,task_key,context_sha256,roles,created_at,blocked_reason
  FROM s42_research_tasks WHERE id=$1`,[taskId])).rows[0];
 if(!task)throw new Error('task_not_found');
 const steps=(await db.query(`SELECT role,ordinal,status,error_code,completed_at,
  decision->>'recommendation' AS recommendation FROM s42_agent_steps
  WHERE task_id=$1 ORDER BY ordinal`,[taskId])).rows;
 const events=(await db.query(`SELECT role,kind,at,details FROM s42_progress_events
  WHERE task_id=$1 ORDER BY id DESC LIMIT 30`,[taskId])).rows;
 const budget=(await db.query(`SELECT calls_reserved FROM s42_daily_call_budget
  WHERE day_utc=(now() AT TIME ZONE 'UTC')::date`)).rows[0]?.calls_reserved??0;
 return {kind:'s42_status',task:publicTask(task),steps,events,dailyCallsReserved:budget,
  economicsAuthorized:false,liveTrading:false};
}
export async function executeBridge(db,cmd,input){
 switch(validateBridgeCommand(cmd)){
  case 'submit':return submitTask(db,input);
  case 'reserve':return reserveStep(db,input);
  case 'finish':return finishStep(db,input);
  case 'status':return taskStatus(db,input);
 }
}
async function main(){
 const cmd=validateBridgeCommand(process.argv[2]);
 const parts=[];let size=0;
 for await (const chunk of process.stdin){
  size+=chunk.length;if(size>65536)throw new Error('bridge_input_too_large');
  parts.push(chunk);
 }
 const input=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
 if(!process.env.DATABASE_URL)throw new Error('database_unavailable');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:10000});
 try{
  await db.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const result=await executeBridge(db,cmd,input);
  process.stdout.write(JSON.stringify(result)+'\n');
 }finally{await db.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(e=>{console.error(JSON.stringify({kind:'s42_bridge_failed',
  code:['invalid_bridge_command','invalid_task_id','task_not_found','task_not_running',
   'step_not_reserved','invalid_step_identity','invalid_daily_codex_budget',
   'bridge_input_too_large','invalid_roles','invalid_step_sequence'].includes(e?.message)
   ?e.message:'BRIDGE_ERROR'}));process.exitCode=1;});
