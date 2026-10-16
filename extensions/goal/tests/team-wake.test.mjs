import test from 'node:test';
import {EventEmitter} from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const here=path.dirname(fileURLToPath(import.meta.url));
import {hostDir} from '../../../scripts/host.mjs';
const packageDir=hostDir;
const moduleAt=p=>import(pathToFileURL(path.join(packageDir,p)));
const {RpcClient}=await moduleAt('dist/index.js');
const {loadExtensions,createExtensionRuntime}=await moduleAt('dist/core/extensions/loader.js');
const {createEventBus}=await moduleAt('dist/core/event-bus.js');

async function withTeam(fn){
  const peers=[];const sent=[];const notices=[];const events=[];const monitor=[];const bus=createEventBus();
  const originals=new Map();
  const methods={
    async start(){this.process=new EventEmitter();this.probe={listeners:new Set(),messages:[],active:false,stopped:false};peers.push(this);},
    async getState(){return {};},
    onEvent(fn){this.probe.listeners.add(fn);return()=>this.probe.listeners.delete(fn);},
    async prompt(message){this.probe.messages.push(message);this.probe.active=true;for(const fn of [...this.probe.listeners])fn({type:'agent_start'});return 'started';},
    async abort(){if(this.probe.active){this.probe.active=false;for(const fn of [...this.probe.listeners])fn({type:'agent_settled',aborted:true});}},
    async stop(){this.probe.stopped=true;this.probe.active=false;this.probe.listeners.clear();},
  };
  for(const [name,method] of Object.entries(methods)){originals.set(name,RpcClient.prototype[name]);RpcClient.prototype[name]=method;}
  const runtime=createExtensionRuntime();runtime.sendMessage=(message,options)=>sent.push({message,options});runtime.appendEntry=()=>{};
  const loaded=await loadExtensions([path.resolve(here,'../../team/index.ts')],process.cwd(),bus,runtime);assert.deepEqual(loaded.errors,[]);
  const extension=loaded.extensions[0];
  const ctx={cwd:process.cwd(),model:undefined,thinkingLevel:'high',ui:{notify:(...args)=>notices.push(args)},sessionManager:{getBranch:()=>[]},isIdle:()=>true};
  const tool=(name,args={},signal)=>extension.tools.get(name).definition.execute('test',args,signal,undefined,ctx);
  const emit=async name=>{for(const handler of extension.handlers.get(name)||[])await handler({type:name},ctx);};
  const spawn=async name=>{await tool('team_spawn',{name,role:'test'});assert.equal(peers.length>0,true,'RPC client patch must prevent real subprocesses');return peers.at(-1);};
  const settle=(peer,text='done',stopReason='stop')=>{peer.probe.active=false;for(const fn of [...peer.probe.listeners])fn({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason,errorMessage:stopReason==='error'?'provider failed':undefined}});for(const fn of [...peer.probe.listeners])fn({type:'agent_settled',aborted:false});};
  bus.on('team:job-end',data=>events.push(data));
  bus.on('agent-monitor:update',data=>monitor.push(data));
  try{await emit('session_start');await fn({peers,sent,notices,events,monitor,bus,ctx,tool,emit,spawn,settle,command:args=>extension.commands.get('team-wake').handler(args,ctx)});}
  finally{await emit('session_shutdown');for(const [name,method] of originals)RpcClient.prototype[name]=method;}
}

test('async batch wakes exactly once after both members finish; sync calls never wake',async()=>withTeam(async h=>{
  const a=await h.spawn('a'),b=await h.spawn('b');
  const first=await h.tool('team_send',{to:'a',message:'first',wait:false});const second=await h.tool('team_send',{to:'b',message:'second',wait:false});
  await delay(0);h.settle(a,'first result');await delay(0);assert.equal(h.sent.length,0);
  h.settle(b,'second result');await delay(0);assert.equal(h.sent.length,1);assert.equal(h.sent[0].options.triggerTurn,false);assert.equal(h.events.length,2);
  const history=await h.tool('team_collect',{jobIds:[first.details.jobId,second.details.jobId]});assert.equal(history.details.results.length,2);assert.equal(history.details.results[0].reply,'first result');
  const sync=h.tool('team_send',{to:'a',message:'sync'});await delay(0);h.settle(a,'sync result');assert.equal((await sync).isError,undefined);assert.equal(h.sent.length,1);
}));

test('off jobs do not block unrelated batch and are retained by job ID',async()=>withTeam(async h=>{
  const a=await h.spawn('a'),b=await h.spawn('b');
  await h.tool('team_send',{to:'b',message:'silent',wait:false,notify:'off'});
  await h.tool('team_send',{to:'a',message:'normal',wait:false});await delay(0);
  h.settle(a);await delay(0);assert.equal(h.sent.length,1);
  h.settle(b);await delay(0);assert.equal(h.sent.length,1);
}));

