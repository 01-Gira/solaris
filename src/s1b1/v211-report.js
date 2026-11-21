// V2.11 safe read-only integrity and cohort-quality review.
// Read metadata only; no token amounts, wallet access, RPC, Codex, or economics.
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {createQualitySummary} from './v211-quality.js';
import {V2_VERSION} from './v2.js';

export function qualityLimit(env=process.env){
 const value=env.S1B1_V211_LIMIT===undefined?10000:Number(env.S1B1_V211_LIMIT);
 if(!Number.isSafeInteger(value)||value<1||value>100000)
  throw new Error('invalid_v211_limit');
 return value;
}
export async function runQualityReport(db,{limit=10000}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>100000)
  throw new Error('invalid_v211_limit');
 const summary=createQualitySummary();
 let afterId=0,remaining=limit;
 while(remaining>0){
  const {rows}=await db.query(`
   SELECT e.id,e.pool_address,e.signature,e.slot AS event_slot,
    e.source,e.first_received_at,p.venue_family,
    p.pool_created_at,p.first_seen_at AS pool_first_seen_at,
    t.slot AS tx_slot,t.block_time,t.tx_error,
    (t.payload->>'slot') AS payload_slot,
    (t.payload->>'blockTime') AS payload_block_time,
    (t.payload->'transaction'->'signatures') AS payload_signatures,
    (t.payload->'meta'->'err') AS payload_meta_error,
    v.status
   FROM onchain_pool_events e
   JOIN onchain_trade_candidate_v2 v
    ON v.pool_address=e.pool_address AND v.signature=e.signature
     AND v.candidate_version=$1
   JOIN onchain_transactions t ON t.signature=e.signature
   LEFT JOIN pools p ON p.pool_address=e.pool_address
   WHERE e.id>$2 ORDER BY e.id LIMIT $3`,
   [V2_VERSION,afterId,Math.min(500,remaining)]);
  if(!rows.length)break;
  for(const row of rows)summary.add(row);
  afterId=Number(rows.at(-1).id);remaining-=rows.length;
 }
 return {...summary.result(),candidateVersion:V2_VERSION,
  limit,afterEventRowId:afterId};
}
async function main(){
 if(!process.env.DATABASE_URL)throw new Error('missing_database_url');
 const db=new pg.Client({
  connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000
 });
 await db.connect();
 try{
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const result=await runQualityReport(db,{limit:qualityLimit()});
  await db.query('COMMIT');
  console.log(JSON.stringify(result));
 }catch(error){
  await db.query('ROLLBACK').catch(()=>{});
  throw error;
 }finally{
  await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(e=>{
  console.error(JSON.stringify({
   kind:'s1b1_v211_failed',
   code:['invalid_v211_limit','missing_database_url',
    'invalid_quality_row'].includes(e?.message)?
    e.message:'QUALITY_DB_ERROR'
  }));
  process.exitCode=1;
 });
}
