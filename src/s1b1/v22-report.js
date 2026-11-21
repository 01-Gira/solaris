// Read-only V2.2 authority evidence report, no transactions or decode writes.
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {createAuthoritySummary} from './v22-authority.js';
import {V2_VERSION} from './v2.js';
export function authorityLimit(env=process.env){
 const n=env.S1B1_V22_LIMIT===undefined?1000:Number(env.S1B1_V22_LIMIT);
 if(!Number.isInteger(n)||n<1||n>10000)throw Error('invalid_v22_limit');
 return n;
}
export async function runAuthorityReport(client,{limit=1000}={}){
 if(!Number.isInteger(limit)||limit<1||limit>10000)throw Error('invalid_v22_limit');
 const report=createAuthoritySummary();
 let afterId=0,remaining=limit;
 while(remaining>0){
  const {rows}=await client.query(`SELECT e.id,e.pool_address,e.signature,
    p.venue_family,t.payload
   FROM onchain_pool_events e
   JOIN onchain_trade_candidate_v2 v
     ON v.pool_address=e.pool_address AND v.signature=e.signature
     AND v.candidate_version=$1 AND v.status='single_trade_candidate'
   JOIN onchain_transactions t ON t.signature=e.signature
   LEFT JOIN pools p ON p.pool_address=e.pool_address
   WHERE e.id>$2 ORDER BY e.id LIMIT $3`,
   [V2_VERSION,afterId,Math.min(remaining,100)]);
  if(!rows.length)break;
  for(const row of rows)report.add(row);
  afterId=Number(rows.at(-1).id);
  remaining-=rows.length;
 }
 return {...report.result(),limit,candidateVersion:V2_VERSION,afterEventRowId:afterId};
}
async function main(){
 if(!process.env.DATABASE_URL)throw Error('missing_database_url');
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,
  connectionTimeoutMillis:10000});
 await client.connect();
 try{
  await client.query('BEGIN READ ONLY');
  const report=await runAuthorityReport(client,{limit:authorityLimit()});
  await client.query('COMMIT');
  console.log(JSON.stringify(report));
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
 finally{await client.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(e=>{
  console.error(JSON.stringify({kind:'s1b1_v22_failed',
   code:['invalid_v22_limit','missing_database_url'].includes(e?.message)?
    e.message:'AUTHORITY_DB_ERROR'}));process.exitCode=1;
 });
