// S4.2A deterministic task identity. No Codex or DB access in this module.
import {createHash} from 'node:crypto';
import {ROLE_NAMES,sanitizeResearchContext} from '../s4/policy.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function validateRoles(roles){
 if(!Array.isArray(roles)||roles.length<1||roles.length>5||
  new Set(roles).size!==roles.length||!roles.every(x=>ROLE_NAMES.includes(x)))
   throw new Error('invalid_roles');
 return roles;
}
export function prepareTask(context,roles=ROLE_NAMES){
 const evidence=sanitizeResearchContext(context);
 validateRoles(roles);
 // Collection time is deliberately not evidence; changed on every export.
 const {collected_at,...stableEvidence}=evidence;
 const contextSha256=hash(stableEvidence);
 const taskKey=hash({contextSha256,roles});
 return {contextSha256,taskKey,evidence,roles};
}
export function boundedDailyLimit(value){
 const n=Number(value);
 if(!Number.isInteger(n)||n<1||n>20)throw new Error('invalid_daily_codex_budget');
 return n;
}
export function validateBridgeCommand(cmd){
 if(!['submit','reserve','finish','status'].includes(cmd))throw new Error('invalid_bridge_command');
 return cmd;
}
