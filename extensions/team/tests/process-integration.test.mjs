import test from 'node:test';
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostDir} from '../../../scripts/host.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const packageRoot=path.resolve(here,'../../..');
const {loadExtensions,createExtensionRuntime}=await import(pathToFileURL(path.join(hostDir,'dist/core/extensions/loader.js')));
const {createEventBus}=await import(pathToFileURL(path.join(hostDir,'dist/core/event-bus.js')));
const {RpcClient,SessionManager}=await import(pathToFileURL(path.join(hostDir,'dist/index.js')));
test('a completely new parent process restores its saved roster and member conversation',{timeout:45000},async()=>{
 let base=await fs.mkdtemp(path.join(os.tmpdir(),'pi-parent-restart-'));
 if(process.platform==='win32')base=realpathSync.native(base);
 try{
  const run=promisify(execFile);const driver=path.join(packageRoot,'scripts/fixtures/team-restart-driver.mjs');
  for(const phase of ['create','restore'])await run(process.execPath,['--unhandled-rejections=strict',driver,phase,base],{timeout:20000,env:{...process.env,PI_TEST_PACKAGE_DIR:hostDir}});
  const first=JSON.parse(await fs.readFile(path.join(base,'create.json'),'utf8'));
  const second=JSON.parse(await fs.readFile(path.join(base,'restore.json'),'utf8'));
  assert.equal(first.passed,true);assert.equal(second.passed,true);assert.notEqual(first.parentPid,second.parentPid);
  assert.equal(first.sessionId,second.sessionId);assert.notEqual(first.childPids[0],second.childPids[0]);
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

const originalStart=RpcClient.prototype.start;

async function harness(manager,peers,withGoal=false){
 const bus=createEventBus(), runtime=createExtensionRuntime();
 runtime.appendEntry=(type,data)=>manager.appendCustomEntry(type,structuredClone(data));
 runtime.sendMessage=()=>{};
 const loaded=await loadExtensions([path.join(packageRoot,'extensions/team/index.ts'),...(withGoal?[path.join(packageRoot,'extensions/goal/index.ts')]:[])],manager.getCwd(),bus,runtime);assert.deepEqual(loaded.errors,[]);
 const extension=loaded.extensions[0];const ctx={mode:'rpc',cwd:manager.getCwd(),sessionManager:manager,thinkingLevel:'off',model:{provider:'workbench-fixture',id:'model'},ui:{notify(){}},isIdle:()=>true};
 const emit=async(type)=>{for(const ext of loaded.extensions)for(const handler of ext.handlers.get(type)||[])await handler({type},ctx);};
 const tool=(name,args)=>loaded.extensions.find(e=>e.tools.has(name)).tools.get(name).definition.execute('integration',args,undefined,undefined,ctx);
 await emit('session_start');
 return {bus,tool,close:()=>emit('session_shutdown'),manager};
}
function unpack(result){assert.ok(!result.isError,JSON.stringify(result));const text=result.content[0].text;return JSON.parse(text.slice(text.indexOf('\n\n')+2));}
async function send(h,to,command){return unpack(await h.tool('team_send',{to,message:'PROBE:'+JSON.stringify(command),timeoutMs:15000}));}

test('real restricted children expose the message tool, enforce ACL both ways, and restore legacy child history after restart',{timeout:60000},async()=>{
 let base=await fs.mkdtemp(path.join(os.tmpdir(),'pi-team-process-integration-'));if(process.platform==='win32')base=realpathSync.native(base);const peers=[];let h;
 RpcClient.prototype.start=async function(){
  this.options.cliPath=path.join(hostDir,'dist/bundle/cli.js');
  this.options.args.push('--extension',path.join(packageRoot,'scripts/fixtures/offline-provider.ts'));
  peers.push(this);return originalStart.call(this);
 };
 try{
  const cwd=path.join(base,'work');await fs.mkdir(cwd);const sessions=path.join(base,'parent-sessions');
  let manager=SessionManager.create(cwd,sessions);
  manager.appendMessage({role:'user',content:'Isolated integration fixture',timestamp:Date.now()});
  const legacyId=`team-${randomUUID()}-cpu-supervisor`;
  const legacy={name:'cpu-supervisor',role:'CPU supervisor',cwd,persistent:true,sessionId:legacyId,model:'workbench-fixture/model',workspace:{root:cwd,access:'read-only',extraReadRoots:[],execution:'disabled'},communication:{allow:['cpu-builder']},createdAt:Date.now()};
  manager.appendCustomEntry('team-roster',{version:1,members:[legacy],pendingJobs:[],completedJobs:[]});
  h=await harness(manager,peers);
  const builder=await h.tool('team_spawn',{name:'cpu-builder',role:'CPU builder',workspace:{root:cwd,access:'read-write'},communication:{allow:[]}});assert.ok(!builder.isError,JSON.stringify(builder));
  const gpu=await h.tool('team_spawn',{name:'gpu-builder',role:'GPU builder',workspace:{root:cwd,access:'read-write'},communication:{allow:[]}});assert.ok(!gpu.isError);
  const snapshot=manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='team-roster').at(-1).data;
  assert.equal(snapshot.members.find(m=>m.name==='cpu-supervisor').sessionId,legacyId);
  assert.match(snapshot.members.find(m=>m.name==='cpu-builder').sessionId,/^[a-f0-9-]{36}$/);
  await send(h,'cpu-supervisor',{op:'remember',token:'RESTART_MEMORY_7482'});
  for(const [from,to] of [['cpu-supervisor','cpu-builder'],['cpu-builder','cpu-supervisor']]){
   const response=await send(h,from,{tool:'workspace_team_message',args:{to,message:'PROBE:'+JSON.stringify({op:'remember',token:`MESSAGE_${from}`}),wait:true,timeoutMs:10000}});
   assert.equal(response.isError,false,JSON.stringify(response));assert.match(response.content[0].text,/remembered/);
  }
  const denied=await send(h,'cpu-supervisor',{tool:'workspace_team_message',args:{to:'gpu-builder',message:'PROBE:{"op":"remember","token":"forbidden"}',wait:true,timeoutMs:10000}});
  assert.equal(denied.isError,true);assert.match(denied.content[0].text,/ACL denied/);
  const memory=await send(h,'gpu-builder',{op:'recall'});assert.ok(!JSON.stringify(memory).includes('forbidden'));
  const ready=new Promise(resolve=>peers[1].onEvent(event=>{if(event.type==='agent_start')resolve();}));
  const hanging=h.tool('team_send',{to:'cpu-builder',message:'PROBE:{"op":"hang"}',wait:true,timeoutMs:15000});await ready;
  const stopping={reason:'integration stop',pending:[]};h.bus.emit('workbench:stop',stopping);await Promise.allSettled(stopping.pending);
  assert.equal((await hanging).isError,true);assert.equal((await h.tool('team_list',{})).details.count,3);
  await send(h,'cpu-builder',{op:'remember',token:'AFTER_STOP_REUSE'});
  const savedFile=manager.getSessionFile();const firstPids=peers.map(p=>p.process?.pid);
  await h.close();h=undefined;
  assert.ok(peers.every(peer=>peer.process===null),'all original children must stop before restart');
  manager=SessionManager.open(savedFile);h=await harness(manager,peers);
  const list=await h.tool('team_list',{});assert.equal(list.details.count,3,'restoration must finish before session_start returns');
  const recalled=await send(h,'cpu-supervisor',{op:'recall'});assert.match(JSON.stringify(recalled),/RESTART_MEMORY_7482/);
  const response=await send(h,'cpu-builder',{tool:'workspace_team_message',args:{to:'cpu-supervisor',message:'PROBE:{"op":"recall"}',wait:true,timeoutMs:10000}});assert.equal(response.isError,false);
  assert.ok(peers.slice(3).every(peer=>!firstPids.includes(peer.process?.pid)),'must use newly launched processes');
 }finally{
  if(h)await h.close();await Promise.allSettled(peers.map(peer=>peer.stop()));RpcClient.prototype.start=originalStart;
  await fs.rm(base,{recursive:true,force:true});
 }
});

test('real supervisor dispatches downstream work, sleeps, reviews delivery and keeps Goal pending until review',{timeout:45000},async()=>{
 const base=realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(),'pi-task-tree-process-'))),peers=[];let h;
 RpcClient.prototype.start=async function(){this.options.cliPath=path.join(hostDir,'dist/bundle/cli.js');this.options.args.push('--extension',path.join(packageRoot,'scripts/fixtures/offline-provider.ts'));peers.push(this);return originalStart.call(this);};
 try{
  const cwd=path.join(base,'work');await fs.mkdir(cwd);let manager=SessionManager.create(cwd,path.join(base,'parents'));manager.appendMessage({role:'user',content:'Task tree integration',timestamp:Date.now()});
  h=await harness(manager,peers,true);
  for(const name of ['supervisor','executor']){const r=await h.tool('team_spawn',{name,role:name,workspace:{root:cwd,access:'read-only'},communication:{allow:name==='supervisor'?['executor']:[]}});assert.ok(!r.isError,JSON.stringify(r));}
  await h.tool('goal_start',{objective:'Review a downstream receipt',criteria:['Supervisor reviews worker receipt']});
  let childStarted,rootFinished;const childReady=new Promise(resolve=>{childStarted=resolve;}),rootReady=new Promise(resolve=>{rootFinished=resolve;});
  h.bus.on('team:job-start',job=>{if(job.member==='executor')childStarted(job);});h.bus.on('team:job-end',job=>{if(job.member==='supervisor')rootFinished(job);});
  const sent=await h.tool('team_send',{to:'supervisor',message:'PROBE:'+JSON.stringify({op:'delegate',to:'executor',child:{op:'remember',token:'VERIFIED_CHILD_RECEIPT'}}),wait:false});
  const child=await childReady;assert.equal(child.parentId,sent.details.jobId);const state=await h.tool('goal_status',{});assert.ok(state.details.pending.some(job=>job.id===sent.details.jobId));
  const completed=await rootReady;assert.equal(completed.ok,true,JSON.stringify(completed));assert.match(completed.reply,/reviewed/);assert.match(completed.reply,/VERIFIED_CHILD_RECEIPT/);
  const tree=await h.tool('team_tree',{});assert.equal(tree.details.tasks.length,2);assert.ok(tree.details.tasks.every(task=>task.state==='completed'));assert.equal(new Set(tree.details.deliveries.map(d=>d.id)).size,2);
  assert.equal((await h.tool('goal_status',{})).details.pending.length,0);
  const file=manager.getSessionFile();await h.close();h=undefined;manager=SessionManager.open(file);h=await harness(manager,peers,true);
  const restored=await h.tool('team_tree',{});assert.equal(restored.details.tasks.length,2);assert.ok(restored.details.tasks.every(task=>task.state==='completed'));
  let blocked;const blockedReady=new Promise(resolve=>{blocked=resolve;});h.bus.on('team:blocked',event=>blocked(event));
  const blockedRoot=await h.tool('team_send',{to:'supervisor',message:'PROBE:'+JSON.stringify({op:'delegate',to:'executor',child:{op:'block',reason:'FIXTURE_TOOLCHAIN_BLOCKER'}}),wait:false});
  await blockedReady;assert.equal((await h.tool('goal_status',{})).details.status,'blocked');
  assert.match((await h.tool('goal_status',{})).details.reason,/FIXTURE_TOOLCHAIN_BLOCKER/);
  const cancelled=await h.tool('team_cancel',{jobId:blockedRoot.details.jobId});assert.ok(!cancelled.isError,JSON.stringify(cancelled));
  const final=await h.tool('team_tree',{taskId:blockedRoot.details.jobId});assert.ok(final.details.tasks.every(task=>task.state==='cancelled'));
 }finally{if(h)await h.close();await Promise.allSettled(peers.map(peer=>peer.stop()));RpcClient.prototype.start=originalStart;await fs.rm(base,{recursive:true,force:true});}
});
