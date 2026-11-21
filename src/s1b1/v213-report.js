// Audits immutable provider snapshots against historical on-chain block dates.
// Read-only; preserves source pool snapshots, transactions and candidate labels.
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {createProviderCohortSummary} from './v213-provider.js';

export function v213Limit(env=process.env){
 const value=env.S1B1_V213_LIMIT===undefined?1000:Number(env.S1B1_V213_LIMIT);
 if(!Number.isSafeInteger(value)||value<1||value>10000)throw Error('invalid_v213_limit');
 return value;
}
export async function runV213(db,{limit=1000}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw Error('invalid_v213_limit');
 const report=createProviderCohortSummary();let after='';
 while(true){
  const {rows}=await db.query(`WITH historical AS (
   SELECT e.pool_address,
     COUNT(*)::bigint AS historical_event_rows,
     COUNT(*) FILTER (WHERE t.tx_error IS NOT NULL)::bigint AS failed_onchain_rows,
     COUNT(*) FILTER (WHERE t.tx_error IS NULL)::bigint AS single_candidate_rows,
     MIN(t.block_time) AS earliest_historical_block,
     MAX(t.block_time) AS latest_historical_block
   FROM onchain_pool_events e
   JOIN onchain_transactions t ON t.signature=e.signature
   WHERE t.block_time IS NOT NULL
     AND t.block_time < (now() - interval '30 days')
   GROUP BY e.pool_address
  ), snapshot_summary AS (
   SELECT s.pool_address,
     COUNT(*)::bigint AS snapshot_count,
     COUNT(DISTINCT NULLIF(s.source_data#>>'{attributes,pool_created_at}',''))::bigint
       AS distinct_creation_values,
     (ARRAY_AGG(NULLIF(s.source_data#>>'{attributes,pool_created_at}','')
       ORDER BY s.observed_at ASC))[1] AS earliest_provider_created,
     (ARRAY_AGG(NULLIF(s.source_data#>>'{attributes,pool_created_at}','')
       ORDER BY s.observed_at DESC))[1] AS latest_provider_created
   FROM pool_snapshots s
   WHERE s.pool_address IN (SELECT pool_address FROM historical)
   GROUP BY s.pool_address
  )
  SELECT h.pool_address,h.historical_event_rows,h.failed_onchain_rows,
   h.single_candidate_rows,h.earliest_historical_block,h.latest_historical_block,
   p.pool_created_at AS current_provider_created,
   p.first_seen_at AS pool_first_seen_at,
   COALESCE(s.snapshot_count,0) AS snapshot_count,
   COALESCE(s.distinct_creation_values,0) AS distinct_creation_values,
   s.earliest_provider_created,s.latest_provider_created
  FROM historical h JOIN pools p ON p.pool_address=h.pool_address
  LEFT JOIN snapshot_summary s ON s.pool_address=h.pool_address
  WHERE h.pool_address>$1
  ORDER BY h.pool_address LIMIT $2`,[after,Math.min(200,limit)]);
  if(!rows.length)break;
  for(const row of rows)report.add(row);
  after=rows.at(-1).pool_address;
  limit-=rows.length;
  if(limit===0)break;
 }
 return {...report.result(),limitRemaining:limit,afterPoolSha256Prefix:after?
  (await import('node:crypto')).createHash('sha256').update(after).digest('hex').slice(0,16):null};
}
async function main(){
 if(!process.env.DATABASE_URL)throw Error('missing_database_url');
 const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
 await db.connect();
 try{
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const result=await runV213(db,{limit:v213Limit()});
  await db.query('COMMIT');
  console.log(JSON.stringify(result));
 }catch(err){await db.query('ROLLBACK').catch(()=>{});throw err;}
 finally{await db.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(e=>{
  console.error(JSON.stringify({kind:'s1b1_v213_failed',
   code:['invalid_v213_limit','missing_database_url','invalid_v213_row','invalid_v213_counts'].includes(e?.message)?
    e.message:'PROVIDER_DB_ERROR'}));process.exitCode=1;
 });
