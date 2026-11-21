import {ATA,SYSTEM,isToken,isNative,isDecimals,uint,systemMovement} from './reconcile-trace.js';

export const INIT_TYPES=new Set(['initializeAccount','initializeAccount2','initializeAccount3']);
const ACCOUNT_LIFECYCLE=new Set([...INIT_TYPES,'closeAccount','syncNative']);
const NON_MOVEMENT=new Set(['approve','approveChecked','revoke','freezeAccount','thawAccount',
 'initializeImmutableOwner','getAccountDataSize','initializeMint','initializeMint2']);
const MINT_BURN=new Set(['mintTo','mintToChecked','burn','burnChecked']);
const TRANSFERS=new Set(['transfer','transferChecked','transferCheckedWithFee']);

export function getBalanceEntries(entries,keys){
 if(!Array.isArray(entries))return null;
 const balances=new Map();
 for(const row of entries){
  const account=Number.isInteger(row?.accountIndex)&&keys[row.accountIndex];
  if(!account||balances.has(account))return null;
  const amount=uint(typeof row.uiTokenAmount?.amount==='string'?row.uiTokenAmount.amount:null);
  balances.set(account,{amount,mint:row.mint,program:row.programId,owner:row.owner,
   decimals:row.uiTokenAmount?.decimals});
 }
 return balances;
}

const agrees=(balance,role)=>balance?.owner===role.owner&&balance.mint===role.mint&&
 balance.program===role.program;

