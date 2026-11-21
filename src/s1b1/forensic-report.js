// Read-only bounded PostgreSQL forensic report for prior decoder classifications.
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {createForensicReport} from './forensics.js';
import {DECODER_VERSION} from './decoder.js';

export function forensicLimit(env=process.env){
 const v=env.S1B1_FORENSIC_LIMIT===undefined?1000:Number(env.S1B1_FORENSIC_LIMIT);
 if(!Number.isInteger(v)||v<1||v>10000)throw new Error('invalid_forensic_limit');
 return v;
}
export async function generateForensicReport(client,{limit=1000,decoderVersion=DECODER_VERSION}={}){
 if(!Number.isInteger(limit)||limit<1||limit>10000)throw new Error('invalid_forensic_limit');
 const report=createForensicReport();
 let afterId=0,remaining=limit;
 while(remaining>0){
  const {rows}=await client.query(`
   SELECT e.id,e.pool_address,e.signature,d.status,d.reason,
    p.venue_family,t.payload
   FROM onchain_pool_events e
   JOIN onchain_trade_decodes d
    ON d.pool_address=e.pool_address AND d.signature=e.signature
   JOIN onchain_transactions t ON t.signature=e.signature
   LEFT JOIN pools p ON p.pool_address=e.pool_address
   WHERE e.id>$1 AND d.decoder_version=$2
   ORDER BY e.id
   LIMIT $3`,[afterId,decoderVersion,Math.min(remaining,100)]);
  if(rows.length===0)break;
  for(const row of rows)report.add(row);
  afterId=Number(rows.at(-1).id);
  remaining-=rows.length;
 }
 return {...report.result(),limit,decoderVersion,afterEventRowId:afterId};
}
async function main(){
 const dbUrl=process.env.DATABASE_URL;
 if(!dbUrl)throw new Error('missing_database_url');
 const client=new pg.Client({connectionString:dbUrl,connectionTimeoutMillis:10000});
 await client.connect();
 try{
  await client.query('BEGIN READ ONLY');
  const result=await generateForensicReport(client,{limit:forensicLimit()});
  await client.query('COMMIT');
  console.log(JSON.stringify(result));
 }catch(e){
  await client.query('ROLLBACK').catch(()=>{});
  throw e;
 }finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(e=>{
  // Do not log payloads, RPC URLs, credentials or unredacted PostgreSQL errors.
  const allowed=new Set(['invalid_forensic_limit','missing_database_url']);
  console.error(JSON.stringify({kind:'s1b1_forensic_failed',
   code:allowed.has(e?.message)?e.message:'FORENSIC_DB_ERROR'}));
  process.exitCode=1;
 });
}
