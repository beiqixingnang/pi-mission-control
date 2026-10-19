import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ArchiveStorage,safeJson,writeJson,hash} from './storage.mjs';
import {createIndex,captureCatalog,materializeCatalog} from './catalog.mjs';
import {importSession} from './importer.mjs';
import {captureFile,canonical,scanJson,nativePath} from './scan.mjs';

const ownDir=path.dirname(fileURLToPath(import.meta.url));
const parse=row=>row?JSON.parse(row.data):undefined;
const publicSource=s=>({id:s.id,member:s.member,file:s.file,bytes:s.size,frozenBytes:s.end,incompleteTailBytes:s.incompleteTail,capturedAt:s.capturedAt,sessionId:s.sessionId,leafId:s.lastEntryId,records:s.result?.records,sha256:s.result?.sha256,appendedBytes:s.result?.appendedBytes});
const viewId=key=>'v'+hash(key).slice(0,24);

function cleanUnreferenced(index,root) {
  index.exec(`DELETE FROM item_bodies WHERE item IN (SELECT items.seq FROM items JOIN records ON records.seq=items.record WHERE records.eligible=0);
    DELETE FROM items WHERE record IN (SELECT seq FROM records WHERE eligible=0);
    DELETE FROM body_segments WHERE body NOT IN (SELECT body FROM item_bodies);
    DELETE FROM search_segments WHERE body NOT IN (SELECT body FROM item_bodies);`);
  for(const row of index.prepare('SELECT path FROM chunks WHERE path NOT IN (SELECT path FROM body_segments)').iterate())fs.unlinkSync(path.join(root,row.path));
  index.exec('DELETE FROM chunks WHERE path NOT IN (SELECT path FROM body_segments)');
  for(const row of index.prepare("SELECT path FROM assets WHERE path NOT IN (SELECT json_extract(data,'$.asset.path') FROM items WHERE json_extract(data,'$.asset.path') IS NOT NULL)").iterate())fs.unlinkSync(path.join(root,row.path));
  index.exec("DELETE FROM assets WHERE path NOT IN (SELECT json_extract(data,'$.asset.path') FROM items WHERE json_extract(data,'$.asset.path') IS NOT NULL)");
}
function markBranches(index,sources,leafId) {
  index.exec('ALTER TABLE records ADD COLUMN branch INTEGER NOT NULL DEFAULT 0; CREATE INDEX record_identity ON records(source,id,seq); CREATE TABLE visited(source TEXT,id TEXT,PRIMARY KEY(source,id));');
  const visited=index.prepare('INSERT OR IGNORE INTO visited VALUES(?,?)'),parent=index.prepare('SELECT parent FROM records WHERE source=? AND id=? ORDER BY seq DESC LIMIT 1'),mark=index.prepare('UPDATE records SET branch=1 WHERE source=? AND id=?');
  for(const s of sources) {
    let current=s.member==='lead'&&leafId?leafId:s.lastEntryId;
    s.selectedLeaf=current;s.leafOrigin=s.member==='lead'&&leafId?'captured-ui-leaf':'last-complete-record';
    while(current){if(!visited.run(s.id,current).changes)throw Error('Cycle in recorded session ancestry: '+s.id);mark.run(s.id,current);current=parent.get(s.id,current)?.parent;}
  }
}

