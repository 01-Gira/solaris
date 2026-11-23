import {createPublicKey,verify,createHash} from 'node:crypto';
import {check,isSignature} from './contract.js';
import {decodeBase58} from '../s1b1/decoder.js';

const SPKI=Buffer.from('302a300506032b6570032100','hex');
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const V1_PREFIX=0x81;
const SIGNATURE_BYTES=64;
const LEGACY_MAX_BYTES=1232;
const V1_MAX_BYTES=4096;
const V1_MAX_ACCOUNTS=96;
export function encode58(bytes){
 if(!bytes.length)return '';
 let number=BigInt(`0x${bytes.toString('hex')}`),out='',zeros=0;
 while(number){out=ALPHABET[Number(number%58n)]+out;number/=58n;}
 while(bytes[zeros]===0)zeros++;
 return '1'.repeat(zeros)+out;
}
function shortVector(bytes,at){
 let size=0;
 for(let n=0;n<3;n++){
  const byte=bytes[at+n];
  check(byte!==undefined&&!(n===2&&byte>3),'invalid_wire_vector');
  size|=(byte&127)<<(7*n);
  if(byte<128){check(n===0||byte>0,'noncanonical_wire_vector');return [size,at+n+1];}
 }
 throw new Error('invalid_wire_vector');
}

function reader(message){
 let cursor=0;
 function take(size){
  check(cursor+size<=message.length,'truncated_wire_message');
  const slice=message.subarray(cursor,cursor+size);cursor+=size;return slice;
 }
 function size(){const [length,next]=shortVector(message,cursor);cursor=next;return length;}
 return {take,size,done:()=>cursor===message.length};
}

function readAccounts(take,header,keys,maxKeys){
 const [signers,readOnlySigners,readOnlyUnsigned]=header;
 check(signers>0&&readOnlySigners<signers&&keys<=maxKeys&&readOnlyUnsigned<=keys-signers,'invalid_signer_header');
 return Array.from({length:keys},()=>take(32));
}

function readSignatureFirst(bytes){
 check(bytes.length<=LEGACY_MAX_BYTES,'invalid_transaction_wire');
 const [signers,signaturesStart]=shortVector(bytes,0);
 const messageStart=signaturesStart+SIGNATURE_BYTES*signers;
 const message=bytes.subarray(messageStart),signatures=bytes.subarray(signaturesStart,messageStart);
 check(signers>0&&signers<=64&&message.length>=37,'invalid_transaction_wire');
 const versioned=(message[0]&128)!==0;
 check(!versioned||message[0]===128,'unsupported_wire_version');
 const {take,size,done}=reader(message);
 if(versioned)take(1);
 const header=take(3);
 check(header[0]===signers,'invalid_signer_header');
 const keys=readAccounts(take,header,size(),256);
 take(32);
 const count=size();check(count<=256,'wire_instruction_limit');
 const instructions=Array.from({length:count},()=>({programIdIndex:take(1)[0],
  accounts:[...take(size())],data:take(size()).toString('hex')}));
 let loadedReadOnly=0,loadedWritable=0;
 if(versioned){
  const lookupCount=size();check(lookupCount<=256,'wire_lookup_limit');
  for(let i=0;i<lookupCount;i++){
   take(32);const writable=take(size()),readOnly=take(size());
   check(writable.length+readOnly.length>0,'empty_address_lookup');
   loadedWritable+=writable.length;loadedReadOnly+=readOnly.length;
  }
 }
 check(done(),'invalid_wire_message');
 return {version:versioned?0:'legacy',keys,signers,signatures,message,instructions,loadedWritable,loadedReadOnly};
}

// SIMD-0385 places the signed message first and has no address lookup tables.
function readV1(bytes){
 const signers=bytes[1];
 check(signers>0&&signers<=12,'invalid_signer_header');
 const messageEnd=bytes.length-SIGNATURE_BYTES*signers;
 check(messageEnd>=42,'truncated_wire_message');
 const message=bytes.subarray(0,messageEnd),signatures=bytes.subarray(messageEnd);
 const {take,done}=reader(message);
 take(1);
 const header=take(3),mask=take(4).readUInt32LE();
 check((mask&~31)===0&&((mask&3)===0||(mask&3)===3),'invalid_v1_config_mask');
 take(32);
 const [count,keyCount]=take(2);
 check(count<=64,'wire_instruction_limit');
 // Accept the SIMD-0596 wire capacity. Finalized witnesses establish historical inclusion.
 const keys=readAccounts(take,header,keyCount,V1_MAX_ACCOUNTS);
 const config={};
 if(mask&3)config.priorityFeeLamports=take(8).readBigUInt64LE().toString();
 if(mask&4)config.computeUnitLimit=take(4).readUInt32LE();
 if(mask&8)config.loadedAccountsDataSizeLimit=take(4).readUInt32LE();
 if(mask&16)config.heapSize=take(4).readUInt32LE();
 const headers=Array.from({length:count},()=>take(4));
 const instructions=headers.map(header=>({programIdIndex:header[0],
  accounts:[...take(header[1])],data:take(header.readUInt16LE(2)).toString('hex')}));
 check(done(),'invalid_wire_message');
 return {version:1,keys,signers,signatures,message,instructions,config,loadedWritable:0,loadedReadOnly:0};
}

export function verifyWire(wire,signature){
 check(typeof wire==='string'&&wire.length<=Math.ceil(V1_MAX_BYTES/3)*4&&isSignature(signature),'invalid_transaction_wire');
 const bytes=Buffer.from(wire,'base64');
 check(bytes.toString('base64')===wire&&bytes.length<=V1_MAX_BYTES,'invalid_transaction_wire');
 const {keys,signers,signatures,message,...decoded}=bytes[0]===V1_PREFIX?readV1(bytes):readSignatureFirst(bytes);
 const {instructions,loadedWritable,loadedReadOnly}=decoded,total=keys.length+loadedWritable+loadedReadOnly;
 check(total<=256&&instructions.every(ix=>ix.programIdIndex>0&&ix.programIdIndex<keys.length&&ix.accounts.every(i=>i<total)),
  'invalid_wire_message');
 check(signatures.subarray(0,SIGNATURE_BYTES).equals(decodeBase58(signature)),'wire_signature_mismatch');
 const accounts=keys.map(encode58);
 check(new Set(accounts.slice(0,signers)).size===signers,'duplicate_wire_signer');
 check(new Set(accounts).size===accounts.length,'duplicate_wire_account');
 for(let i=0;i<signers;i++){
  const key=createPublicKey({key:Buffer.concat([SPKI,keys[i]]),format:'der',type:'spki'});
  check(verify(null,message,key,signatures.subarray(i*SIGNATURE_BYTES,(i+1)*SIGNATURE_BYTES)),
   'invalid_transaction_signature');
 }
 return {...decoded,accounts,wireDigest:createHash('sha256').update(bytes).digest('hex')};
}
