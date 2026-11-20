import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessPoolRisk,parseMintProof,TOKEN_PROGRAM,TOKEN_2022} from '../src/s2/risk.js';
const NOW='2026-11-20T11:00:00.000Z';
const pool={pool_address:'PoolA',base_mint:'MintA',first_seen_at:'2026-11-20T10:30:00.000Z'};
const snapshots=[
 {observed_at:'2026-11-20T10:58:00.000Z',price_usd:'0.01',liquidity_usd:'25000',volume_m5_usd:'100'},
 {observed_at:'2026-11-20T10:59:00.000Z',price_usd:'0.011',liquidity_usd:'25000',volume_m5_usd:'130'},
 {observed_at:'2026-11-20T10:59:59.000Z',price_usd:'0.012',liquidity_usd:'25000',volume_m5_usd:'150'}
];
const mint=(mintAuthority=null,freezeAuthority=null)=>({owner:TOKEN_PROGRAM,data:{parsed:{type:'mint',
 info:{decimals:6,supply:'1000000000',mintAuthority,freezeAuthority}}}});
test('missing mint proof always blocks tradability',()=>{
 const r=assessPoolRisk({pool,snapshots,now:NOW});
 assert.equal(r.riskBand,'unknown');assert.equal(r.tradability,'blocked');
 assert.ok(r.unknown.includes('mint_and_freeze_authorities_unverified'));
 assert.equal(r.economicsAuthorized,false);
});
test('verified mint without authorities remains review, NEVER approved to trade',()=>{
 const proof=parseMintProof(mint(),'MintA',NOW);
 const r=assessPoolRisk({pool,snapshots,mintProof:proof,now:NOW});
 assert.equal(proof.status,'verified_structure_only');
 assert.equal(r.riskBand,'review');assert.equal(r.tradability,'blocked');
 assert.ok(r.unknown.includes('sellability_unverified'));
});
test('mint authority causes hard risk rejection',()=>{
 const proof=parseMintProof(mint('canMint'),'MintA',NOW);
 const r=assessPoolRisk({pool,snapshots,mintProof:proof,now:NOW});
 assert.equal(r.riskBand,'reject');assert.ok(r.reasons.includes('mint_authority_enabled'));
});
test('freeze authority causes hard risk rejection',()=>{
 const proof=parseMintProof(mint(null,'canFreeze'),'MintA',NOW);
 const r=assessPoolRisk({pool,snapshots,mintProof:proof,now:NOW});
 assert.equal(r.riskBand,'reject');
});
test('low liquidity rejects even with null authorities',()=>{
 const proof=parseMintProof(mint(),'MintA',NOW);
 const low=snapshots.map(s=>({...s,liquidity_usd:150}));
 const r=assessPoolRisk({pool,snapshots:low,mintProof:proof,now:NOW});
 assert.equal(r.riskBand,'reject');
});
test('future observations are excluded from point-in-time assessment',()=>{
 const proof=parseMintProof(mint(),'MintA',NOW);
 const future={observed_at:'2026-11-20T11:30:00.000Z',price_usd:99,liquidity_usd:1};
 const r=assessPoolRisk({pool,snapshots:[...snapshots,future],mintProof:proof,now:NOW});
 assert.equal(r.riskBand,'review');assert.equal(r.observed.snapshotCount,3);
});
test('unparsed mint fails closed',()=>{
 const r=parseMintProof({owner:TOKEN_PROGRAM,data:{parsed:{type:'account',info:{}}}},'MintA',NOW);
 assert.equal(r.status,'unknown');
});
test('Token-2022 with unknown extension list remains unknown',()=>{
 const r=parseMintProof({owner:TOKEN_2022,data:{parsed:{type:'mint',
  info:{decimals:9,supply:'100',mintAuthority:null,freezeAuthority:null}}}},'MintA',NOW);
 assert.equal(r.status,'unknown');
});
test('Token-2022 transfer hook is flagged as high concern',()=>{
 const proof=parseMintProof({owner:TOKEN_2022,data:{parsed:{type:'mint',
 info:{decimals:9,supply:'100',mintAuthority:null,freezeAuthority:null,extensions:['transferHook']}}}},'MintA',NOW);
 const r=assessPoolRisk({pool,snapshots,mintProof:proof,now:NOW});
 assert.equal(r.riskBand,'reject'); assert.ok(r.reasons.includes('sensitive_token_extensions_present'));
});
test('zero observations cannot be certified',()=>{
 const r=assessPoolRisk({pool,snapshots:[],mintProof:parseMintProof(mint(),'MintA',NOW),now:NOW});
 assert.equal(r.riskBand,'unknown');assert.equal(r.tradability,'blocked');
});
