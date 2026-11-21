import {createHash,createPublicKey,verify} from 'node:crypto';
import {decodeBase58,PUMP_FUN,PUMP_SWAP} from '../s1b1/decoder.js';

export const VERSION='solaris-forward-1';
export const PROSPECTIVE='prospective-launch-v1';
export const DAY=86_400_000;
export const FLOORS=Object.freeze({eventDays:30,pools:20,signatures:200,maxPoolPercent:20});
export const MAX_RECORD_BYTES=8*1024*1024;
export const MAINNET='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const ROLES=new Set(['chain','history','execution','census','market','strategy','clock','discovery','enrollment']);
export const ROLE={block:'chain',segment:'chain',gap:'chain',deployment:'history',pool:'history',fill:'execution',
 census:'census',quote:'market',decision:'strategy',timestamp:'clock',launch_scan:'census',
 discovery:'discovery',launch_outcome:'enrollment'};
export const PROGRAM={pumpfun:PUMP_FUN,pumpswap:PUMP_SWAP};
export const check=(condition,code)=>{if(!condition)throw new Error(code);};
export const recordObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const integer=(n,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
export const isHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const isAddress=x=>typeof x==='string'&&x.length>=32&&x.length<=44&&decodeBase58(x)?.length===32;
export const isSignature=x=>typeof x==='string'&&x.length>=64&&x.length<=88&&decodeBase58(x)?.length===64;
export const isId=x=>typeof x==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(x);
export const isList=(x,max=10000)=>Array.isArray(x)&&x.length<=max;
export const distinct=x=>new Set(x).size===x.length;
export const micros=x=>typeof x==='string'&&/^\d{1,20}$/.test(x)&&BigInt(x)<(1n<<64n)?BigInt(x):null;
export const stamp=x=>typeof x==='string'&&x.length===24&&Number.isFinite(Date.parse(x))&&
 new Date(x).toISOString()===x?Date.parse(x):null;

// Canonical JSON for signed contracts. Byte serialization is UTF-8.
export function canonical(value,depth=0){
 check(depth<64,'record_too_deep');
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){
  check(Number.isFinite(value),'invalid_number');return JSON.stringify(value);
 }
 if(Array.isArray(value))return `[${value.map(x=>canonical(x,depth+1)).join(',')}]`;
 check(recordObject(value),'invalid_json_value');
 return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k],depth+1)}`).join(',')}}`;
}
export const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');

export function readPolicy(raw){
 check(raw?.version===VERSION&&['mainnet','fixture'].includes(raw.network)&&isAddress(raw.genesis)&&
  (raw.network!=='mainnet'||raw.genesis===MAINNET)&&
  isList(raw.authorities,64)&&isList(raw.layouts,64)&&raw.layouts.every(row=>
   Object.values(PROGRAM).includes(row?.program)&&isHash(row.idlDigest)),'invalid_trust_policy');
 const authorities=new Map(),keyFingerprints=new Set();
 for(const authority of raw.authorities){
  check(isId(authority?.id)&&isId(authority.organization)&&isList(authority.roles,ROLES.size)&&authority.roles.length>0&&
   distinct(authority.roles)&&authority.roles.every(role=>ROLES.has(role))&&!authorities.has(authority.id)&&
   typeof authority.publicKey==='string'&&authority.publicKey.length<=256,'invalid_authority');
  let publicKey;
  try{publicKey=createPublicKey(authority.publicKey);}catch{throw new Error('invalid_authority_key');}
  check(publicKey.asymmetricKeyType==='ed25519'&&!authority.publicKey.includes('PRIVATE KEY'),'invalid_authority_key');
  const fingerprint=publicKey.export({format:'der',type:'spki'}).toString('hex');
  check(!keyFingerprints.has(fingerprint),'duplicate_authority_key');
  keyFingerprints.add(fingerprint);
  authorities.set(authority.id,{...authority,publicKey});
 }
 return {network:raw.network,genesis:raw.genesis,authorities,digest:hash(raw),
  layouts:new Set(raw.layouts.map(row=>`${row.program}:${row.idlDigest}`))};
}

export function signedPayload({kind,issuer,policy,body}){return {version:VERSION,kind,issuer,policy,body};}

