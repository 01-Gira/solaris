import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getS1bConfig} from '../src/s1b/config.js';
import {SolanaRpc,RpcError} from '../src/s1b/rpc.js';
import {SharedRpcPacer,rpcProviderKey,RpcPacingUnavailable,RPC_RESERVE_SQL} from '../src/s1b/rpc-pacer.js';
import {streamReadyForExternalHydration,runDetachedHydration} from '../src/s1b/hydration.js';
import {processTransactions} from '../src/s1b/worker.js';

const env={DATABASE_URL:'postgresql://tester@db/tester',
 SOLANA_RPC_HTTP_URL:'https://rpc.example.net/secret-value',
 SOLANA_RPC_WS_URL:'wss://rpc.example.net/ws-secret'};
test('S1b retains the existing inline default; external mode must be explicit',()=>{
 assert.equal(getS1bConfig(env).hydrationMode,'inline');
 assert.equal(getS1bConfig({...env,S1B_HYDRATION_MODE:'external'}).hydrationMode,'external');
 assert.throws(()=>getS1bConfig({...env,S1B_HYDRATION_MODE:'both'}),/S1B_HYDRATION_MODE/);
});
test('pacer hashes private RPC endpoint and reserves through DB',async()=>{
 const statements=[],waits=[];
 const db={query:async(sql,params)=>{
  statements.push({sql,params});
  return {rows:[{wait_ms:23}]};
 }};
 const p=new SharedRpcPacer(db,env.SOLANA_RPC_HTTP_URL,
  {spacingMs:1000,sleepImpl:async ms=>waits.push(ms)});
 await p.reserve();
 await p.defer(45000);
 assert.equal(waits[0],23);
 assert.equal(statements[0].sql,RPC_RESERVE_SQL);
 assert.equal(statements[0].params[1],1000);
 assert.equal(statements[1].params[1],45000);
 assert.equal(statements[0].params[0],rpcProviderKey(env.SOLANA_RPC_HTTP_URL));
 assert.equal(statements[0].params[0].length,64);
 assert.ok(!JSON.stringify(statements).includes('secret-value'));
});
test('pacer fails closed if DB reservations are inaccessible',async()=>{
 const p=new SharedRpcPacer({query:async()=>{throw Error('network lost');}},
  env.SOLANA_RPC_HTTP_URL);
 await assert.rejects(()=>p.reserve(),e=>e instanceof RpcPacingUnavailable);
 await assert.rejects(()=>p.defer(30000),e=>e.code==='RPC_PACING_UNAVAILABLE');
});
test('RPC refuses to fetch if the shared rate reservation fails',async()=>{
 let calls=0;
 const rpc=new SolanaRpc(env.SOLANA_RPC_HTTP_URL,{
  spacingMs:1000,pacer:{reserve:async()=>{throw new RpcPacingUnavailable();}},
  fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({result:1})}}
 });
 await assert.rejects(()=>rpc.call('getSlot'),/rpc_pacing_unavailable/);
 assert.equal(calls,0);
});
test('RPC 429 causes provider-wide shared cooldown, no burst fallback',async()=>{
 let reserve=0,defer=0;
 const rpc=new SolanaRpc(env.SOLANA_RPC_HTTP_URL,{
  pacer:{reserve:async()=>{reserve++},defer:async ms=>{defer=ms}},
  fetchImpl:async()=>({ok:false,status:429,headers:{get:()=> '40'}})
 });
 await assert.rejects(()=>rpc.call('getSlot'),e=>e instanceof RpcError&&e.retryAfterMs===40000);
 assert.equal(reserve,1);assert.equal(defer,40000);
});
test('failed DB pacing never burns the transaction retry budget',async()=>{
 let retries=0;
 const db={query:async sql=>{
  if(sql.includes('SELECT signature'))return {rows:[{signature:'sig',attempts:0}]};
  if(sql.includes('UPDATE onchain_pool_events'))retries++;
  return {rows:[]};
 }};
 const rpc={getTransaction:async()=>{throw new RpcPacingUnavailable()}};
 await assert.rejects(()=>processTransactions(db,rpc,{txBatchSize:5,txMaxAttempts:8}),/rpc_pacing_unavailable/);
 assert.equal(retries,0);
});
test('worker checks streamer-attested external mode and fresh connected heartbeat',async()=>{
 assert.match((await import('../src/s1b/hydration.js')).streamReadyForExternalHydration.toString(),/waiting_for_pools/);
 const good={query:async()=>({rows:[{ready:true,hydration_mode:'external',state:'connected'}]})};
 const stale={query:async()=>({rows:[{ready:false,hydration_mode:'inline',state:'connected'}]})};
 assert.equal(await streamReadyForExternalHydration(good),true);
 assert.equal(await streamReadyForExternalHydration(stale),false);
});
test('hydration worker refuses inline mode before opening a DB connection',async()=>{
 let opened=0;
 const db={connect:async()=>{opened++}};
 await assert.rejects(()=>runDetachedHydration(db,{hydrationMode:'inline'},new AbortController().signal),
  /hydration_mode_external_required/);
 assert.equal(opened,0);
});
test('worker owns an exclusive session lease and releases it on graceful shutdown',async()=>{
 const c=new AbortController();
 const queries=[];
 const owner={query:async(sql)=>{
  queries.push(sql);
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{acquired:true}]};
  if(sql==='SELECT 1')c.abort();
  return {rows:[{ready:false}]};
 },release:()=>queries.push('release')};
 const db={connect:async()=>owner,query:async()=>({rows:[{ready:false}]})};
 const result=await runDetachedHydration(db,{hydrationMode:'external',httpUrl:env.SOLANA_RPC_HTTP_URL,
  rpcSpacingMs:1000,txBatchSize:10},c.signal);
 assert.equal(result.status,'STOPPED');
 assert.ok(queries.some(x=>x.includes('pg_try_advisory_lock')));
 assert.ok(queries.some(x=>x.includes('pg_advisory_unlock')));
 assert.ok(queries.includes('release'));
});
