import pg from 'pg';
import { readFile } from 'node:fs/promises';
import {runResearch,DEFAULTS,RESEARCH_VERSION} from './engine.js';

function integer(name, fallback, max) {
 const v=process.env[name]===undefined?fallback:Number(process.env[name]);
 if(!Number.isInteger(v)||v<1||v>max)throw new Error(name+' must be 1..'+max);
 return v;
}
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const maxPools=integer('S3_MAX_POOLS',50,500);
const maxSnapshots=integer('S3_MAX_SNAPSHOTS_PER_POOL',500,10000);
const exploratory=process.env.S3_EXPLORATORY_PROXY==='1';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:10000});
let txClient;
try{
 await pool.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
 const {rows:poolRows}=await pool.query('SELECT * FROM pools ORDER BY first_seen_at DESC LIMIT $1',[maxPools]);
 const pools=[];
 for(const p of poolRows){
  const {rows:snapshots}=await pool.query(
   'SELECT observed_at,price_usd,liquidity_usd,volume_m5_usd,buys_m5,sells_m5 FROM pool_snapshots WHERE pool_address=$1 ORDER BY observed_at DESC LIMIT $2',
   [p.pool_address,maxSnapshots]);
  pools.push({pool:p,snapshots});
 }
 const result=runResearch(pools,{exploratory,config:DEFAULTS});
 txClient=await pool.connect();
 await txClient.query('BEGIN');
 const insertRun=await txClient.query([
  'INSERT INTO s3_research_runs (engine_version,mode,status,economics_authorized,inputs,report)',
  'VALUES($1,$2,$3,FALSE,$4::jsonb,$5::jsonb) RETURNING id'
 ].join(' '),[
  RESEARCH_VERSION,result.summary.mode,result.summary.status,
  JSON.stringify({maxPools,maxSnapshots,exploratory,config:DEFAULTS}),
  JSON.stringify(result.summary)
 ]);
 const runId=insertRun.rows[0].id;
 for(const c of result.summary.coverage){
  await txClient.query([
   'INSERT INTO s3_pool_coverage',
   '(run_id,pool_address,ready,observations,span_minutes,max_gap_minutes,distinct_prices,failures)',
   'VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)'
  ].join(' '),[runId,c.poolAddress,c.ready,c.count,c.spanMinutes,c.maxGapMinutes,
    c.distinctPrices,JSON.stringify(c.failures)]);
 }
 for(const t of result.trades){
  await txClient.query([
   'INSERT INTO s3_proxy_trades',
   '(run_id,pool_address,strategy,signal_at,entry_at,exit_at,signal_price,entry_mark,exit_mark,',
   'proxy_net_return,censored,reason,dataset_split,feature_evidence)',
   'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)'
  ].join(' '),[
   runId,t.poolAddress,t.strategy,new Date(t.signalAt),
   t.entryAt===null?null:new Date(t.entryAt),
   t.exitAt===null?null:new Date(t.exitAt),
   t.signalMark,t.entryMark,t.exitMark,t.proxyNetReturn,t.censored,t.reason,t.split,
   JSON.stringify(t.featureEvidence)]);
 }
 await txClient.query('COMMIT');
 console.log(JSON.stringify({kind:'s3_research_complete',runId,version:RESEARCH_VERSION,
   status:result.summary.status,mode:result.summary.mode,pools:result.summary.pools,
   readyPools:result.summary.readyPools,signals:result.summary.signals,
   censored:result.summary.censored,proxyCompleted:result.summary.proxyCompleted,
   economicsAuthorized:false}));
}catch(error){
 if(txClient)await txClient.query('ROLLBACK').catch(()=>{});
 console.error(JSON.stringify({kind:'s3_research_failed',message:String(error?.message||error).replace(/(?:https?|wss?):\/\/\S+/g,'[url-redacted]')}));
 process.exitCode=1;
}finally{txClient?.release();await pool.end().catch(()=>{});}
