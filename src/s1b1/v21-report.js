// Read-only review of V2 candidate instructions and watched pool references.
// No migration, writes, Codex calls, RPC calls, or trading logic.
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {createAttributionSummary} from './v21-attribution.js';
import {V2_VERSION} from './v2.js';

export function attributionLimit(env=process.env){
 const value=env.S1B1_V21_LIMIT===undefined?1000:Number(env.S1B1_V21_LIMIT);
 if(!Number.isInteger(value)||value<1||value>10000)
  throw new Error('invalid_v21_limit');
 return value;
}
export async function runAttributionReport(client,{limit=1000}={}){
 if(!Number.isInteger(limit)||limit<1||limit>10000)
  throw new Error('invalid_v21_limit');
 const report=createAttributionSummary();
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
   [V2_VERSION,afterId,Math.min(100,remaining)]);
  if(!rows.length)break;
  for(const row of rows)report.add(row);
  afterId=Number(rows.at(-1).id);
  remaining-=rows.length;
 }
 return {...report.result(),limit,afterEventRowId:afterId,
  candidateVersion:V2_VERSION};
}
async function main(){
 if(!process.env.DATABASE_URL)throw new Error('missing_database_url');
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,
  connectionTimeoutMillis:10000});
 await client.connect();
 try{
  await client.query('BEGIN READ ONLY');
  const result=await runAttributionReport(client,{limit:attributionLimit()});
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify(result)+'\n');
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
 finally{await client.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(e=>{
  console.error(JSON.stringify({kind:'s1b1_v21_attribution_failed',
   code:['invalid_v21_limit','missing_database_url'].includes(e?.message)?
    e.message:'ATTRIBUTION_DB_ERROR'}));
  process.exitCode=1;
 });
}
