import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareObservations,evaluateCoverage,proposedSignals,buildProxyTrade,tradeSplit,
 splitWindows,proxyStats,runResearch,DEFAULTS} from '../src/s3/engine.js';
const base=Date.parse('2026-11-20T10:00:00.000Z');
const pool={pool_address:'PoolA',base_mint:'MintA',first_seen_at:new Date(base-3600000).toISOString()};
const row=(minute,price=1,liquidity=40000,vol=300,buys=15,sells=2)=>({
 observed_at:new Date(base+minute*60000).toISOString(),
 price_usd:String(price),liquidity_usd:String(liquidity),
 volume_m5_usd:String(vol),buys_m5:buys,sells_m5:sells
});
const rows=Array.from({length:42},(_,i)=>row(i,1+i*0.03,40000,300*(i+1),15,2));
const config={...DEFAULTS,minSnapshots:3,minSpanMinutes:2,maxGapMinutes:2,
 minDistinctPrices:2,minLiquidityUsd:10000,minTradesPerSplit:1,holdMinutes:4};
test('invalid, duplicate and nonpositive price snapshots are not used',()=>{
 const out=prepareObservations([row(0),row(0),row(1,-1),row(2),{observed_at:'bad',price_usd:4,liquidity_usd:40000}]);
 assert.equal(out.length,2); assert.equal(out[0].at,base);
});
test('short history is blocked by coverage gate',()=>{
 const out=evaluateCoverage(prepareObservations([row(0),row(1)]));
 assert.equal(out.ready,false);assert.ok(out.failures.includes('too_few_snapshots'));
});
test('large observation gaps prevent continuous backtest',()=>{
 const x=prepareObservations([row(0),row(1),row(20),row(21)]);
 const out=evaluateCoverage(x,config);assert.equal(out.ready,false);
 assert.ok(out.failures.includes('observation_gap_too_large'));
});
test('constant marks are blocked despite many rows',()=>{
 const x=prepareObservations(Array.from({length:40},(_,i)=>row(i,1)));
 assert.ok(evaluateCoverage(x,DEFAULTS).failures.includes('insufficient_price_variation'));
});
test('signals only use current and historical feature timestamps',()=>{
 const x=prepareObservations(rows);
 const signals=proposedSignals(pool,x,config);
 assert.ok(signals.length>0);
 for(const s of signals)assert.ok(s.featureEvidence.pastTimes.every(t=>t<=s.signalAt));
 assert.equal(new Set(signals.map(s=>s.strategy)).size,signals.length);
});
test('signal does not observe future price shock',()=>{
 const prior=prepareObservations(rows.slice(0,8));
 const before=proposedSignals(pool,prior,config);
 const future=prepareObservations([...rows.slice(0,8),row(8,100000)]);
 const after=proposedSignals(pool,future,config);
 assert.deepEqual(after.filter(s=>s.signalAt<base+8*60000),before);
});
test('next observed mark is used as entry (never signal mark)',()=>{
 const x=prepareObservations(rows),signals=proposedSignals(pool,x,config);
 const t=buildProxyTrade(signals[0],x,config);
 assert.equal(t.entryAt,signals[0].signalAt+60000);
 assert.notEqual(t.entryMark,signals[0].signalMark);
});
test('missing exit is censored and cannot become a win',()=>{
 const x=prepareObservations(rows.slice(0,5));
 const signal={poolAddress:'PoolA',strategy:'volume_surge',signalAt:x[3].at,signalIndex:3,signalMark:x[3].price};
 const t=buildProxyTrade(signal,x,config);
 assert.equal(t.censored,true);assert.equal(t.proxyNetReturn,null);
});
test('entry and exit gaps are censored, not interpolated',()=>{
 const x=prepareObservations([row(0),row(1),row(2),row(20),row(21)]);
 const signal={poolAddress:'PoolA',strategy:'early_momentum',signalAt:x[2].at,signalMark:x[2].price};
 const t=buildProxyTrade(signal,x,config);
 assert.equal(t.censored,true);
});
test('cost stress reduces the indicative return',()=>{
 const x=prepareObservations(rows),signal=proposedSignals(pool,x,config)[0];
 const free=buildProxyTrade(signal,x,{...config,entrySlippageBps:0,exitSlippageBps:0,additionalFeesBps:0});
 const stressed=buildProxyTrade(signal,x,config);
 assert.ok(stressed.proxyNetReturn<free.proxyNetReturn);
});
test('chronological splits require ample timestamps',()=>{
 assert.equal(splitWindows([1,2,3]),null);
 const bounds=splitWindows(Array.from({length:30},(_,i)=>i*100));
 assert.ok(bounds.testStart>bounds.validationStart);
 assert.equal(tradeSplit({censored:true},bounds),null);
});
test('signals crossing splits are excluded',()=>{
 const bounds={validationStart:base+10*60000,testStart:base+20*60000};
 const t={censored:false,signalAt:base+9*60000,entryAt:base+11*60000,exitAt:base+12*60000};
 assert.equal(tradeSplit(t,bounds),null);
});
test('profit factor null without losses; censoring excluded from mean',()=>{
 const a=[{censored:false,proxyNetReturn:.1,exitAt:100},{censored:true,proxyNetReturn:null},
  {censored:false,proxyNetReturn:.2,exitAt:200}];
 const s=proxyStats(a);assert.equal(s.completed,2);assert.equal(s.censored,1);assert.equal(s.profitFactor,null);
});
test('audit mode is blocked and never runs any simulated trades',()=>{
 const r=runResearch([{pool,snapshots:rows}],{config});
 assert.equal(r.summary.mode,'audit');assert.equal(r.summary.economicsAuthorized,false);
 assert.equal(r.trades.length,0);assert.equal(r.summary.status,'RESEARCH_ONLY_BLOCKED');
});
test('exploratory runs are still unauthorized even if proxy positive',()=>{
 const r=runResearch([{pool,snapshots:rows}],{config,exploratory:true});
 assert.equal(r.summary.mode,'exploratory_proxy');
 assert.equal(r.summary.economicsAuthorized,false);
 assert.ok(['RESEARCH_ONLY_BLOCKED','BLOCKED_DATA'].includes(r.summary.status));
 assert.ok(r.summary.signals>0);
 assert.ok(r.trades.every(x=>x.censored||x.reason==='indexed_marks_only_not_executable_fills'));
});
test('no data remains BLOCKED_DATA',()=>{
 const r=runResearch([],{config,exploratory:true});
 assert.equal(r.summary.status,'BLOCKED_DATA');
 assert.equal(r.summary.economicsAuthorized,false);
});
