// Read-only transaction-level amount consistency diagnostics.
// Raw transaction payload is read locally; no token quantities exported.
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {createV215Summary} from './v215-amounts.js';
import {V2_VERSION} from './v2.js';
export function v215Limit(env=process.env){
 const n=env.S1B1_V215_LIMIT===undefined?3000:Number(env.S1B1_V215_LIMIT);
 if(!Number.isSafeInteger(n)||n<1||n>100000)throw Error('invalid_v215_limit');
 return n;
}
export async function runV215(db,{limit=3000}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>100000)throw Error('invalid_v215_limit');
 const summary=createV215Summary();let after=0,remaining=limit;
 while(remaining>0){
  const {rows}=await db.query(`SELECT e.id,e.pool_address,e.signature,p.venue_family,t.payload
    FROM onchain_pool_events e
    JOIN onchain_trade_candidate_v2 v ON v.pool_address=e.pool_address
     AND v.signature=e.signature AND v.candidate_version=$1
     AND v.status='single_trade_candidate'
    JOIN onchain_transactions t ON t.signature=e.signature
    LEFT JOIN pools p ON p.pool_address=e.pool_address
    WHERE e.id>$2 ORDER BY e.id LIMIT $3`,
    [V2_VERSION,after,Math.min(100,remaining)]);
  if(!rows.length)break;
  for(const row of rows)summary.add(row);
  after=Number(rows.at(-1).id);remaining-=rows.length;
 }
 return {...summary.result(),candidateVersion:V2_VERSION,limit,afterEventRowId:after};
}
async function main(){
 if(!process.env.DATABASE_URL)throw Error('missing_database_url');
 const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
 await db.connect();
 try{
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const r=await runV215(db,{limit:v215Limit()});
  await db.query('COMMIT');
  console.log(JSON.stringify(r));
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
 finally{await db.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(e=>{
  console.error(JSON.stringify({kind:'s1b1_v215_failed',
   code:['invalid_v215_limit','missing_database_url'].includes(e?.message)?
    e.message:'V215_DB_ERROR'}));process.exitCode=1;
 });
