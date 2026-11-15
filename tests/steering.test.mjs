import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {defaultHostConfig} from '../scripts/host-config.mjs';
import {submitAgentTurn,steerAgentTurn} from '../scripts/agent-adapter.mjs';

test('steering targets the active adapter instance and never starts a second turn', {timeout:5000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'yxn-steer-'));
 let pending;
 try {
  const host=defaultHostConfig({projectLabel:'steer-test'}); host.agent={adapter:'adapter.mjs'};
  await writeFile(path.join(root,'harness.host.json'),JSON.stringify(host));
  await writeFile(path.join(root,'adapter.mjs'),`
  import {writeFile} from 'node:fs/promises';
  export function createAdapter(){
   let finish;
   return {
    declaration:{version:1,adapterId:'steer-test',displayName:'Test',capabilities:{models:false,reasoningEffort:false,modes:false,streaming:false,approvals:false,sessions:false,fileChanges:false,images:false,steering:true}},
    handleTurn:async(input)=>{await writeFile(${JSON.stringify(path.join(root,'started.json'))},JSON.stringify(input));return new Promise(resolve=>{finish=resolve;setTimeout(()=>resolve({ok:false,status:'timeout'}),2000).unref();});},
    handleSteer:async(input)=>{if(!finish)throw new Error('Wrong adapter instance');finish({ok:true,status:'ready',steered:input});return {ok:true,status:'steered'};}
   };
  }
  `);
  assert.equal((await steerAgentTurn(root,{turnId:'turn-a',body:'Change direction'})).status,'blocked');
  pending=submitAgentTurn(root,{turnId:'turn-a',body:'Start work'});
  let started;
  for(let i=0;i<100;i++){try{started=JSON.parse(await readFile(path.join(root,'started.json'),'utf8'));break;}catch{await delay(10);}}
  assert.ok(started);
  assert.equal(started.turnId,'turn-a');
  assert.equal((await steerAgentTurn(root,{turnId:'stale-turn',body:'Wrong target'})).status,'blocked');
  assert.equal((await steerAgentTurn(root,{turnId:'turn-a',body:'  '})).status,'blocked');
  const result=await steerAgentTurn(root,{turnId:'turn-a',body:'Use smaller spacing'});
  assert.equal(result.status,'steered');
  const turn=await pending;
  assert.equal(turn.steered.body,'Use smaller spacing');
  assert.equal(turn.steered.sessionId,started.sessionId);
  assert.equal((await steerAgentTurn(root,{turnId:'turn-a',body:'Already finished'})).status,'blocked');
 } finally {if(pending)await pending;await rm(root,{recursive:true,force:true});}
});
