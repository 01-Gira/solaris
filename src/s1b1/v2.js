// Decoder V2: evidence-gated *candidate* classification, NOT execution fills.
// The V1 decoder and all transaction evidence remain immutable.
import {decodeBase58,PUMP_FUN,PUMP_SWAP} from './decoder.js';

export const V2_VERSION='s1b1-v2-candidate-0.1';
const tradeDiscs={
  [PUMP_FUN]:new Set([
    '66063d1201daebea', // buy
    '33e685a4017f83ad', // sell
    '38fc74089edfcd5f'  // buy_exact_sol_in
  ]),
  [PUMP_SWAP]:new Set([
    '66063d1201daebea', // buy
    '33e685a4017f83ad', // sell
    'c62e1552b4d9e870'  // buy_exact_quote_in
  ])
};
export const CANDIDATE_STATUSES=Object.freeze([
 'failed_onchain','no_known_program','unverified_program_usage',
 'single_trade_candidate','multiple_trade_candidates','unknown'
]);
export function v2CandidateAnalysis(tx){
 const base={version:V2_VERSION,status:'unknown',tradeCandidateCount:0,
  knownProgramInstructionCount:0,unknownKnownProgramInstructionCount:0,
  hasInnerCandidate:false,hasOuterCandidate:false,
  containsPumpfun:false,containsPumpswap:false,
  verifiedFill:false,verifiedDirection:false,verifiedPrice:false,
  economicsAuthorized:false,liveTrading:false};
 if(!tx||!tx.meta||!tx.transaction?.message)return base;
 if(tx.meta.err!==null&&tx.meta.err!==undefined)
  return {...base,status:'failed_onchain'};
 const group=Array.isArray(tx.meta.innerInstructions)?tx.meta.innerInstructions:[];
 const out=Array.isArray(tx.transaction.message.instructions)?
  tx.transaction.message.instructions.map(ix=>({ix,inner:false})):[];
 for(const g of group){
  if(Array.isArray(g?.instructions)){
   for(const ix of g.instructions)out.push({ix,inner:true});
  }
 }
 let known=0,candidate=0,undecodable=0,hasInner=false,hasOuter=false;
 let pumpfun=false,pumpswap=false;
 for(const {ix,inner} of out.slice(0,500)){
  const programs=tradeDiscs[ix?.programId];
  if(!programs)continue;
  known++;
  if(ix.programId===PUMP_FUN)pumpfun=true;
  if(ix.programId===PUMP_SWAP)pumpswap=true;
  const bytes=typeof ix.data==='string'&&ix.data.length<=4096?
   decodeBase58(ix.data):null;
  if(!bytes||bytes.length<8){undecodable++;continue;}
  if(programs.has(bytes.subarray(0,8).toString('hex'))){
   candidate++;
   if(inner)hasInner=true;else hasOuter=true;
  }
 }
 const status=known===0?'no_known_program':
  candidate===0?'unverified_program_usage':
  candidate===1?'single_trade_candidate':'multiple_trade_candidates';
 return {...base,status,tradeCandidateCount:candidate,
  knownProgramInstructionCount:known,
  unknownKnownProgramInstructionCount:known-candidate,
  undecodableKnownProgramInstructionCount:undecodable,
  containsPumpfun:pumpfun,containsPumpswap:pumpswap,
  hasInnerCandidate:hasInner,hasOuterCandidate:hasOuter,
  note:'Candidate discriminator presence only; requires instruction-account proof and per-instruction balance evidence before calling a swap or fill.'};
}
