// S1b.1 V2.2 — readonly authority/CPI evidence diagnostics.
// Account positions are pinned to official pump-fun/pump-public-docs IDLs
// (pump.json blob bb79d04e5a4ef8b286d67511757c23a15672ef51,
//  pump_amm.json blob d907b16a91f035aeb3c3182bfa0972a91bf23a86).
// This does not verify PDA invoke_signed privileges, individual transfers,
// execution prices, trade ownership, or fills.
import {createHash} from 'node:crypto';
import {decodeBase58,PUMP_FUN,PUMP_SWAP} from './decoder.js';
export const AUTHORITY_VERSION='s1b1-v22-cpi-authority-0.1';
const IDL_LAYOUTS={
 [PUMP_FUN]:{
  '66063d1201daebea':{name:'buy',poolIndex:3,userIndex:6,accountCount:16},
  '33e685a4017f83ad':{name:'sell',poolIndex:3,userIndex:6,accountCount:14},
  '38fc74089edfcd5f':{name:'buy_exact_sol_in',poolIndex:3,userIndex:6,accountCount:16}
 },
 [PUMP_SWAP]:{
  '66063d1201daebea':{name:'buy',poolIndex:0,userIndex:1,accountCount:23},
  '33e685a4017f83ad':{name:'sell',poolIndex:0,userIndex:1,accountCount:21},
  'c62e1552b4d9e870':{name:'buy_exact_quote_in',poolIndex:0,userIndex:1,accountCount:23}
 }
};
const nameOf=p=>p===PUMP_FUN?'pumpfun':p===PUMP_SWAP?'pumpswap':'unknown';
const keyOf=k=>typeof k==='string'?k:typeof k?.pubkey==='string'?k.pubkey:null;
const formatAccounts=arr=>Array.isArray(arr)&&arr.length<=100?
 arr.map(keyOf):null;
