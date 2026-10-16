import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostDir} from '../../../scripts/host.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const {loadExtensions,createExtensionRuntime}=await import(pathToFileURL(path.join(hostDir,'dist/core/extensions/loader.js')));
const {createEventBus}=await import(pathToFileURL(path.join(hostDir,'dist/core/event-bus.js')));

test('global stop cancels a real ordinary subagent child and resolves the stop barrier',{timeout:8000},async()=>{
 const bus=createEventBus(),runtime=createExtensionRuntime();let pid,ready;const started=new Promise(resolve=>{ready=resolve;});const originalScript=process.argv[1];
 const loaded=await loadExtensions([path.join(root,'extensions/subagent/index.ts')],root,bus,runtime);assert.deepEqual(loaded.errors,[]);const extension=loaded.extensions[0];
 bus.on('agent-monitor:update',update=>{const match=update.output?.match(/PID:(\d+)/);if(match){pid=Number(match[1]);ready();}});
 const ctx={cwd:root,thinkingLevel:'off',model:undefined,hasUI:false,isProjectTrusted:()=>true,ui:{notify(){}}};
 const lifecycle=async type=>{for(const handler of extension.handlers.get(type)||[])await handler({type},ctx);};
 let running;
 try{
  await lifecycle('session_start');process.argv[1]=path.join(root,'scripts/fixtures/hanging-cli.mjs');
  running=extension.tools.get('subagent').definition.execute('real-one-shot',{agent:'worker',task:'A test process waits until cancellation',agentScope:'user'},undefined,undefined,ctx);
  void running.catch(()=>{});await started;assert.ok(pid>0);assert.doesNotThrow(()=>process.kill(pid,0));
  const stop={reason:'test',pending:[]};bus.emit('workbench:stop',stop);assert.equal(stop.pending.length,1);await Promise.allSettled(stop.pending);
  await assert.rejects(running,/aborted/);assert.throws(()=>process.kill(pid,0));
 }finally{await lifecycle('session_shutdown');if(running)await Promise.allSettled([running]);process.argv[1]=originalScript;}
});

test('targeted subagent_cancel stops one background child without touching another invocation',{timeout:10000},async()=>{
 const bus=createEventBus(),runtime=createExtensionRuntime();const pids=new Map();const originalScript=process.argv[1];
 const loaded=await loadExtensions([path.join(root,'extensions/subagent/index.ts')],root,bus,runtime);assert.deepEqual(loaded.errors,[]);const extension=loaded.extensions[0];
 bus.on('agent-monitor:update',update=>{const match=update.output?.match(/PID:(\d+)/);if(match)pids.set(update.name,Number(match[1]));});
 const ctx={cwd:root,thinkingLevel:'off',model:undefined,hasUI:false,isProjectTrusted:()=>true,ui:{notify(){}}};
 const lifecycle=async type=>{for(const handler of extension.handlers.get(type)||[])await handler({type},ctx);};let first,second;
 try{
  await lifecycle('session_start');process.argv[1]=path.join(root,'scripts/fixtures/hanging-cli.mjs');
  first=extension.tools.get('subagent').definition.execute('bg-one',{agent:'worker',task:'first background wait',agentScope:'user',wait:false,notify:'off'},undefined,undefined,ctx);
  second=extension.tools.get('subagent').definition.execute('bg-two',{agent:'planner',task:'second background wait',agentScope:'user',wait:false,notify:'off'},undefined,undefined,ctx);
  await new Promise(resolve=>setTimeout(resolve,500));assert.ok(pids.size>=2);
  const cancelled=await extension.tools.get('subagent_cancel').definition.execute('cancel',{invocationId:'bg-one'},undefined,undefined,ctx);assert.equal(cancelled.isError,undefined);await Promise.all([first,second]);
  assert.throws(()=>process.kill(pids.get('worker'),0));assert.doesNotThrow(()=>process.kill(pids.get('planner'),0));
  const listed=await extension.tools.get('subagent_list').definition.execute('list',{},undefined,undefined,ctx);assert.match(listed.content[0].text,/bg-two/);assert.doesNotMatch(listed.content[0].text,/bg-one/);
 }finally{await lifecycle('session_shutdown');for(const pid of pids.values()){try{process.kill(pid,'SIGKILL')}catch{}};if(first)await Promise.allSettled([first]);if(second)await Promise.allSettled([second]);process.argv[1]=originalScript;}
});
