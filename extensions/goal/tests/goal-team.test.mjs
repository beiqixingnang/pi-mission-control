import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
import {hostDir} from '../../../scripts/host.mjs';
const packageDir=hostDir;
const {loadExtensions, createExtensionRuntime} = await import(pathToFileURL(path.join(packageDir, 'dist/core/extensions/loader.js')));
const {createEventBus} = await import(pathToFileURL(path.join(packageDir, 'dist/core/event-bus.js')));
const {promptAndWaitSafely} = await import(pathToFileURL(path.resolve(here, '../../team/rpc.ts')));

async function harness(initialEntries = []) {
  const entries = structuredClone(initialEntries);
  const sent = [];
  const notices = [];
  const bus = createEventBus();
  const runtime = createExtensionRuntime();
  runtime.appendEntry = (customType, data) => entries.push({type:'custom', customType, data:structuredClone(data)});
  runtime.sendMessage = (message, options) => sent.push({message:structuredClone(message), options});
  const loaded = await loadExtensions([path.resolve(here, '../index.ts')], process.cwd(), bus, runtime);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  let aborted = false;
  const ctx = {mode:'rpc', hasUI:true, cwd:process.cwd(), tools:[{name:'bash'}], isIdle:()=>true, hasPendingMessages:()=>false,
    sessionManager:{getBranch:()=>entries}, ui:{notify:(...args)=>notices.push(args),setStatus(){}},
    abort:()=>{aborted=true;}, executeTool:async()=>({isError:false,result:{content:[{type:'text',text:'verified'}]}})};
  async function emit(name, event={}) {
    let result;
    for (const handler of extension.handlers.get(name) || []) result = await handler({type:name,...event},ctx);
    return result;
  }
  async function tool(name, params={}) {return extension.tools.get(name).definition.execute('test',params,undefined,undefined,ctx);}
  const state = ()=>tool('goal_status').then(r=>structuredClone(r.details));
  const start = (params={})=>tool('goal_start',{objective:'Complete the test target',criteria:['Criterion one'],...params});
  const boundary = (extra={})=>emit('agent_before_settle',{entries:[],continue:false,context:{canContinue:false},outcome:'completed',...extra});
  const command = args=>extension.commands.get('goal').handler(args,ctx);
  await emit('session_start',{reason:'startup'});
  return {entries,sent,notices,bus,ctx,emit,tool,state,start,boundary,command,aborted:()=>aborted,close:()=>emit('session_shutdown',{reason:'quit'})};
}

async function withHarness(fn, entries) {const h=await harness(entries);try{await fn(h);}finally{await h.close();}}

test('continuation adds a usable message even if initial canContinue is false, preserving sibling entries', async()=>withHarness(async h=>{
  await h.start();
  const prior={type:'custom',customType:'sibling',data:{keep:true}};
  const r=await h.boundary({entries:[prior]});
  assert.equal(r.continue,true);
  assert.deepEqual(r.entries[0],prior);
  assert.ok(r.entries.some(e=>e.type==='custom_message'&&e.customType==='goal-continue'));
  assert.ok(r.entries.some(e=>e.type==='custom'&&e.customType==='goal-state'));
}));

test('pending jobs settle without polling, then wake once with all results',async()=>withHarness(async h=>{
  await h.start();const id=(await h.state()).id;
  h.bus.emit('team:job-start',{id:'a',member:'alice',goalId:id});
  h.bus.emit('team:job-start',{id:'b',member:'bob',goalId:id});
  assert.equal((await h.tool('goal_wait')).terminate,true);
  assert.equal(await h.boundary(),undefined);
  h.bus.emit('team:job-end',{id:'a',member:'alice',goalId:id,ok:true,reply:'first result'});
  await delay(50);assert.equal(h.sent.length,0);
  h.bus.emit('team:job-end',{id:'b',member:'bob',goalId:id,ok:false,error:'test failure'});
  await delay(60);assert.equal(h.sent.length,1);
  assert.equal(h.sent[0].options.triggerTurn,true);
  assert.match(h.sent[0].message.content,/first result/);
  assert.match(h.sent[0].message.content,/test failure/);
  h.bus.emit('team:job-end',{id:'b',member:'bob',goalId:id,ok:true,reply:'duplicate'});
  await delay(50);assert.equal(h.sent.length,1);
}));

test('paused goal retains results without waking and explicit resume delivers them',async()=>withHarness(async h=>{
  await h.start();const id=(await h.state()).id;
  h.bus.emit('team:job-start',{id:'a',member:'alice',goalId:id});
  await h.command('pause');h.sent.length=0;
  h.bus.emit('team:job-end',{id:'a',member:'alice',goalId:id,ok:true,reply:'saved while paused'});
  await delay(60);assert.equal(h.sent.length,0);
  assert.equal((await h.state()).status,'paused');
  await h.command('resume');
  assert.equal(h.sent.length,1);assert.match(h.sent[0].message.content,/saved while paused/);
}));