function candidates(tx){
 const outer=Array.isArray(tx.transaction?.message?.instructions)?
  tx.transaction.message.instructions:[];
 const all=outer.map((ix,index)=>({ix,scope:'outer',outerIndex:index}));
 for(const g of Array.isArray(tx.meta?.innerInstructions)?tx.meta.innerInstructions:[]){
  if(!Array.isArray(g?.instructions))continue;
  for(const ix of g.instructions){
   all.push({ix,scope:'inner',outerIndex:Number.isInteger(g.index)?g.index:null});
  }
 }
 return all.slice(0,500).flatMap(({ix,scope,outerIndex})=>{
  const schemas=IDL_LAYOUTS[ix?.programId];
  if(!schemas||typeof ix.data!=='string'||ix.data.length>4096)return [];
  const bytes=decodeBase58(ix.data);
  if(!bytes||bytes.length<8)return [];
  const discriminator=bytes.subarray(0,8).toString('hex');
  const layout=schemas[discriminator];
  return layout?[{ix,scope,outerIndex,discriminator,layout,
   programName:nameOf(ix.programId),outer}]:[];
 });
}
function aggregateSigners(tx,account){
 const keys=tx.transaction?.message?.accountKeys;
 if(!Array.isArray(keys))return 'transaction_key_metadata_missing';
 const match=keys.find(k=>keyOf(k)===account);
 if(!match)return 'user_absent_from_message_keys';
 if(typeof match==='string'||typeof match.signer!=='boolean')
  return 'signer_flag_unavailable';
 return match.signer?'user_tx_signer_confirmed':'user_not_tx_signer';
}
export function inspectAuthorityEvidence(poolAddress,signature,tx){
 const base={version:AUTHORITY_VERSION,status:'missing_metadata',
  candidateCount:0,candidateProgram:'unknown',instruction:'unknown',
  scope:'none',outerInstructionProgram:'none',
  idlAccountCount:null,actualInstructionAccounts:null,
  idlAccountsPresent:false,authority:'not_evaluated',
  poolMatchesIdlIndex:false,verifiedFill:false,
  verifiedPrice:false,verifiedDirection:false,
  economicsAuthorized:false,liveTrading:false};
 if(!tx?.meta||!tx.transaction?.message)return base;
 if(Array.isArray(tx.transaction.signatures)&&
  !tx.transaction.signatures.includes(signature))
  return {...base,status:'signature_mismatch'};
 if(tx.meta.err!==undefined&&tx.meta.err!==null)
  return {...base,status:'transaction_failed'};
 const found=candidates(tx);
 if(found.length!==1)return {...base,
  status:'not_single_trade_candidate',candidateCount:found.length};
 const c=found[0],accounts=formatAccounts(c.ix.accounts);
 const outerProgram=c.scope==='inner'&&Number.isInteger(c.outerIndex)&&
  c.outerIndex>=0&&c.outerIndex<c.outer.length?
  (c.outer[c.outerIndex]?.programId||'unknown'):'none';
 const details={...base,candidateCount:1,candidateProgram:c.programName,
  instruction:c.layout.name,scope:c.scope,
  outerInstructionProgram:c.scope==='inner'?outerProgram:'none',
  idlAccountCount:c.layout.accountCount,
  actualInstructionAccounts:accounts?.length??null,
  idlAccountsPresent:!!accounts&&accounts.length>=c.layout.accountCount};
 if(!accounts||accounts.some(v=>v===null))return {...details,
  status:'accounts_unusable'};
 if(accounts[c.layout.poolIndex]!==poolAddress)return {...details,
  status:'watched_pool_mismatch'};
 const authority=aggregateSigners(tx,accounts[c.layout.userIndex]);
 return {...details,poolMatchesIdlIndex:true,authority,
  status:accounts.length<c.layout.accountCount?
   'idl_account_count_short':
   'idl_index_match_authority_unverified'};
}
const hash=x=>createHash('sha256').update(String(x||'')).digest('hex').slice(0,16);
const inc=(o,k)=>{o[k]=(o[k]||0)+1;};
const top=(o,n=50)=>Object.entries(o).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,n).map(([key,rows])=>({key,eventRows:rows}));
export function createAuthoritySummary(){
 const status={},byVenue={},authority={},byScopeAuth={},
  byInstruction={},byOuterInstruction={},accountSizes={},examples={};
 let scanned=0;
 return {add(row){
  const r=inspectAuthorityEvidence(row.pool_address,row.signature,row.payload);
  const venue=String(row.venue_family||'unknown').slice(0,40);
  scanned++;
  inc(status,r.status);inc(byVenue,venue+':'+r.status);
  inc(authority,r.authority);
  inc(byScopeAuth,r.scope+':'+r.authority);
  inc(byInstruction,r.candidateProgram+':'+r.instruction+':'+r.authority);
  inc(byOuterInstruction,r.scope+':'+r.outerInstructionProgram+':'+r.authority);
  inc(accountSizes,r.candidateProgram+':'+r.instruction+':' + (r.actualInstructionAccounts===null?
   'unknown':r.actualInstructionAccounts)+':expected_'+(r.idlAccountCount??'unknown'));
  const k=venue+':'+r.authority;
  if((examples[k]||[]).length<2){
   (examples[k]??=[]).push({signatureSha256Prefix:hash(row.signature),
    poolSha256Prefix:hash(row.pool_address),scope:r.scope,
    program:r.candidateProgram,instruction:r.instruction,
    outerInstructionProgram:r.outerInstructionProgram,
    status:r.status,idlAccountsPresent:r.idlAccountsPresent});
  }
 },result(){
  return {kind:'s1b1_v22_authority_evidence',version:AUTHORITY_VERSION,
   inputUnits:'v2_single_trade_candidate_event_rows',
   sampledEventRows:scanned,byStatus:top(status),
   byVenueStatus:top(byVenue),byAuthority:top(authority),
   byScopeAuthority:top(byScopeAuth),
   byInstructionAuthority:top(byInstruction),
   byOuterInstructionProgram:top(byOuterInstruction),
   accountCountComparedToOfficialIdl:top(accountSizes),examples,
   interpretation:'A signer flag refers to an original transaction signature; an inner CPI can use delegated privileges or PDA invoke_signed. A false flag neither proves invalid execution nor proves valid authority. Current official-IDL account-index matches do not by themselves establish instruction-level token transfers, fills, or prices.',
   readOnly:true,verifiedFills:0,economicsAuthorized:false,liveTrading:false};
 }};
}
