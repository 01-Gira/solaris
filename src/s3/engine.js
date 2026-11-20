// SOLARIS S3 - deterministic, non-authoritative research on provider snapshots.
// No real fills, no implied tradeability. No data after the signal is used to make a signal.
import {assessPoolRisk} from '../s2/risk.js';
export const RESEARCH_VERSION='s3-0.5.0';
export const DEFAULTS=Object.freeze({
  minSnapshots:12,minSpanMinutes:30,maxGapMinutes:5,minDistinctPrices:3,
  minLiquidityUsd:10000,holdMinutes:5,maxEntryDelayMinutes:5,
  entrySlippageBps:300,exitSlippageBps:300,additionalFeesBps:100,
  minTradesPerSplit:30
});
const scalar=x=>{if(x==null||x==='')return null;const n=Number(x);return Number.isFinite(n)&&n>=0?n:null;};
const timestamp=x=>{const n=Date.parse(x);return Number.isFinite(n)?n:null;};
export function prepareObservations(rows){
 const indexed=rows.map(r=>({
  at:timestamp(r.observed_at??r.observedAt),
  price:scalar(r.price_usd??r.priceUsd),
  liquidity:scalar(r.liquidity_usd??r.liquidityUsd),
  volumeM5:scalar(r.volume_m5_usd??r.volumeM5Usd),
  buysM5:scalar(r.buys_m5??r.buysM5),sellsM5:scalar(r.sells_m5??r.sellsM5)
 })).filter(x=>x.at!==null&&x.price!==null&&x.price>0&&x.liquidity!==null)
 .sort((a,b)=>a.at-b.at);
 // One observation per timestamp. Never interpolate missing intervals.
 return indexed.filter((x,i)=>i===0||x.at!==indexed[i-1].at);
}
export function evaluateCoverage(observations,config=DEFAULTS){
 const n=observations.length;
 const span=n>1?(observations.at(-1).at-observations[0].at)/60000:0;
 let maxGap=0;
 for(let i=1;i<n;i++)maxGap=Math.max(maxGap,(observations[i].at-observations[i-1].at)/60000);
 const distinct=new Set(observations.map(x=>String(x.price))).size;
 const failures=[];
 if(n<config.minSnapshots)failures.push('too_few_snapshots');
 if(span<config.minSpanMinutes)failures.push('insufficient_observed_span');
 if(maxGap>config.maxGapMinutes)failures.push('observation_gap_too_large');
 if(distinct<config.minDistinctPrices)failures.push('insufficient_price_variation');
 return {ready:failures.length===0,count:n,spanMinutes:span,maxGapMinutes:maxGap,distinctPrices:distinct,failures};
}
export function proposedSignals(pool,observations,config=DEFAULTS){
 const coverage=evaluateCoverage(observations,config);
 if(!coverage.ready)return [];
 const found=new Set(),signals=[];
 for(let i=2;i<observations.length;i++){
  const a=observations[i-2],b=observations[i-1],c=observations[i];
  if(c.at<=b.at||b.at<=a.at||c.at-a.at>12*60000)continue;
  // All market risk features are computed using current/past observations only.
  const past=observations.slice(0,i+1).map(x=>({
    observedAt:new Date(x.at).toISOString(),priceUsd:x.price,
    liquidityUsd:x.liquidity,volumeM5Usd:x.volumeM5
  }));
  const risk=assessPoolRisk({pool,snapshots:past,now:new Date(c.at).toISOString()});
  if(risk.riskBand==='reject'||c.liquidity<config.minLiquidityUsd)continue;
  const matches=[];
  if(c.price/a.price>=1.05&&c.volumeM5!==null&&c.volumeM5>=200)matches.push('early_momentum');
  if(b.volumeM5!==null&&b.volumeM5>0&&c.volumeM5!==null&&
      c.volumeM5>=300&&c.volumeM5/b.volumeM5>=2)matches.push('volume_surge');
  if(c.buysM5!==null&&c.sellsM5!==null&&
      c.buysM5+c.sellsM5>=8&&c.buysM5/(c.buysM5+c.sellsM5)>=0.75)
    matches.push('buy_pressure');
  for(const strategy of matches){
   if(found.has(strategy))continue;
   found.add(strategy);
   signals.push({poolAddress:pool.pool_address??pool.poolAddress,strategy,
     signalAt:c.at,signalIndex:i,signalMark:c.price,
     featureEvidence:{pastTimes:[a.at,b.at,c.at],rollingVolumeM5:c.volumeM5,
       buysM5:c.buysM5,sellsM5:c.sellsM5,observedRiskBand:risk.riskBand,
       source:'geckoterminal_indexed_snapshot',featuresFutureFree:true}});
  }
 }
 return signals;
}
export function buildProxyTrade(signal,observations,config=DEFAULTS){
 const base={...signal,entryAt:null,exitAt:null,entryMark:null,exitMark:null,
   proxyNetReturn:null,censored:true,reason:null};
 const next=observations.find(x=>x.at>signal.signalAt);
 if(!next||next.at-signal.signalAt>config.maxEntryDelayMinutes*60000)
  return {...base,reason:'entry_observation_missing'};
 const partial={...base,entryAt:next.at,entryMark:next.price};
 const target=next.at+config.holdMinutes*60000;
 let prev=next;
 for(const o of observations){
  if(o.at<=next.at)continue;
  if((o.at-prev.at)>config.maxGapMinutes*60000)return {...partial,reason:'holding_gap_unobserved'};
  if(o.at>=target){
   const inPrice=next.price*(1+config.entrySlippageBps/10000);
   const outPrice=o.price*(1-config.exitSlippageBps/10000);
   const net=(outPrice/inPrice)*(1-config.additionalFeesBps/10000)-1;
   return {...partial,exitAt:o.at,exitMark:o.price,proxyNetReturn:Math.max(-1,net),
     censored:false,reason:'indexed_marks_only_not_executable_fills'};
  }
  prev=o;
 }
 return {...partial,reason:'exit_observation_missing'};
}
export function splitWindows(allTimes){
 const times=[...new Set(allTimes.filter(Number.isFinite))].sort((a,b)=>a-b);
 if(times.length<15)return null;
 return {validationStart:times[Math.floor(times.length*0.6)],
   testStart:times[Math.floor(times.length*0.8)]};
}
export function tradeSplit(trade,bounds){
 if(!bounds||trade.censored||trade.entryAt===null||trade.exitAt===null)return null;
 const phase=t=>t<bounds.validationStart?'discovery':t<bounds.testStart?'validation':'test';
 const p=phase(trade.signalAt);
 return p===phase(trade.entryAt)&&p===phase(trade.exitAt)?p:null;
}
export function proxyStats(trades){
 const completed=trades.filter(x=>!x.censored&&Number.isFinite(x.proxyNetReturn))
   .sort((a,b)=>a.exitAt-b.exitAt);
 const n=completed.length,losses=completed.filter(x=>x.proxyNetReturn<0);
 const gains=completed.filter(x=>x.proxyNetReturn>0);
 let equity=1,peak=1,maxDrawdown=0;
 for(const t of completed){equity*=Math.max(0,1+t.proxyNetReturn);peak=Math.max(peak,equity);if(peak>0)maxDrawdown=Math.max(maxDrawdown,1-equity/peak);}
 const grossProfit=gains.reduce((a,x)=>a+x.proxyNetReturn,0);
 const grossLoss=-losses.reduce((a,x)=>a+x.proxyNetReturn,0);
 return {completed:n,censored:trades.filter(x=>x.censored).length,
   winRate:n?gains.length/n:null,meanProxyReturn:n?completed.reduce((a,x)=>a+x.proxyNetReturn,0)/n:null,
   profitFactor:grossLoss>0?grossProfit/grossLoss:null,
   compoundedProxyReturn:n?equity-1:null,maxDrawdown:n?maxDrawdown:null};
}
export function runResearch(pools,{exploratory=false,config=DEFAULTS}={}){
 const observationsByPool=pools.map(p=>({pool:p.pool,obs:prepareObservations(p.snapshots)}));
 const coverage=observationsByPool.map(p=>({poolAddress:p.pool.pool_address??p.pool.poolAddress,
   ...evaluateCoverage(p.obs,config)}));
 const ready=coverage.filter(x=>x.ready).length;
 const summary={version:RESEARCH_VERSION,mode:exploratory?'exploratory_proxy':'audit',
   status:ready===0?'BLOCKED_DATA':'RESEARCH_ONLY_BLOCKED',
   economicsAuthorized:false,priceSource:'geckoterminal_indexed_snapshot',
   nonAuthoritative:true,pools:coverage.length,readyPools:ready,
   coverage,signals:0,censored:0,proxyCompleted:0,byStrategySplit:{},
   exclusions:{crossSplit:0}};
 if(!exploratory||ready===0)return {summary,trades:[]};
 const allTimes=observationsByPool.flatMap(x=>x.obs.map(o=>o.at));
 const bounds=splitWindows(allTimes);
 if(!bounds){summary.status='BLOCKED_DATA';summary.reason='chronological_split_unavailable';return {summary,trades:[]};}
 const trades=[];
 for(const {pool,obs} of observationsByPool){
  for(const signal of proposedSignals(pool,obs,config)){
   const trade=buildProxyTrade(signal,obs,config);
   summary.signals++;
   if(trade.censored)summary.censored++;
   const split=tradeSplit(trade,bounds);
   if(!split&&!trade.censored){summary.exclusions.crossSplit++;continue;}
   trades.push({...trade,split});
  }
 }
 summary.proxyCompleted=trades.filter(x=>!x.censored).length;
 for(const strategy of ['early_momentum','volume_surge','buy_pressure']){
  summary.byStrategySplit[strategy]={};
  for(const split of ['discovery','validation','test']){
   const sample=trades.filter(t=>t.strategy===strategy&&t.split===split);
   summary.byStrategySplit[strategy][split]={...proxyStats(sample),
    sampleGateMet:sample.filter(t=>!t.censored).length>=config.minTradesPerSplit};
  }
 }
 if(summary.proxyCompleted===0)summary.status='BLOCKED_DATA';
 return {summary,trades};
}
