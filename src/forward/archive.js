import {setTimeout as delay} from 'node:timers/promises';
import {append,records,withCollectionLease} from './store.js';
import {check,distinct,hash,integer,isAddress,isList,isSignature,micros,stamp,VERSION,DAY} from './contract.js';
import {verifyWire} from './wire.js';

export const LIMITS=Object.freeze({requests:64,perUtcDay:256,retries:2,spacingMs:1000,timeoutMs:15000,
 responseBytes:32*1024*1024,slots:32,signaturesPerSlot:32,units:128,unitsPerUtcDay:512});
const nullCodes=new Set([-32004,-32007,-32009]);
const unavailableCodes=new Set([-32001,-32011,-32014,-32015]);
export const blockIdentity=body=>({slot:body.slot,parentSlot:body.parentSlot,blockhash:body.blockhash,
 previousBlockhash:body.previousBlockhash,blockTime:body.blockTime,rosterHash:hash(body.roster)});

export function validateBlock(body,genesis){
 check(body.genesis===genesis&&integer(body.slot,1)&&integer(body.parentSlot,0,body.slot-1)&&
  isAddress(body.blockhash)&&isAddress(body.previousBlockhash)&&stamp(body.blockTime)!==null&&
  isList(body.roster,20000)&&distinct(body.roster)&&body.roster.every(isSignature)&&
  isList(body.transactions,LIMITS.signaturesPerSlot),'invalid_finalized_block');
 const receipts=new Map(),roster=new Set(body.roster);
 for(const tx of body.transactions){
  check(roster.has(tx?.signature)&&!receipts.has(tx.signature)&&['success','failed'].includes(tx.outcome)&&
   micros(tx.fee)!==null&&/^[a-f0-9]{64}$/.test(tx.metaDigest)&&
   tx.meta&&Object.hasOwn(tx.meta,'err')&&tx.outcome===(tx.meta.err===null?'success':'failed')&&
   integer(tx.meta.fee)&&BigInt(tx.meta.fee)===micros(tx.fee)&&hash(tx.meta)===tx.metaDigest,'invalid_block_receipt');
  const wire=verifyWire(tx.wire,tx.signature);
  receipts.set(tx.signature,{...wire,meta:tx.meta,metaDigest:tx.metaDigest,outcome:tx.outcome,fee:tx.fee});
 }
 return {identity:hash(blockIdentity(body)),receipts};
}

function normalizeBlock(block,full,slot,genesis,requested){
 const roster=block?.signatures;
 const transactions=[];
 if(full){
  check(['parentSlot','blockhash','previousBlockhash','blockTime'].every(key=>full[key]===block[key])&&
   Array.isArray(full.transactions)&&Array.isArray(roster)&&full.transactions.length===roster.length,
   'rpc_block_selector_conflict');
  for(const signature of requested){
   const tx=full.transactions[roster.indexOf(signature)],wire=tx?.transaction?.[0];
   if(tx?.transaction?.[1]!=='base64'||!tx.meta||!Object.hasOwn(tx.meta,'err')||!integer(tx.meta.fee))continue;
   try{verifyWire(wire,signature);}catch{continue;}
   transactions.push({signature,wire,outcome:tx.meta.err===null?'success':'failed',fee:String(tx.meta.fee),
    metaDigest:hash(tx.meta),meta:tx.meta});
  }
 }
 check(integer(block?.blockTime,0,253402300799),'block_time_unavailable');
 const body={slot,genesis,parentSlot:block.parentSlot,blockhash:block.blockhash,previousBlockhash:block.previousBlockhash,
  blockTime:new Date(block.blockTime*1000).toISOString(),roster,transactions};
 validateBlock(body,genesis);
 return body;
}

async function responseJson(response){
 const reader=response.body?.getReader();
 check(reader,'missing_rpc_body');
 const chunks=[];let size=0;
 try{
  while(true){
   const {value,done}=await reader.read();if(done)break;
   size+=value.byteLength;
   check(size<=LIMITS.responseBytes,'rpc_response_limit');chunks.push(value);
  }
 }finally{await reader.cancel().catch(()=>{});}
 return JSON.parse(Buffer.concat(chunks));
}

