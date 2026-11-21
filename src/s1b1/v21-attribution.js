// S1b.1 V2.1: diagnostic-only transaction-to-observed-pool attribution.
// DO NOT use these hints as swap, direction, quantity, price or fill evidence.
// Legacy account indices are comparison HINTS, not independently audited IDLs.
import {createHash} from 'node:crypto';
import {decodeBase58,PUMP_FUN,PUMP_SWAP} from './decoder.js';

export const ATTRIBUTION_VERSION='s1b1-v21-attribution-0.1';
const LEGACY_HINT={
 [PUMP_FUN]:{accountIndex:3,signerIndex:6,program:'pumpfun'},
 [PUMP_SWAP]:{accountIndex:0,signerIndex:1,program:'pumpswap'}
};
const DISCS={
 [PUMP_FUN]:new Set(['66063d1201daebea','33e685a4017f83ad','38fc74089edfcd5f']),
 [PUMP_SWAP]:new Set(['66063d1201daebea','33e685a4017f83ad','c62e1552b4d9e870'])
};
function instructions(tx){
 const out=[];
 const outer=tx?.transaction?.message?.instructions;
 if(Array.isArray(outer)){
  for(const ix of outer)out.push({ix,scope:'outer'});
 }
 const groups=tx?.meta?.innerInstructions;
 if(Array.isArray(groups)){
  for(const group of groups){
   if(!Array.isArray(group?.instructions))continue;
   for(const ix of group.instructions)out.push({ix,scope:'inner'});
  }
 }
 return out.slice(0,500);
}
function normalizedAccounts(ix){
 if(!Array.isArray(ix?.accounts)||ix.accounts.length>100)return null;
 const result=ix.accounts.map(x=>
  typeof x==='string'?x:
   typeof x?.pubkey==='string'?x.pubkey:null);
 return result.every(x=>typeof x==='string')?result:null;
}
function checkLegacySigner(tx,candidate,accounts){
 const legacy=LEGACY_HINT[candidate.ix.programId];
 const signer=accounts?.[legacy.signerIndex];
 if(!signer)return 'missing_legacy_signer_account';
 const keys=tx.transaction?.message?.accountKeys;
 if(!Array.isArray(keys))return 'missing_parsed_signer_metadata';
 const record=keys.find(x=>typeof x==='object'&&x?.pubkey===signer);
 if(!record)return 'missing_parsed_signer_metadata';
 return record.signer===true?'legacy_signer_flag_present':
  record.signer===false?'legacy_signer_flag_absent':'missing_parsed_signer_metadata';
}
export function inspectCandidateAttribution(poolAddress,signature,tx){
 const base={version:ATTRIBUTION_VERSION,status:'missing_metadata',
  candidateProgram:'unknown',candidateScope:'none',candidateCount:0,
  watchedPoolReferenced:false,atLegacyPoolIndex:false,
  legacySignerHint:'not_checked',signatureHint:'not_available',
  fillVerified:false,directionVerified:false,priceVerified:false,
  economicsAuthorized:false,liveTrading:false};
 if(!tx?.meta||!tx.transaction?.message)return base;
 const signatures=tx.transaction.signatures;
 if(Array.isArray(signatures)){
  if(!signatures.includes(signature))return {...base,status:'signature_mismatch',
   signatureHint:'mismatch'};
  base.signatureHint='matched';
 }
 if(tx.meta.err!==null&&tx.meta.err!==undefined)
  return {...base,status:'tx_failed'};
 const matches=instructions(tx).filter(({ix})=>{
  const discSet=DISCS[ix?.programId];
  if(!discSet||typeof ix?.data!=='string'||ix.data.length>4096)return false;
  const raw=decodeBase58(ix.data);
  return raw?.length>=8&&discSet.has(raw.subarray(0,8).toString('hex'));
 });
 if(matches.length!==1)return {...base,status:'not_single_candidate',candidateCount:matches.length};
 const candidate=matches[0],schema=LEGACY_HINT[candidate.ix.programId];
 const prefix={...base,candidateCount:1,candidateProgram:schema.program,
  candidateScope:candidate.scope};
 const accounts=normalizedAccounts(candidate.ix);
 if(!accounts)return {...prefix,status:'accounts_unusable'};
 const referenced=accounts.includes(poolAddress);
 const legacyMatched=accounts[schema.accountIndex]===poolAddress;
 const signerHint=checkLegacySigner(tx,candidate,accounts);
 return {...prefix,watchedPoolReferenced:referenced,
  atLegacyPoolIndex:legacyMatched,legacySignerHint:signerHint,
  status:legacyMatched?'pool_at_legacy_index_unverified':
   referenced?'pool_present_other_index':'pool_absent_from_candidate'};
}
const shortHash=s=>createHash('sha256').update(String(s||'')).digest('hex').slice(0,16);
const bump=(obj,k)=>{obj[k]=(obj[k]||0)+1;};
const top=obj=>Object.entries(obj).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .map(([key,eventRows])=>({key,eventRows}));
export function createAttributionSummary(){
 const byStatus={},byVenueStatus={},byProgramStatus={},byScopeStatus={},signerHints={};
 const examples={};let scanned=0;
 return {
  add(row){
   const examined=inspectCandidateAttribution(row.pool_address,row.signature,row.payload);
   const venue=String(row.venue_family||'unknown').slice(0,40);
   scanned++;
   bump(byStatus,examined.status);
   bump(byVenueStatus,venue+':'+examined.status);
   bump(byProgramStatus,examined.candidateProgram+':'+examined.status);
   bump(byScopeStatus,examined.candidateScope+':'+examined.status);
   bump(signerHints,examined.legacySignerHint);
   const k=venue+':'+examined.status;
   if((examples[k]||[]).length<3)(examples[k]??=[]).push({
    signatureSha256Prefix:shortHash(row.signature),
    poolSha256Prefix:shortHash(row.pool_address),
    program:examined.candidateProgram,
    scope:examined.candidateScope,
    candidateCount:examined.candidateCount,
    legacySignerHint:examined.legacySignerHint,
    signatureHint:examined.signatureHint
   });
  },
  result(){
   return {kind:'s1b1_v21_attribution_audit',version:ATTRIBUTION_VERSION,
    inputUnits:'previously_classified_single_trade_candidate_event_rows',
    sampledEventRows:scanned,
    byStatus:top(byStatus),
    byVenueStatus:top(byVenueStatus),
    byProgramStatus:top(byProgramStatus),
    byScopeStatus:top(byScopeStatus),
    legacySignerHints:top(signerHints),
    examples,
    interpretation:'A pool present in instruction accounts or at a legacy index is NOT audited account-layout proof, signer authorization, a swap, a fill or an executable price.',
    readOnly:true,verifiedFills:0,economicsAuthorized:false,liveTrading:false};
  }
 };
}
