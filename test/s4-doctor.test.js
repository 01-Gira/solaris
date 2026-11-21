import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {classifyCodexFailure} from '../src/s4/orchestrator.js';
import {diagnoseS4} from '../src/s4/doctor.js';

const cases=[
 ['error: unexpected argument --ask-for-approval', 'CLI_ARGUMENT_OR_VERSION'],
 ['invalid schema for response_format', 'STRUCTURED_OUTPUT_SCHEMA'],
 ['Error 429: usage limit reached', 'CHATGPT_USAGE_OR_RATE_LIMIT'],
 ['401 unauthorized; refresh token', 'CODEX_AUTH_OR_ACCESS'],
 ['model does not exist', 'MODEL_NOT_AVAILABLE'],
 ['Operation not permitted while creating file', 'LOCAL_SANDBOX_OR_PERMISSION'],
 ['failed to parse config.toml', 'CODEX_LOCAL_CONFIGURATION'],
 ['TLS certificate verification failed', 'NETWORK_OR_TLS'],
 ['a private token bearer somethingunknown', 'UNCLASSIFIED']
];
for(const [message,expected] of cases){
 test('classify: '+expected,()=>assert.equal(classifyCodexFailure(message),expected));
}
function fakeCli({global='--ask-for-approval',exec='--sandbox --output-schema --output-last-message --skip-git-repo-check',login='Logged in using ChatGPT'}={}){
 return (cmd,args)=>{
  assert.equal(cmd,'codex');
  const child=new EventEmitter();
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.kill=()=>{};
  queueMicrotask(()=>{
   let output='';
   if(args.join(' ')==='--help')output=global;
   else if(args.join(' ')==='--ask-for-approval never exec --help')output=exec;
   else if(args.join(' ')==='login status')output=login;
   else throw new Error('unexpected CLI args');
   child.stdout.emit('data',Buffer.from(output));
   child.emit('close',0);
  });
  return child;
 };
}
test('doctor does not call a model and passes supported CLI/login',async()=>{
 const r=await diagnoseS4({spawnImpl:fakeCli(),env:{PATH:'/bin',HOME:'/tmp'}});
 assert.equal(r.status,'PREFLIGHT_PASS_MODEL_NOT_TESTED');
 assert.equal(r.modelCalls,0);assert.equal(r.requiredCliFlags,true);
 assert.equal(r.chatgptLogin,true);assert.equal(r.paidApiFallback,false);
});
test('doctor rejects missing global CLI flags without invoking login',async()=>{
 const r=await diagnoseS4({spawnImpl:fakeCli({global:'help text'}),env:{PATH:'/bin',HOME:'/tmp'}});
 assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'CLI_FLAGS_UNSUPPORTED');
});
test('doctor rejects API-key login',async()=>{
 const r=await diagnoseS4({spawnImpl:fakeCli({login:'Logged in using an API key'}),env:{PATH:'/bin',HOME:'/tmp'}});
 assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'CHATGPT_LOGIN_REQUIRED');
});

test('normal CLI help mentioning --output-schema must not be misclassified as schema failure',()=>{
 assert.equal(classifyCodexFailure('error: unexpected argument --output-schema\nUsage: codex exec [OPTIONS]'),'CLI_ARGUMENT_OR_VERSION');
 assert.equal(classifyCodexFailure('note: --output-schema is supported, transport broke'),'UNCLASSIFIED');
});
test('concrete invalid schema is classified without returning raw text',()=>{
 assert.equal(classifyCodexFailure('invalid schema for response_format: schema_id private'), 'STRUCTURED_OUTPUT_SCHEMA');
});
