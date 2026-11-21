import {createHash} from 'node:crypto';

// A DB-backed, per-endpoint reservation clock shared by the S1b streamer and
// detached hydration worker. No API credentials or RPC URLs are stored in DB.
// The INSERT/ON CONFLICT update serializes reservations on one primary-key row.
export const RPC_RESERVE_SQL = `
WITH slot AS (
 INSERT INTO onchain_rpc_request_budget(provider_key,next_allowed_at)
 VALUES ($1,clock_timestamp() + ($2::bigint * interval '1 millisecond'))
 ON CONFLICT(provider_key) DO UPDATE SET
  next_allowed_at = GREATEST(onchain_rpc_request_budget.next_allowed_at,clock_timestamp())
    + ($2::bigint * interval '1 millisecond')
 RETURNING next_allowed_at - ($2::bigint * interval '1 millisecond') AS reserved_at
)
SELECT GREATEST(0,CEIL(EXTRACT(EPOCH FROM ((SELECT reserved_at FROM slot) - clock_timestamp()))*1000))::integer AS wait_ms
`;
export const RPC_DEFER_SQL = `
INSERT INTO onchain_rpc_request_budget(provider_key,next_allowed_at)
VALUES ($1,clock_timestamp() + ($2::bigint * interval '1 millisecond'))
ON CONFLICT(provider_key) DO UPDATE SET
 next_allowed_at=GREATEST(onchain_rpc_request_budget.next_allowed_at,EXCLUDED.next_allowed_at)
`;
export class RpcPacingUnavailable extends Error {
 constructor() { super('rpc_pacing_unavailable'); this.code='RPC_PACING_UNAVAILABLE'; }
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function rpcProviderKey(url){
 if(typeof url!=='string'||!url.startsWith('https://'))throw new Error('invalid_rpc_endpoint');
 // Hash the complete URL: never expose an endpoint containing an API token.
 return createHash('sha256').update(url).digest('hex');
}
export class SharedRpcPacer {
 constructor(db,url,{spacingMs=1000,sleepImpl=sleep}={}){
  if(!Number.isInteger(spacingMs)||spacingMs<100||spacingMs>60000)throw new Error('invalid_rpc_spacing');
  this.db=db;this.key=rpcProviderKey(url);this.spacingMs=spacingMs;this.sleepImpl=sleepImpl;
 }
 async reserve(){
  let waitMs;
  try{
   const {rows}=await this.db.query(RPC_RESERVE_SQL,[this.key,this.spacingMs]);
   waitMs=Number(rows[0]?.wait_ms);
   if(!Number.isFinite(waitMs)||waitMs<0||waitMs>3600000)throw new Error('invalid_slot');
  }catch{throw new RpcPacingUnavailable();}
  if(waitMs>0)await this.sleepImpl(waitMs);
 }
 async defer(retryAfterMs){
  const delay=Math.max(30000,Math.min(600000,Math.ceil(Number(retryAfterMs)||0)));
  try{await this.db.query(RPC_DEFER_SQL,[this.key,delay]);}
  catch{throw new RpcPacingUnavailable();}
 }
}
