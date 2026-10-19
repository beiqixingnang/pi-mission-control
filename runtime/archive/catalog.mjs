import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {sanitize,writeJson} from './storage.mjs';
import {nativePath,canonical,captureFile} from './scan.mjs';

export function createIndex(file) {
  const db=new DatabaseSync(file);db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; PRAGMA secure_delete=ON; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;
    CREATE TABLE catalog(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id));
    CREATE TABLE sources(id TEXT PRIMARY KEY,member TEXT,data TEXT);
    CREATE TABLE records(seq INTEGER PRIMARY KEY,source TEXT,id TEXT,parent TEXT,type TEXT,role TEXT,time TEXT,eligible INTEGER,data TEXT);
    CREATE INDEX record_source ON records(source,seq);
    CREATE TABLE items(seq INTEGER PRIMARY KEY,record INTEGER,kind TEXT,data TEXT);
    CREATE INDEX item_record ON items(record,seq);
    CREATE TABLE item_bodies(item INTEGER,body INTEGER);
    CREATE TABLE body_segments(body INTEGER,part INTEGER,path TEXT,chars INTEGER,PRIMARY KEY(body,part));
    CREATE TABLE chunks(sha TEXT PRIMARY KEY,path TEXT,bytes INTEGER);
    CREATE TABLE search_segments(seq INTEGER PRIMARY KEY,body INTEGER,part INTEGER,path TEXT,before_text TEXT,bits TEXT);
    CREATE INDEX search_body ON search_segments(body);
    CREATE TABLE legacy_members(id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE assets(path TEXT PRIMARY KEY,data TEXT);
  `);return db;
}
export function captureCatalog(options,index,manifest) {
  const stateDir=path.resolve(nativePath(options.stateDirectory)),agent=path.resolve(stateDir,'../../..');
  const main=path.resolve(nativePath(options.sessionFile));
  const allowedRoots=[stateDir,path.join(agent,'sessions'),path.dirname(main)].filter(p=>fs.existsSync(p)).map(canonical);
  const candidates=new Map([[main,{member:'lead'}]]),members=new Map();
  const addPath=(file,member)=>{if(typeof file==='string'&&file.endsWith('.jsonl'))candidates.set(nativePath(file),{member:member??'unknown'});};
  const addMember=m=>{if(!m?.id)return;members.set(m.id,m);addPath(m.sessionFile,m.id);};
  const store=index.prepare('INSERT OR REPLACE INTO catalog VALUES(?,?,?)');
  const database=path.join(stateDir,'state.sqlite');
  if(fs.existsSync(database)) {
    const db=new DatabaseSync(database,{readOnly:true});
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;');
      const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
      const mapping={members:'member',tasks:'task',schedules:'schedule',goal_nodes:'goal',goal_acceptances:'acceptance',goal_receipts:'receipt',goal_missions:'mission',deliveries:'delivery'};
      // Archives first, so live identities/versions override their old copies.
      if(options.includeArchived!==false&&tables.has('lifecycle_archive'))for(const row of db.prepare('SELECT kind,id,data FROM lifecycle_archive ORDER BY rowid').iterate()) {
        const value=sanitize(JSON.parse(row.data));store.run(row.kind==='goal'?'mission':row.kind,row.id,JSON.stringify(value));
        if(row.kind==='member')addMember(value);if(row.kind==='task')addPath(value.sessionFile,value.memberId);
      }
      for(const [table,kind] of Object.entries(mapping))if(tables.has(table))for(const row of db.prepare(`SELECT id,data FROM ${table} ORDER BY rowid`).iterate()) {
        const value=sanitize(JSON.parse(row.data));
        if(options.includeArchived===false&&value.archivedAt)continue;
        store.run(kind,row.id,JSON.stringify(value));if(kind==='member')addMember(value);if(kind==='task')addPath(value.sessionFile,value.memberId);
      }
      if(tables.has('meta'))for(const row of db.prepare('SELECT key,data FROM meta ORDER BY key').iterate()) {
        if(['mission','leadRecovery','missionActivityClock','reportIntervalMs','goalMaxDepth','relocationHold','escapeHold','projectId'].includes(row.key)||row.key.startsWith('goalFocus:'))store.run('meta',row.key,JSON.stringify(sanitize(JSON.parse(row.data))));
      }
      if(tables.has('events'))for(const row of db.prepare('SELECT sequence,at,kind,entity,data FROM events ORDER BY sequence').iterate())store.run('event',String(row.sequence),JSON.stringify(sanitize({...row,data:JSON.parse(row.data)})));
      manifest.databaseCapturedAt=new Date().toISOString();db.exec('COMMIT;');
    } finally{db.close();}
  } else manifest.notices.push({kind:'no-ledger',message:'No task database was available; only captured session records can be exported.'});
  for(const [id] of members) {
    if(!/^[\w-]+$/.test(id))continue;
    const dir=path.join(stateDir,'sessions',id);if(!fs.existsSync(dir))continue;
    for(const entry of fs.readdirSync(dir,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.jsonl'))addPath(path.join(dir,entry.name),id);
  }
  // An accidentally shared path must never turn the main transcript into a member.
  candidates.set(main,{member:'lead'});
  const sources=[],seen=new Set();
  for(const [file,association] of candidates) {
    try {
      const key=canonical(file);if(seen.has(key))continue;
      const source=captureFile(file,allowedRoots);source.id='s'+String(sources.length).padStart(5,'0');source.member=association.member;
      sources.push(source);seen.add(key);
    } catch(error) {if(file===main)throw error;manifest.notices.push({kind:'missing-source',file,message:error.message});}
  }
  return {stateDir,agent,allowedRoots,sources,members,seen};
}
export function materializeCatalog(root,index,manifest) {
  const kinds=index.prepare('SELECT kind,COUNT(*) AS count FROM catalog GROUP BY kind ORDER BY kind').all();
  manifest.catalog={};
  for(const {kind,count} of kinds) {
    let page=[],n=0,bytes=0;const pages=[];
    for(const row of index.prepare('SELECT data FROM catalog WHERE kind=? ORDER BY id').iterate(kind)) {
      if(page.length&&bytes+Buffer.byteLength(row.data)>512*1024){const name=`catalog/${kind}-${n++}.json`;writeJson(root,name,page);pages.push(name);page=[];bytes=0;}
      page.push(JSON.parse(row.data));bytes+=Buffer.byteLength(row.data);if(page.length===100){const name=`catalog/${kind}-${n++}.json`;writeJson(root,name,page);pages.push(name);page=[];bytes=0;}
    }
    if(page.length){const name=`catalog/${kind}-${n++}.json`;writeJson(root,name,page);pages.push(name);}
    manifest.catalog[kind]={count,pages};
  }
}
