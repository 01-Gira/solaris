// Offline V2 candidate-only decoder. Never overwrites V1 classifications.
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {v2CandidateAnalysis,V2_VERSION} from './v2.js';

export function v2Limit(env=process.env){
 const n=env.S1B1_V2_LIMIT===undefined?1000:Number(env.S1B1_V2_LIMIT);
 if(!Number.isInteger(n)||n<1||n>10000)throw Error('invalid_v2_limit');
 return n;
}
export async function runV2(client,{limit=1000}={}){
 if(!Number.isInteger(limit)||limit<1||limit>10000)throw Error('invalid_v2_limit');
 const totals={},summary={kind:'s1b1_v2_candidates',version:V2_VERSION,
  processed:0,byStatus:totals,economicsAuthorized:false,
  liveTrading:false,verifiedFills:0};
 while(summary.processed<limit){
  const {rows}=await client.query(`SELECT e.pool_address,e.signature,t.payload
    FROM onchain_pool_events e
    JOIN onchain_transactions t ON t.signature=e.signature
    LEFT JOIN onchain_trade_candidate_v2 v
      ON v.pool_address=e.pool_address AND v.signature=e.signature
      AND v.candidate_version=$1
    WHERE v.signature IS NULL ORDER BY e.id LIMIT $2`,
   [V2_VERSION,Math.min(100,limit-summary.processed)]);
  if(!rows.length)break;
  for(const row of rows){
   const result=v2CandidateAnalysis(row.payload);
   await client.query(`INSERT INTO onchain_trade_candidate_v2 (
    pool_address,signature,candidate_version,status,trade_candidate_count,
    known_program_instruction_count,unknown_known_program_instruction_count,
    has_inner_candidate,has_outer_candidate,contains_pumpfun,contains_pumpswap,
    verified_fill,economics_authorized)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,false)
    ON CONFLICT(pool_address,signature,candidate_version) DO NOTHING`,
   [row.pool_address,row.signature,V2_VERSION,result.status,result.tradeCandidateCount,
    result.knownProgramInstructionCount,result.unknownKnownProgramInstructionCount,
    result.hasInnerCandidate,result.hasOuterCandidate,result.containsPumpfun,
    result.containsPumpswap]);
   summary.processed++;
   totals[result.status]=(totals[result.status]||0)+1;
  }
 }
 return summary;
}
async function main(){
 if(!process.env.DATABASE_URL)throw Error('missing_database_url');
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
 try{
  await client.connect();
  await client.query(await readFile(new URL('./v2-schema.sql',import.meta.url),'utf8'));
  const summary=await runV2(client,{limit:v2Limit()});
  console.log(JSON.stringify(summary));
 }finally{await client.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(e=>{
  const code=['invalid_v2_limit','missing_database_url'].includes(e?.message)?e.message:'V2_DATABASE_ERROR';
  console.error(JSON.stringify({kind:'s1b1_v2_failed',code}));process.exitCode=1;
 });