async function discoverLegacy(main,capture,index,manifest,options) {
  let customType='',sessionId='',name='',id='',file='',field,value='',collect=false;
  const save=()=>{if(customType==='team-roster'&&(sessionId||file))index.prepare('INSERT OR REPLACE INTO legacy_members VALUES(?,?)').run((id||name||'legacy')+':'+(sessionId||file),JSON.stringify({id,name,sessionId,sessionFile:file}));sessionId=name=id=file='';};
  const first=await scanJson(main,{
    start(){customType='';},token(t,p){
      if(t.name==='startString'){field=undefined;collect=false;value='';if(p.length===1&&p[0]==='customType'){field='customType';collect=true;}else if(p[0]==='data'&&p[1]==='members'&&p.length===4&&['id','name','sessionId','sessionFile'].includes(p[3])){field=p[3];collect=true;}}
      else if(t.name==='stringChunk'&&collect){value+=t.value;if(value.length>65536)throw Error('Legacy identity exceeds supported metadata bound');}
      else if(t.name==='endString'&&collect){if(field==='customType')customType=value;else if(field==='id')id=value;else if(field==='name')name=value;else if(field==='sessionId')sessionId=value;else file=value;collect=false;}
      else if(t.name==='endObject'&&p[0]==='data'&&p[1]==='members'&&p.length===3)save();
    },progress:bytes=>options.progress?.({phase:'discovering',source:main.id,bytes,total:main.end})
  },options.signal);main.discoverySha=first.sha256;
  const refs=index.prepare('SELECT data FROM legacy_members').all().map(parse);if(!refs.length)return;
  const wanted=new Map(refs.filter(m=>m.sessionId).map(m=>[m.sessionId,m]));
  const candidates=[];
  for(const m of refs)if(m.sessionFile)candidates.push([m.sessionFile,m]);
  const sessions=path.join(capture.agent,'sessions');
  if(fs.existsSync(sessions))for await(const folder of await fs.promises.opendir(sessions)) {
    if(!folder.isDirectory()||folder.isSymbolicLink())continue;
    for await(const entry of await fs.promises.opendir(path.join(sessions,folder.name))) {
      if(!entry.isFile()||!entry.name.endsWith('.jsonl'))continue;
      const m=[...wanted].find(([session])=>entry.name.endsWith('_'+session+'.jsonl'))?.[1];
      if(m)candidates.push([path.join(sessions,folder.name,entry.name),m]);
    }
  }
  for(const [file,m] of candidates) {
    try{
      const key=canonical(file);if(capture.seen.has(key))continue;
      const s=captureFile(file,capture.allowedRoots);s.member=m.id||('legacy-'+hash(m.name||m.sessionId).slice(0,12));s.id='s'+String(capture.sources.length).padStart(5,'0');capture.sources.push(s);capture.seen.add(key);
      index.prepare('INSERT OR IGNORE INTO catalog VALUES(?,?,?)').run('member',s.member,JSON.stringify({...m,id:s.member,legacy:true}));
    }catch(error){manifest.notices.push({kind:'missing-legacy-source',file,message:error.message});}
  }
  for(const [session,m] of wanted)if(!capture.sources.some(s=>s.file.endsWith('_'+session+'.jsonl')))manifest.notices.push({kind:'unresolved-legacy-member',sessionId:session,member:m.name});
}

