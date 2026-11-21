// SOLARIS S1b.1 V2.15 — read-only raw amount / transaction-balance CONSISTENCY.
// Gross token movements are not instruction-specific net economics or fills.
// Never emit amount values, balance quantities, prices, fees, or PnL.
import {createHash} from 'node:crypto';
import {decodeBase58,PUMP_SWAP} from './decoder.js';
import {inspectV214} from './v214-routing.js';

export const V215_VERSION='s1b1-v215-amount-consistency-0.1';
const TOKEN_PROGRAMS=new Set([
 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
]);
const DISCS={
 '66063d1201daebea':{instruction:'buy',side:'buy',fixed:23},
 '33e685a4017f83ad':{instruction:'sell',side:'sell',fixed:21},
 'c62e1552b4d9e870':{instruction:'buy_exact_quote_in',side:'buy',fixed:23}
};
const key=x=>typeof x==='string'?x:typeof x?.pubkey==='string'?x.pubkey:null;
const hash=x=>createHash('sha256').update(String(x||'')).digest('hex').slice(0,16);
const bump=(o,k,n=1)=>{o[k]=(o[k]||0)+n;};
const rank=(o,n=50)=>Object.entries(o).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
 .slice(0,n).map(([key,eventRows])=>({key,eventRows}));
const positive=x=>typeof x==='string'&&/^[0-9]+$/.test(x)&&BigInt(x)>0n;
const unsigned=x=>typeof x==='string'&&/^[0-9]+$/.test(x);
function candidate(tx){
 const out=tx?.transaction?.message?.instructions,groups=tx?.meta?.innerInstructions;
 if(!Array.isArray(out)||!Array.isArray(groups)||out.length>500)return null;
 const hits=[];
 const check=ix=>{
  if(ix?.programId!==PUMP_SWAP||typeof ix.data!=='string'||ix.data.length>4096)return;
  const bytes=decodeBase58(ix.data);
  if(!bytes||bytes.length<8)return;
  const layout=DISCS[bytes.subarray(0,8).toString('hex')];
  if(layout)hits.push({ix,layout});
 };
 out.forEach(check);
 for(const group of groups){
  if(!Array.isArray(group?.instructions)||group.instructions.length>500)return null;
  group.instructions.forEach(check);
 }
 return hits.length===1?hits[0]:null;
}
function allInstructions(tx){
 const out=tx?.transaction?.message?.instructions,groups=tx?.meta?.innerInstructions;
 if(!Array.isArray(out)||!Array.isArray(groups))return null;
 const all=[...out];
 for(const group of groups){
  if(!Array.isArray(group?.instructions))return null;
  all.push(...group.instructions);
  if(all.length>10000)return null;
 }
 return all;
}
function roleBalances(tx,account,mint,expectedOwner){
 const keys=tx.transaction.message.accountKeys;
 if(!Array.isArray(keys))return 'account_key_index_unavailable';
 const positions=keys.map(key).flatMap((v,i)=>v===account?[i]:[]);
 if(positions.length!==1)return 'account_index_missing_or_duplicated';
 const pre=tx.meta.preTokenBalances,post=tx.meta.postTokenBalances;
 if(!Array.isArray(pre)||!Array.isArray(post))return 'balance_arrays_unavailable';
 const before=pre.filter(x=>x?.accountIndex===positions[0]);
 const after=post.filter(x=>x?.accountIndex===positions[0]);
 if(before.length===0||after.length===0)return 'partial_pre_or_post_balance';
 if(before.length!==1||after.length!==1)return 'duplicated_balance_entries';
 if(before[0].mint!==mint||after[0].mint!==mint)return 'balance_mint_mismatch';
 const prior=before[0]?.uiTokenAmount,afterAmt=after[0]?.uiTokenAmount;
 if(!unsigned(prior?.amount)||!unsigned(afterAmt?.amount)||!Number.isInteger(prior?.decimals)||
  prior.decimals<0||prior.decimals>18||prior.decimals!==afterAmt?.decimals)
  return 'balance_amount_or_decimal_unusable';
 const priorOwner=before[0]?.owner,afterOwner=after[0]?.owner;
 if(expectedOwner!==null&&((priorOwner!==undefined&&priorOwner!==expectedOwner)||
  (afterOwner!==undefined&&afterOwner!==expectedOwner)))
  return 'balance_owner_hint_conflict';
 return {delta:BigInt(afterAmt.amount)-BigInt(prior.amount),decimals:prior.decimals};
}
export function inspectV215(poolAddress,signature,tx){
 const gate=inspectV214(poolAddress,signature,tx);
 const baseline={status:'v214_blocked',quoteClass:gate.quoteClass,
  instruction:gate.instruction,matchedRoleCount:0,
  missingRoleBalanceCount:0,transactionFeeLamportsRecorded:false,
  transferDecimalEvidence:'not_checked',feeRecipientIdentityVerified:false,
  netSwapAmountVerified:false,verifiedFills:0,economicsAuthorized:false,
  liveTrading:false};
 if(gate.status!=='known_and_remaining_structural_edges_no_fee_or_fill_proof')
  return {...baseline,status:'v214_'+gate.status};
 if(!Array.isArray(tx?.transaction?.signatures)||
  !tx.transaction.signatures.includes(signature))
  return {...baseline,status:'rpc_signature_not_proven'};
 if(tx.meta?.err!==null&&tx.meta?.err!==undefined)
  return {...baseline,status:'rpc_transaction_failed'};
 const c=candidate(tx),all=allInstructions(tx);
 if(!c||!all)return {...baseline,status:'candidate_or_instructions_missing'};
 const a=Array.isArray(c.ix.accounts)?c.ix.accounts.map(key):null;
 if(!a||a.some(x=>!x)||a[0]!==poolAddress)
  return {...baseline,status:'candidate_account_mismatch'};
 const roleDefs=[
  {name:'user_base',account:a[5],mint:a[3],owner:a[1]},
  {name:'pool_base',account:a[7],mint:a[3],owner:null},
  {name:'user_quote',account:a[6],mint:a[4],owner:a[1]},
  {name:'pool_quote',account:a[8],mint:a[4],owner:null}
 ];
 // Pool token account owner is a PDA/authority, not the user. Its ownership
 // is not established here; use the owner hint only for user roles.
 const deltas=new Map(roleDefs.map(r=>[r.name,0n]));
 const checkedDecimals=new Map();
 let unknownActivity=false,invalidAmount=false,unknownDecimals=false;
 for(const ix of all){
  if(!TOKEN_PROGRAMS.has(ix?.programId))continue;
  const kind=ix.parsed?.type;
  if(!['transfer','transferChecked','transferCheckedWithFee'].includes(kind))continue;
  const info=ix?.parsed?.info;
  const source=info?.source,destination=info?.destination;
  const involved=roleDefs.filter(r=>r.account===source||r.account===destination);
  if(involved.length===0)continue;
  if(kind!=='transferChecked'||typeof source!=='string'||typeof destination!=='string'||
   typeof info?.mint!=='string'){unknownActivity=true;continue;}
  const value=info.tokenAmount?.amount??info.amount;
  if(!positive(value)){invalidAmount=true;continue;}
  const decimals=info.tokenAmount?.decimals;
  if(!Number.isInteger(decimals)||decimals<0||decimals>18){
   unknownDecimals=true;continue;
  }
  if(checkedDecimals.has(info.mint)&&checkedDecimals.get(info.mint)!==decimals){
   unknownDecimals=true;continue;
  }
  checkedDecimals.set(info.mint,decimals);
  const amount=BigInt(value);
  for(const role of involved){
   if(info.mint!==role.mint){unknownActivity=true;continue;}
   if(source===role.account)deltas.set(role.name,deltas.get(role.name)-amount);
   if(destination===role.account)deltas.set(role.name,deltas.get(role.name)+amount);
  }
 }
 const baseInfo={...baseline,
  transactionFeeLamportsRecorded:Number.isSafeInteger(tx.meta.fee)&&tx.meta.fee>=0,
  transferDecimalEvidence:unknownDecimals?'missing_or_conflicting':'checked_decimals_consistent'};
 if(invalidAmount||unknownActivity||unknownDecimals)
  return {...baseInfo,status:invalidAmount?'invalid_or_missing_raw_transfer_amount':
   unknownDecimals?'transfer_decimals_unavailable_or_conflicting':
   'unparsed_or_other_mint_token_activity'};
 let matched=0,missing=0,otherStatus=null;
 for(const role of roleDefs){
  const bal=roleBalances(tx,role.account,role.mint,role.owner);
  if(typeof bal==='string'){
   if(bal==='partial_pre_or_post_balance'||bal==='balance_arrays_unavailable')
    missing++;
   else otherStatus=bal;
   continue;
  }
  if(checkedDecimals.get(role.mint)!==bal.decimals){otherStatus='balance_transfer_decimal_disagreement';continue;}
  if(bal.delta!==deltas.get(role.name)){otherStatus='balance_delta_disagrees_with_tx_checked_transfers';continue;}
  matched++;
 }
 const result={...baseInfo,matchedRoleCount:matched,missingRoleBalanceCount:missing};
 if(otherStatus)return {...result,status:otherStatus};
 if(missing>0)return {...result,status:'partial_balances_no_complete_tx_reconciliation'};
 if(matched!==roleDefs.length)return {...result,status:'unverified_balances'};
 // Equality is transaction-level and can include additional token operations.
 // It does not isolate a swap, verify token authority, unknown fee recipients or
 // net economics, especially for WSOL created/closed in this transaction.
 return {...result,status:'four_role_transaction_balance_consistent_not_fill'};
}
export function createV215Summary(){
 const byStatus={},byQuote={},byInstruction={},byFee={},byMatched={},examples={};
 let scanned=0,eligible=0,withFee=0;
 return {add(row){
  const x=inspectV215(row.pool_address,row.signature,row.payload);
  scanned++;if(x.status.startsWith('v214_')===false)eligible++;
  if(x.transactionFeeLamportsRecorded)withFee++;
  bump(byStatus,x.status);bump(byQuote,x.quoteClass+':'+x.status);
  bump(byInstruction,x.instruction+':'+x.status);
  bump(byFee,x.transactionFeeLamportsRecorded?'transaction_fee_metadata_present':'fee_metadata_unavailable');
  if(!x.status.startsWith('v214_'))bump(byMatched,x.quoteClass+':matched_'+x.matchedRoleCount+
   ':missing_'+x.missingRoleBalanceCount);
  if((examples[x.status]||[]).length<3)(examples[x.status]??=[]).push({
   signatureSha256Prefix:hash(row.signature),poolSha256Prefix:hash(row.pool_address),
   instruction:x.instruction,quoteClass:x.quoteClass,
   matchedRoleCount:x.matchedRoleCount,
   missingRoleBalanceCount:x.missingRoleBalanceCount,
   transactionFeeLamportsRecorded:x.transactionFeeLamportsRecorded
  });
 },result(){
  return {kind:'s1b1_v215_transaction_amount_consistency_audit',
   version:V215_VERSION,sampledEventRows:scanned,
   structurallyEligibleCandidateRows:eligible,
   rowsWithTransactionFeeMetadata:withFee,
   byStatus:rank(byStatus),byQuoteStatus:rank(byQuote),
   byInstructionStatus:rank(byInstruction),byTxFeeMetadata:rank(byFee),
   byAccountBalanceEvidence:rank(byMatched),examples,
   interpretation:'Compares raw transferChecked amounts using bigint against whole-transaction pre/post token-account changes. Equality is not instruction-specific economics. Missing balances, Token-2022 fee variants, native SOL funding/refunds, unknown remaining-account recipients, and user/authority proof remain unresolved. No raw quantities, prices, fees or PnL exported.',
   grossTransferAmountsVerifiedForEconomics:false,netSwapAmountVerified:false,
   verifiedFills:0,economicsAuthorized:false,liveTrading:false,readOnly:true};
 }};
}