test('stop emits cancellation, late old-goal completions never become normal team wakeups',async()=>withHarness(async h=>{
  await h.start();const id=(await h.state()).id;let cancelled;
  h.bus.on('team:cancel-goal',data=>{cancelled=data.goalId;});
  h.bus.emit('team:job-start',{id:'a',member:'alice',goalId:id});
  await h.command('stop');assert.equal(cancelled,id);h.sent.length=0;
  h.bus.emit('team:job-end',{id:'a',member:'alice',goalId:id,ok:true,reply:'late result'});
  const request={results:[{goalId:id},{goalId:'older-goal'},{id:'normal'}]};h.bus.emit('team:before-wake',request);
  assert.deepEqual(request.results,[{id:'normal'}]);
  await delay(60);assert.equal(h.sent.length,0);
  const scope={};h.bus.emit('team:scope',scope);assert.equal(scope.goalId,undefined);
}));

test('completion requires per-criterion evidence and successful configured checks',async()=>withHarness(async h=>{
  await h.start({criteria:['first','second'],verificationCommands:['test-check']});const id=(await h.state()).id;
  assert.equal((await h.tool('goal_finish',{goalId:id,evidence:[{criterion:1,evidence:'one'}]})).isError,true);
  const evidence=[{criterion:1,evidence:'one'},{criterion:2,evidence:'two'}];
  h.ctx.executeTool=async()=>({isError:true,result:{content:[{type:'text',text:'failed check'}]}});
  assert.equal((await h.tool('goal_finish',{goalId:id,evidence})).isError,true);
  assert.equal((await h.state()).status,'running');
  h.ctx.executeTool=async(name,args)=>{assert.equal(name,'bash');assert.equal(args.command,'test-check');return {isError:false,result:{content:[{type:'text',text:'passed check'}]}};};
  assert.equal((await h.tool('goal_finish',{goalId:id,evidence})).isError,undefined);
  assert.equal((await h.state()).status,'completed');
  assert.equal(await h.boundary(),undefined);
}));

test('completion cannot succeed while pending or if paused during verification',async()=>withHarness(async h=>{
  await h.start({verificationCommands:['test-check']});const id=(await h.state()).id;
  const evidence=[{criterion:1,evidence:'verified'}];
  h.bus.emit('team:job-start',{id:'a',member:'alice',goalId:id});
  assert.equal((await h.tool('goal_finish',{goalId:id,evidence})).isError,true);
  h.bus.emit('team:job-end',{id:'a',member:'alice',goalId:id,ok:true,reply:'done'});
  let release;h.ctx.executeTool=()=>new Promise(resolve=>{release=resolve;});
  const pending=h.tool('goal_finish',{goalId:id,evidence});
  await h.tool('goal_pause',{reason:'pause while verifying'});
  release({isError:false,result:{content:[]}});
  assert.equal((await pending).isError,true);assert.equal((await h.state()).status,'paused');
}));

test('abort and provider failure pause instead of restarting the lead',async()=>{
  for(const outcome of ['aborted','error'])await withHarness(async h=>{
    await h.start();assert.equal(await h.boundary({outcome}),undefined);
    if(outcome==='error') {
      assert.equal((await h.state()).status,'running','before_settle must allow the retry extension to continue');
      await h.emit('agent_settled',{aborted:false});
      assert.equal((await h.state()).pauseCause,'provider-error');
    }
    assert.equal((await h.state()).status,'paused');assert.equal(h.sent.length,0);
  });
});

test('automatic continuation budget is enforced',async()=>withHarness(async h=>{
  await h.start({maxContinuations:2});
  assert.equal((await h.boundary()).continue,true);
  assert.equal((await h.boundary()).continue,true);
  assert.equal(await h.boundary(),undefined);
  assert.equal((await h.state()).status,'paused');
  assert.match((await h.state()).reason,/budget/);
}));

test('token budget stops a continuing tool loop at turn_end',async()=>withHarness(async h=>{
  await h.start({maxOutputTokens:100});
  await h.emit('message_end',{message:{role:'assistant',usage:{output:110}}});
  await h.emit('turn_end');
  assert.equal((await h.state()).status,'paused');assert.equal(h.aborted(),true);
}));

test('restore is branch scoped and pauses interrupted jobs',async()=>{
  let saved;
  await withHarness(async h=>{await h.start();const id=(await h.state()).id;h.bus.emit('team:job-start',{id:'a',member:'alice',goalId:id});saved=structuredClone(h.entries);});
  await withHarness(async h=>{const s=await h.state();assert.equal(s.status,'paused');assert.deepEqual(s.pending,[]);assert.equal(h.sent.length,0);},saved);
  await withHarness(async h=>{assert.equal(await h.state(),null);},[]);
});

