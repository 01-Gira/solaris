import {decodeBase58,PUMP_FUN,PUMP_SWAP,WSOL} from './decoder.js';

export const SYSTEM='11111111111111111111111111111111';
export const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TOKEN_2022_NATIVE='9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP';
export const isToken=program=>program===TOKEN||program===TOKEN_2022;
export const isNative=(mint,program)=>mint===WSOL&&program===TOKEN||
 mint===TOKEN_2022_NATIVE&&program===TOKEN_2022;
export const isDecimals=value=>Number.isInteger(value)&&value>=0&&value<=255;
export const key=value=>typeof value==='string'?value:value?.pubkey;
const MAX_U64=(1n<<64n)-1n;
export function uint(value){
 if(typeof value==='number')return Number.isSafeInteger(value)&&value>=0?BigInt(value):null;
 if(typeof value!=='string'||!/^\d{1,20}$/.test(value))return null;
 const n=BigInt(value);
 return n<=MAX_U64?n:null;
}

// Account layouts in pump-public-docs/idl (blob IDs recorded in the research contract).
const BUY='66063d1201daebea',SELL='33e685a4017f83ad';
const BUY2='b817ee6167c5d33d',SELL2='5df6823ce7e940b2',EXACT2='c2ab1c46684d5b2f';
const BUY3='07051dc4f5176550',SELL3='1c92de7726c469d5',EXACT3='e1f7501ed5b38488';
const curveLegacy={pool:3,user:6,base:[2,5,4],system:7,program:11};
const swapLegacy={pool:0,user:1,base:[3,5,7,11],quote:[4,6,8,12],system:13,program:16,
 recipients:{protocolAccount:10,creatorVault:17}};
const curve2={pool:10,user:13,base:[1,14,11,3],quote:[2,15,12,4],
 recipients:{protocolAccount:[6,7],creatorVault:[16,17],buybackAccount:[8,9]}};
const curve3={pool:5,user:8,base:[1,9,6,3],quote:[2,10,7,4],system:14,program:16,
 fixed:17,recipients:{buybackAccount:13}};
const swap2={pool:0,user:1,base:[3,5,7,9],quote:[4,6,8,10],system:11,program:16,
 fixed:17,recipients:{buybackAccount:14}};
const curveBuy={...curveLegacy,fixed:16,base:[2,5,4,8],recipients:{protocolAccount:1,creatorVault:9}};
const curveBuy2={...curve2,system:24,program:26,fixed:27};
const swapBuy={...swapLegacy,fixed:23};
const variants={
 [PUMP_FUN]:{[BUY]:curveBuy,'38fc74089edfcd5f':curveBuy,
  [SELL]:{...curveLegacy,fixed:14,base:[2,5,4,9],recipients:{protocolAccount:1,creatorVault:8}},
  [BUY2]:curveBuy2,[EXACT2]:curveBuy2,[SELL2]:{...curve2,system:23,program:25,fixed:26},
  [BUY3]:curve3,[EXACT3]:curve3,[SELL3]:curve3},
 [PUMP_SWAP]:{[BUY]:swapBuy,'c62e1552b4d9e870':swapBuy,[SELL]:{...swapLegacy,fixed:21},
  [BUY2]:swap2,[EXACT2]:swap2,[SELL2]:swap2}
};

export function traceTransaction(tx){
 const outer=tx.transaction.message.instructions,groups=tx.meta.innerInstructions;
 const logs=tx.meta.logMessages;
 if(!Array.isArray(outer)||!Array.isArray(groups)||outer.length>500||groups.length>outer.length||
   (logs!=null&&(!Array.isArray(logs)||logs.some(line=>typeof line!=='string'||line==='Log truncated'))))return null;
 const groupsByIndex=new Map(),trace=[];
 for(const group of groups){
  if(!Number.isInteger(group?.index)||group.index<0||group.index>=outer.length||
    !Array.isArray(group.instructions)||group.instructions.length>500||groupsByIndex.has(group.index))return null;
  groupsByIndex.set(group.index,group.instructions);
 }
 for(const [outerIndex,ix] of outer.entries()){
  if(typeof ix?.programId!=='string'||(ix.stackHeight!=null&&ix.stackHeight!==1))return null;
  const node={ix,outerIndex,innerIndex:-1,parent:null};
  trace.push(node);
  const stack=[null,node];
  for(const [innerIndex,child] of (groupsByIndex.get(outerIndex)??[]).entries()){
   const height=child?.stackHeight;
   if(typeof child?.programId!=='string'||!Number.isInteger(height)||height<2||height>stack.length)return null;
   stack.length=height;
   const entry={ix:child,outerIndex,innerIndex,parent:stack[height-1]};
   stack.push(entry);trace.push(entry);
   if(trace.length>10000)return null;
  }
 }
 return trace;
}