function materialize(root,index,sources,manifest,options) {
  options.progress?.({phase:'indexing'});
  index.exec(`CREATE TABLE rendered(ordinal INTEGER PRIMARY KEY,source TEXT,member TEXT,task TEXT,goal TEXT,branch INTEGER,data TEXT);
    CREATE TABLE memberships(view TEXT,ordinal INTEGER,PRIMARY KEY(view,ordinal));
    CREATE TABLE task_sources(source TEXT,task TEXT,start REAL,finish REAL,data TEXT);
    CREATE TABLE rendered_bodies(ordinal INTEGER,body INTEGER);
    CREATE INDEX rendered_body ON rendered_bodies(body,ordinal);
    CREATE INDEX membership_page ON memberships(view,ordinal);`);
  const sourceMap=new Map(sources.map(s=>[s.id,s])),byPath=new Map(sources.map(s=>[s.canonical,s]));
  const taskPut=index.prepare('INSERT INTO task_sources VALUES(?,?,?,?,?)');
  for(const row of index.prepare("SELECT id,data FROM catalog WHERE kind='task'").iterate()) {
    const t=parse(row);if(!t.sessionFile)continue;let s;try{s=byPath.get(canonical(t.sessionFile));}catch{}if(s)taskPut.run(s.id,t.id,t.startedAt??t.createdAt,t.finishedAt??Number.MAX_SAFE_INTEGER,JSON.stringify(t));
  }
  const taskAt=index.prepare('SELECT data FROM task_sources WHERE source=? AND start<=? AND finish>=? ORDER BY start DESC LIMIT 1');
  const ancestorCache=new Map();
  const ancestors=id=>{if(!id)return[];if(ancestorCache.has(id))return ancestorCache.get(id);const out=[],seen=new Set();let at=id;while(at){if(seen.has(at))throw Error('Cycle in goal ancestry');seen.add(at);out.push(at);const row=index.prepare("SELECT data FROM catalog WHERE kind='goal' AND id=?").get(at);at=parse(row)?.parentId;}ancestorCache.set(id,out);if(ancestorCache.size>128)ancestorCache.delete(ancestorCache.keys().next().value);return out;};
  const put=index.prepare('INSERT INTO rendered VALUES(?,?,?,?,?,?,?)'),memberPut=index.prepare('INSERT OR IGNORE INTO memberships VALUES(?,?)');
  let ordinal=0,page=[],pageId=0;const channelCounts=new Map();
  for(const row of index.prepare("SELECT items.seq,items.kind,items.data,records.seq AS recordSeq,records.source,records.id,records.parent,records.time,records.branch,records.data AS meta FROM items JOIN records ON records.seq=items.record ORDER BY COALESCE(records.time,''),records.source,records.seq,items.seq").iterate()) {
    options.signal?.throwIfAborted();const data=JSON.parse(row.data),meta=JSON.parse(row.meta),s=sourceMap.get(row.source),at=Date.parse(row.time);
    const task=Number.isFinite(at)?parse(taskAt.get(row.source,at,at)):undefined;
    const receipt=row.kind==='tool-call'&&data.callId?parse(index.prepare("SELECT data FROM catalog WHERE kind='receipt' AND id=?").get(data.callId)):undefined;
    const goal=receipt?.goalId??task?.goalId??task?.missionId;
    const item={...data,ordinal:++ordinal,key:`${row.source}:${row.id??row.recordSeq}:${row.seq}`,source:row.source,member:s.member,recordId:row.id,parentId:row.parent,kind:row.kind,role:meta.role,time:row.time,model:meta.model,provider:meta.provider,toolName:meta.toolName,toolCallId:meta.toolCallId,isError:meta.isError,usage:meta.usage,branch:!!row.branch,taskId:task?.id,goalId:goal,goalRevision:receipt?.revision??task?.goalRevision,binding:receipt?'tool-receipt':task?'session-and-task-time-window':'unbound'};
    item.channelOffset=channelCounts.get(s.member)??0;channelCounts.set(s.member,item.channelOffset+1);
    put.run(ordinal,row.source,s.member,task?.id??null,goal??null,row.branch,JSON.stringify(item));
    if(ordinal%1000===0)options.progress?.({phase:'message-index',items:ordinal});
    for(const body of [item.body,item.args])if(body?.id)index.prepare('INSERT INTO rendered_bodies VALUES(?,?)').run(ordinal,body.id);
    const views=new Set(['all','c:'+s.member,'s:'+row.source]);
    if(task)views.add('t:'+task.id);
    for(const id of ancestors(goal)){views.add('g:'+id);views.add('c:'+s.member+'|g:'+id);}
    if(row.kind==='event')views.add('events');
    for(const key of views){memberPut.run(key,ordinal);if(row.branch)memberPut.run(key+'|b',ordinal);}
  }
  index.exec("CREATE INDEX rendered_call ON rendered(source,json_extract(data,'$.toolCallId'));");
  const resultAt=index.prepare("SELECT ordinal,data FROM rendered WHERE source=? AND json_extract(data,'$.toolCallId')=? AND json_extract(data,'$.role')='toolResult' ORDER BY ordinal LIMIT 1");
  for(const row of index.prepare("SELECT ordinal,source,data FROM rendered WHERE json_extract(data,'$.kind')='tool-call'").iterate()) {
    const data=JSON.parse(row.data),result=resultAt.get(row.source,data.callId??'');
    data.resultOrdinal=result?.ordinal;data.callOutcome=result?(JSON.parse(result.data).isError?'error':'success'):'missing';index.prepare('UPDATE rendered SET data=? WHERE ordinal=?').run(JSON.stringify(data),row.ordinal);
  }
  for(const row of index.prepare('SELECT data FROM rendered ORDER BY ordinal').iterate()){page.push(JSON.parse(row.data));if(page.length===40){writeJson(root,`items/${pageId++}.json`,page);page=[];}}
  if(page.length)writeJson(root,`items/${pageId++}.json`,page);
  manifest.itemCount=ordinal;manifest.itemPageSize=40;
  const views=new Map();
  for(const row of index.prepare('SELECT view,COUNT(*) AS count FROM memberships GROUP BY view ORDER BY view').iterate()) {
    const id=viewId(row.view);let page=[],part=0;
    for(const item of index.prepare('SELECT ordinal FROM memberships WHERE view=? ORDER BY ordinal').iterate(row.view)){page.push(item.ordinal);if(page.length===40){writeJson(root,`views/${id}/${part++}.json`,page);page=[];}}
    if(page.length)writeJson(root,`views/${id}/${part++}.json`,page);
    const meta={id,count:row.count,pages:part};writeJson(root,`views/${id}/meta.json`,meta);views.set(row.view,meta);
  }
  const namedViews=key=>({all:views.get(key),branch:views.get(key+'|b')});
  for(const row of index.prepare("SELECT kind,id,data FROM catalog WHERE kind IN ('goal','task','member')").iterate()) {
    const data=JSON.parse(row.data),prefix={goal:'g:',task:'t:',member:'c:'}[row.kind];data.archiveViews=namedViews(prefix+row.id);
    if(row.kind==='goal'){
      data.channelViews={};for(const s of sources)if(views.has('c:'+s.member+'|g:'+row.id))data.channelViews[s.member]=namedViews('c:'+s.member+'|g:'+row.id);
      data.currentAcceptance=data.acceptanceId?parse(index.prepare("SELECT data FROM catalog WHERE kind='acceptance' AND id=?").get(data.acceptanceId)):undefined;
      data.acceptanceHistoryCount=index.prepare("SELECT COUNT(*) AS count FROM catalog WHERE kind='acceptance' AND json_extract(data,'$.goalId')=?").get(row.id).count;
    }
    index.prepare('UPDATE catalog SET data=? WHERE kind=? AND id=?').run(JSON.stringify(data),row.kind,row.id);
  }
  materializeCatalog(root,index,manifest);
  manifest.views=namedViews('all');manifest.events=namedViews('events');
  manifest.channels=[];
  for(const m of new Set(['lead',...sources.map(s=>s.member)])) {
    const member=parse(index.prepare("SELECT data FROM catalog WHERE kind='member' AND id=?").get(m));
    const last=parse(index.prepare("SELECT data FROM catalog WHERE kind='task' AND json_extract(data,'$.memberId')=? ORDER BY json_extract(data,'$.createdAt') DESC LIMIT 1").get(m));
    const taskCount=index.prepare("SELECT COUNT(*) AS count FROM catalog WHERE kind='task' AND json_extract(data,'$.memberId')=?").get(m).count;
    manifest.channels.push({id:m,name:m==='lead'?'主对话':member?.name??m,model:member?.model,archivedAt:member?.archivedAt,status:last?.state??(m==='lead'?'lead':'unknown'),sourceCount:sources.filter(s=>s.member===m).length,taskCount,views:namedViews('c:'+m)});
  }
  for(const s of sources)s.archiveViews=namedViews('s:'+s.id);
  // Per-body segment directories contain bounded reference pages, not a giant
  // array. The complete text lives in content-addressed JSON chunks.
  for(const row of index.prepare('SELECT body,COUNT(*) AS count,SUM(chars) AS chars FROM body_segments GROUP BY body ORDER BY body').iterate()) {
    if(row.count===1)continue;
    let page=[],part=0;for(const segment of index.prepare('SELECT path FROM body_segments WHERE body=? ORDER BY part').iterate(row.body)){page.push(segment.path);if(page.length===100){writeJson(root,`bodies/${row.body}/${part++}.json`,page);page=[];}}
    if(page.length)writeJson(root,`bodies/${row.body}/${part++}.json`,page);
    writeJson(root,`bodies/${row.body}/meta.json`,{segments:row.count,pages:part,chars:row.chars});
  }
  // Bloom pages are advisory only: text is confirmed after every positive hit.
  let search=[],searchPage=0;
  for(const row of index.prepare('SELECT search_segments.*,MIN(rendered_bodies.ordinal) AS ordinal FROM search_segments JOIN rendered_bodies ON rendered_bodies.body=search_segments.body GROUP BY search_segments.seq ORDER BY search_segments.seq').iterate()) {
    search.push({ordinal:row.ordinal,body:row.body,part:row.part,path:row.path,before:row.before_text,bits:row.bits});
    if(search.length===100){writeJson(root,`search/${searchPage++}.json`,search);search=[];}
  }
  if(search.length)writeJson(root,`search/${searchPage++}.json`,search);
  manifest.searchPages=searchPage;
  manifest.goals=index.prepare("SELECT data FROM catalog WHERE kind='goal' ORDER BY json_extract(data,'$.depth'),id LIMIT 100").all().map(parse);
  manifest.goalsPreviewComplete=(manifest.catalog.goal?.count??0)<=manifest.goals.length;
  manifest.mission=parse(index.prepare("SELECT data FROM catalog WHERE kind='meta' AND id='mission'").get());
  manifest.focusGoalId=parse(index.prepare("SELECT data FROM catalog WHERE kind='meta' AND id=?").get('goalFocus:'+manifest.mission?.id));
  index.exec("CREATE INDEX catalog_goal_root ON catalog(kind,json_extract(data,'$.rootId'));");
  const roots=[];let rootPage=[],rootPageId=0;
  for(const row of index.prepare("SELECT id,data FROM catalog WHERE kind='goal' AND json_extract(data,'$.depth')=1 ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,id").iterate(manifest.mission?.id??'')) {
    const data=JSON.parse(row.data),tree='g'+hash(row.id).slice(0,24),levels={};let nodes=[],part=0,size=0,count=0;
    for(const node of index.prepare("SELECT data FROM catalog WHERE kind='goal' AND json_extract(data,'$.rootId')=? ORDER BY json_extract(data,'$.depth'),json_extract(data,'$.order'),id").iterate(row.id)) {
      if(nodes.length&&(nodes.length===100||size+Buffer.byteLength(node.data)>512*1024)){writeJson(root,`trees/${tree}/${part++}.json`,nodes);nodes=[];size=0;}
      const g=JSON.parse(node.data);nodes.push(g);size+=Buffer.byteLength(node.data);count++;
      if([2,3].includes(g.depth)&&!['cancelled','skipped'].includes(g.state)){levels[g.depth]??={total:0,completed:0};levels[g.depth].total++;if(g.state==='accepted'&&g.acceptanceId)levels[g.depth].completed++;}
    }
    if(nodes.length)writeJson(root,`trees/${tree}/${part++}.json`,nodes);
    const meta={id:tree,rootId:row.id,root:data,count,pages:part,levels};writeJson(root,`trees/${tree}/meta.json`,meta);
    const entry={id:row.id,title:data.objective,state:data.state,tree,selected:row.id===manifest.mission?.id};rootPage.push(entry);if(roots.length<100)roots.push(entry);
    if(rootPage.length===100){writeJson(root,`roots/${rootPageId++}.json`,rootPage);rootPage=[];}
    if(entry.selected||(!manifest.goalTree&&roots.length===1)){manifest.goalTree=meta;manifest.goals=JSON.parse(fs.readFileSync(path.join(root,`trees/${tree}/0.json`),'utf8'));}
  }
  if(rootPage.length)writeJson(root,`roots/${rootPageId++}.json`,rootPage);manifest.roots=roots;manifest.rootPages=rootPageId;
  manifest.goalProgress={};
  for(const depth of [2,3])manifest.goalProgress[depth]=index.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN json_extract(data,'$.state')='accepted' AND json_extract(data,'$.acceptanceId') IS NOT NULL THEN 1 ELSE 0 END) AS completed FROM catalog WHERE kind='goal' AND json_extract(data,'$.rootId')=? AND json_extract(data,'$.depth')=? AND json_extract(data,'$.state') NOT IN ('cancelled','skipped')").get(manifest.mission?.id??'',depth);
}

