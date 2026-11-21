// Read-only V2.5 token-account endpoint diagnostics, no changes to any tables.
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {createV25Summary} from './v25-edges.js';
import {V2_VERSION} from './v2.js';

export function v25Limit(env=process.env){
 const n=env.S1B1_V25_LIMIT===undefined?1000:Number(env.S1B1_V25_LIMIT);
 if(!Number.isInteger(n)||n<1||n>10000)throw Error('invalid_v25_limit');
 return n;
}
export async function runV25(db,{limit=1000}={}){
 if(!Number.isInteger(limit)||limit<1||limit>10000)throw Error('invalid_v25_limit');
 const report=createV25Summary();let after=0,remaining=limit;
 while(remaining>0){
  const {rows}=await db.query(`SELECT e.id,e.pool_address,e.signature,p.venue_family,t.payload
    FROM onchain_pool_events e
    JOIN onchain_trade_candidate_v2 v ON
      v.pool_address=e.pool_address AND v.signature=e.signature
      AND v.candidate_version=$1 AND v.status='single_trade_candidate'
    JOIN onchain_transactions t ON t.signature=e.signature
    LEFT JOIN pools p ON p.pool_address=e.pool_address
    WHERE e.id>$2 ORDER BY e.id LIMIT $3`,
  [V2_VERSION,after,Math.min(remaining,100)]);
  if(!rows.length)break;
  for(const row of rows)report.add(row);
  after=Number(rows.at(-1).id);remaining-=rows.length;
 }
 return {...report.result(),limit,candidateVersion:V2_VERSION,afterEventRowId:after};
}
async function main(){
 if(!process.env.DATABASE_URL)throw Error('missing_database_url');
 const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
 await db.connect();
 try{
  await db.query('BEGIN READ ONLY');
  const result=await runV25(db,{limit:v25Limit()});
  await db.query('COMMIT');
  console.log(JSON.stringify(result));
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
 finally{await db.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(e=>{
  console.error(JSON.stringify({kind:'s1b1_v25_failed',
   code:['invalid_v25_limit','missing_database_url'].includes(e?.message)?
    e.message:'TOKEN_EDGE_DB_ERROR'}));process.exitCode=1;
 });
