import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {hostDir} from '../../../scripts/host.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const {loadExtensions,createExtensionRuntime}=await import(pathToFileURL(path.join(hostDir,'dist/core/extensions/loader.js')));
const {createEventBus}=await import(pathToFileURL(path.join(hostDir,'dist/core/event-bus.js')));

test('member viewer is read-only, hides thinking, and Esc returns without altering the main draft',async()=>{
 const bus=createEventBus(),runtime=createExtensionRuntime();let widget,viewer,finish,requests=0;const notices=[];const mainDraft='未发送的主对话草稿';
 runtime.sendMessage=()=>{requests++;};runtime.sendUserMessage=()=>{requests++;};
 const loaded=await loadExtensions([path.resolve(here,'../index.ts')],process.cwd(),bus,runtime);const extension=loaded.extensions[0];assert.deepEqual(loaded.errors,[]);
 const host={terminal:{columns:100,rows:32},requestRender(){}};
 const ui={theme:{fg:(_c,text)=>text,style:(text,options)=>`<${options.fg||""}|${options.bg||""}>${text}</>`},notify:text=>notices.push(text),onTerminalInput:()=>()=>{},setWidget(_key,factory){widget=factory?factory(host,this.theme):undefined;},getEditorText:()=>mainDraft,
  custom(factory){return new Promise(resolve=>{finish=resolve;viewer=factory(host,this.theme,{},resolve);});}};
 const ctx={cwd:process.cwd(),mode:'tui',ui,sessionManager:{getBranch:()=>[]}};
 const emit=async type=>{for(const handler of extension.handlers.get(type)||[])await handler({type},ctx);};
 try{
  await emit('session_start');bus.emit('agent-monitor:update',{id:'team:alice',kind:'team',name:'alice',status:'working',output:'live preview',lastMessageAt:Date.now()});
  bus.on('agent-monitor:history',request=>{request.promise=Promise.resolve([{role:'user',content:'TASK_VISIBLE',timestamp:Date.now()},{role:'assistant',content:[{type:'thinking',thinking:'DO_NOT_RENDER'},{type:'text',text:'REPLY_VISIBLE'}],timestamp:Date.now()}]);});
  const opened=extension.commands.get('agents').handler('view alice',ctx);await delay(0);
  assert.match(viewer.render(80).join('\n'),/TASK_VISIBLE/);assert.match(viewer.render(80).join('\n'),/REPLY_VISIBLE/);assert.doesNotMatch(viewer.render(80).join('\n'),/DO_NOT_RENDER/);
  bus.emit('agent-monitor:conversation',{id:'team:alice',messages:[{role:'toolResult',toolName:'read',content:[{type:'text',text:'NEW_TOOL_OUTPUT'}]}]});
  assert.match(viewer.render(80).join('\n'),/NEW_TOOL_OUTPUT/);
  viewer.handleInput('\x1b');await opened;assert.equal(ui.getEditorText(),mainDraft);assert.equal(requests,0);
 }finally{finish?.();await emit('session_shutdown');}
});

test('message timestamp is independent of activity/spinner redraws',async()=>{
 const bus=createEventBus(),runtime=createExtensionRuntime();let widget;
 const loaded=await loadExtensions([path.resolve(here,'../index.ts')],process.cwd(),bus,runtime);const extension=loaded.extensions[0];
 const ctx={mode:'tui',sessionManager:{getBranch:()=>[]},ui:{theme:{fg:(_c,text)=>text,style:(text,options)=>`<${options.fg||""}|${options.bg||""}>${text}</>`},onTerminalInput:()=>()=>{},notify(){},setWidget(_key,factory){widget=factory?factory({requestRender(){}},this.theme):undefined;}}};
 const emit=async type=>{for(const handler of extension.handlers.get(type)||[])await handler({type},ctx);};
 try{
  await emit('session_start');const at=new Date().setHours(12,34,56,0);
  bus.emit('agent-monitor:update',{id:'x',kind:'team',name:'alice',status:'working',lastMessageAt:at});
  bus.emit('agent-monitor:update',{id:'x',kind:'team',name:'alice',status:'working',activity:'工具 read',updatedAt:Date.now()});
  const time=widget.render(160).join('\n');assert.match(time,/12:34:56/);assert.match(time,/工具 read/);
 }finally{await emit('session_shutdown');}
});
