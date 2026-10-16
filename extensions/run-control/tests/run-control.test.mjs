import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {hostDir} from '../../../scripts/host.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const {loadExtensions,createExtensionRuntime}=await import(pathToFileURL(path.join(hostDir,'dist/core/extensions/loader.js')));
const {createEventBus}=await import(pathToFileURL(path.join(hostDir,'dist/core/event-bus.js')));

async function withControl(fn){
 const bus=createEventBus(),runtime=createExtensionRuntime(),statuses=[],sent=[];let listener,aborts=0,idle=true;
 runtime.sendUserMessage=(...args)=>sent.push(args);
 const result=await loadExtensions([path.resolve(here,'../index.ts')],process.cwd(),bus,runtime);assert.deepEqual(result.errors,[]);const extension=result.extensions[0];
 const ctx={mode:'tui',isIdle:()=>idle,ui:{setStatus:(_key,text)=>statuses.push(text),onTerminalInput:fn=>{listener=fn;return()=>{listener=undefined;};}},abort:()=>{aborts++;}};
 const emit=async(name,event={})=>{let result;for(const handler of extension.handlers.get(name)||[])result=await handler({type:name,...event},ctx);return result;};
 await emit('session_start');
 try{await fn({bus,ctx,sent,statuses,emit,key:data=>listener?.(data),aborts:()=>aborts,idle:value=>{idle=value;},stop:()=>extension.commands.get('stop').handler('',ctx)});}
 finally{await emit('session_shutdown');}
}

test('Esc works while main is idle but a background member is active; no roster deletion',()=>withControl(async h=>{
 let stopped=0;h.bus.on('workbench:stop',request=>{stopped++;assert.ok(Array.isArray(request.pending));});
 h.bus.emit('team:job-start',{id:'a'});assert.equal(h.key('\x1b').consume,true);await delay(0);
 assert.equal(stopped,1);assert.equal(h.aborts(),1);assert.match(h.statuses.at(-1),/已停止/);
}));

test('ordinary input after Esc is retained until both main and child cancellation settle',()=>withControl(async h=>{
 let release;h.bus.on('workbench:stop',request=>request.pending.push(new Promise(resolve=>{release=resolve;})));
 h.idle(false);await h.emit('agent_start');h.key('\x1b');
 const input=await h.emit('input',{source:'interactive',streamingBehavior:'steer',text:'New instruction'});assert.equal(input.action,'handled');assert.equal(h.sent.length,0);
 h.idle(true);await h.emit('agent_settled',{aborted:true});assert.equal(h.sent.length,0);
 release();await delay(0);assert.equal(h.sent.length,1);assert.equal(h.sent[0][0][0].text,'New instruction');
}));

test('Enter remains steer and explicit follow-up stays queued, with distinct feedback',()=>withControl(async h=>{
 assert.equal(await h.emit('input',{source:'interactive',streamingBehavior:'steer',text:'change direction'}),undefined);assert.match(h.statuses.at(-1),/已插话/);
 assert.equal(await h.emit('input',{source:'interactive',streamingBehavior:'followUp',text:'later'}),undefined);assert.match(h.statuses.at(-1),/已追加/);assert.equal(h.sent.length,0);
}));

test('Esc when nothing is running is left to menus and editor; shutdown drops held input',()=>withControl(async h=>{
 assert.equal(h.key('\x1b'),undefined);
 h.idle(false);await h.emit('agent_start');h.key('\x1b');await h.emit('input',{source:'interactive',streamingBehavior:'steer',text:'must not leak'});
 await h.emit('session_shutdown');h.idle(true);await delay(0);assert.equal(h.sent.length,0);assert.equal(h.key('\x1b'),undefined);
}));
