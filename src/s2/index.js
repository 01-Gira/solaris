import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {SolanaRpc} from '../s1b/rpc.js';
import {assessPoolRisk,parseMintProof} from './risk.js';

function parameter(name,fallback,max){
 const raw=process.env[name],value=raw===undefined?fallback:Number(raw);
 if(!Number.isInteger(value)||value<1||value>max)throw new Error(name+' must be 1..'+max);
 return value;
}
const limit=parameter('S2_MAX_POOLS',25,200);
const rpcSpacing=parameter('S2_RPC_SPACING_MS',1500,60000);
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:10000});
const rpc=process.env.SOLANA_RPC_HTTP_URL
 ? new SolanaRpc(process.env.SOLANA_RPC_HTTP_URL,{spacingMs:rpcSpacing}) : null;
let completed=0,bands={reject:0,unknown:0,review:0},proofs=0;
try{
 await pool.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
 const {rows:pools}=await pool.query('SELECT * FROM pools ORDER BY first_seen_at DESC LIMIT $1',[limit]);
 for(const p of pools){
  const {rows:snapshots}=await pool.query(
   'SELECT observed_at,price_usd,liquidity_usd,volume_m5_usd FROM pool_snapshots WHERE pool_address=$1 ORDER BY observed_at DESC LIMIT 30',
   [p.pool_address]);
  let mintProof={status:'unknown',reason:'rpc_not_configured_or_mint_missing'};
  if(rpc&&p.base_mint){
   try{
    const response=await rpc.call('getAccountInfo',[p.base_mint,{encoding:'jsonParsed',commitment:'finalized'}]);
    mintProof=parseMintProof(response?.value,p.base_mint);
   }catch(error){
    mintProof={status:'unknown',reason:'rpc_mint_lookup_failed',
      errorCode:String(error?.message||error).match(/(?:HTTP|RPC error) -?\d+/)?.[0]||'transport_or_parse'};
   }
  }
  const a=assessPoolRisk({pool:p,snapshots,mintProof});
  const sql=[
   'INSERT INTO s2_pool_assessments',
   '(pool_address,version,assessed_at,risk_band,observed_concern_score,tradability,reasons,unknowns,evidence,economics_authorized)',
   "VALUES($1,$2,$3,$4,$5,'blocked',$6::jsonb,$7::jsonb,$8::jsonb,FALSE)",
   'ON CONFLICT(pool_address) DO UPDATE SET version=excluded.version,assessed_at=excluded.assessed_at,',
   'risk_band=excluded.risk_band,observed_concern_score=excluded.observed_concern_score,',
   'reasons=excluded.reasons,unknowns=excluded.unknowns,evidence=excluded.evidence'
  ].join(' ');
  await pool.query(sql,[p.pool_address,a.version,a.assessedAt,a.riskBand,
   a.observedConcernScore,JSON.stringify(a.reasons),JSON.stringify(a.unknown),
   JSON.stringify({observed:a.observed,mintProof:a.mintProof})]);
  completed++;bands[a.riskBand]++;if(mintProof.status==='verified_structure_only')proofs++;
 }
 console.log(JSON.stringify({kind:'s2_complete',version:'s2-0.4.0',assessed:completed,bands,
  mintStructuresVerified:proofs,tradability:'blocked',economicsAuthorized:false}));
}catch(error){
 console.error(JSON.stringify({kind:'s2_failed',message:String(error?.message||error).replace(/(?:https?|wss?):\/\/\S+/g,'[rpc-redacted]')}));
 process.exitCode=1;
}finally{await pool.end().catch(()=>{});}
