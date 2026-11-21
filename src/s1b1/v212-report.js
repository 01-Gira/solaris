// Read-only transaction/IDL provenance report; no external RPC calls.
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {createProvenanceSummary} from './v212-provenance.js';
import {V2_VERSION} from './v2.js';
export function v212Limit(env=process.env){
 const n=env.S1B1_V212_LIMIT===undefined?10000:Number(env.S1B1_V212_LIMIT);
 if(!Number.isSafeInteger(n)||n<1||n>100000)throw Error('invalid_v212_limit');
 return n;
}
export async function runV212(db,{limit=10000}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>100000)throw Error('invalid_v212_limit');
 const report=createProvenanceSummary();let after=0,left=limit;
 while(left>0){
  const {rows}=await db.query(`SELECT e.id,e.pool_address,e.signature,e.source,e.first_received_at,
   p.venue_family,p.pool_created_at,t.block_time,t.tx_error,
   t.payload->'transaction'->'message'->'instructions' AS outer_instructions,
   t.payload->'transaction'->'message'->'accountKeys' AS account_keys,
   t.payload->'meta'->'innerInstructions' AS inner_groups,
   t.payload->'meta'->'logMessages' AS log_messages,
   v.status
   FROM onchain_pool_events e
   JOIN onchain_trade_candidate_v2 v ON v.pool_address=e.pool_address
     AND v.signature=e.signature AND v.candidate_version=$1
   JOIN onchain_transactions t ON t.signature=e.signature
   LEFT JOIN pools p ON p.pool_address=e.pool_address
   WHERE e.id>$2 ORDER BY e.id LIMIT $3`,
   [V2_VERSION,after,Math.min(500,left)]);
  if(!rows.length)break;
  rows.forEach(row=>report.add(row));
  after=Number(rows.at(-1).id);left-=rows.length;
 }
 return {...report.result(),candidateVersion:V2_VERSION,limit,afterEventRowId:after};
}
async function main(){
 if(!process.env.DATABASE_URL)throw Error('missing_database_url');
 const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
 await db.connect();
 try{
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const report=await runV212(db,{limit:v212Limit()});
  await db.query('COMMIT');console.log(JSON.stringify(report));
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
 finally{await db.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(e=>{
  console.error(JSON.stringify({kind:'s1b1_v212_failed',
   code:['invalid_v212_limit','missing_database_url','invalid_v212_row'].includes(e?.message)?
    e.message:'PROVENANCE_DB_ERROR'}));process.exitCode=1;
 });