export function getCandidates(trace){
 return trace.flatMap(node=>{
  const {ix}=node,table=variants[ix.programId];
  if(!table)return [];
  const data=decodeBase58(ix.data),disc=data?.subarray(0,8).toString('hex'),layout=table[disc];
  if(!layout)return [];
  const a=Array.isArray(ix.accounts)?ix.accounts.map(key):[];
  const pool=a[layout.pool],user=a[layout.user],quoteMint=layout.quote?a[layout.quote[0]]:null;
  const nativeSol=ix.programId===PUMP_FUN&&(!layout.quote||quoteMint===WSOL);
  const rolePair=([mint,userAccount,poolAccount,program])=>[
   {account:a[userAccount],owner:user,mint:a[mint],program:a[program]},
   {account:a[poolAccount],owner:pool,mint:a[mint],program:a[program]}
  ];
  const roles=rolePair(layout.base);
  if(!nativeSol&&layout.quote)roles.push(...rolePair(layout.quote));
  const recipients=Object.entries(layout.recipients).map(([name,index])=>
   [a[Array.isArray(index)?index[nativeSol?0:1]:index],name]);
  return [{node,pool,user,roles,nativeSol,sell:[SELL,SELL2,SELL3].includes(disc),quoteMint,
   eventAuthority:ix.programId===PUMP_FUN?a[layout.program-1]:null,
   hasLayout:data.length>=24&&a.length>=layout.fixed&&a.length<=128&&a.every(Boolean)&&
    a[layout.system]===SYSTEM&&a[layout.program]===ix.programId&&roles.every(r=>isToken(r.program)),
   recipients}];
 });
}

const CURVE_TRADE_EVENT=Buffer.from('e445a52e51cb9a1dbddb7fd34ee661ee','hex');
export function curveEventEvidence(candidate,children,base){
 if(!candidate.nativeSol||!candidate.eventAuthority)return 'not_applicable';
 const reports=children.flatMap(({ix})=>{
  if(ix.programId!==PUMP_FUN)return [];
  const data=decodeBase58(ix.data);
  return data?.subarray(0,16).equals(CURVE_TRADE_EVENT)?[{ix,data}]:[];
 });
 if(reports.length===0)return 'missing';
 if(reports.length!==1)return 'duplicate';
 const [{ix,data}]=reports;
 const mint=decodeBase58(candidate.roles[0].mint),user=decodeBase58(candidate.user);
 if(data.length<105||ix.accounts?.length!==1||key(ix.accounts[0])!==candidate.eventAuthority||
   !mint?.equals(data.subarray(16,48))||!user?.equals(data.subarray(65,97))||
   data[64]!==Number(!candidate.sell)||data.readBigUInt64LE(48)===0n)return 'conflicting';
 if(!base)return 'base_amount_unproven';
 return data.readBigUInt64LE(56)===base.gross?'token_amount_matches_program_claim':'conflicting';
}

export function tokenTransfer(ix,identities){
 if(!isToken(ix.programId))return null;
 const kind=ix.parsed?.type;
 if(!['transfer','transferChecked','transferCheckedWithFee'].includes(kind))return null;
 const info=ix.parsed?.info,source=info?.source,destination=info?.destination;
 const src=identities.get(source),dst=identities.get(destination),unchecked=kind==='transfer';
 const mint=unchecked?(src?.mint===dst?.mint&&src?.program===ix.programId&&
  dst?.program===ix.programId?src.mint:null):info?.mint;
 const decimals=unchecked?(src?.decimals===dst?.decimals?src?.decimals:null):info?.tokenAmount?.decimals;
 const gross=unchecked?uint(typeof info?.amount==='string'?info.amount:null):
  uint(typeof info?.tokenAmount?.amount==='string'?info.tokenAmount.amount:null);
 if(typeof source!=='string'||typeof destination!=='string'||source===destination||!mint||
  !isDecimals(decimals)||(isNative(mint,ix.programId)&&decimals!==9)||gross===null||
  [src,dst].some(b=>b&&(b.mint!==mint||b.program!==ix.programId||
   (b.decimals!==undefined&&b.decimals!==decimals))))return {error:'unusable_token_transfer'};
 const explicitFee=kind==='transferCheckedWithFee';
 const fee=explicitFee?uint(typeof info.feeAmount?.amount==='string'?info.feeAmount.amount:null):0n;
 if(explicitFee&&(ix.programId!==TOKEN_2022||fee===null||fee>gross||info.feeAmount.decimals!==decimals))
  return {error:'invalid_token_transfer_fee'};
 // Token-2022 may withhold fees even for ordinary checked transfers.
 const credited=ix.programId===TOKEN_2022&&!explicitFee&&!isNative(mint,ix.programId)?null:gross-fee;
 return {source,destination,mint,program:ix.programId,gross,credited,decimals};
}

export function systemMovement(ix){
 if(ix.programId!==SYSTEM)return null;
 const type=ix.parsed?.type,info=ix.parsed?.info;
 if(!['transfer','transferWithSeed','createAccount','createAccountWithSeed',
  'createAccountAllowPrefund','withdrawFromNonce'].includes(type))return null;
 const creation=type.startsWith('createAccount');
 return {source:info?.source??info?.nonceAccount,destination:creation?info?.newAccount:info?.destination,
  amount:uint(info?.lamports),creation};
}