test('team-wake off retains notifications, on delivers once, history survives later jobs',async()=>withTeam(async h=>{
  const a=await h.spawn('a');await h.command('off');
  const dispatched=await h.tool('team_send',{to:'a',message:'saved',wait:false});await delay(0);h.settle(a,'held result');await delay(0);assert.equal(h.sent.length,0);
  await h.command('on');assert.equal(h.sent.length,1);await h.command('on');assert.equal(h.sent.length,1);
  await h.tool('team_send',{to:'a',message:'overwrite last reply',wait:false,notify:'off'});await delay(0);h.settle(a,'new result');await delay(0);
  const history=await h.tool('team_collect',{jobIds:[dispatched.details.jobId]});assert.equal(history.details.results[0].reply,'held result');
}));

test('global stop skips queued member work and suppresses wakes without removing roster',async()=>withTeam(async h=>{
  const a=await h.spawn('a');
  await h.tool('team_send',{to:'a',message:'running',wait:false});await h.tool('team_send',{to:'a',message:'queued',wait:false});await delay(0);
  const request={reason:'test global stop',pending:[]};h.bus.emit('workbench:stop',request);await Promise.allSettled(request.pending);await delay(0);
  assert.equal(a.probe.messages.length,1);assert.equal(h.events.length,2);assert.equal(h.sent.length,0);
  const newTask=h.tool('team_send',{to:'a',message:'after stop'});await delay(0);h.settle(a,'new task');assert.equal((await newTask).isError,undefined);
}));

test('cancel-goal aborts the active job, skips queued jobs, never wakes',async()=>withTeam(async h=>{
  const a=await h.spawn('a');h.bus.on('team:scope',scope=>{scope.goalId='goal-one';});
  await h.tool('team_send',{to:'a',message:'running',wait:false});await h.tool('team_send',{to:'a',message:'queued',wait:false});await delay(0);
  assert.equal(a.probe.messages.length,1);h.bus.emit('team:cancel-goal',{goalId:'goal-one'});await delay(10);
  assert.equal(a.probe.messages.length,1);assert.equal(h.events.length,2);assert.equal(h.sent.length,0);assert.equal(a.probe.listeners.size,1);
}));

test('resolved RPC provider errors are reported as failed jobs',async()=>withTeam(async h=>{
  const a=await h.spawn('a');await h.tool('team_send',{to:'a',message:'fail',wait:false});await delay(0);h.settle(a,'','error');await delay(0);
  assert.equal(h.events.length,1);assert.equal(h.events[0].ok,false);assert.match(h.events[0].error,/provider failed/);assert.equal(h.sent.length,1);
}));

test('async jobs ignore parent tool abort; disband cancels collector without late wake',async()=>withTeam(async h=>{
  const a=await h.spawn('a');const controller=new AbortController();
  await h.tool('team_send',{to:'a',message:'background',wait:false},controller.signal);await delay(0);controller.abort();assert.equal(a.probe.active,true);
  await h.tool('team_disband',{name:'a'});await delay(10);assert.equal(a.probe.stopped,true);assert.equal(h.sent.length,0);assert.equal(h.events.length,1);
}));

test('tree navigation clears team and board, suppressing old-job callbacks',async()=>withTeam(async h=>{
  const a=await h.spawn('a');await h.tool('team_tasks',{action:'add',title:'old branch'});await h.tool('team_send',{to:'a',message:'old',wait:false});await delay(0);
  await h.emit('session_tree');await delay(10);assert.equal(a.probe.stopped,true);assert.equal(h.sent.length,0);
  assert.equal((await h.tool('team_list')).details.count,0);assert.equal((await h.tool('team_tasks',{action:'list'})).details.count,0);
}));

test('session change closes a starting client and prevents stale roster insertion',async()=>withTeam(async h=>{
  let release,announce;const ready=new Promise(resolve=>{announce=resolve;});
  RpcClient.prototype.getState=()=>new Promise(resolve=>{release=resolve;announce();});
  const starting=h.tool('team_spawn',{name:'starting',role:'test'});await ready;
  assert.equal(h.peers.length,1);await h.emit('session_tree');release({});
  assert.equal((await starting).isError,true);assert.equal(h.peers[0].probe.stopped,true);assert.equal((await h.tool('team_list')).details.count,0);
}));

test('concurrent same-name startup cannot leak a second member',async()=>withTeam(async h=>{
  let release,announce;const ready=new Promise(resolve=>{announce=resolve;});
  RpcClient.prototype.getState=()=>new Promise(resolve=>{release=resolve;announce();});
  const first=h.tool('team_spawn',{name:'same',role:'test'});await ready;
  const second=await h.tool('team_spawn',{name:'same',role:'test'});assert.equal(second.details.error,'duplicate_name');assert.equal(h.peers.length,1);
  release({});assert.equal((await first).details.name,'same');
}));

test('unexpected child exit updates the monitor and fails a running job promptly',async()=>withTeam(async h=>{
  const member=await h.spawn('exit-probe');await h.tool('team_send',{to:'exit-probe',message:'running',wait:false,notify:'off'});await delay(0);
  member.process.emit('exit',1,null);await delay(0);
  assert.equal(h.monitor.at(-1).status,'error');assert.equal(h.monitor.at(-1).alive,false);assert.match(h.monitor.at(-1).activity,/进程退出/);
  assert.equal(h.events.length,1);assert.equal(h.events[0].ok,false);assert.equal(h.sent.length,0);
}));