export function rpcTransport(endpoint,fetchImpl=fetch){
 let url;
 try{url=new URL(endpoint);}catch{throw new Error('independent_archival_endpoint_required');}
 check(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash,'https_archival_endpoint_required');
 return async (method,params,id)=>{
  check(['getGenesisHash','getBlock'].includes(method),'rpc_method_not_allowed');
  try{
   const response=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(LIMITS.timeoutMs),
    headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
   if(response.status===429){
    const header=response.headers.get('retry-after'),seconds=/^\d+$/.test(header??'')?Number(header):null;
    const waitMs=seconds===null?Date.parse(header)-Date.now():seconds*1000;
    await response.body?.cancel().catch(()=>{});
    return {status:'rate_limited',waitMs:Number.isFinite(waitMs)?Math.max(60000,waitMs):DAY};
   }
   if(!response.ok){await response.body?.cancel().catch(()=>{});
    return {status:'unavailable',reason:response.status>=500?'http_server':'http_denied'};
   }
   const reply=await responseJson(response);
   if(reply?.id!==id||reply?.jsonrpc!=='2.0')return {status:'unavailable',reason:'invalid_rpc_response'};
   if(reply.error?.code===429)return {status:'rate_limited',waitMs:60000};
   if(nullCodes.has(reply.error?.code)||reply.result===null)return {status:'missing',reason:'no_finalized_block'};
   if(unavailableCodes.has(reply.error?.code))return {status:'unavailable',reason:'archive_or_version_unavailable'};
   if(reply.error||!Object.hasOwn(reply,'result'))return {status:'unavailable',reason:'rpc_error'};
   return {status:'available',value:reply.result};
  }catch(error){
   return {status:'unavailable',reason:error.message==='rpc_response_limit'?'response_limit':'transport_or_parse'};
  }
 };
}

