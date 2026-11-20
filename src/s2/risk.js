// SOLARIS S2: screening, not a token-safety certification or trading approval.
export const RISK_VERSION='s2-0.4.0';
export const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022='TokenzQdBNbLqP5VEhdkAS6EPFZLh8ixpuJ5X4CkZ';
const riskyExtensions=new Set(['transferFeeConfig','transferHook','permanentDelegate','confidentialTransferMint','defaultAccountState','nonTransferable','pausable','mintCloseAuthority']);
const time=x=>{const n=Date.parse(x);return Number.isFinite(n)?n:null;};
const numeric=x=>{if(x==null||x==='')return null; const n=Number(x);return Number.isFinite(n)&&n>=0?n:null;};

export function parseMintProof(value,expectedMint,checkedAt=new Date().toISOString()){
  const unknown=reason=>({status:'unknown',reason,mint:expectedMint||null,checkedAt});
  if(!value||typeof value!=='object'||typeof expectedMint!=='string')return unknown('mint_account_absent');
  if(![TOKEN_PROGRAM,TOKEN_2022].includes(value.owner))return unknown('non_token_program_owner');
  const parsed=value.data?.parsed,info=parsed?.info;
  if(parsed?.type!=='mint'||!info||typeof info!=='object')return unknown('mint_not_json_parsed');
  if(!Object.hasOwn(info,'mintAuthority')||!Object.hasOwn(info,'freezeAuthority')||
      !Number.isInteger(info.decimals)||info.decimals<0||info.decimals>18||
      !/^\d+$/.test(String(info.supply??'')))return unknown('incomplete_mint_info');
  if(info.mintAuthority!==null&&typeof info.mintAuthority!=='string')return unknown('invalid_mint_authority');
  if(info.freezeAuthority!==null&&typeof info.freezeAuthority!=='string')return unknown('invalid_freeze_authority');
  if(value.owner===TOKEN_2022&&!Array.isArray(info.extensions)&&!Array.isArray(parsed.extensions))
    return unknown('token_2022_extensions_unverified');
  const extensions=(info.extensions||parsed.extensions||[]).map(x=>typeof x==='string'?x:x?.extension||x?.type||'unknown').filter(Boolean);
  return {status:'verified_structure_only',reason:null,mint:expectedMint,checkedAt,tokenProgram:value.owner,
    mintAuthority:info.mintAuthority,freezeAuthority:info.freezeAuthority,supplyRaw:String(info.supply),
    decimals:info.decimals,extensions,sensitiveExtensions:extensions.filter(x=>riskyExtensions.has(x)||x==='unknown')};
}
export function assessPoolRisk({pool,snapshots=[],mintProof=null,now=new Date().toISOString()}){
  const reasons=[],unknown=[],observed={};const ts=time(now);
  const firstSeen=time(pool?.first_seen_at??pool?.firstSeenAt);
  const valid=snapshots.map(s=>({at:time(s.observed_at??s.observedAt),
    liquidity:numeric(s.liquidity_usd??s.liquidityUsd),price:numeric(s.price_usd??s.priceUsd),
    volume:numeric(s.volume_m5_usd??s.volumeM5Usd)}))
    .filter(s=>s.at!==null&&ts!==null&&s.at<=ts).sort((a,b)=>a.at-b.at);
  const latest=valid.at(-1);observed.snapshotCount=valid.length;
  observed.latestObservedAt=latest?.at===undefined?null:new Date(latest.at).toISOString();
  observed.liquidityUsd=latest?.liquidity??null;observed.priceUsd=latest?.price??null;
  observed.volumeM5Usd=latest?.volume??null;
  observed.ageMinutes=firstSeen===null||ts===null?null:Math.max(0,(ts-firstSeen)/60000);
  observed.staleSeconds=latest===undefined||ts===null?null:Math.max(0,(ts-latest.at)/1000);
  let score=0,reject=false,missing=false;
  if(!pool?.base_mint&&!pool?.baseMint){unknown.push('base_mint_missing');missing=true;score+=20;}
  if(!latest||latest.liquidity===null||latest.price===null||latest.price<=0){
    unknown.push('market_observation_missing');missing=true;score+=30;
  }else{
    if(latest.liquidity<10000){reasons.push('low_liquidity_under_10000_usd');reject=true;score+=35;}
    else if(latest.liquidity<25000){reasons.push('thin_liquidity_under_25000_usd');score+=15;}
    if(latest.volume!==null&&latest.liquidity>0&&latest.volume/latest.liquidity>5){
      reasons.push('rolling_5m_volume_exceeds_5x_liquidity');score+=15;
    }
  }
  if(valid.length<3){unknown.push('insufficient_snapshots');score+=10;}
  if(observed.staleSeconds===null||observed.staleSeconds>300){
    unknown.push('stale_or_missing_market_observation');missing=true;score+=20;
  }
  if(observed.ageMinutes===null){unknown.push('unknown_pool_first_seen');score+=10;}
  else if(observed.ageMinutes<5){reasons.push('extremely_young_observation');score+=10;}
  if(mintProof?.status==='verified_structure_only'&&mintProof.mint===(pool.base_mint||pool.baseMint)){
    observed.mintProofCheckedAt=mintProof.checkedAt;
    if(mintProof.mintAuthority){reasons.push('mint_authority_enabled');reject=true;score+=30;}
    if(mintProof.freezeAuthority){reasons.push('freeze_authority_enabled');reject=true;score+=35;}
    if((mintProof.sensitiveExtensions||[]).length){
      reasons.push('sensitive_token_extensions_present');reject=true;score+=35;
    }
  }else{unknown.push('mint_and_freeze_authorities_unverified');missing=true;score+=20;}
  unknown.push('holder_concentration_unverified','liquidity_lock_unverified','sellability_unverified');
  return {version:RISK_VERSION,poolAddress:pool?.pool_address??pool?.poolAddress??null,
    riskBand:reject?'reject':missing?'unknown':'review',observedConcernScore:Math.min(score,100),
    tradability:'blocked',reasons:[...new Set(reasons)],unknown:[...new Set(unknown)],
    observed,mintProof:mintProof||{status:'unknown',reason:'not_checked'},assessedAt:now,economicsAuthorized:false};
}