export function authenticate(record,policy){
 check(recordObject(record)&&record.version===VERSION&&Object.keys(record).length===6&&
  Object.hasOwn(ROLE,record.kind)&&record.policy===policy.digest&&recordObject(record.body),'invalid_envelope');
 const authority=policy.authorities.get(record.issuer),signature=record.signature;
 check(authority?.roles.includes(ROLE[record.kind])&&typeof signature==='string'&&/^[A-Za-z0-9+/]{86}==$/.test(signature)&&
  verify(null,Buffer.from(canonical(signedPayload(record))),authority.publicKey,Buffer.from(signature,'base64')),'invalid_attestation');
 return {kind:record.kind,issuer:record.issuer,organization:authority.organization,body:record.body,digest:hash(record)};
}

export function validateManifest(plan,policy){
 check(plan?.version===VERSION&&plan.policy===policy.digest&&isId(plan.study)&&
  [plan.strategy,plan.selection,plan.feeModel,plan.exclusions].every(isHash)&&integer(plan.maxQuoteAgeMs,1,300000)&&
  integer(plan.maxObservedLatencyMs,1,300000)&&integer(plan.horizonMs,1,DAY)&&recordObject(plan.windows),'invalid_manifest');
 const universe=plan.universe;
 if(universe!==undefined){
  check(recordObject(universe)&&Object.keys(universe).length===8&&universe.mode===PROSPECTIVE&&
   universe.algorithm==='first-eligible-creation-v1'&&isList(universe.venues,2)&&universe.venues.length>0&&
   distinct(universe.venues)&&universe.venues.every(venue=>Object.hasOwn(PROGRAM,venue))&&
   isList(universe.quoteMints,64)&&universe.quoteMints.length>0&&distinct(universe.quoteMints)&&universe.quoteMints.every(isAddress)&&
   isList(universe.excludedBaseMints,10000)&&distinct(universe.excludedBaseMints)&&universe.excludedBaseMints.every(isAddress)&&
   integer(universe.maxDiscoveryDelayMs,1000,15*60*1000)&&
   integer(universe.maxAdmissionDelayMs,universe.maxDiscoveryDelayMs,60*60*1000)&&
   recordObject(universe.issuers)&&Object.keys(universe.issuers).length===2,'invalid_launch_universe');
  const discovery=policy.authorities.get(universe.issuers.discovery),enrollment=policy.authorities.get(universe.issuers.enrollment);
  const externalOrganizations=new Set([...policy.authorities.values()].filter(a=>
   a.roles.some(role=>['chain','history','census','clock','market','strategy','execution'].includes(role))).map(a=>a.organization));
  check(discovery?.roles.includes('discovery')&&enrollment?.roles.includes('enrollment')&&
   discovery.organization!==enrollment.organization&&!externalOrganizations.has(discovery.organization)&&
   !externalOrganizations.has(enrollment.organization),'invalid_launch_authorities');
 }
 const pools=new Set(),developmentMints=new Set();
 for(const name of ['development','forward']){
  const window=plan.windows[name],start=stamp(window?.from),end=stamp(window?.until);
  check(start!==null&&end!==null&&start%DAY===0&&end%DAY===0&&end-start>=FLOORS.eventDays*DAY&&
   end-start<=366*DAY,'invalid_window');
  if(universe){
   check(Object.keys(window).length===2&&!Object.hasOwn(window,'pools'),'prospective_window_has_fixed_pools');
   continue;
  }
  check(isList(window.pools,10000)&&window.pools.length>=FLOORS.pools,'invalid_window');
  for(const pool of window.pools){
   check(isAddress(pool?.address)&&isAddress(pool.baseMint)&&isAddress(pool.quoteMint)&&pool.baseMint!==pool.quoteMint&&
    Object.hasOwn(PROGRAM,pool.venue)&&!pools.has(pool.address)&&
    (name==='development'||!developmentMints.has(pool.baseMint)),'non_disjoint_or_invalid_pool');
   pools.add(pool.address);if(name==='development')developmentMints.add(pool.baseMint);
  }
 }
 check(stamp(plan.windows.development.until)<=stamp(plan.windows.forward.from),'overlapping_windows');
 return plan;
}

export function manifestRecord(plan,policy){
 validateManifest(plan,policy);
 return {version:VERSION,kind:'manifest',body:plan};
}
