import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {hostDir} from '../../../scripts/host.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const {loadExtensions,createExtensionRuntime}=await import(pathToFileURL(path.join(hostDir,'dist/core/extensions/loader.js')));
const {createEventBus}=await import(pathToFileURL(path.join(hostDir,'dist/core/event-bus.js')));

async function harness(settings={retry:{baseDelayMs:0,maxAgentDelayMs:0}}) {
  const bus=createEventBus();
  const runtime=createExtensionRuntime();
  runtime.getSettings=()=>settings;
  const loaded=await loadExtensions([path.resolve(here,'../index.ts')],process.cwd(),bus,runtime);
  assert.deepEqual(loaded.errors,[]);
  const extension=loaded.extensions[0];
  const ctx={hasPendingMessages:()=>false,settings};
  async function emit(name,event={}) {
    let result;
    for(const handler of extension.handlers.get(name)||[]) result=await handler({type:name,...event},ctx);
    return result;
  }
  const fail=async(extra={})=>{
    await emit('message_end',{message:{role:'assistant',stopReason:'error',errorMessage:'provider failed'}});
    return emit('agent_before_settle',{entries:[],continue:false,outcome:'error',...extra});
  };
  return {emit,fail,ctx,close:()=>emit('session_shutdown')};
}

async function withHarness(fn,settings) {const h=await harness(settings);try{await fn(h);}finally{await h.close();}}

test('any assistant provider error appends a retry message and continues, preserving entries',async()=>withHarness(async h=>{
  const prior={type:'custom',customType:'sibling',data:{keep:true}};
  const result=await h.fail({entries:[prior]});
  assert.equal(result.continue,true);
  assert.deepEqual(result.entries[0],prior);
  const retry=result.entries.at(-1);
  assert.equal(retry.type,'custom_message');
  assert.equal(retry.customType,'retry-any');
  assert.equal(retry.details.retry,1);
  assert.equal(retry.details.maxRetries,5);
  assert.match(retry.content,/Retry the user's request/);
}));

test('default retry count is bounded at five and success resets the count',async()=>withHarness(async h=>{
  for(let i=0;i<5;i++) assert.equal((await h.fail()).continue,true);
  assert.equal(await h.fail(),undefined);
  await h.emit('agent_before_settle',{entries:[],continue:false,outcome:'completed'});
  assert.equal((await h.fail()).entries.at(-1).details.retry,1);
}));

test('exponential delay is capped by maxAgentDelayMs',async()=>withHarness(async h=>{
  for(let i=0;i<3;i++) {
    const result=await h.fail();
    assert.equal(result.entries.at(-1).details.delayMs,[2,3,3][i]);
  }
},{retry:{maxRetries:3,baseDelayMs:2,maxAgentDelayMs:3}}));

test('agent_before_settle retries unclassified errors and skips known non-error outcomes',async()=>withHarness(async h=>{
  const fallback=await h.emit('agent_before_settle',{entries:[{type:'message',message:{role:'assistant',stopReason:'provider_specific'}}],continue:false,outcome:'error'});
  assert.equal(fallback.continue,true);
  const missingMessage=await h.emit('agent_before_settle',{entries:[],continue:false,outcome:'error'});
  assert.equal(missingMessage.continue,true);
  assert.equal(await h.emit('agent_before_settle',{entries:[],continue:false,outcome:'unknown'}),undefined);
  assert.equal(await h.emit('agent_before_settle',{entries:[{type:'message',message:{role:'assistant',stopReason:'toolUse'}}],continue:false,outcome:'error'}),undefined);
}));

test('user aborts and successful assistant responses are never retried',async()=>withHarness(async h=>{
  await h.emit('message_end',{message:{role:'assistant',stopReason:'error',errorMessage:'provider failed'}});
  assert.equal(await h.emit('agent_before_settle',{entries:[],continue:false,outcome:'aborted'}),undefined);
  await h.emit('message_end',{message:{role:'assistant',stopReason:'stop'}});
  assert.equal(await h.emit('agent_before_settle',{entries:[],continue:false,outcome:'completed'}),undefined);
}));

test('core-classified errors are not retried again by the fallback layer',async()=>withHarness(async h=>{
  await h.emit('message_end',{message:{role:'assistant',stopReason:'error',errorMessage:'502 Bad Gateway'}});
  assert.equal(await h.emit('agent_before_settle',{entries:[],continue:false,outcome:'error'}),undefined);
},{retry:{enabled:true,maxRetries:5,baseDelayMs:0,maxAgentDelayMs:0}}));

test('explicitly disabled retry stays disabled for random gateway errors',async()=>withHarness(async h=>{
  assert.equal(await h.fail(),undefined);
},{retry:{enabled:false,maxRetries:5,baseDelayMs:0,maxAgentDelayMs:0}}));

test('user abort during backoff never starts another provider attempt',async()=>withHarness(async h=>{
  const controller=new AbortController();h.ctx.signal=controller.signal;
  const waiting=h.fail();setTimeout(()=>controller.abort(),10);
  assert.equal(await waiting,undefined);
},{retry:{enabled:true,maxRetries:5,baseDelayMs:500,maxAgentDelayMs:500}}));

test('shutdown invalidates a pending fallback retry',async()=>withHarness(async h=>{
  await h.emit('message_end',{message:{role:'assistant',stopReason:'error',errorMessage:'arbitrary upstream failure'}});
  const waiting=h.emit('agent_before_settle',{entries:[],continue:false,outcome:'error'});
  await h.close();assert.equal(await waiting,undefined);
},{retry:{enabled:true,maxRetries:5,baseDelayMs:30,maxAgentDelayMs:30}}));

test('malformed retry configuration disables retries',async()=>withHarness(async h=>{
  assert.equal(await h.fail(),undefined);
},{retry:{maxRetries:-1,baseDelayMs:0,maxAgentDelayMs:0}}));
