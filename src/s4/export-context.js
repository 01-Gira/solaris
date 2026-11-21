// Export a minimal bounded, allowlisted snapshot. Emit one JSON document, no secrets,
// full transaction payloads, WALLET private keys, raw provider responses or credentials.
import pg from 'pg';
import {sanitizeResearchContext} from './policy.js';
import {fetchHydrationMetrics} from './hydration-metrics.js';
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
async function optional(sql,fallback){
 try{return (await db.query(sql)).rows;}catch(error){
  if(error?.code==='42P01'||error?.code==='42703')return fallback;
  throw error;
 }
}
try{
 await db.connect();
 const poolRows=await optional([
  'SELECT p.pool_address,p.venue_family,p.base_mint,p.first_seen_at,p.last_seen_at,',
  'p.last_liquidity_usd AS liquidity_usd,p.last_price_usd,',
  'r.risk_band,r.observed_concern_score AS risk_concern,r.assessed_at AS s2_assessed_at',
  'FROM pools p LEFT JOIN s2_pool_assessments r ON r.pool_address=p.pool_address',
  'ORDER BY p.first_seen_at DESC LIMIT 20'
 ].join(' '),null);
 const pools=poolRows||await optional([
  'SELECT pool_address,venue_family,base_mint,first_seen_at,last_seen_at,',
  'last_liquidity_usd AS liquidity_usd,last_price_usd FROM pools',
  'ORDER BY first_seen_at DESC LIMIT 20'
 ].join(' '),[]);
 const counters={
  observed_pools:'pools',decoded_events:'onchain_trade_decodes',
  s2_assessed_pools:'s2_pool_assessments'
 };
 const stats={};
 for(const [name,table] of Object.entries(counters)){
  const rows=await optional('SELECT COUNT(*)::int AS n FROM '+table,[{n:null}]);
  stats[name]=rows[0]?.n??null;
 }
 // Signature-matched coverage is distinct from global transaction row counts.
 const hydration=await optional('SELECT 1 FROM onchain_pool_events LIMIT 0',null)===null
  ? null : await fetchHydrationMetrics(db);
 if(hydration){
  stats.total_events=hydration.event_rows;
  stats.hydrated_events=hydration.hydrated_event_rows;
  stats.hydration=hydration;
 }else{
  stats.total_events=null;
  stats.hydrated_events=null;
  stats.hydration=null;
 }
 // Decoder classifications are NOT verified fills. Preserve observed categories.
 const decodeRows=await optional(
  'SELECT status,COUNT(*)::int AS n FROM onchain_trade_decodes GROUP BY status',null);
 stats.decode_breakdown=decodeRows===null?null:Object.fromEntries(
  decodeRows.filter(x=>typeof x.status==='string').map(x=>[x.status,x.n]));
 const s3Rows=await optional(
  'SELECT mode,status,economics_authorized,report FROM s3_research_runs ORDER BY id DESC LIMIT 1',[]);
 const last=s3Rows[0];
 const payload=sanitizeResearchContext({source:'solaris_s4_context_v1',
  collected_at:new Date().toISOString(),pools,stats,
  s3:last?{mode:last.mode,status:last.status,ready_pools:last.report?.readyPools,
    economics_authorized:false}:{status:'no_validated_run'}});
 process.stdout.write(JSON.stringify(payload)+'\n');
}catch(error){
 // Error text may include credentials. Never echo underlying SQL/DSN or RPC URLs.
 console.error('s4_context_export_failed: '+(error?.code||error?.name||'unknown'));
 process.exitCode=1;
}finally{await db.end().catch(()=>{});}
