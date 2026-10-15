/** One parent-process phase of the disk persistence regression. No model API. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {hostDir} from '../host.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [phase,base]=process.argv.slice(2);
const {SessionManager,RpcClient}=await import(pathToFileURL(path.join(hostDir,'dist/index.js')));
const {loadExtensions,createExtensionRuntime}=await import(pathToFileURL(path.join(hostDir,'dist/core/extensions/loader.js')));
const {createEventBus}=await import(pathToFileURL(path.join(hostDir,'dist/core/event-bus.js')));
const original=RpcClient.prototype.start;const peers=[];
RpcClient.prototype.start=async function(){this.options.cliPath=path.join(hostDir,'dist/bundle/cli.js');this.options.args.push('--extension',path.join(root,'scripts/fixtures/offline-provider.ts'));peers.push(this);return original.call(this);};
const location=path.join(base,'parent-file.txt');const cwd=path.join(base,'workspace');await fs.mkdir(cwd,{recursive:true});
const manager=phase==='create'?SessionManager.create(cwd,path.join(base,'parents')):SessionManager.open((await fs.readFile(location,'utf8')).trim());
if(phase==='create')manager.appendMessage({role:'user',content:'Offline main-process restart test',timestamp:Date.now()});
const runtime=createExtensionRuntime();runtime.appendEntry=(type,data)=>manager.appendCustomEntry(type,structuredClone(data));runtime.sendMessage=()=>{};
const loaded=await loadExtensions([path.join(root,'extensions/team/index.ts')],cwd,createEventBus(),runtime);if(loaded.errors.length)throw new Error(JSON.stringify(loaded.errors));
const extension=loaded.extensions[0];const ctx={cwd,sessionManager:manager,mode:'rpc',isIdle:()=>true,thinkingLevel:'off',model:{provider:'workbench-fixture',id:'model'},ui:{notify(){}}};
const emit=async type=>{for(const handler of extension.handlers.get(type)||[])await handler({type},ctx);};
const call=(name,args)=>extension.tools.get(name).definition.execute('restart',args,undefined,undefined,ctx);
try{
 await emit('session_start');
 if(phase==='create'){
  const member=await call('team_spawn',{name:'persistent',role:'Persistence test',workspace:{root:cwd,access:'read-only'},communication:{allow:[]}});if(member.isError)throw new Error(JSON.stringify(member));
 }
 const list=await call('team_list',{});if(list.details.count!==1)throw new Error(JSON.stringify(list));
 const command=phase==='create'?{op:'remember',token:'MAIN_PROCESS_RESTART_6259'}:{op:'recall'};
 const result=await call('team_send',{to:'persistent',message:'PROBE:'+JSON.stringify(command),timeoutMs:15000});
 if(result.isError||!JSON.stringify(result.content).includes('MAIN_PROCESS_RESTART_6259'))throw new Error(JSON.stringify(result));
 await fs.writeFile(location,manager.getSessionFile());
 await fs.writeFile(path.join(base,phase+'.json'),JSON.stringify({phase,parentPid:process.pid,sessionId:list.details.members[0].sessionId,childPids:peers.map(peer=>peer.process.pid),passed:true}));
}finally{await emit('session_shutdown');await Promise.allSettled(peers.map(peer=>peer.stop()));}
