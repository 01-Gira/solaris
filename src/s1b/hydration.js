// SOLARIS S1b.2 detached transaction hydration. No signing or trading.
// Never starts hydrating until a recent S1b stream explicitly attests external
// mode. One DB advisory lock session owns the hydration queue.
import {createPool,migrate} from '../db.js';
import {getS1bConfig} from './config.js';
import {migrateS1b} from './store.js';
import {SolanaRpc} from './rpc.js';
import {SharedRpcPacer} from './rpc-pacer.js';
import {processTransactions} from './worker.js';

const LEASE_KEY='74290110377113';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report=(kind,details={})=>console.log(JSON.stringify({
 kind:'s1b2_'+kind,at:new Date().toISOString(),...details
}));
export async function streamReadyForExternalHydration(db){
 const {rows}=await db.query(`SELECT
  hydration_mode='external' AND heartbeat_at>now()-interval '90 seconds'
  AND state='connected' AS ready,hydration_mode,state
  FROM onchain_stream_health WHERE singleton=true`);
 return rows[0]?.ready===true;
}
export async function runDetachedHydration(db,config,signal,{rpcFactory}={}){
 if(config.hydrationMode!=='external')throw new Error('hydration_mode_external_required');
 // Dedicated advisory-lock connection stays checked out until shutdown.
 // No network call is made without this lock and a fresh stream attestation.
 const owner=await db.connect();
 let locked=false;
 try{
  while(!signal.aborted && !locked){
   const lock=await owner.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired',[LEASE_KEY]);
   locked=lock.rows[0]?.acquired===true;
   if(!locked){report('waiting_for_lease');await sleep(10000);}
  }
  if(signal.aborted)return {status:'STOPPED_BEFORE_LEASE'};
  report('lease_acquired',{rpcSpacingMs:config.rpcSpacingMs,txBatchSize:config.txBatchSize});
  const pacer=new SharedRpcPacer(db,config.httpUrl,{spacingMs:config.rpcSpacingMs});
  const rpc=rpcFactory?rpcFactory(pacer):new SolanaRpc(config.httpUrl,{
   spacingMs:config.rpcSpacingMs,pacer
  });
  let lastWaitLog=0;
  while(!signal.aborted){
   // Check the *same* connection still holds a live session. If it fails,
   // terminate; PostgreSQL will release the session advisory lock.
   await owner.query('SELECT 1');
   const ready=await streamReadyForExternalHydration(db);
   if(!ready){
    if(Date.now()-lastWaitLog>30000){report('waiting_for_external_stream');lastWaitLog=Date.now();}
    await sleep(2000);continue;
   }
   const processed=await processTransactions(db,rpc,config);
   if(processed===0)await sleep(2000);
  }
  report('stopped');
  return {status:'STOPPED'};
 }finally{
  if(locked)await owner.query('SELECT pg_advisory_unlock($1::bigint)',[LEASE_KEY]).catch(()=>{});
  owner.release();
 }
}
async function main(){
 const config=getS1bConfig();
 if(config.hydrationMode!=='external')throw new Error('S1B_HYDRATION_MODE=external required');
 const db=createPool(config.dbUrl);
 const controller=new AbortController();
 process.once('SIGTERM',()=>controller.abort());
 process.once('SIGINT',()=>controller.abort());
 try{
  await migrate(db);
  await migrateS1b(db);
  await runDetachedHydration(db,config,controller.signal);
 }finally{await db.end();}
}
if(import.meta.url===new URL('file://'+process.argv[1]).href){
 main().catch(e=>{
  // DB credentials, RPC URLs and transaction data must never reach logs.
  report('failed',{reason:e?.code||(/^(hydration_mode_external_required|S1B_HYDRATION_MODE=external required)$/.test(e?.message||'')?e.message:'worker_error')});
  process.exitCode=1;
 });
}
