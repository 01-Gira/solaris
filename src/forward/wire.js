import {createPublicKey,verify,createHash} from 'node:crypto';
import {check,isSignature} from './contract.js';
import {decodeBase58} from '../s1b1/decoder.js';

const SPKI=Buffer.from('302a300506032b6570032100','hex');
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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

export function verifyWire(wire,signature){
 check(typeof wire==='string'&&wire.length<=5500&&isSignature(signature),'invalid_transaction_wire');
 const bytes=Buffer.from(wire,'base64');
 check(bytes.toString('base64')===wire&&bytes.length<=4096,'invalid_transaction_wire');
 const [signers,signaturesStart]=shortVector(bytes,0);
 const message=bytes.subarray(signaturesStart+64*signers);
 check(signers>0&&signers<=64&&message.length>=37,'invalid_transaction_wire');
 const versioned=(message[0]&128)!==0;
 // The v1 message uses a different header. Unsupported wire never qualifies.
 check(!versioned||message[0]===128,'unsupported_wire_version');
 const start=Number(versioned),[keys,keyStart]=shortVector(message,start+3);
 check(bytes.length<=1232&&message[start]===signers&&keys>=signers&&keys<=256&&
  message[start+1]<signers&&message[start+2]<=keys-signers&&message.length>=keyStart+keys*32+33,
  'invalid_signer_header');
 check(bytes.subarray(signaturesStart,signaturesStart+64).equals(decodeBase58(signature)),'wire_signature_mismatch');
 const signerKeys=new Set();
 for(let i=0;i<signers;i++){
  const publicKey=message.subarray(keyStart+32*i,keyStart+32*(i+1));
  const id=publicKey.toString('hex');
  check(!signerKeys.has(id),'duplicate_wire_signer');signerKeys.add(id);
  const key=createPublicKey({key:Buffer.concat([SPKI,publicKey]),format:'der',type:'spki'});
  check(verify(null,message,key,bytes.subarray(signaturesStart+i*64,signaturesStart+(i+1)*64)),
   'invalid_transaction_signature');
 }
 const accounts=Array.from({length:keys},(_,i)=>encode58(message.subarray(keyStart+32*i,keyStart+32*(i+1))));
 let cursor=keyStart+keys*32+32;
 function take(size){
  check(cursor+size<=message.length,'truncated_wire_message');
  const slice=message.subarray(cursor,cursor+size);cursor+=size;return slice;
 }
 function size(){const [length,next]=shortVector(message,cursor);cursor=next;return length;}
 const instructionCount=size();check(instructionCount<=256,'wire_instruction_limit');
 const instructions=[];
 for(let i=0;i<instructionCount;i++){
  const programIdIndex=take(1)[0],indexes=[...take(size())];
  instructions.push({programIdIndex,accounts:indexes,data:take(size()).toString('hex')});
 }
 let loadedReadOnly=0,loadedWritable=0;
 if(versioned){
  const lookupCount=size();check(lookupCount<=256,'wire_lookup_limit');
  for(let i=0;i<lookupCount;i++){
   take(32);const writable=take(size()),readOnly=take(size());
   loadedWritable+=writable.length;loadedReadOnly+=readOnly.length;
  }
 }
 const total=keys+loadedWritable+loadedReadOnly;
 check(cursor===message.length&&total<=256&&instructions.every(ix=>ix.programIdIndex<total&&ix.accounts.every(i=>i<total)),
  'invalid_wire_message');
 return {wireDigest:createHash('sha256').update(bytes).digest('hex'),accounts,instructions,loadedWritable,loadedReadOnly};
}
