import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostDir} from '../host.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager}=await import(pathToFileURL(path.join(hostDir,'dist/index.js')));
const fixtureModel={id:'model',name:'fixture',provider:'workbench-fixture',api:'workbench-fixture',baseUrl:'http://127.0.0.1/unused',reasoning:false,input:['text'],contextWindow:64000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};

async function harness(fn){
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'pi-goal-retry-integration-'));let session;
 const errors=[];const events=[];
 const settings=SettingsManager.inMemory({retry:{enabled:true,maxRetries:5,baseDelayMs:0,maxAgentDelayMs:0},cacheWarming:'off'});
 const resources=new DefaultResourceLoader({cwd,agentDir:process.env.PI_CODING_AGENT_DIR,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noContextFiles:true,noThemes:true,additionalExtensionPaths:[
  path.join(root,'extensions/goal/index.ts'),path.join(root,'extensions/retry-any/index.ts'),path.join(root,'extensions/supervisor/index.ts'),path.join(root,'scripts/fixtures/offline-provider.ts'),
 ]});
 try{
  await resources.reload();
  ({session}=await createAgentSession({cwd,agentDir:process.env.PI_CODING_AGENT_DIR,model:fixtureModel,settingsManager:settings,resourceLoader:resources,sessionManager:SessionManager.inMemory(cwd)}));
  await session.bindExtensions({mode:'print',onError:error=>errors.push(error)});
  session.subscribe(event=>events.push(event));
  const tool=async(name,args)=>session.agent.state.tools.find(tool=>tool.name===name).execute('integration',args,undefined,undefined);
  const goal=()=>session.sessionManager.getBranch().filter(entry=>entry.type==='custom'&&entry.customType==='goal-state').at(-1)?.data;
  await tool('goal_start',{objective:'Finish a local integration test',criteria:['Verified response after the provider recovers'],maxContinuations:10,maxMinutes:5});
  await fn({session,events,tool,goal});assert.deepEqual(errors,[]);
 }finally{if(session){await session.abort();await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}await fs.rm(cwd,{recursive:true,force:true});}
}
function command(goal,options){return 'PROBE:'+JSON.stringify({op:'failure-sequence',tool:'goal_finish',args:{goalId:goal.id,evidence:[{criterion:1,evidence:'Offline provider recovery verified by the real Pi lifecycle'}]},...options});}

test('real Pi lifecycle retries unclassified errors and successfully finishes the still-active Goal',async()=>harness(async h=>{
 await h.session.prompt(command(h.goal(),{failures:2}));
 assert.equal(h.events.filter(event=>event.type==='message_end'&&event.message?.stopReason==='error').length,2);
 assert.equal(h.goal().status,'completed');
 assert.equal(h.events.filter(event=>event.type==='agent_settled').length,1);
}));

test('real Pi lifecycle handles five built-in 502 retries without losing Goal state',async()=>harness(async h=>{
 await h.session.prompt(command(h.goal(),{failures:5,error:'502 Bad Gateway'}));assert.equal(h.goal().status,'completed');
 assert.equal(h.events.filter(event=>event.type==='message_end'&&event.message?.stopReason==='error').length,5);
 assert.equal(h.events.filter(event=>event.type==='auto_retry_start').length,5);
}));

test('after six provider failures with no background jobs the supervisor wakes and completes the Goal',{timeout:12000},async()=>harness(async h=>{
 await h.session.prompt('/supervisor on 1');
 await h.session.prompt(command(h.goal(),{failures:6}));
 assert.equal(h.goal().status,'paused');assert.equal(h.goal().pauseCause,'provider-error');assert.equal(h.goal().pending.length,0);
 assert.equal(h.events.filter(event=>event.type==='message_end'&&event.message?.stopReason==='error').length,6);
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{off();reject(new Error('Supervisor did not recover the Goal'));},6000);
  const off=h.session.subscribe(event=>{if(event.type==='agent_settled'&&h.goal().status==='completed'){clearTimeout(timer);off();resolve();}});
 });
 assert.ok(h.events.some(event=>event.type==='message_end'&&event.message?.customType==='supervisor-check'));
 assert.equal(h.goal().status,'completed');
}));

test('an explicit blocked Goal stays blocked after provider retry and supervisor ticks',async()=>harness(async h=>{
 await h.tool('goal_pause',{reason:'User action required',blocked:true});await h.session.prompt('/supervisor on 1');
 await h.session.prompt('PROBE:'+JSON.stringify({op:'failure-sequence',failures:1}));
 assert.equal(h.goal().status,'blocked');assert.equal(h.goal().pauseCause,undefined);
 await new Promise(resolve=>setTimeout(resolve,1100));
 assert.equal(h.events.some(event=>event.type==='message_end'&&event.message?.customType==='supervisor-check'),false);
}));
