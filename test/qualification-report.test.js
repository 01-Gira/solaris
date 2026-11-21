import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {classifyChronology,createQualificationSummary,runQualification,reportLimit} from '../src/s1b1/qualification-report.js';
import {saveTransaction} from '../src/s1b/store.js';

const block='2026-11-20T00:00:00.000Z';
const signature='3'.repeat(88);
const sample={pool_address:'private-watched-pool',signature,source:'live',venue_family:'meteora',
 block_time:block,first_received_at:block,pool_created_at:block,event_slot:'100',stored_slot:'100',
 error_class:'success',payload:{slot:100,blockTime:Date.parse(block)/1000}};

test('creation timestamps, fork-slot conflicts and late receipt do not become trusted chronology',()=>{
 assert.equal(classifyChronology(sample),'no_conflict_detected');
 assert.equal(classifyChronology({...sample,pool_created_at:'2026-11-21'}),'provider_created_after_chain_event');
 assert.equal(classifyChronology({...sample,pool_created_at:null}),'provider_created_missing');
 assert.equal(classifyChronology({...sample,event_slot:'99'}),'slot_missing_or_conflicting');
 assert.equal(classifyChronology({...sample,block_time:null}),'time_missing');
 assert.equal(classifyChronology({...sample,block_time:'2026-11-19'}),'stored_rpc_block_time_conflict');
 assert.equal(classifyChronology({...sample,first_received_at:'2026-11-19'}),'block_after_receipt');
 assert.equal(classifyChronology({...sample,first_received_at:'2027-01-20'}),'historical_requires_provenance');
 assert.throws(()=>reportLimit(0),/invalid_qualification_limit/);
 assert.throws(()=>reportLimit(100001),/invalid_qualification_limit/);
});

test('a signature watched under two pools contributes once, and the report is aggregate only',()=>{
 const report=createQualificationSummary();
 report.add({...sample,shared_signature:true});
 report.add({...sample,pool_address:'other-private-pool',shared_signature:true,error_class:'unknown'});
 const result=report.result();
 assert.equal(result.examined.uniqueSignatures,1);
 assert.equal(result.examined.uniquePools,2);
 assert.equal(result.examined.repeatedSignatureRows,1);
 assert.equal(result.examined.eventRowsWithSharedSignature,2);
 assert.equal(result.examined.topPoolFraction,0.5);
 assert.deepEqual(result.byRpcOutcome,{success:1,unknown:1});
 assert.equal(result.byReconciliation['meteora:unsupported_venue'],2);
 assert.ok(!JSON.stringify(result).includes(signature));
 assert.ok(!JSON.stringify(result).includes('private-watched-pool'));
});

test('failed read transaction rolls back and does not turn an absent denominator into zero',async()=>{
 const statements=[];
 const db={query:async sql=>{statements.push(sql);return {rows:[]};}};
 await assert.rejects(runQualification(db),/qualification_hydration_missing/);
 assert.match(statements[0],/REPEATABLE READ READ ONLY/);
 assert.equal(statements.at(-1),'ROLLBACK');
});

const fixtureUrl=process.env.SOLARIS_FIXTURE_DATABASE_URL;
test('qualification and ingestion on isolated PostgreSQL',{
 skip:!fixtureUrl&&'set SOLARIS_FIXTURE_DATABASE_URL to an empty solaris_fixture PostgreSQL database'
},async()=>{
 const url=new URL(fixtureUrl);
 assert.equal(url.pathname,'/solaris_fixture');
 assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
 const db=new pg.Client({connectionString:fixtureUrl});
 await db.connect();
 try{
  assert.equal((await db.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count,'0');
  for(const migration of ['schema.sql','s1b/schema.sql','s1b1/v2-schema.sql','s3/schema.sql'])
   await db.query(await readFile(new URL(`../src/${migration}`,import.meta.url),'utf8'));
  await db.query(`INSERT INTO pools (pool_address,venue_family,pool_created_at,first_seen_at,last_seen_at,last_raw)
   VALUES ('pool-1','meteora',$1,$1,$1,'{}'),('pool-2','pumpfun',$1,$1,$1,'{}')`,[block]);
  await db.query(`INSERT INTO onchain_pool_events (pool_address,signature,slot,source,first_received_at)
   VALUES ('pool-1',$1,100,'live',$4),('pool-2',$1,100,'live',$4),('pool-1',$2,100,'backfill',$4),
   ('pool-1',$3,100,'live',$4),('pool-1','pending',100,'live',$4)`,[signature,'unknown','failed',block]);
  const tx={...sample.payload,transaction:{signatures:[signature],message:{instructions:[],accountKeys:[]}},meta:{err:null,fee:5000}};
  const shim={connect:async()=>({query:db.query.bind(db),release(){}})};
  await saveTransaction(shim,signature,tx);
  await saveTransaction(shim,signature,{...tx,meta:{...tx.meta,fee:8000}});
  await db.query(`INSERT INTO onchain_transactions (signature,slot,block_time,tx_error,payload)
   VALUES ('unknown',100,$1,NULL,$2),('failed',100,$1,'"BlockhashNotFound"'::jsonb,$3)`,[block,
   JSON.stringify({...tx,meta:{fee:5000}}),JSON.stringify({...tx,meta:{err:'BlockhashNotFound',fee:5000}})]);
  await db.query(`INSERT INTO s3_research_runs (engine_version,mode,status,inputs,report)
   VALUES ('fixture','audit','BLOCKED_DATA','{}','{}')`);
  const r=await runQualification(db);
  assert.equal(r.completeReplay,true);
  assert.equal(r.examined.uniqueSignatures,3);assert.equal(r.examined.eventRows,4);
  assert.equal(r.hydration.event_rows,5);assert.equal(r.hydration.missing_event_rows,1);
  assert.deepEqual(r.byRpcOutcome,{failed:1,success:2,unknown:1});
  assert.equal(r.transactionErrorStorageConflicts,0);
  assert.equal(r.independentHoldout.eligibleRows,0);
  assert.equal(r.currentS3Status,'BLOCKED_DATA');
  assert.equal(r.verifiedFills,0);assert.equal(r.economicsAuthorized,false);
  assert.equal(r.verdict,'BLOCKED_EXTERNAL_EVIDENCE');
  assert.equal((await db.query('SELECT fee_lamports FROM onchain_transactions WHERE signature=$1',[signature])).rows[0].fee_lamports,'5000');
  assert.equal((await runQualification(db,{limit:2})).gates.replay,'BLOCKED');
 }finally{await db.end();}
});
