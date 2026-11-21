import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareTask,boundedDailyLimit} from '../src/s42/policy.js';
import {submitTask,reserveStep,finishStep,taskStatus} from '../src/s42/bridge.js';
import {parseArgs,runTask} from '../src/s42/host.js';
import {createRunPlan} from '../src/s4/orchestrator.js';
const input={source:'solaris_s4_context_v1',collected_at:'2026-11-21T01:54:00Z',
 pools:[],stats:{observed_pools:2845,total_events:5066,hydrated_events:3287,decoded_events:1000},
 s3:{mode:'audit',status:'BLOCKED_DATA',ready_pools:0,economics_authorized:false}};
const decision=role=>({agent:role,recommendation:'INSUFFICIENT_DATA',confidence:'low',
 summary:'Insufficient verified execution and decoded fill evidence.',
 evidence_ids:['stats:summary','s3:latest'],
 unknowns:['No validated execution evidence'],next_research_step:'Collect labeled swaps.',
 economics_authorized:false});

test('stable task hash ignores export timestamp but detects material evidence change',()=>{
 const a=prepareTask(input,['onchain','audit']);
 const b=prepareTask({...input,collected_at:'2026-11-21T02:00:00Z'},['onchain','audit']);
 const c=prepareTask({...input,stats:{...input.stats,decoded_events:1001}},['onchain','audit']);
 assert.equal(a.taskKey,b.taskKey);
 assert.notEqual(a.taskKey,c.taskKey);
 assert.notEqual(a.taskKey,prepareTask(input,['audit','onchain']).taskKey);
});
test('task policy refuses invalid roles and budget override',()=>{
 assert.throws(()=>prepareTask(input,['audit','audit']),/invalid_roles/);
 assert.throws(()=>prepareTask(input,['sell']),/invalid_roles/);
 assert.throws(()=>boundedDailyLimit(21),/invalid_daily_codex_budget/);
 assert.equal(boundedDailyLimit(5),5);
});
test('CLI requires context or task and never defaults to agent execution',()=>{
 assert.deepEqual(parseArgs(['submit','--context','.solaris/s4-context.json']).command,'submit');
 assert.equal(parseArgs(['run','--task','5']).maxSteps,1);
 assert.throws(()=>parseArgs(['run']),/task_required/);
 assert.throws(()=>parseArgs(['run','--task','5','--max-steps','6']),/invalid_max_steps/);
 assert.throws(()=>parseArgs(['run','--task','5','--daily-limit','999']),/invalid_daily_codex_budget/);
});
function fakeDatabase(){
 const state={task:null,steps:[],budget:0,events:[],calls:[]};
 const db={
  connect:async()=>({query:async(sql,args=[])=>q(sql,args),release:()=>{}}),
  query:(sql,args=[])=>q(sql,args)
 };
 async function q(sql,args=[]){
  state.calls.push(sql);
  if(/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql))return {rows:[]};
  if(sql.includes('INSERT INTO s42_research_tasks')){
   if(!state.task)state.task={id:8,task_key:args[0],context_sha256:args[1],
    evidence:JSON.parse(args[2]),roles:JSON.parse(args[3]),status:'queued',
    blocked_reason:null,created_at:'2026-11-21T01:54:00Z'};
   return {rows:[state.task]};
  }
  if(sql.includes('INSERT INTO s42_agent_steps')){
   if(!state.steps.some(x=>x.role===args[1]))
    state.steps.push({task_id:8,role:args[1],ordinal:args[2],status:'pending',decision:null});
   return {rows:[]};
  }
  if(sql.includes('SELECT count(*)::int AS n FROM s42_progress_events'))return {rows:[{n:state.events.length}]};
  if(sql.includes('SELECT * FROM s42_research_tasks'))return {rows:state.task?[{...state.task}]:[]};
  if(sql.includes('SELECT * FROM s42_agent_steps')&&sql.includes('ORDER BY ordinal'))
   return {rows:state.steps.map(x=>({...x}))};
  if(sql.includes('SELECT * FROM s42_agent_steps')&&sql.includes('role=$2'))
   return {rows:state.steps.filter(x=>x.role===args[1]).map(x=>({...x}))};
  if(sql.includes('INSERT INTO s42_daily_call_budget'))return {rows:[{calls_reserved:state.budget}]};
  if(sql.includes('UPDATE s42_daily_call_budget')){state.budget++;return {rows:[]};}
  if(sql.includes('UPDATE s42_agent_steps')){
   const s=state.steps.find(x=>x.role===args[1]);s.status=sql.includes("SET status='reserved'")?'reserved':args[2];
   if(!sql.includes("SET status='reserved'"))s.decision=args[3]&&JSON.parse(args[3]);
   return {rows:[]};
  }
  if(sql.includes('UPDATE s42_research_tasks')){
   if(sql.includes("SET status='completed'"))state.task.status='completed';
   else{state.task.status=args[1];state.task.blocked_reason=args[2];}
   return {rows:[]};
  }
  if(sql.includes('INSERT INTO s42_progress_events')){
   state.events.push({role:args[1],kind:args[2]||'agent_reserved'});return {rows:[]};
  }
  if(sql.includes('SELECT count(*)::int AS remaining'))
   return {rows:[{remaining:state.steps.filter(x=>x.role!==args[1]&&x.status!=='completed').length}]};
  if(sql.includes('SELECT id,status,task_key,context_sha256,roles'))
   return {rows:state.task?[state.task]:[]};
  if(sql.includes('SELECT role,ordinal,status,error_code'))
   return {rows:state.steps.map(x=>({...x,recommendation:x.decision?.recommendation||null}))};
  if(sql.includes('SELECT role,kind,at,details FROM s42_progress_events'))
   return {rows:[...state.events].reverse()};
  if(sql.includes('SELECT calls_reserved FROM s42_daily_call_budget'))
   return {rows:[{calls_reserved:state.budget}]};
  throw new Error('unmocked SQL: '+sql.slice(0,90));
 }
 return {db,state};
}
test('submit deduplicates same evidence; reserves sequential roles atomically and finishes',async()=>{
 const {db,state}=fakeDatabase();
 const first=await submitTask(db,{context:input,roles:['onchain','audit']});
 const duplicate=await submitTask(db,{context:{...input,collected_at:'2026-11-21T02:00:00Z'},roles:['onchain','audit']});
 assert.equal(first.task.id,8);
 assert.equal(duplicate.task.id,8);
 assert.equal(state.steps.length,2);
 let one=await reserveStep(db,{taskId:8,dailyLimit:2});
 assert.equal(one.status,'RESERVED');
 assert.equal(one.role,'onchain');
 assert.equal((await reserveStep(db,{taskId:8,dailyLimit:2})).status,'ALREADY_RESERVED');
 await finishStep(db,{taskId:8,role:'onchain',decision:decision('onchain')});
 const two=await reserveStep(db,{taskId:8,dailyLimit:2});
 assert.equal(two.role,'audit');
 assert.equal(two.priorDecisions[0].recommendation,'INSUFFICIENT_DATA');
 await finishStep(db,{taskId:8,role:'audit',decision:decision('audit')});
 assert.equal(state.task.status,'completed');
 assert.equal((await reserveStep(db,{taskId:8,dailyLimit:2})).status,'NOT_RUNNABLE');
 assert.equal(state.budget,2);
 assert.equal((await taskStatus(db,{taskId:8})).dailyCallsReserved,2);
});
test('daily budget blocks additional roles without reserving work',async()=>{
 const {db,state}=fakeDatabase();
 await submitTask(db,{context:input,roles:['onchain','audit']});
 await reserveStep(db,{taskId:8,dailyLimit:1});
 await finishStep(db,{taskId:8,role:'onchain',decision:decision('onchain')});
 assert.equal((await reserveStep(db,{taskId:8,dailyLimit:1})).status,'DAILY_BUDGET_EXHAUSTED');
 assert.equal(state.steps[1].status,'pending');
});
test('failed agent blocks task and cannot start another agent',async()=>{
 const {db}=fakeDatabase();
 await submitTask(db,{context:input,roles:['onchain','audit']});
 await reserveStep(db,{taskId:8,dailyLimit:5});
 const finished=await finishStep(db,{taskId:8,role:'onchain',errorCode:'MODEL_NOT_AVAILABLE'});
 assert.equal(finished.status,'blocked');
 assert.equal((await reserveStep(db,{taskId:8,dailyLimit:5})).status,'NOT_RUNNABLE');
});
test('host coordinator will not reserve or spend any budget unless explicitly enabled',async()=>{
 let bridgeCalls=0,agentCalls=0;
 const old=process.env.S42_CODEX_ENABLED;
 delete process.env.S42_CODEX_ENABLED;
 try{
  await assert.rejects(()=>runTask({taskId:8,plan:createRunPlan({S4_DRY_RUN:'0',S4_CODEX_ENABLED:'1'}),
   bridge:async()=>{bridgeCalls++},agentRunner:async()=>{agentCalls++}}),/s42_codex_explicit_enable_required/);
  assert.equal(bridgeCalls,0);assert.equal(agentCalls,0);
 }finally{
  if(old===undefined)delete process.env.S42_CODEX_ENABLED;
  else process.env.S42_CODEX_ENABLED=old;
 }
});
