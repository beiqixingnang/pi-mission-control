import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostDir} from '../../../scripts/host.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const {promptAndWaitSafely}=await import(pathToFileURL(path.join(root,'extensions/team/rpc.ts')));
const {SessionManager,SettingsManager,createAgentSessionRuntime,createAgentSessionServices,createAgentSessionFromServices,RpcClient}=await import(pathToFileURL(path.join(hostDir,'dist/index.js')));
const model={id:'model',name:'fixture',provider:'workbench-fixture',api:'workbench-fixture',baseUrl:'http://127.0.0.1/unused',reasoning:false,input:['text'],contextWindow:64000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
async function harness(fn,{team=false}={}){
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'pi-project-runtime-'))),source=path.join(base,'1'),target=path.join(base,'2'),agent=path.join(base,'agent');
 fs.mkdirSync(source);fs.mkdirSync(agent);const cwd=process.cwd(),priorAgent=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agent;
 let runtime;let disposed=false;const errors=[],notices=[];const peers=[];const originalStart=RpcClient.prototype.start;
 const settings=()=>SettingsManager.inMemory({retry:{enabled:false},cacheWarming:'off'});
 const paths=['extensions/project/index.ts','extensions/goal/index.ts','extensions/supervisor/index.ts','scripts/fixtures/offline-provider.ts'];if(team)paths.push('extensions/team/index.ts');
 RpcClient.prototype.start=async function(){this.options.cliPath=path.join(hostDir,'dist/bundle/cli.js');this.options.args.push('--extension',path.join(root,'scripts/fixtures/offline-provider.ts'));peers.push(this);return originalStart.call(this);};
 const factory=async({cwd,sessionManager,sessionStartEvent})=>{
  const services=await createAgentSessionServices({cwd,agentDir:agent,settingsManager:settings(),resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noContextFiles:true,noThemes:true,additionalExtensionPaths:paths.map(p=>path.join(root,p))}});
  return {...await createAgentSessionFromServices({services,sessionManager,sessionStartEvent,model}),services,diagnostics:services.diagnostics};
 };
 let resolveSwitched;const switched=new Promise(resolve=>{resolveSwitched=resolve;});
 const bind=async session=>session.bindExtensions({mode:'print',uiContext:{notify:(...args)=>notices.push(args)},onError:e=>errors.push(e),commandContextActions:{
  waitForIdle:()=>runtime.session.waitForIdle(),newSession:o=>runtime.newSession(o),fork:(id,o)=>runtime.fork(id,o),navigateTree:(id,o)=>runtime.session.navigateTree(id,o),reload:async()=>{},
  switchSession:async(file,options)=>{const value=await runtime.switchSession(file,options);resolveSwitched(value);return value;},
 }});
 try{
  const manager=SessionManager.create(source);manager.appendMessage({role:'user',content:'Original conversation fixture',timestamp:Date.now()});
  runtime=await createAgentSessionRuntime(factory,{cwd:source,agentDir:agent,sessionManager:manager});runtime.setRebindSession(bind);await bind(runtime.session);
  const tool=(name,args={})=>runtime.session.agent.state.tools.find(t=>t.name===name).execute('test',args,undefined,undefined);
  const command=text=>runtime.session.prompt(text);
  await fn({runtime,source,target,agent,base,tool,command,errors,notices,switched,peers,dispose:async()=>{await runtime.dispose();disposed=true;}});assert.deepEqual(errors,[]);
 }finally{
  if(!disposed)await runtime?.dispose();await Promise.allSettled(peers.map(p=>p.stop()));RpcClient.prototype.start=originalStart;process.chdir(cwd);if(priorAgent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=priorAgent;fs.rmSync(base,{recursive:true,force:true});
 }
}
function untilSwitched(promise,details){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Migration did not finish after settlement '+JSON.stringify(details))),10000);promise.then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});});}

test('manual rename continues inside the same Pi host and a fresh session lookup finds the history',()=>harness(async h=>{
 await h.command('PROBE:{"op":"remember","token":"BEFORE_RENAME_MEMORY"}');
 await h.tool('goal_start',{objective:'Keep the goal',criteria:['c']});await h.command('/supervisor on 60');
 const old=h.runtime.session;process.chdir(h.source);
 await h.command('/project rename 2');
 assert.notEqual(h.runtime.session,old,JSON.stringify(h.notices));assert.equal(h.runtime.cwd,h.target);assert.equal(process.cwd(),h.target);
 await h.command('PROBE:{"op":"recall"}');assert.match(h.runtime.session.getLastAssistantText(),/BEFORE_RENAME_MEMORY/);
 const manager=SessionManager.continueRecent(h.target);assert.equal(manager.getSessionId(),h.runtime.session.sessionId);
 const listed=await SessionManager.list(h.target);assert.ok(listed.some(s=>s.id===manager.getSessionId()));
 assert.equal(manager.getBranch().filter(e=>e.customType==='goal-state').at(-1).data.status,'paused');
 assert.equal((await h.tool('supervisor_control',{action:'status'})).details.enabled,false);
 const id=h.runtime.session.sessionId;await h.dispose();
 // Start a completely fresh Pi process from the new directory, as after closing the terminal.
 const client=new RpcClient({cliPath:path.join(hostDir,'dist/bundle/cli.js'),cwd:h.target,args:['--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--no-mcp','--session-id',id,'--model','workbench-fixture/model']});
 try{await client.start();await promptAndWaitSafely(client,'PROBE:{"op":"recall"}',undefined,10000);const messages=await client.getMessages();assert.match(JSON.stringify(messages),/BEFORE_RENAME_MEMORY/);assert.equal((await client.getState()).sessionId,id);}finally{await client.stop();}
}));

test('manual rename stops an active provider before replacing its workspace',{timeout:15000},()=>harness(async h=>{
 let ready;const started=new Promise(resolve=>{ready=resolve;});const old=h.runtime.session;
 const off=old.subscribe(event=>{if(event.type==='message_start'&&event.message?.role==='assistant')ready();});
 const running=old.prompt('PROBE:{"op":"hang"}');await started;
 await h.command('/project rename 2');await running;off();
 assert.equal(h.runtime.cwd,h.target,JSON.stringify(h.notices));assert.notEqual(h.runtime.session,old);
 await h.command('PROBE:{"op":"remember","token":"AFTER_ACTIVE_RENAME"}');assert.match(h.runtime.session.getLastAssistantText(),/AFTER_ACTIVE_RENAME/);
}));

test('AI cannot change a workspace without a grant; one authorized change executes only after tool settlement',()=>harness(async h=>{
 const denied=await h.tool('project_apply',{authorizationId:'forged'});assert.equal(denied.isError,true);assert.ok(fs.existsSync(h.source));
 await h.command('/project allow rename 2');const grant=(await h.tool('project_status')).details.authorization;
 assert.equal((await h.tool('project_apply',{authorizationId:'wrong'})).isError,true);
 const old=h.runtime.session;
 await h.command('PROBE:'+JSON.stringify({tool:'project_apply',args:{authorizationId:grant.id}}));
 await untilSwitched(h.switched,h.notices);
 assert.notEqual(h.runtime.session,old,JSON.stringify(h.notices));assert.equal(h.runtime.cwd,h.target);assert.equal((await h.tool('project_status')).details.authorization,null);
 assert.equal((await h.tool('project_apply',{authorizationId:grant.id})).isError,true);
}));

test('revocation disables AI execution; manual switching preserves context without moving source files',()=>harness(async h=>{
 fs.mkdirSync(h.target);await h.command('/project allow switch "'+h.target+'"');const grant=(await h.tool('project_status')).details.authorization;
 await h.command('/project revoke');assert.equal((await h.tool('project_apply',{authorizationId:grant.id})).isError,true);
 await h.command('PROBE:{"op":"remember","token":"SWITCH_MEMORY"}');
 await h.command('/project switch "'+h.target+'"');assert.equal(h.runtime.cwd,h.target,JSON.stringify(h.notices));assert.ok(fs.existsSync(h.source));
 await h.command('PROBE:{"op":"recall"}');assert.match(h.runtime.session.getLastAssistantText(),/SWITCH_MEMORY/);
}));

test('rename closes real children, migrates their saved conversation and restores the team in the new directory',{timeout:45000},()=>harness(async h=>{
 const spawned=await h.tool('team_spawn',{name:'worker',role:'Read-only worker',workspace:{root:h.source,access:'read-only'},communication:{allow:[]}});assert.ok(!spawned.isError,JSON.stringify(spawned));
 await h.tool('team_send',{to:'worker',message:'PROBE:{"op":"remember","token":"REAL_CHILD_MEMORY"}',wait:true});
 const oldPid=h.peers[0].process.pid;
 await h.command('/project rename 2');assert.equal(h.runtime.cwd,h.target,JSON.stringify(h.notices));
 const list=await h.tool('team_list');assert.equal(list.details.count,1,JSON.stringify(list));assert.equal(list.details.members[0].cwd,h.target);assert.notEqual(h.peers.at(-1).process.pid,oldPid);
 const recall=await h.tool('team_send',{to:'worker',message:'PROBE:{"op":"recall"}',wait:true});assert.ok(!recall.isError,JSON.stringify(recall));assert.match(JSON.stringify(recall.content),/REAL_CHILD_MEMORY/);
},{team:true}));

test('a member explicitly confirmed to have no messages can migrate before its first task',{timeout:30000},()=>harness(async h=>{
 const spawned=await h.tool('team_spawn',{name:'empty',role:'New member',communication:{allow:[]}});assert.ok(!spawned.isError,JSON.stringify(spawned));
 await h.command('/project rename 2');assert.equal(h.runtime.cwd,h.target,JSON.stringify(h.notices));
 const list=await h.tool('team_list');assert.equal(list.details.count,1,JSON.stringify(list));assert.equal(list.details.members[0].cwd,h.target);
},{team:true}));

test('expired authorization and session replacement cannot be reused',()=>harness(async h=>{
 await h.command('/project allow rename 2');const grant=(await h.tool('project_status')).details.authorization;
 const now=Date.now;try{Date.now=()=>grant.expiresAt+1;assert.equal((await h.tool('project_apply',{authorizationId:grant.id})).isError,true);}finally{Date.now=now;}
 await h.command('/project allow rename 2');const second=(await h.tool('project_status')).details.authorization;
 await h.runtime.newSession();assert.equal((await h.tool('project_apply',{authorizationId:second.id})).isError,true);assert.ok(fs.existsSync(h.source));
}));

test('a cancelled host switch restores the original directory and leaves the source session usable',()=>harness(async h=>{
 h.runtime.session.resourceLoader.getExtensions().extensions[0].handlers.set('session_before_switch',[async()=>({cancel:true})]);
 const old=h.runtime.session;await h.command('/project rename 2');assert.equal(h.runtime.session,old);assert.equal(h.runtime.cwd,h.source);
 assert.ok(fs.existsSync(h.source));assert.equal(fs.existsSync(h.target),false);
 await h.command('PROBE:{"op":"remember","token":"AFTER_ROLLBACK"}');assert.match(h.runtime.session.getLastAssistantText(),/AFTER_ROLLBACK/);
}));
