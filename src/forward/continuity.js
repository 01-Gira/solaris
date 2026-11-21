import {blockIdentity} from './archive.js';
import {check,hash,integer,isAddress,isHash,isList,stamp} from './contract.js';

export const MAX_SEGMENT_SLOTS=8192;
const node=(left,right)=>hash([left,right]);
function validHeader(header){
 return integer(header?.slot,1)&&integer(header.parentSlot,0,header.slot-1)&&isAddress(header.blockhash)&&
  isAddress(header.previousBlockhash)&&stamp(header.blockTime)!==null&&isHash(header.rosterHash);
}

export function buildSegment(genesis,headers){
 check(isAddress(genesis)&&isList(headers,MAX_SEGMENT_SLOTS)&&headers.length>0&&headers.every(validHeader),
  'invalid_segment_headers');
 const first=headers[0],last=headers.at(-1);
 check(last.slot-first.parentSlot<=MAX_SEGMENT_SLOTS&&headers.every((item,i)=>i===0||
  item.parentSlot===headers[i-1].slot&&item.previousBlockhash===headers[i-1].blockhash&&
  stamp(item.blockTime)>=stamp(headers[i-1].blockTime)),'segment_parent_discontinuity');
 // Strip transport-only fields so the compact header and full block share a leaf.
 const leaves=headers.map(({slot,parentSlot,blockhash,previousBlockhash,blockTime,rosterHash})=>
  hash({slot,parentSlot,blockhash,previousBlockhash,blockTime,rosterHash}));
 const levels=[leaves];
 while(levels.at(-1).length>1){
  const previous=levels.at(-1),next=[];
  for(let i=0;i<previous.length;i+=2)next.push(node(previous[i],previous[i+1]??previous[i]));
  levels.push(next);
 }
 const body={genesis,root:levels.at(-1)[0],blockCount:leaves.length,firstSlot:first.slot,lastSlot:last.slot,
  parentSlot:first.parentSlot,parentHash:first.previousBlockhash,lastHash:last.blockhash,
  firstTime:first.blockTime,lastTime:last.blockTime};
 return {body,proof(index){
  check(integer(index,0,leaves.length-1),'invalid_segment_leaf');
  const siblings=[];let position=index;
  for(const level of levels.slice(0,-1)){
   siblings.push(level[position^1]??level[position]);position=Math.floor(position/2);
  }
  return {root:body.root,index,siblings};
 }};
}

export function validSegment(body,genesis){
 return body.genesis===genesis&&isHash(body.root)&&integer(body.firstSlot,1)&&integer(body.lastSlot,body.firstSlot)&&
  integer(body.parentSlot,0,body.firstSlot-1)&&body.lastSlot-body.parentSlot<=MAX_SEGMENT_SLOTS&&
  integer(body.blockCount,1,body.lastSlot-body.firstSlot+1)&&isAddress(body.parentHash)&&isAddress(body.lastHash)&&
  stamp(body.firstTime)!==null&&stamp(body.lastTime)!==null&&stamp(body.firstTime)<=stamp(body.lastTime);
}

export function agreedSegments(entries,genesis){
 const byRange=new Map();
 for(const entry of entries){
  const body=entry.body;
  check(validSegment(body,genesis),'invalid_chain_segment');
  let versions=byRange.get(body.firstSlot);
  if(!versions){versions=new Map();byRange.set(body.firstSlot,versions);}
  const digest=hash(body);
  if(!versions.has(digest))versions.set(digest,{...body,digest,sources:new Set(),witnesses:[]});
  const segment=versions.get(digest);
  segment.sources.add(entry.organization);segment.witnesses.push(entry);
 }
 const confirmed=new Map(),conflicts=[];
 for(const versions of byRange.values()){
  if(versions.size>1){conflicts.push(...versions.values());continue;}
  const [segment]=versions.values();
  if(segment.sources.size>=2)confirmed.set(segment.digest,segment);
 }
 return {confirmed,conflicts};
}

export function included(block,segment){
 if(!block||!segment||!integer(block.slot,segment.firstSlot,segment.lastSlot)||
  stamp(block.blockTime)<stamp(segment.firstTime)||stamp(block.blockTime)>stamp(segment.lastTime))return false;
 const proof=block.proofs?.get(segment.root);
 if(!proof||!integer(proof.index,0,segment.blockCount-1)||!isList(proof.siblings,13)||
  proof.siblings.length!==Math.ceil(Math.log2(segment.blockCount))||!proof.siblings.every(isHash))return false;
 let leaf=hash(blockIdentity(block)),index=proof.index;
 for(const sibling of proof.siblings){leaf=index%2?node(sibling,leaf):node(leaf,sibling);index=Math.floor(index/2);}
 return leaf===segment.root;
}
// Check that the two certified paths overlap or are joined by an unambiguous forward bridge.
export function connectedSegments(development,forward,segments,conflicts){
 if(!development?.length||!forward?.length)return false;
 const knownForward=new Set(forward.map(s=>s.digest));
 if(development.some(s=>knownForward.has(s.digest)))return true;
 const first=forward[0];let tip=development.at(-1);
 if(tip.lastSlot>=first.firstSlot||[...conflicts].some(slot=>slot>tip.lastSlot&&slot<first.firstSlot))return false;
 const children=new Map();
 for(const segment of segments.values()){
  const parent=`${segment.parentSlot}:${segment.parentHash}`;
  if(!children.has(parent))children.set(parent,[]);
  children.get(parent).push(segment);
 }
 while(tip.lastSlot<first.firstSlot){
  const next=children.get(`${tip.lastSlot}:${tip.lastHash}`)??[];
  if(next.length!==1||stamp(next[0].firstTime)<stamp(tip.lastTime))return false;
  tip=next[0];
  if(tip.digest===first.digest)return true;
 }
 return false;
}
