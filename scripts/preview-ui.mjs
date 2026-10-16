/** Render documentation previews with Pi's actual fullscreen renderer and local fixture data. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostDir} from './host.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {TuiAltScreen,VStack,Text,Container,ScrollView,stripTerminalSequences}=await import(pathToFileURL(path.join(hostDir,'node_modules/@earendil-works/pi-tui/dist/index.js')));
const {loadExtensions,createExtensionRuntime}=await import(pathToFileURL(path.join(hostDir,'dist/core/extensions/loader.js')));
const {createEventBus}=await import(pathToFileURL(path.join(hostDir,'dist/core/event-bus.js')));
const terminal={columns:180,rows:42,kittyProtocolActive:false,start(){},stop(){},write(){},hideCursor(){},showCursor(){},clearLine(){},clearFromCursor(){},clearScreen(){},setTitle(){},setProgress(){},setProgramStatus(){},moveBy(){},async drainInput(){}};
const tui=new TuiAltScreen(terminal,false,undefined,{mouse:false}),widget=new Container();
const document=new Text('Pi Mission Control — 界面演示（测试数据）\n\n主 AI：正在协调 CPU/GPU 两组任务。\n\nCPU 构建员正在核对接口，CPU 监督员等待审阅结果。\nGPU 构建员已生成说明，GPU 监督员正在检查。\n\nEnter：插话，在当前响应或工具完成后优先处理\nCtrl+Q：在任务结束后追加\nEsc：全局停止，保留成员身份与历史',0,0);
const original=new VStack([{component:new ScrollView(document,{primary:true,follow:'end'}),basis:0,grow:1},{component:widget},{component:new Text('> 尚未发送的主对话草稿',0,0)}]);tui.setLayoutRoot(original);
const entries=[{type:'custom',customType:'goal-state',data:{status:'running',objective:'核对 CPU/GPU 文档和接口，收集监督员验收意见',criteria:['CPU 接口检查完成','GPU 文档审阅完成']}}];
const bus=createEventBus(),runtime=createExtensionRuntime();const loaded=await loadExtensions([path.join(root,'extensions/agent-monitor/index.ts')],root,bus,runtime);if(loaded.errors.length)throw new Error(JSON.stringify(loaded.errors));const extension=loaded.extensions[0];
const ui={theme:{fg:(_color,text)=>text},notify(){},onTerminalInput:()=>()=>{},setWidget(_key,factory){widget.clear();if(factory)widget.addChild(factory(tui,this.theme));}};
const ctx={mode:'tui',cwd:root,ui,sessionManager:{getBranch:()=>entries}};
const emit=async(type,event={})=>{for(const handler of extension.handlers.get(type)||[])await handler({type,...event},ctx);};
try{
 tui.start();await emit('session_start');
 const now=Date.now();await emit('message_end',{message:{role:'assistant',timestamp:now-10000,content:[{type:'text',text:'演示消息'}]}});bus.emit('supervisor:state',{enabled:true,intervalMs:300000,nextCheckAt:now+240000,checking:false});
 for(const [name,status]of [['cpu-supervisor','idle'],['cpu-builder','working'],['gpu-supervisor','working'],['gpu-builder','idle']])bus.emit('agent-monitor:update',{id:'team:'+name,kind:'team',name,status,alive:true,lastMessageAt:now-30000,updatedAt:now-1000,startedAt:now-120000,output:'测试进度：接口与文档核对中'});
 tui.renderNow(true);await fs.writeFile(path.join(root,'docs/ui-preview-wide.txt'),tui.getScreenLines().map(line=>stripTerminalSequences(line).trimEnd()).join('\n')+'\n');
 terminal.columns=90;terminal.rows=30;tui.renderNow(true);await fs.writeFile(path.join(root,'docs/ui-preview-compact.txt'),tui.getScreenLines().map(line=>stripTerminalSequences(line).trimEnd()).join('\n')+'\n');
 console.log('Generated docs/ui-preview-wide.txt and docs/ui-preview-compact.txt using the actual Pi renderer.');
}finally{await emit('session_shutdown');tui.stop();}
