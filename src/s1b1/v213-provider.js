// SOLARIS S1b.1 V2.13: Read-only audit of provider-derived pool creation metadata.
// Current pools.pool_created_at is mutable GeckoTerminal metadata, NOT a verified
// on-chain pool creation proof. Historical events must never be silently re-dated.
import {createHash} from 'node:crypto';

export const V213_VERSION='s1b1-v213-provider-provenance-0.1';
const hash=x=>createHash('sha256').update(String(x||'')).digest('hex').slice(0,16);
const parseTime=x=>{
 if(x===null||x===undefined||x==='')return null;
 const millis=x instanceof Date?x.getTime():new Date(x).getTime();
 return Number.isFinite(millis)?millis:null;
};
const date=x=>{const n=parseTime(x);return n===null?null:new Date(n).toISOString().slice(0,10);};
const tally=(obj,key,n=1)=>{obj[key]=(obj[key]||0)+n;};
const ranked=obj=>Object.entries(obj).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .map(([key,eventRows])=>({key,eventRows}));

export function inspectProviderCohort(row){
 if(!row||typeof row.pool_address!=='string'||!row.pool_address)
  throw Error('invalid_v213_row');
 const historicalCount=Number(row.historical_event_rows);
 const snapCount=Number(row.snapshot_count);
 const distinctCount=Number(row.distinct_creation_values);
 if(![historicalCount,snapCount,distinctCount].every(x=>Number.isSafeInteger(x)&&x>=0)||
  historicalCount===0||distinctCount>snapCount)
  throw Error('invalid_v213_counts');
 const oldest=parseTime(row.earliest_historical_block);
 const current=parseTime(row.current_provider_created);
 const first=parseTime(row.earliest_provider_created);
 const last=parseTime(row.latest_provider_created);
 const firstSeen=parseTime(row.pool_first_seen_at);
 const sourceUnknown=current===null&&first===null&&last===null;
 const chronology=current===null?'current_provider_created_missing':
  oldest===null?'historical_block_time_missing':
  current>oldest+300000?'current_provider_created_after_oldest_historical_block':
  'current_provider_created_not_after_oldest_historical_block';
 const earliestComparison=first===null?'earliest_snapshot_creation_missing':
  oldest===null?'historical_block_time_missing':
  first>oldest+300000?'earliest_snapshot_creation_after_oldest_historical_block':
  'earliest_snapshot_creation_not_after_oldest_historical_block';
 const sourceVariation=distinctCount>1?'provider_created_value_changed_across_snapshots':
  distinctCount===1?'provider_created_value_stable_in_available_snapshots':
  'no_provider_created_value_in_snapshots';
 const firstSeenRelation=firstSeen===null||oldest===null?'not_comparable':
  firstSeen>oldest?'discovered_after_historical_transaction':
  'discovered_before_or_at_historical_transaction';
 return {
  poolSha256Prefix:hash(row.pool_address),
  historicalEventRows:historicalCount,
  failedOnchainRows:Number(row.failed_onchain_rows||0),
  singleTradeCandidateRows:Number(row.single_candidate_rows||0),
  earliestHistoricalBlockDay:date(row.earliest_historical_block),
  latestHistoricalBlockDay:date(row.latest_historical_block),
  firstDiscoveredDay:date(row.pool_first_seen_at),
  currentProviderCreatedDay:date(row.current_provider_created),
  earliestProviderCreatedDay:date(row.earliest_provider_created),
  latestProviderCreatedDay:date(row.latest_provider_created),
  providerSnapshotCount:snapCount,
  distinctProviderCreatedValues:distinctCount,
  chronology,earliestComparison,sourceVariation,firstSeenRelation,
  adjudication:sourceUnknown?'provider_creation_metadata_unavailable':
   current!==null&&oldest!==null&&current>oldest+300000?
    'provider_chain_creation_conflict_requires_external_proof':
    'provider_creation_not_in_conflict_by_current_date',
  immutableChainProvenanceVerified:false,verifiedFills:0
 };
}
export function createProviderCohortSummary(){
 const records=[],byAdjudication={},byVariation={},byChronology={};
 let total=0;
 return {add(row){
  const r=inspectProviderCohort(row);records.push(r);total+=r.historicalEventRows;
  tally(byAdjudication,r.adjudication,r.historicalEventRows);
  tally(byVariation,r.sourceVariation,r.historicalEventRows);
  tally(byChronology,r.chronology,r.historicalEventRows);
 },result(){
  const sorted=records.sort((a,b)=>b.historicalEventRows-a.historicalEventRows||
   a.poolSha256Prefix.localeCompare(b.poolSha256Prefix));
  return {kind:'s1b1_v213_provider_provenance_audit',version:V213_VERSION,
   historicalPoolCount:sorted.length,historicalEventRows:total,
   byAdjudication:ranked(byAdjudication),
   byProviderCreationVariation:ranked(byVariation),
   byCurrentCreationChronology:ranked(byChronology),
   pools:sorted.slice(0,30),
   observation:'Provider pool_created_at may be overwritten during collection. Past pool snapshots retain original provider source_data, but are not on-chain creation proofs. Discovery before later trades is normal and must not be flagged as corrupt.',
   researchAuthority:'BLOCKED_DATA',verifiedFills:0,economicsAuthorized:false,
   liveTrading:false,readOnly:true};
 }};
}