const ledger=(kind,body)=>({version:VERSION,kind,body});
export async function collectArchive(dir,{policy,source,requests,transport,maxRequests=LIMITS.requests,retries=0,
 maxUnits=LIMITS.units,now=Date.now,sleep=delay}){
 check(policy.authorities.get(source)?.roles.includes('chain'),'unapproved_chain_source');
 check(isList(requests,LIMITS.slots)&&requests.length>0&&distinct(requests.map(x=>x?.slot))&&
  requests.every(x=>integer(x?.slot,1)&&isList(x.signatures,LIMITS.signaturesPerSlot)&&
   x.signatures.every(isSignature)&&distinct(x.signatures))&&integer(maxRequests,2,LIMITS.requests)&&
  integer(retries,0,LIMITS.retries)&&integer(maxUnits,2,LIMITS.units),'invalid_collection_plan');
 return withCollectionLease(dir,async()=>{
  const spent=new Map(),dailyUnits=new Map();let last=0,cooldown=0,used=0,units=0;
  for await(const {record} of records(dir)){
   if(record.kind==='request'){
    const at=stamp(record.body.at);
    check(at!==null&&integer(record.body.units,1,16),'invalid_request_ledger');last=Math.max(last,at);
    const day=Math.floor(at/DAY);spent.set(day,(spent.get(day)??0)+1);
    dailyUnits.set(day,(dailyUnits.get(day)??0)+record.body.units);
   }
   if(record.kind==='request_end')last=Math.max(last,stamp(record.body.at)??0);
   if(record.kind==='cooldown')cooldown=Math.max(cooldown,stamp(record.body.until)??0);
  }
  const counts={available:0,missing:0,unavailable:0,rate_limited:0,deferred:0,unresolvedWitnesses:0};
  async function call(method,params){
   const cost=method==='getGenesisHash'?1:params[1].transactionDetails==='full'?16:4;
   if(now()<last)throw new Error('collection_clock_went_backwards');
   if(now()<cooldown)return {status:'deferred',reason:'provider_cooldown'};
   if(used>=maxRequests||units+cost>maxUnits||(spent.get(Math.floor(now()/DAY))??0)>=LIMITS.perUtcDay)
    return {status:'deferred',reason:'request_budget'};
   if(last+LIMITS.spacingMs>now())await sleep(last+LIMITS.spacingMs-now());
   const at=now(),day=Math.floor(at/DAY),daily=spent.get(day)??0;
   if(at<last+LIMITS.spacingMs||daily>=LIMITS.perUtcDay||(dailyUnits.get(day)??0)+cost>LIMITS.unitsPerUtcDay)
    return {status:'deferred',reason:'pacing_or_daily_budget'};
   await append(dir,ledger('request',{source,method,slot:method==='getBlock'?params[0]:null,
    at:new Date(at).toISOString(),sequence:daily+1,units:cost}));
   spent.set(day,daily+1);dailyUnits.set(day,(dailyUnits.get(day)??0)+cost);last=at;used++;units+=cost;
   const result=await transport(method,params,used);
   last=now();
   if(result.status==='rate_limited'){
    const waitMs=Number.isFinite(result.waitMs)?Math.min(365*DAY,Math.max(60000,result.waitMs)):DAY;
    cooldown=now()+waitMs;
    await append(dir,ledger('cooldown',{source,until:new Date(cooldown).toISOString()}));
   }
   await append(dir,ledger('request_end',{source,sequence:daily+1,startedAt:new Date(at).toISOString(),
    at:new Date(last).toISOString()}));
   return result;
  }
  const recordGap=(slot,status,reason,signature=null)=>append(dir,ledger('capture_gap',{source,policy:policy.digest,
   slot,status,reason,signature,at:new Date(now()).toISOString()}));
  async function blockCall(slot,transactionDetails){
   let result;
   for(let attempt=0;attempt<=retries;attempt++){
    result=await call('getBlock',[slot,{commitment:'finalized',encoding:'base64',transactionDetails,
     rewards:false,maxSupportedTransactionVersion:1}]);
    if(!['transport_or_parse','http_server'].includes(result.reason))break;
   }
   return result;
  }
  async function recordRequestGaps({slot,signatures},status,reason){
   await recordGap(slot,status,reason);
   for(const signature of signatures)await recordGap(slot,status,reason,signature);
  }
  const network=await call('getGenesisHash',[]);
  if(network.status!=='available'){
   const reason=network.reason??'provider_cooldown';
   for(const request of requests){await recordRequestGaps(request,'deferred',reason);counts.deferred++;}
   return {requests:used,units,counts,status:network.status,reason};
  }
  check(network.value===policy.genesis,'archival_network_mismatch');
  for(const [requestIndex,request] of requests.entries()){
   const {slot,signatures}=request;
   let result=await blockCall(slot,'signatures'),stopReason=result;
   if(result.status==='available'){
    let block;
    try{block=normalizeBlock(result.value,null,slot,policy.genesis,[]);}catch{
     result={status:'unavailable',reason:'invalid_finalized_block_header'};
    }
    if(block){
     let witness={status:'available'};
     const wanted=signatures.filter(signature=>block.roster.includes(signature));
     if(wanted.length){
      witness=await blockCall(slot,'full');
      if(witness.status==='available'){
       try{block=normalizeBlock(result.value,witness.value,slot,policy.genesis,wanted);}catch{
        witness={status:'unavailable',reason:'invalid_finalized_block_payload'};
       }
      }
     }
     await append(dir,ledger('capture',{source,policy:policy.digest,block,requested:signatures}));
     for(const signature of signatures)if(!block.transactions.some(tx=>tx.signature===signature)){
      await recordGap(slot,witness.status==='available'?'unavailable':witness.status,
       witness.reason??'transaction_witness_missing',signature);counts.unresolvedWitnesses++;
     }
     stopReason=witness;
    }
   }
   if(result.status!=='available')await recordRequestGaps(request,result.status,result.reason??'provider_cooldown');
   counts[result.status]++;
   if(['deferred','rate_limited'].includes(stopReason.status)){
    for(const pending of requests.slice(requestIndex+1)){
     await recordRequestGaps(pending,'deferred',stopReason.reason??'provider_cooldown');counts.deferred++;
    }
    break;
   }
  }
  return {requests:used,units,counts,status:'captured_unsigned'};
 });
}
