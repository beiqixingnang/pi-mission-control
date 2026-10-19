import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {exportMissionArchive} from '../../runtime/archive/core.mjs';
import {verifyArchive} from '../../runtime/archive/verify.mjs';

const row=value=>JSON.stringify(value)+'\n';
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mission-archive-')),state=path.join(root,'agent/mission-control/v2/session');fs.mkdirSync(state,{recursive:true});
  const logs=path.join(root,'agent/sessions/test');fs.mkdirSync(logs,{recursive:true});
  const main=path.join(logs,'main.jsonl'),member=path.join(state,'sessions/reader/child.jsonl');fs.mkdirSync(path.dirname(member),{recursive:true});
  fs.writeFileSync(main,row({type:'session',id:'session'})+row({type:'message',id:'m1',timestamp:'2026-10-19T00:00:00Z',message:{role:'user',content:'USER_TEXT 中文🙂'}}));
  fs.writeFileSync(member,row({type:'session',id:'child'})+row({type:'message',id:'a1',timestamp:'2026-10-19T00:00:01Z',message:{role:'assistant',model:'luna',content:[{type:'thinking',thinking:'PRIVATE_THOUGHT'},{type:'text',text:'CHILD_PUBLIC_END'}]}}));
  const db=new DatabaseSync(path.join(state,'state.sqlite'));db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,data TEXT); CREATE TABLE members(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE tasks(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE goal_nodes(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE goal_receipts(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE goal_acceptances(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE lifecycle_archive(kind TEXT,id TEXT,data TEXT);');
  db.exec('PRAGMA synchronous=OFF;');
  const put=(table,id,data)=>db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(id,JSON.stringify(data));
  put('meta','schema',2);put('meta','mission',{id:'goal',objective:'Export real staged work',criteria:['Evidence'],status:'active',revision:2,turns:7,outputTokens:99});
  put('members','reader',{id:'reader',name:'luna-reader',sessionId:'child',sessionFile:member,model:'luna'});
  put('goal_nodes','goal',{id:'goal',rootId:'goal',depth:1,objective:'Export real staged work',criteria:['Evidence'],state:'active',revision:2,dependsOn:[]});
  const options={stateDirectory:state,sessionFile:main,sessionId:'session',destination:path.join(root,'export')};
  return {root,state,main,member,db,put,options,close(){db.close();fs.rmSync(root,{recursive:true,force:true});}};
}
function allItems(dir,m) {const out=[];for(let i=0;i<Math.ceil(m.itemCount/m.itemPageSize);i++)out.push(...JSON.parse(fs.readFileSync(path.join(dir,`items/${i}.json`),'utf8')));return out;}
function readBody(dir,body) {if(body.text!==undefined)return body.text;if(body.chunk)return JSON.parse(fs.readFileSync(path.join(dir,body.chunk))).text;let out='';for(let i=0;i<body.segments;i++){const refs=JSON.parse(fs.readFileSync(path.join(dir,`bodies/${body.id}/${Math.floor(i/100)}.json`)));out+=JSON.parse(fs.readFileSync(path.join(dir,refs[i%100]))).text;}return out;}

test('archive captures main, member, goals and every receipt without acquiring the running owner lock',async()=>{
  const h=fixture();try {
    fs.writeFileSync(path.join(h.state,'owner.lock'),'OWNER_MUST_NOT_CHANGE');
    for(let i=0;i<1105;i++)h.put('tasks','task'+i,{id:'task'+i,memberId:'reader',member:'luna-reader',missionId:'goal',goalId:'goal',state:'completed',createdAt:Date.parse('2026-10-19T00:00:00Z'),startedAt:Date.parse('2026-10-19T00:00:00Z'),finishedAt:Date.parse('2026-10-19T00:01:00Z'),sessionFile:h.member});
    for(let i=0;i<125;i++)h.put('goal_receipts','receipt'+i,{id:'receipt'+i,goalId:'goal',revision:2,tool:'read',input:'exact input',output:'exact output'});
    h.db.prepare('INSERT INTO lifecycle_archive VALUES(?,?,?)').run('member','old',JSON.stringify({id:'old',name:'old-reader',archivedAt:1}));
    const before=h.db.prepare("SELECT data FROM meta WHERE key='mission'").get().data;
    const result=await exportMissionArchive(h.options),m=JSON.parse(fs.readFileSync(result.manifest));
    assert.equal(result.status,'complete');assert.equal(m.catalog.task.count,1105);assert.equal(m.catalog.receipt.count,125);assert.equal(m.catalog.member.count,2);
    assert.equal(fs.readFileSync(path.join(h.state,'owner.lock'),'utf8'),'OWNER_MUST_NOT_CHANGE');assert.equal(h.db.prepare("SELECT data FROM meta WHERE key='mission'").get().data,before);
    const text=allItems(result.destination,m).map(r=>readBody(result.destination,r.body??r.args??{text:''})).join('\n');assert.match(text,/CHILD_PUBLIC_END/);assert.doesNotMatch(text,/PRIVATE_THOUGHT/);
    assert.ok(fs.existsSync(path.join(result.destination,'checksums.jsonl')));assert.ok(fs.existsSync(path.join(result.destination,'items/0.js')));assert.match(fs.readFileSync(path.join(result.destination,'items/0.js'),'utf8'),/__PI_MISSION_ARCHIVE__/);const staticWindow={};vm.runInNewContext(fs.readFileSync(path.join(result.destination,'items/0.js'),'utf8'),{window:staticWindow});assert.ok(staticWindow.__PI_MISSION_ARCHIVE__['items/0.json']);assert.doesNotMatch(fs.readFileSync(path.join(result.destination,'README.txt'),'utf8'),/选择归档文件夹/);assert.equal(m.sources.length,2);
  } finally{h.close();}
});
test('archive retains all recorded branches and embeds image bytes without executing their content',async()=>{
  const h=fixture();try{
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf5kAAAAASUVORK5CYII=','base64');
    fs.appendFileSync(h.main,row({type:'message',id:'left',parentId:'m1',message:{role:'assistant',content:'OLDER_BRANCH'}})+row({type:'message',id:'right',parentId:'m1',message:{role:'user',content:[{type:'text',text:'CURRENT_BRANCH'},{type:'image',mimeType:'image/png',data:png.toString('base64')}]}}));
    const result=await exportMissionArchive({...h.options,leafId:'right'}),m=JSON.parse(fs.readFileSync(result.manifest)),items=allItems(result.destination,m);
    assert.equal(items.find(r=>r.body?.text==='OLDER_BRANCH').branch,false);assert.equal(items.find(r=>r.body?.text==='CURRENT_BRANCH').branch,true);
    const image=items.find(r=>r.asset);assert.deepEqual(fs.readFileSync(path.join(result.destination,image.asset.path)),png);assert.equal(m.omittedAttachments,0);
  }finally{h.close();}
});
test('archive preserves long public text and complete arguments while filtering structural private fields',async()=>{
  const h=fixture();try {
    const text='公开正文🙂\n</script><img src=x onerror=alert(1)>\u2028'.repeat(4000)+'TAIL_完整🙂';
    const args={rows:Array.from({length:350},(_,i)=>i),apiKey:'PRIVATE_KEY',nested:{authorization:'PRIVATE_AUTH',code:'literal "systemPrompt": is source text, not a private field'}};
    fs.appendFileSync(h.main,row({type:'message',id:'m2',parentId:'m1',message:{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE_THOUGHT'},{type:'text',text},{type:'toolCall',id:'call-1',name:'read',arguments:args}]}})+row({type:'message',id:'m3',parentId:'m2',message:{role:'toolResult',toolName:'read',toolCallId:'call-1',content:[{type:'text',text:'RESULT_OK'}]}}));
    const result=await exportMissionArchive(h.options),m=JSON.parse(fs.readFileSync(result.manifest)),items=allItems(result.destination,m);
    const long=items.find(r=>r.body?.bytes>100000),call=items.find(r=>r.kind==='tool-call');assert.equal(readBody(result.destination,long.body),text);assert.equal(long.body.sha256,createHash('sha256').update(text).digest('hex'));
    const recovered=JSON.parse(readBody(result.destination,call.args));assert.equal(recovered.rows.length,350);assert.equal(recovered.apiKey,undefined);assert.equal(recovered.nested.authorization,undefined);assert.match(recovered.nested.code,/systemPrompt/);assert.equal(call.callOutcome,'success');assert.ok(call.resultOrdinal);
    assert.ok(m.redactedFields>=2);assert.ok(m.searchPages>0);
  }finally{h.close();}
});
test('archive freezes complete LF prefixes and does not chase appends or half-written records',async()=>{
  const h=fixture();try {
    fs.appendFileSync(h.main,'{"partial":');
    let appended=false;const result=await exportMissionArchive({...h.options,onProgress(value){if(value.phase==='captured'&&!appended){appended=true;fs.appendFileSync(h.member,row({type:'message',id:'new',message:{role:'assistant',content:'APPENDED_AFTER_SNAPSHOT'}}));}}});
    const m=JSON.parse(fs.readFileSync(result.manifest));assert.equal(m.sources.find(s=>s.member==='lead').incompleteTailBytes,11);assert.ok(m.sources.find(s=>s.member==='reader').appendedBytes>0);
    assert.doesNotMatch(JSON.stringify(allItems(result.destination,m)),/APPENDED_AFTER_SNAPSHOT|partial/);
  }finally{h.close();}
});
test('archive fails visibly on malformed middle records and never overwrites an existing destination',async()=>{
  const h=fixture();try {
    fs.appendFileSync(h.main,'{"broken": NO}\n'+row({type:'message',message:{role:'user',content:'later'}}));
    await assert.rejects(exportMissionArchive(h.options),/Parser/);assert.equal(fs.existsSync(h.options.destination),false);assert.equal(JSON.parse(fs.readFileSync(h.options.destination+'.partial/job.json')).status,'failed');
    await assert.rejects(exportMissionArchive(h.options),/already exists/);
  }finally{h.close();}
});
test('archive cancellation leaves a partial receipt, and missing sources or checksum damage are explicit',async()=>{
  const h=fixture();try{
    const abort=new AbortController();await assert.rejects(exportMissionArchive({...h.options,signal:abort.signal,onProgress(value){if(value.phase==='captured')abort.abort(new Error('USER_CANCELLED'));}}),/USER_CANCELLED/);
    assert.equal(JSON.parse(fs.readFileSync(h.options.destination+'.partial/job.json')).status,'cancelled');
    fs.unlinkSync(h.member);
    const result=await exportMissionArchive({...h.options,destination:path.join(h.root,'second-export')});assert.equal(result.status,'partial');assert.ok(result.notices.some(n=>n.kind==='missing-source'));
    assert.equal((await verifyArchive(result.destination)).verified,true);
    fs.appendFileSync(path.join(result.destination,'index.html'),'tamper');assert.equal((await verifyArchive(result.destination)).verified,false);
  }finally{h.close();}
});