export function reconcileBalances(tx,keys,trace,roles,preToken,postToken,transfers){
 const {meta}=tx,networkFeeLamports=uint(meta.fee);
 const tokens=new Map(),mintDecimals=new Map(),rolesSeen=new Map();
 const pre=Array.isArray(meta.preBalances)?meta.preBalances.map(uint):[];
 const post=Array.isArray(meta.postBalances)?meta.postBalances.map(uint):[];
 const completeLamports=pre.length===keys.length&&post.length===keys.length&&
  pre.every(x=>x!==null)&&post.every(x=>x!==null)&&networkFeeLamports!==null&&
  tx.transaction.message.accountKeys[0]?.signer===true;
 const indexes=new Map(keys.map((key,index)=>[key,index]));
 const amounts=[...pre],created=new Map(),reserves=new Map(),closed=new Set();
 let nativeKnown=completeLamports&&pre[0]>=networkFeeLamports,tokenStatus='matched',lifecycleRoles=0;
 const issue=status=>{if(tokenStatus==='matched')tokenStatus=status;};
 const recordDecimals=(mint,decimals)=>{
  if(decimals===undefined)return;
  if(mintDecimals.has(mint)&&mintDecimals.get(mint)!==decimals)issue('token_balance_amount_or_decimals_invalid');
  mintDecimals.set(mint,decimals);
 };
 if(!preToken||!postToken)issue('token_balance_arrays_missing_or_nonunique');
 if(nativeKnown)amounts[0]-=networkFeeLamports;
 const move=(src,dst,quantity)=>{
  const s=indexes.get(src),d=indexes.get(dst);
  if(!nativeKnown||quantity===null||s===undefined||d===undefined||s===d||amounts[s]<quantity){
   nativeKnown=false;return;
  }
  amounts[s]-=quantity;amounts[d]+=quantity;
 };
 for(const role of roles){
  const before=preToken?.get(role.account),after=postToken?.get(role.account);
  const index=indexes.get(role.account);
  if(index===undefined||(before&&!agrees(before,role))||(after&&!agrees(after,role)))
   issue('token_owner_mint_or_program_mismatch');
  if((before&&(before.amount===null||!isDecimals(before.decimals)))||
    (after&&(after.amount===null||!isDecimals(after.decimals)))||
    (before&&after&&before.decimals!==after.decimals))issue('token_balance_amount_or_decimals_invalid');
  if(isNative(role.mint,role.program)&&[[before,pre[index]],[after,post[index]]].some(([balance,lamports])=>
    balance&&(balance.decimals!==9||typeof lamports!=='bigint'||balance.amount>lamports)))
   issue('native_token_balance_invalid');
  if((!before&&pre[index]!==0n)||(!after&&post[index]!==0n))issue('missing_balance_or_lifecycle_proof');
  tokens.set(role.account,before?.amount??null);
  recordDecimals(role.mint,before?.decimals??after?.decimals);
  rolesSeen.set(role.account,{...role,before,after,initialization:false,closure:false});
 }
 const applyToken=(account,amount,edgeDecimals)=>{
  if(!rolesSeen.has(account))return;
  const previous=tokens.get(account);
  if(previous===null){issue('missing_balance_or_lifecycle_proof');return;}
  if(amount===null){issue('token2022_fee_unknown');return;}
  recordDecimals(rolesSeen.get(account).mint,edgeDecimals);
  tokens.set(account,previous+amount);
  if(previous+amount<0n)issue('mismatch');
 };
 for(const node of trace){
  const {ix}=node,kind=ix.parsed?.type,info=ix.parsed?.info;
  const sys=systemMovement(ix);
  if(sys){
   if(sys.creation&&nativeKnown&&amounts[indexes.get(sys.destination)]===0n)
    created.set(sys.destination,{parent:node.parent,program:info.owner,amount:sys.amount});
   move(sys.source,sys.destination,sys.amount);
  }else if(ix.programId===SYSTEM&&!['allocate','allocateWithSeed','assign','assignWithSeed',
   'advanceNonce','initializeNonce','authorizeNonce','upgradeNonce'].includes(kind))nativeKnown=false;
  if(!isToken(ix.programId))continue;
  const edge=transfers.get(node);
  if(edge&&!edge.error){
   applyToken(edge.source,-edge.gross,edge.decimals);
   applyToken(edge.destination,edge.credited,edge.decimals);
   if(isNative(edge.mint,edge.program))move(edge.source,edge.destination,edge.gross);
   continue;
  }
  if(TRANSFERS.has(kind)||!kind){issue(edge?.error??'unparsed_token_activity');nativeKnown=false;continue;}
  const account=info?.account,role=rolesSeen.get(account);
  if(ACCOUNT_LIFECYCLE.has(kind)){
   if(!indexes.has(account)){issue('unparsed_token_activity');nativeKnown=false;continue;}
   if(role&&ix.programId!==role.program){issue('token_owner_mint_or_program_mismatch');continue;}
   if(INIT_TYPES.has(kind)){
    if(!role)continue;
    const creation=created.get(account);
    if(role.before||role.initialization||role.closure||creation?.program!==role.program||
      !agrees({...info,program:ix.programId},role)){
     issue('missing_balance_or_lifecycle_proof');continue;
    }
    role.initialization=true;
    if(isNative(role.mint,role.program)){
     // Only the ATA program's fresh-account branch funds the exact rent reserve.
     const ata=node.parent?.ix;
     const details=ata?.parsed?.info;
     if(!nativeKnown||creation.parent!==node.parent||ata?.programId!==ATA||
       !['create','createIdempotent'].includes(ata.parsed?.type)||details?.account!==account||
       details.wallet!==role.owner||details.mint!==role.mint||
       creation.amount!==amounts[indexes.get(account)])issue('native_sync_or_reserve_unproven');
     else reserves.set(account,creation.amount);
    }
    tokens.set(account,0n);
   }else if(kind==='syncNative'&&role){
    const reserve=reserves.get(account),lamports=amounts[indexes.get(account)];
    if(!nativeKnown||reserve===undefined||lamports<reserve||!isNative(role.mint,role.program))
     issue('native_sync_or_reserve_unproven');
    else tokens.set(account,lamports-reserve);
   }else if(kind==='closeAccount'){
    if(closed.has(account)){issue('missing_balance_or_lifecycle_proof');nativeKnown=false;continue;}
    closed.add(account);
    if(role){
     if(role.after||tokens.get(account)===null||(!isNative(role.mint,role.program)&&tokens.get(account)!==0n))
      issue('missing_balance_or_lifecycle_proof');
     role.closure=true;tokens.set(account,null);
    }
    move(account,info.destination,amounts[indexes.get(account)]??null);
   }
   continue;
  }
  if(MINT_BURN.has(kind)&&role){
   const raw=info.tokenAmount?.amount??info.amount;
   const amount=uint(typeof raw==='string'?raw:null);
   if(amount===null||info.mint!==role.mint||ix.programId!==role.program||
     isNative(role.mint,role.program)||(kind.endsWith('Checked')&&!isDecimals(info.tokenAmount?.decimals)))
    issue('unmodeled_token_activity');
   else applyToken(account,kind.startsWith('burn')?-amount:amount,info.tokenAmount?.decimals);
  }else if(!NON_MOVEMENT.has(kind)&&!MINT_BURN.has(kind)){
   issue('unmodeled_token_activity');nativeKnown=false;
  }
 }
 for(const [account,role] of rolesSeen){
  if((!role.before&&!role.initialization)||(!role.after&&!role.closure))
   issue('missing_balance_or_lifecycle_proof');
  if(role.initialization||role.closure)lifecycleRoles++;
  if(role.after&&tokens.get(account)!==role.after.amount)issue('mismatch');
 }
 return {tokenBalances:tokenStatus,lifecycleRoles,networkFeeLamports,
  lamportBalances:!completeLamports?'missing':!nativeKnown?'unmodeled':
   amounts.every((amount,i)=>amount===post[i]&&amount>=0n)?'matched':'mismatch'};
}
