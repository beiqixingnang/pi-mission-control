import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostDir} from '../../../scripts/host.mjs';
const image=process.env.PI_SANDBOX_TEST_IMAGE;
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const {SessionManager,RpcClient}=await import(pathToFileURL(path.join(hostDir,'dist/index.js')));
const {loadExtensions,createExtensionRuntime}=await import(pathToFileURL(path.join(hostDir,'dist/core/extensions/loader.js')));
const {createEventBus}=await import(pathToFileURL(path.join(hostDir,'dist/core/event-bus.js')));

test('a restricted executor runs Python and its supervisor reads the receipt without lead forwarding',{skip:!image,timeout:60000},async()=>{
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'pi-sandbox-team-'))),cwd=path.join(base,'workspace');fs.mkdirSync(cwd);
 const originalStart=RpcClient.prototype.start,originalEvent=RpcClient.prototype.onEvent,peers=[],tools=[];
 RpcClient.prototype.start=async function(){this.options.cliPath=path.join(hostDir,'dist/bundle/cli.js');this.options.args.push('--extension',path.join(root,'scripts/fixtures/offline-provider.ts'));peers.push(this);return originalStart.call(this);};
 RpcClient.prototype.onEvent=function(listener){return originalEvent.call(this,event=>{if(event.type==='tool_execution_end')tools.push({member:this.options.env.PI_TEAM_MEMBER,tool:event.toolName,isError:event.isError});listener(event);});};
 const manager=SessionManager.create(cwd,path.join(base,'parents'));manager.appendMessage({role:'user',content:'Isolated sandbox teamwork regression',timestamp:Date.now()});
 const bus=createEventBus(),runtime=createExtensionRuntime();runtime.appendEntry=(type,data)=>manager.appendCustomEntry(type,structuredClone(data));runtime.sendMessage=()=>{};
 const loaded=await loadExtensions([path.join(root,'extensions/team/index.ts'),path.join(root,'extensions/goal/index.ts')],cwd,bus,runtime);assert.deepEqual(loaded.errors,[]);
 const ctx={cwd,mode:'rpc',model:{provider:'workbench-fixture',id:'model'},thinkingLevel:'off',sessionManager:manager,isIdle:()=>true,ui:{notify(){}}};
 const emit=async type=>{for(const extension of loaded.extensions)for(const handler of extension.handlers.get(type)||[])await handler({type},ctx);};
 const call=(name,args={})=>loaded.extensions.find(e=>e.tools.has(name)).tools.get(name).definition.execute('test',args,undefined,undefined,ctx);
 let timer;
 try{
  await emit('session_start');
  for(const name of ['supervisor','executor']){const spawned=await call('team_spawn',{name,role:name,workspace:{root:cwd,access:name==='supervisor'?'read-only':'read-write'},communication:{allow:name==='supervisor'?['executor']:[]}});assert.ok(!spawned.isError,JSON.stringify(spawned));}
  const before=(await call('team_list')).details.members.find(m=>m.name==='executor').sessionId;
  const configured=await call('team_configure',{name:'executor',execution:'sandbox',sandbox:{engine:'podman',image,maxSeconds:30,memoryMb:512}});assert.ok(!configured.isError,JSON.stringify(configured));
  assert.equal((await call('team_list')).details.members.find(m=>m.name==='executor').sessionId,before);
  await call('goal_start',{objective:'Executor runs, supervisor reads receipt',criteria:['Receipt verified']});
  let finish;const done=new Promise((resolve,reject)=>{finish=resolve;timer=setTimeout(()=>reject(new Error('Supervisor never reviewed sandbox receipt')),45000);});
  bus.on('team:job-end',event=>{if(event.member==='supervisor')finish(event);});
  await call('team_send',{to:'supervisor',message:'PROBE:'+JSON.stringify({op:'delegate',to:'executor',reviewReceipt:true,child:{tool:'workspace_exec',args:{command:'python3 -c \'open("verified.txt","w").write("SANDBOX_TEAM_OK")\'',timeoutSeconds:15}}}),wait:false,timeoutMs:45000});
  assert.equal((await call('goal_wait')).terminate,true);
  const result=await done;assert.equal(result.ok,true,JSON.stringify(result));assert.match(result.reply,/reviewed/);
  const tree=await call('team_tree');const execution=tree.details.tasks.find(t=>t.member==='executor');const receiptPath=execution.resultPaths.find(p=>p.endsWith('receipt.json'));assert.ok(receiptPath,JSON.stringify(tree));
  const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));assert.equal(receipt.ok,true,JSON.stringify(receipt));assert.equal(receipt.containerStopped,true);assert.equal(fs.readFileSync(path.join(cwd,'verified.txt'),'utf8'),'SANDBOX_TEAM_OK');
  assert.ok(tools.some(t=>t.member==='executor'&&t.tool==='workspace_exec'&&!t.isError),JSON.stringify(tools));assert.ok(tools.some(t=>t.member==='supervisor'&&t.tool==='workspace_read'&&!t.isError),JSON.stringify(tools));
  assert.equal((await call('goal_status')).details.pending.length,0);
 }finally{if(timer)clearTimeout(timer);await emit('session_shutdown');await Promise.allSettled(peers.map(p=>p.stop()));RpcClient.prototype.start=originalStart;RpcClient.prototype.onEvent=originalEvent;fs.rmSync(base,{recursive:true,force:true});}
});