test('goal_wait refuses an empty wait; completion-before-settle is continued',async()=>withHarness(async h=>{
  await h.start();assert.equal((await h.tool('goal_wait')).isError,true);
  const id=(await h.state()).id;h.bus.emit('team:job-start',{id:'a',member:'alice',goalId:id});await h.tool('goal_wait');
  h.bus.emit('team:job-end',{id:'a',member:'alice',goalId:id,ok:true,reply:'fast result'});
  const r=await h.boundary();assert.equal(r.continue,true);assert.match(r.entries.at(-1).content,/fast result/);
  await delay(60);assert.equal(h.sent.length,0);
}));

test('tree navigation invalidates scheduled wakes and restores the branch',async()=>withHarness(async h=>{
  await h.start();const id=(await h.state()).id;h.bus.emit('team:job-start',{id:'a',member:'alice',goalId:id});
  h.bus.emit('team:job-end',{id:'a',member:'alice',goalId:id,ok:true,reply:'old branch'});
  h.entries.length=0;await h.emit('session_tree');await delay(60);
  assert.equal(await h.state(),null);assert.equal(h.sent.length,0);
}));

function peer(prompt) {const listeners=new Set();return {listeners,onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn);},prompt,emit(event){for(const fn of [...listeners])fn(event);}};}

test('model can update an active goal and stop it by id', async()=>withHarness(async h=>{
  await h.start({criteria:['old criterion']}); const id=(await h.state()).id;
  const updated=await h.tool('goal_update',{goalId:id,objective:'New objective',criteria:['new criterion'],maxContinuations:3});
  assert.equal(updated.isError,undefined); const next=await h.state(); assert.equal(next.id,id); assert.equal(next.objective,'New objective'); assert.deepEqual(next.criteria,['new criterion']); assert.equal(next.maxContinuations,3);
  let cancelled; h.bus.on('team:cancel-goal',data=>{cancelled=data.goalId;});
  const stopped=await h.tool('goal_stop',{goalId:id,reason:'test cleanup'}); assert.equal(stopped.isError,undefined); assert.equal(cancelled,id); assert.equal((await h.state()).status,'stopped');
  assert.equal((await h.tool('goal_update',{goalId:id,objective:'should fail'})).isError,true);
}));


test('RPC timeout before prompt acceptance is caught without leaking listeners or rejection',async()=>{
  const p=peer(()=>delay(50).then(()=> 'started'));
  await assert.rejects(promptAndWaitSafely(p,'test',undefined,5),/timed out/);
  assert.equal(p.listeners.size,0);await delay(60);
});

test('RPC rejected prompt cleans up its collector immediately',async()=>{
  const p=peer(()=>Promise.reject(new Error('prompt failed')));
  await assert.rejects(promptAndWaitSafely(p,'test',undefined,10),/prompt failed/);
  assert.equal(p.listeners.size,0);await delay(20);
});

test('RPC handled commands finish without waiting for nonexistent agent_settled',async()=>{
  const p=peer(async()=> 'handled');assert.deepEqual(await promptAndWaitSafely(p,'test',undefined,50),[]);assert.equal(p.listeners.size,0);
});

test('RPC collector subscribes before a fast completion and can be reused',async()=>{
  const p=peer(async()=>{p.emit({type:'agent_start'});p.emit({type:'agent_settled'});return 'started';});
  for(let i=0;i<2;i++){assert.equal((await promptAndWaitSafely(p,'test',undefined,50)).length,2);assert.equal(p.listeners.size,0);}
});

test('RPC abort clears a pending collector immediately',async()=>{
  const p=peer(async()=> 'started');const controller=new AbortController();
  const waiting=promptAndWaitSafely(p,'test',undefined,5000,controller.signal);controller.abort();
  await assert.rejects(waiting,/cancelled/);assert.equal(p.listeners.size,0);
});

test('RPC ignores a stale settlement until the new run has started',async()=>{
  const p=peer(async()=>{p.emit({type:'agent_settled'});await delay(10);p.emit({type:'agent_start'});p.emit({type:'agent_settled'});return 'started';});
  const events=await promptAndWaitSafely(p,'test',undefined,100);assert.equal(events.length,2);
});

test('last allowed continuation may still finish the goal',async()=>withHarness(async h=>{
  await h.start({maxContinuations:1});const id=(await h.state()).id;await h.boundary();
  assert.equal((await h.state()).status,'running');
  const result=await h.tool('goal_finish',{goalId:id,evidence:[{criterion:1,evidence:'verified'}]});
  assert.equal(result.isError,undefined);assert.equal((await h.state()).status,'completed');
}));

test('configured verification requires a callable bash tool',async()=>withHarness(async h=>{
  await h.start({verificationCommands:['test-check']});const id=(await h.state()).id;h.ctx.tools=[];
  const result=await h.tool('goal_finish',{goalId:id,evidence:[{criterion:1,evidence:'verified'}]});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/bash tool/);assert.equal((await h.state()).status,'running');
}));
