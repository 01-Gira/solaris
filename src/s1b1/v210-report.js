// Read-only V2.10 sample coverage, clustering, and source/time-bias audit.
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {createCohortSummary} from './v210-cohort.js';
import {V2_VERSION} from './v2.js';

export function cohortLimit(env=process.env){
 const n=env.S1B1_V210_LIMIT===undefined?10000:Number(env.S1B1_V210_LIMIT);
 if(!Number.isSafeInteger(n)||n<1||n>100000)throw Error('invalid_v210_limit');
 return n;
}
export async function runCohortReport(db,{limit=10000}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>100000)
  throw Error('invalid_v210_limit');
 const {rows:coverageRows}=await db.query(`
  SELECT
   (SELECT count(*)::bigint FROM onchain_pool_events) AS total_event_rows,
   (SELECT count(*)::bigint FROM onchain_pool_events e
     JOIN onchain_transactions t ON t.signature=e.signature) AS hydrated_event_rows,
   (SELECT count(*)::bigint FROM onchain_trade_candidate_v2 v
     WHERE v.candidate_version=$1) AS v2_classified_event_rows`,[V2_VERSION]);
 const summary=createCohortSummary(coverageRows[0]);
 let after=0,remaining=limit;
 while(remaining>0){
  const {rows}=await db.query(`SELECT e.id,e.pool_address,e.signature,
    e.source,e.first_received_at,t.block_time,p.venue_family,v.status
   FROM onchain_pool_events e
   JOIN onchain_trade_candidate_v2 v
     ON v.pool_address=e.pool_address AND v.signature=e.signature
     AND v.candidate_version=$1
   JOIN onchain_transactions t ON t.signature=e.signature
   LEFT JOIN pools p ON p.pool_address=e.pool_address
   WHERE e.id>$2 ORDER BY e.id LIMIT $3`,
   [V2_VERSION,after,Math.min(500,remaining)]);
  if(!rows.length)break;
  for(const row of rows)summary.add(row);
  after=Number(rows.at(-1).id);remaining-=rows.length;
 }
 return {...summary.result(),candidateVersion:V2_VERSION,limit,
  afterEventRowId:after};
}
async function main(){
 if(!process.env.DATABASE_URL)throw Error('missing_database_url');
 const db=new pg.Client({connectionString:process.env.DATABASE_URL,
  connectionTimeoutMillis:10000});
 await db.connect();
 try{
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const result=await runCohortReport(db,{limit:cohortLimit()});
  await db.query('COMMIT');console.log(JSON.stringify(result));
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
 finally{await db.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(e=>{
  console.error(JSON.stringify({kind:'s1b1_v210_failed',
   code:['invalid_v210_limit','missing_database_url','invalid_coverage_count',
    'invalid_cohort_row'].includes(e?.message)?e.message:'COHORT_DB_ERROR'}));
  process.exitCode=1;
 });
