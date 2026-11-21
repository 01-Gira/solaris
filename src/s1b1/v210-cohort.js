// SOLARIS S1b.1 V2.10 — coverage/independence audit over V2 classified event rows.
// No transaction re-decoding, new fills, economics, or writes.
import {createHash} from 'node:crypto';

export const COHORT_VERSION='s1b1-v210-cohort-coverage-0.1';
const hash=value=>createHash('sha256').update(String(value||'')).digest('hex').slice(0,16);
const inc=(map,key,n=1)=>map.set(key,(map.get(key)||0)+n);
const ranked=(map,max=40)=>[...map.entries()]
 .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,max).map(([key,eventRows])=>({key,eventRows}));
const day=value=>{
 if(value===null||value===undefined)return null;
 const t=value instanceof Date?value.getTime():Date.parse(String(value));
 return Number.isFinite(t)?new Date(t).toISOString().slice(0,10):null;
};
const safeCount=value=>{
 const n=Number(value);
 if(!Number.isSafeInteger(n)||n<0)throw Error('invalid_coverage_count');
 return n;
};
export function createCohortSummary(coverage){
 const totals={totalEventRows:safeCount(coverage.total_event_rows),
  hydratedEventRows:safeCount(coverage.hydrated_event_rows),
  v2ClassifiedEventRows:safeCount(coverage.v2_classified_event_rows)};
 const pools=new Map(),signatures=new Set(),byStatus=new Map(),byVenue=new Map(),
  bySource=new Map(),byBlockDay=new Map(),byStatusVenue=new Map();
 let rows=0,missingBlockTime=0,missingReceivedAt=0;
 let earliestBlockDay=null,latestBlockDay=null;
 const min=(a,b)=>a===null?b:Math.min(Date.parse(a),Date.parse(b))===Date.parse(a)?a:b;
 const max=(a,b)=>a===null?b:Math.max(Date.parse(a),Date.parse(b))===Date.parse(a)?a:b;
 return {add(row){
  const pool=String(row.pool_address||''),signature=String(row.signature||'');
  if(!pool||!signature)throw Error('invalid_cohort_row');
  const status=String(row.status||'unknown').slice(0,60);
  const venue=String(row.venue_family||'unknown').slice(0,40);
  const source=String(row.source||'unknown').slice(0,24);
  const block=day(row.block_time);
  const received=day(row.first_received_at);
  if(!block)missingBlockTime++;
  else{
   inc(byBlockDay,block);
   earliestBlockDay=min(earliestBlockDay,block);
   latestBlockDay=max(latestBlockDay,block);
  }
  if(!received)missingReceivedAt++;
  rows++;signatures.add(signature);
  inc(byStatus,status);inc(byVenue,venue);inc(bySource,source);
  inc(byStatusVenue,status+':'+venue);
  let bucket=pools.get(pool);
  if(!bucket){bucket={venue,events:0,signatures:new Set(),byStatus:new Map(),
   firstBlockDay:null,lastBlockDay:null};pools.set(pool,bucket);}
  bucket.events++;bucket.signatures.add(signature);inc(bucket.byStatus,status);
  if(block){
   bucket.firstBlockDay=min(bucket.firstBlockDay,block);
   bucket.lastBlockDay=max(bucket.lastBlockDay,block);
  }
 },result(){
  const poolRank=[...pools.entries()].sort((a,b)=>b[1].events-a[1].events||a[0].localeCompare(b[0]));
  const sumSquares=poolRank.reduce((sum,[,p])=>sum+p.events*p.events,0);
  const top1=poolRank[0]?.[1].events||0;
  const top3=poolRank.slice(0,3).reduce((s,[,p])=>s+p.events,0);
  const topPools=poolRank.slice(0,10).map(([pool,p])=>({
   poolSha256Prefix:hash(pool),venue:p.venue,eventRows:p.events,
   uniqueSignatures:p.signatures.size,byStatus:ranked(p.byStatus,10),
   firstBlockDay:p.firstBlockDay,lastBlockDay:p.lastBlockDay
  }));
  return {kind:'s1b1_v210_cohort_coverage_audit',version:COHORT_VERSION,
   units:'v2_classified_event_rows_ordered_by_event_id',
   sampledClassifiedEventRows:rows,uniquePools:pools.size,
   uniqueSignatures:signatures.size,
   sampling:{
    ...totals,unclassifiedHydratedEventRows:Math.max(0,
     totals.hydratedEventRows-totals.v2ClassifiedEventRows),
    sampledAllV2ClassifiedRows:rows===totals.v2ClassifiedEventRows,
    fractionOfClassifiedSampled:totals.v2ClassifiedEventRows?
     rows/totals.v2ClassifiedEventRows:null,
    fractionOfHydratedClassified:totals.hydratedEventRows?
     totals.v2ClassifiedEventRows/totals.hydratedEventRows:null,
    orderedBy:'onchain_pool_events.id',
    design:'deterministic_first_rows_not_random_or_representative'
   },
   concentration:{
    topPoolEventRows:top1,topPoolFraction:rows?top1/rows:null,
    top3PoolFraction:rows?top3/rows:null,
    effectivePoolsByEventConcentration:sumSquares>0?
     Number((rows*rows/sumSquares).toFixed(3)):0
   },
   timeCoverage:{earliestBlockDay,latestBlockDay,
    distinctBlockDays:byBlockDay.size,
    missingBlockTimeEventRows:missingBlockTime,
    missingReceivedAtEventRows:missingReceivedAt},
   byStatus:ranked(byStatus),byVenue:ranked(byVenue),
   bySource:ranked(bySource),
   byStatusVenue:ranked(byStatusVenue),
   byBlockDay:ranked(byBlockDay,60),topPools,
   interpretation:'Event rows are clustered by pool and may repeat the same signature across observed pools. An early event-ID ordered sample does not establish independent trades, population representativeness, holdout performance, executable fills or profitability.',
   readiness:'EVIDENCE_DIVERSITY_NOT_ESTABLISHED',
   verifiedFills:0,economicsAuthorized:false,liveTrading:false,readOnly:true
  };
 }};
}
