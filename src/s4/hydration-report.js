// Read-only CLI diagnostic, invoked in the existing s4-context container.
// Intentionally does not call Codex, make RPC requests, mutate DB or access wallets.
import pg from 'pg';
import {fetchHydrationMetrics} from './hydration-metrics.js';
import {pathToFileURL} from 'node:url';
async function main(){
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL_REQUIRED');
 const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
 try{
  await db.connect();
  const metrics=await fetchHydrationMetrics(db);
  if(!metrics)throw new Error('EVENT_METRICS_UNAVAILABLE');
  process.stdout.write(JSON.stringify({
   kind:'s1b_hydration_diagnostic',at:new Date().toISOString(),
   units:'event_rows_joined_by_signature',
   ...metrics,
   hydration_pct:metrics.event_rows>0
    ?Math.round(10000*metrics.hydrated_event_rows/metrics.event_rows)/100:null,
   interpretation:'Recent arrivals and hydration completions are not the same cohorts; do not infer ingestion throughput or net queue trend from one sample.',
   readOnly:true,economicsAuthorized:false,liveTrading:false
  })+'\n');
 }finally{await db.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(e=>{console.error(JSON.stringify({kind:'s1b_hydration_diagnostic_failed',
  code:e?.code||(/^[A-Z_]+$/.test(e?.message||'')?e.message:'DB_ERROR')}));process.exitCode=1;});
}
