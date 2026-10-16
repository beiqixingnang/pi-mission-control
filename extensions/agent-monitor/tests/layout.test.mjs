import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostDir} from '../../../scripts/host.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const tuiLib=await import(pathToFileURL(path.join(hostDir,'node_modules/@earendil-works/pi-tui/dist/index.js')));
const {TuiAltScreen,VStack,Text,visibleWidth}=tuiLib;
const {createJiti}=await import(pathToFileURL(path.join(hostDir,'node_modules/jiti/lib/jiti.mjs')));
const require=createRequire(path.join(hostDir,'package.json'));
const jiti=createJiti(import.meta.url,{alias:{'@earendil-works/pi-tui':require.resolve('@earendil-works/pi-tui')}});
const {installSidebar}=await jiti.import(path.resolve(here,'../layout.ts'));
const {visibleHistory,clock,boxed}=await jiti.import(path.resolve(here,'../history.ts'));

class TerminalFixture{
 columns=180;rows=36;kittyProtocolActive=false;
 start(input,resize){this.input=input;this.resize=resize;}stop(){}write(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}moveBy(){}async drainInput(){}
}

test('real Pi fullscreen renderer reflows left chat and sidebar on resize, then restores original layout',()=>{
 const terminal=new TerminalFixture(),tui=new TuiAltScreen(terminal,false,undefined,{mouse:false});
 const original=new VStack([new Text('MAIN_CHAT '+('long text '.repeat(30)),0,0),new Text('INPUT_DRAFT 中文草稿',0,0)]);tui.setLayoutRoot(original);
 const side={render(width){return ['SIDEBAR_GOAL','SIDEBAR_MEMBERS',`WIDTH ${width}`];},invalidate(){}};
 const remove=installSidebar(tui,side,(width,height)=>width>=140&&height>=24);assert.equal(typeof remove,'function');
 try{
  tui.start();tui.renderNow(true);let rows=tui.getScreenLines();
  assert.match(rows.join('\n'),/MAIN_CHAT/);assert.match(rows.join('\n'),/SIDEBAR_GOAL/);assert.match(rows.join('\n'),/INPUT_DRAFT/);
  for(const row of rows)assert.ok(visibleWidth(row)<=180);
  terminal.columns=90;tui.renderNow(true);rows=tui.getScreenLines();assert.doesNotMatch(rows.join('\n'),/SIDEBAR_GOAL/);assert.match(rows.join('\n'),/INPUT_DRAFT/);
  terminal.columns=180;tui.renderNow(true);assert.match(tui.getScreenLines().join('\n'),/SIDEBAR_MEMBERS/);
  remove();assert.equal(tui.layoutRoot,original);tui.renderNow(true);assert.doesNotMatch(tui.getScreenLines().join('\n'),/SIDEBAR_GOAL/);
 }finally{tui.stop();}
});

test('history borders remain within extremely narrow terminal widths',()=>{
 for(const width of [0,1,2,3,20])for(const row of boxed(['中文🙂'],width,5,'成员对话'))assert.ok(visibleWidth(row)<=width);
});

test('history includes visible messages and tool results, excludes thinking and signatures',()=>{
 const messages=visibleHistory([{role:'assistant',timestamp:1,content:[{type:'thinking',thinking:'SECRET_REASONING',thinkingSignature:'SECRET_SIGNATURE'},{type:'text',text:'visible reply'},{type:'toolCall',name:'workspace_read'}]},{role:'toolResult',toolName:'workspace_read',content:[{type:'text',text:'file result'}]}]);
 assert.match(JSON.stringify(messages),/visible reply/);assert.match(JSON.stringify(messages),/file result/);assert.doesNotMatch(JSON.stringify(messages),/SECRET_/);
 assert.equal(clock(undefined),'尚无消息');assert.match(clock(Date.now()),/\d\d:\d\d:\d\d/);
});
