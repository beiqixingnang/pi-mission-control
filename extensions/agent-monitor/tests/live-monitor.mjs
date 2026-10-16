import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const here=path.dirname(fileURLToPath(import.meta.url));
import {hostDir} from '../../../scripts/host.mjs';
const packageDir=hostDir;
const {loadExtensions,createExtensionRuntime}=await import(pathToFileURL(path.join(packageDir,'dist/core/extensions/loader.js')));
const {createEventBus}=await import(pathToFileURL(path.join(packageDir,'dist/core/event-bus.js')));
const root=path.resolve(here,'../..');
const output=process.env.PI_MONITOR_TEST_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'pi-agent-monitor-'));
const liveMemberModel=process.env.PI_LIVE_MEMBER_MODEL;
if(!liveMemberModel)throw new Error('Set PI_LIVE_MEMBER_MODEL=provider/model-id before running the live monitor test.');
fs.mkdirSync(output,{recursive:true});
const bus=createEventBus(),runtime=createExtensionRuntime(),updates=[],frames=[];
let component,modelMessages=0,timer,pending;
const controller=new AbortController();
runtime.sendMessage=()=>{modelMessages++;};runtime.sendUserMessage=()=>{modelMessages++;};runtime.appendEntry=()=>{};
function capture(){const lines=component?.render(100)||[];const content=lines.join('\n');if(content&&frames.at(-1)?.content!==content){frames.push({at:new Date().toISOString(),content});if(frames.length>200)frames.shift();}}
const ui={theme:{fg:(_color,text)=>text},notify(){},setWidget(_key,factory){component?.dispose?.();component=typeof factory==='function'?factory({requestRender:capture},this.theme):undefined;capture();}};
const ctx={mode:'tui',hasUI:true,cwd:output,model:{provider:'configured',id:'live-test'},thinkingLevel:'high',isIdle:()=>true,isProjectTrusted:()=>true,ui};
bus.on('agent-monitor:update',update=>{updates.push({...update});console.log(JSON.stringify({kind:update.kind,name:update.name,status:update.status,activity:update.activity,visibleChars:update.output?.length||0}));});
const loaded=await loadExtensions([path.join(root,'agent-monitor/index.ts'),path.join(root,'team/index.ts'),path.join(root,'subagent/index.ts')],output,bus,runtime);
assert.deepEqual(loaded.errors,[]);
const emit=async name=>{for(const extension of loaded.extensions)for(const handler of extension.handlers.get(name)||[])await handler({type:name},ctx);};
const tool=(name,args)=>{const extension=loaded.extensions.find(extension=>extension.tools.has(name));return extension.tools.get(name).definition.execute('monitor-probe',args,controller.signal,undefined,ctx);};
const originalScript=process.argv[1];
try{
  await emit('session_start');
  // Match the real CLI host: the legacy subagent launcher intentionally reuses argv[1].
  process.argv[1]=path.join(packageDir,'dist/bundle/cli.js');
  const spawn=await tool('team_spawn',{name:'preview-member',role:'Visual activity probe',model:liveMemberModel,tools:['read'],systemPrompt:'Only answer the exact simple smoke test. Do not call tools or delegate work.'});
  assert.ok(!spawn.isError);
  pending=Promise.all([
    tool('team_send',{to:'preview-member',message:'Reply exactly MONITOR_TEAM_OK. Do not use tools.',wait:true,timeoutMs:90000}),
    tool('subagent',{agent:'worker',agentScope:'user',confirmProjectAgents:false,task:'Do not use tools or modify files. Reply exactly MONITOR_SUBAGENT_OK.'}),
  ]);
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Live monitor test exceeded 120 seconds')),120000);});
  const [team,subagent]=await Promise.race([pending,timeout]);
  assert.ok(!team.isError);assert.ok(!subagent.isError);
  assert.ok(updates.some(update=>update.kind==='team'&&update.status==='working'));
  assert.ok(updates.some(update=>update.kind==='team'&&update.output?.includes('MONITOR_TEAM_OK')));
  assert.ok(updates.some(update=>update.kind==='subagent'&&update.status==='working'));
  assert.ok(updates.some(update=>update.kind==='subagent'&&update.status==='done'&&update.alive===false&&update.output?.includes('MONITOR_SUBAGENT_OK')));
  await delay(160);capture();
  assert.ok(frames.length>2);assert.ok(frames.some(frame=>frame.content.includes('preview-member')&&frame.content.includes('worker')));
  assert.equal(modelMessages,0,'Monitor must not send model messages');
  fs.writeFileSync(path.join(output,'frames.txt'),frames.map(frame=>`[${frame.at}]\n${frame.content}`).join('\n\n'));
  const report={passed:true,models:[liveMemberModel],updates:updates.length,frames:frames.length,maxRows:Math.max(...frames.map(frame=>frame.content.split('\n').length)),monitorModelMessages:modelMessages,teamResult:team.content,subagentResult:subagent.content,lastFrame:frames.at(-1),output};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:false,error:String(error.stack||error),updates:updates.length,frames:frames.length},null,2));console.error(error);process.exitCode=1;}
finally{if(timer)clearTimeout(timer);controller.abort();await emit('session_shutdown');if(pending)await Promise.allSettled([pending]);process.argv[1]=originalScript;}