export async function exportMissionArchive(options) {
  const destination=path.resolve(nativePath(options.destination)),work=destination+'.partial';
  if(fs.existsSync(destination)||fs.existsSync(work))throw Error('Archive destination or .partial directory already exists; use a new destination');
  const started=Date.now();fs.mkdirSync(path.dirname(work),{recursive:true});fs.mkdirSync(work,{recursive:false,mode:0o700});
  const manifest={format:'pi-mission-archive',version:1,createdAt:new Date().toISOString(),status:'building',sessionId:options.sessionId,publicFields:true,includeArchived:options.includeArchived!==false,notices:[],omittedAttachments:0,unknownBlocks:0,redactedFields:0};
  writeJson(work,'job.json',{status:'building',sessionId:options.sessionId,createdAt:manifest.createdAt});
  let index,capture,storage;
  const progress=value=>{options.signal?.throwIfAborted();options.onProgress?.(value);};
  try {
    index=createIndex(path.join(work,'index.sqlite'));capture=captureCatalog(options,index,manifest);progress({phase:'captured',sources:capture.sources.length});
    const runOptions={signal:options.signal,progress};index.exec('BEGIN;');
    await discoverLegacy(capture.sources.find(s=>s.member==='lead'),capture,index,manifest,runOptions);
    storage=new ArchiveStorage(work,index);
    for(const source of capture.sources) {
      source.result=await importSession(source,index,storage,runOptions,manifest);
      if(source.discoverySha&&source.discoverySha!==source.result.sha256)throw Error('Captured main log changed within its frozen prefix');
      if(source.member==='lead'&&options.sessionId&&source.sessionId!==options.sessionId)throw Error('Selected source does not match the requested Pi session identity');
      index.prepare('INSERT INTO sources VALUES(?,?,?)').run(source.id,source.member,JSON.stringify(publicSource(source)));
      progress({phase:'source-complete',source:source.id,records:source.result.records});
    }
    cleanUnreferenced(index,work);markBranches(index,capture.sources,options.leafId);materialize(work,index,capture.sources,manifest,runOptions);
    manifest.sources=capture.sources.map(s=>({...publicSource(s),selectedLeaf:s.selectedLeaf,leafOrigin:s.leafOrigin,archiveViews:s.archiveViews}));
    manifest.title=capture.sources.find(s=>s.member==='lead')?.title??'Pi 联合对话归档';
    manifest.capturedScope='Per-file complete-LF prefixes and a separate read-only SQL transaction; not a globally atomic process snapshot.';
    manifest.textPolicy='Visible text and tool arguments/results are not length-truncated. Structured private fields are omitted. This is a local reading archive, not an assurance that arbitrary text contains no secrets.';
    manifest.integrity={algorithm:'sha256',file:'checksums.jsonl'};
    manifest.status=manifest.omittedAttachments||manifest.unknownBlocks||manifest.notices.some(n=>n.kind.startsWith('missing')||n.kind.startsWith('unresolved'))?'partial':'complete';
    index.exec(`DROP TABLE items; DROP TABLE item_bodies; DROP TABLE rendered_bodies;
      DROP TABLE search_segments; DROP TABLE body_segments; DROP TABLE chunks;
      DROP TABLE memberships; DROP TABLE task_sources; DROP TABLE visited;
      DROP INDEX rendered_call; ALTER TABLE rendered DROP COLUMN data;
      COMMIT; VACUUM;`);index.close();index=undefined;
    const css=fs.readFileSync(path.join(ownDir,'reader.css'),'utf8'),js=fs.readFileSync(path.join(ownDir,'reader.js'),'utf8'),template=fs.readFileSync(path.join(ownDir,'reader.html'),'utf8');
    const nonce=hash(String(Date.now())+Math.random()).slice(0,24);
    fs.writeFileSync(path.join(work,'index.html'),template.replaceAll('__NONCE__',nonce).replace('__CSS__',css).replace('__BOOT__',safeJson(manifest)).replace('__APP__',js));
    manifest.elapsedMs=Date.now()-started;writeJson(work,'manifest.json',manifest);
    writeJson(work,'job.json',{status:manifest.status,sessionId:options.sessionId,completedAt:new Date().toISOString()});
    fs.writeFileSync(path.join(work,'README.txt'),'Open index.html. For offline reading, select this archive folder once when prompted. The HTML includes its reader; data stays local. Copy the entire folder. manifest.json records snapshot boundaries and omissions. index.sqlite and checksums.jsonl preserve the exported indexes and file identities.\n');
    const checksum=fs.openSync(path.join(work,'checksums.jsonl'),'wx');let files=0;
    async function walk(dir){for await(const entry of await fs.promises.opendir(dir)){const full=path.join(dir,entry.name);if(entry.isDirectory())await walk(full);else if(entry.name!=='checksums.jsonl'){const digest=createHash('sha256');for await(const chunk of fs.createReadStream(full))digest.update(chunk);fs.writeSync(checksum,JSON.stringify({path:path.relative(work,full).replaceAll('\\','/'),bytes:fs.statSync(full).size,sha256:digest.digest('hex')})+'\n');files++;}}}
    await walk(work);fs.closeSync(checksum);options.signal?.throwIfAborted();fs.renameSync(work,destination);
    progress({phase:'complete',files,items:manifest.itemCount,status:manifest.status});
    return {destination,index:path.join(destination,'index.html'),manifest:path.join(destination,'manifest.json'),status:manifest.status,sources:manifest.sources.length,items:manifest.itemCount,files,noticeCount:manifest.notices.length,notices:manifest.notices.slice(0,20),elapsedMs:Date.now()-started};
  } catch(error) {
    try{index?.exec('COMMIT');}catch{}try{index?.close();}catch{}
    writeJson(work,'job.json',{status:options.signal?.aborted?'cancelled':'failed',error:error.message,at:new Date().toISOString()});throw error;
  } finally {storage?.close();for(const source of capture?.sources??[])try{fs.closeSync(source.fd);}catch{}}
}
