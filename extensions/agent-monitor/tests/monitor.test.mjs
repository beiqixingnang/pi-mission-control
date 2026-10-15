import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
import {hostDir} from '../../../scripts/host.mjs';
const packageDir=hostDir;
const at=p=>import(pathToFileURL(path.join(packageDir,p)));
const {loadExtensions,createExtensionRuntime}=await at('dist/core/extensions/loader.js');
const {createEventBus}=await at('dist/core/event-bus.js');
const {visibleWidth,stripTerminalSequences}=await at('node_modules/@earendil-works/pi-tui/dist/index.js');

async function withMonitor(fn,mode='tui'){
  const bus=createEventBus(),runtime=createExtensionRuntime();let component;let sends=0;let mounts=0;let renders=0;
  runtime.sendMessage=()=>{sends++;};runtime.sendUserMessage=()=>{sends++;};
  const r=await loadExtensions([path.resolve(here,'../index.ts')],process.cwd(),bus,runtime);assert.deepEqual(r.errors,[]);const extension=r.extensions[0];
  const ctx={mode,ui:{theme:{fg:(_color,text)=>text},notify(){},setWidget(_key,factory){component?.dispose?.();component=typeof factory==='function'?factory({requestRender(){renders++;}},this.theme):undefined;if(component)mounts++;}}};
  const emit=async name=>{for(const handler of extension.handlers.get(name)||[])await handler({type:name},ctx);};
  const command=args=>extension.commands.get('agents').handler(args,ctx);
  const push=(update={})=>bus.emit('agent-monitor:update',{id:'team:alice',kind:'team',name:'alice',status:'working',alive:true,startedAt:Date.now()-3000,...update});
  const render=(width=80)=>component?.render(width)||[];
  await emit('session_start');
  try{await fn({bus,ctx,emit,command,push,render,mounts:()=>mounts,sends:()=>sends,renders:()=>renders});}
  finally{await emit('session_shutdown');}
}

test('compact widget is absent when empty and never exceeds three rows or terminal width',async()=>withMonitor(async h=>{
  assert.deepEqual(h.render(),[]);
  h.push({name:'中文成员😀',output:'正在检查源码界面输出和宽字符\x1b[31m红色\x1b[0m'});
  h.push({id:'sub:worker',kind:'subagent',name:'worker',status:'working',output:'Streaming visible text'});
  for(const width of [1,8,20,40,80,120]){
    const rows=h.render(width);assert.ok(rows.length<=3);for(const row of rows)assert.ok(visibleWidth(row)<=width,`${visibleWidth(row)} > ${width}`);
  }
  assert.match(h.render(120).join('\n'),/中文成员/);assert.match(h.render(120).join('\n'),/Streaming visible text/);
  assert.equal(h.sends(),0);
}));

test('pages rotate through all members without growing the widget',async()=>withMonitor(async h=>{
  const original=Date.now;const base=Math.floor(original()/20000)*20000;
  try{
    for(let i=0;i<5;i++)h.push({id:`team:${i}`,name:`member-${i}`});
    const shown=new Set();
    for(let i=0;i<3;i++){Date.now=()=>base+i*5000;const rows=h.render(120);assert.ok(rows.length<=3);for(const row of rows){const match=row.match(/member-(\d)/);if(match)shown.add(match[1]);}}
    assert.equal(shown.size,5);
  }finally{Date.now=original;}
}));

test('elapsed animation does not pretend fresh activity; silence is shown after 15 seconds',async()=>withMonitor(async h=>{
  h.push({activity:'思考中'});const original=Date.now;const later=original()+16000;
  try{Date.now=()=>later;const rows=h.render(120);assert.match(rows.join('\n'),/无更新 16s/);assert.ok(rows[1].startsWith('…'));}finally{Date.now=original;}
}));

test('model terminal sequences and hidden fields never reach the rendered widget',async()=>withMonitor(async h=>{
  h.push({name:'alice\x1b[2J',output:'hello\x1b]52;c;Y2xpcA==\x07\x1b[31mvisible\x1b[0m\r\nfinal\x00line',thinking:'DO_NOT_DISPLAY',thinkingSignature:'DO_NOT_DISPLAY_EITHER'});
  const rows=h.render(120).join('\n');assert.equal(rows,stripTerminalSequences(rows));assert.doesNotMatch(rows,/DO_NOT_DISPLAY|52;c|\x00/);assert.match(rows,/final line/);
}));

test('off hides the panel, on restores latest state, shutdown blocks late updates',async()=>withMonitor(async h=>{
  h.push();assert.ok(h.render().length);await h.command('off');assert.deepEqual(h.render(),[]);
  h.push({output:'latest while hidden'});assert.deepEqual(h.render(),[]);await h.command('on');assert.match(h.render(120).join('\n'),/latest while hidden/);
  await h.emit('session_shutdown');h.push({output:'stale'});assert.deepEqual(h.render(),[]);assert.equal(h.sends(),0);
}));

test('completed one-shot runs expire, idle team members remain until removed',async()=>withMonitor(async h=>{
  h.push({id:'sub:done',kind:'subagent',status:'done',alive:false,output:'finished'});
  h.push({id:'team:idle',name:'idle-team',status:'idle',alive:true});const original=Date.now;const later=original()+11000;
  try{Date.now=()=>later;await h.command('on');const rows=h.render(120).join('\n');assert.doesNotMatch(rows,/finished/);assert.match(rows,/idle-team/);}finally{Date.now=original;}
  h.bus.emit('agent-monitor:remove',{id:'team:idle'});await h.command('on');assert.deepEqual(h.render(),[]);
}));

test('stopped tasks are distinct from success and clear the old tool activity',async()=>withMonitor(async h=>{
  h.push({id:'sub:stopped',kind:'subagent',activity:'工具 write'});
  h.push({id:'sub:stopped',kind:'subagent',status:'stopped',alive:false});
  const rows=h.render(120);assert.ok(rows[1].startsWith('■'));assert.match(rows[1],/已停止/);assert.doesNotMatch(rows[1],/工具 write/);
}));

test('workspace and access are shown compactly and remain visible in status',async()=>withMonitor(async h=>{
  h.push({workspace:'D:/projects/backend',access:'read-only'});
  const rows=h.render(120);assert.match(rows[1],/只读:backend/);assert.ok(rows.length<=3);
}));

test('tree navigation clears the old roster, and RPC mode never installs a widget',async()=>{
  await withMonitor(async h=>{h.push();await h.emit('session_tree');assert.deepEqual(h.render(),[]);});
  await withMonitor(async h=>{h.push();assert.equal(h.mounts(),0);await h.command('on');assert.equal(h.mounts(),0);assert.equal(h.sends(),0);},'rpc');
});
