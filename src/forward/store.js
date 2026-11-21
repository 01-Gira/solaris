import {mkdir,open,link,unlink,readdir,lstat,readFile,rmdir} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {canonical,check,hash,isHash,MAX_RECORD_BYTES,VERSION} from './contract.js';

const MARKER='.solaris-evidence';
const MODE=0o700;
async function syncDirectory(path){
 const handle=await open(path,'r');
 try{await handle.sync();}finally{await handle.close();}
}
async function fileInfo(file,max){
 const info=await lstat(file);
 check(info.isFile()&&info.size<=max,'unsafe_or_oversize_evidence_file');
 return info;
}
export async function readJson(file,max=MAX_RECORD_BYTES){
 await fileInfo(file,max);
 const bytes=await readFile(file);
 check(bytes.length<=max,'oversize_evidence_file');
 try{return JSON.parse(bytes);}catch{throw new Error('invalid_evidence_json');}
}

export function artifactRecord(bytes){
 check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=4*1024*1024,'invalid_artifact_size');
 return {version:VERSION,kind:'artifact',body:{sha256:createHash('sha256').update(bytes).digest('hex'),
  data:bytes.toString('base64')}};
}

export async function importArtifact(dir,file){
 await fileInfo(file,4*1024*1024);
 const record=artifactRecord(await readFile(file));
 await append(dir,record);
 return record.body.sha256;
}

export function artifactDigest(record){
 const body=record.body;
 check(typeof body?.data==='string'&&body.data.length<=5592408,'invalid_artifact');
 const checked=artifactRecord(Buffer.from(body.data,'base64'));
 check(checked.body.data===body.data&&checked.body.sha256===body.sha256,'artifact_integrity_failure');
 return body.sha256;
}

export async function openStore(location,{create=false}={}){
 check(typeof location==='string'&&location.length>0,'store_required');
 const dir=resolve(location);
 // A new store must be an explicit child directory, never an existing application directory.
 if(create){
  await mkdir(dir,{mode:MODE});
  const marker=await open(join(dir,MARKER),'wx',0o600);
  try{await marker.writeFile(`${VERSION}\n`);await marker.sync();}finally{await marker.close();}
  await syncDirectory(dirname(dir));
 }
 const info=await lstat(dir);
 check(info.isDirectory()&&(info.mode&0o077)===0,'store_must_be_private');
 const markerPath=join(dir,MARKER);
 await fileInfo(markerPath,100);
 check(await readFile(markerPath,'utf8')===`${VERSION}\n`,'not_a_forward_store');
 return dir;
}

export async function append(dir,record){
 const bytes=canonical(record);
 check(Buffer.byteLength(bytes)<=MAX_RECORD_BYTES,'oversize_evidence_record');
 const digest=hash(record),file=join(dir,`${digest}.json`),temp=join(dir,`.append-${randomUUID()}`);
 try{
  const handle=await open(temp,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  try{await link(temp,file);await syncDirectory(dir);}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   check(hash(await readJson(file))===digest,'evidence_integrity_failure');
  }
 }finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 return digest;
}

export async function* records(dir,digests){
 const pinned=digests!==undefined;
 const names=pinned?digests.map(digest=>{check(isHash(digest),'invalid_checkpoint');return `${digest}.json`;}):await readdir(dir);
 for(const name of names.sort()){
  if(!name.endsWith('.json'))continue;
  const expected=basename(name,'.json');
  check(isHash(expected),'unexpected_store_file');
  const record=await readJson(join(dir,name));
  check(hash(record)===expected,'evidence_integrity_failure');
  yield {digest:expected,record};
 }
}

export async function checkpoint(dir){
 const digests=[];
 for await(const {digest,record} of records(dir))if(record.kind!=='checkpoint')digests.push(digest);
 return append(dir,{version:VERSION,kind:'checkpoint',body:{records:digests}});
}

export async function checkpointEntries(dir,digest){
 check(isHash(digest),'invalid_checkpoint');
 const record=await readJson(join(dir,`${digest}.json`));
 const list=record?.body?.records;
 check(record.version===VERSION&&record.kind==='checkpoint'&&hash(record)===digest&&Array.isArray(list)&&
  new Set(list).size===list.length&&!list.includes(digest),'invalid_checkpoint');
 return list;
}

// Process-wide source pacing also needs to survive restarts and competing invocations.
export async function withCollectionLease(dir,work){
 const lease=join(dir,'.collector-active');
 try{await mkdir(lease,{mode:MODE});}catch(error){
  if(error.code==='EEXIST')throw new Error('collection_lease_active');
  throw error;
 }
 try{return await work();}finally{await rmdir(lease);}
}
