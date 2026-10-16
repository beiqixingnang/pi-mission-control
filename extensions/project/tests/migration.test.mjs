import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostDir} from '../../../scripts/host.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const {SessionManager}=await import(pathToFileURL(path.join(hostDir,'dist/index.js')));
const {createJiti}=await import(pathToFileURL(path.join(hostDir,'node_modules/jiti/lib/jiti.mjs')));
const require=createRequire(path.join(hostDir,'package.json'));
const jiti=createJiti(import.meta.url,{alias:{'@earendil-works/pi-coding-agent':path.join(hostDir,'dist/index.js'),typebox:require.resolve('typebox')}});
const {planMigration,prepareMigration,rollbackMigration,rebase}=await jiti.import(path.join(root,'extensions/project/migration.ts'));
function fixture(fn){
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'pi-project-migration-')));
 const originalCwd=process.cwd(),priorAgent=process.env.PI_CODING_AGENT_DIR;
 const source=path.join(base,'1'),target=path.join(base,'2'),agent=path.join(base,'agent');
 fs.mkdirSync(source);fs.mkdirSync(agent);process.env.PI_CODING_AGENT_DIR=agent;
 try{return fn({base,source,target,agent});}finally{process.chdir(originalCwd);if(priorAgent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=priorAgent;fs.rmSync(base,{recursive:true,force:true});}
}
const remember=(session,text)=>session.appendMessage({role:'user',content:text,timestamp:Date.now()});

test('rename keeps every historical entry, active branch, child memory and new-directory session discovery',()=>{
 fixture(f=>{
  const manager=SessionManager.create(f.source);remember(manager,'Original conversation');
  const chosen=manager.appendMessage({role:'assistant',content:[{type:'thinking',thinking:'PRIVATE_THOUGHT',thinkingSignature:'opaque-signature'},{type:'text',text:'chosen answer'}],timestamp:Date.now()});
  remember(manager,'abandoned branch');manager.branch(chosen);
  const sub=path.join(f.source,'sub');fs.mkdirSync(sub);
  const child=SessionManager.create(sub);remember(child,'CHILD_MEMORY_MARKER');
  const member={name:'worker',role:'worker',cwd:sub,persistent:true,sessionId:child.getSessionId(),communication:{allow:[]},createdAt:Date.now(),turns:1,workspace:{root:sub,access:'read-only',extraReadRoots:[path.join(f.base,'outside')],execution:'disabled'}};
  manager.appendCustomEntry('team-roster',{version:1,members:[member],pendingJobs:[],completedJobs:[{id:'done',member:'worker',ok:true,reply:'saved result'}]});
  manager.appendCustomEntry('goal-state',{id:'g',status:'running',criteria:['c'],pending:[],results:[{id:'done'}],verificationCommands:['node check.js'],outputTokens:8});
  const oldEntries=structuredClone(manager.getEntries());const oldFile=manager.getSessionFile();
  process.chdir(f.source);
  const migration=prepareMigration(planMigration('rename','2',f.source),manager,{worker:child.getSessionFile()});
  assert.equal(fs.existsSync(f.source),false);assert.equal(fs.existsSync(f.target),true);
  assert.equal(fs.existsSync(oldFile),true);assert.equal(fs.existsSync(migration.backup),true);
  const next=SessionManager.open(migration.sessionFile);
  assert.equal(next.getCwd(),f.target);assert.notEqual(next.getSessionId(),manager.getSessionId());
  assert.deepEqual(next.getEntries().slice(0,oldEntries.length),oldEntries);
  assert.ok(!JSON.stringify(next.getBranch()).includes('abandoned branch'));
  const roster=next.getBranch().filter(e=>e.customType==='team-roster').at(-1).data;
  assert.equal(roster.members[0].cwd,path.join(f.target,'sub'));assert.equal(roster.members[0].workspace.root,path.join(f.target,'sub'));
  assert.equal(roster.members[0].workspace.extraReadRoots[0],path.join(f.base,'outside'));
  assert.deepEqual(roster.completedJobs,[{id:'done',member:'worker',ok:true,reply:'saved result'}]);
  const childFile=SessionManager.findById(path.join(f.target,'sub'),roster.members[0].sessionId);
  assert.ok(childFile);assert.match(fs.readFileSync(childFile,'utf8'),/CHILD_MEMORY_MARKER/);
  const goal=next.getBranch().filter(e=>e.customType==='goal-state').at(-1).data;assert.equal(goal.status,'paused');assert.equal(goal.outputTokens,8);
  assert.equal(SessionManager.findById(f.target,next.getSessionId()),migration.sessionFile);
  assert.equal(SessionManager.continueRecent(f.target).getSessionId(),next.getSessionId());
  assert.equal(fs.readFileSync(migration.journal,'utf8').includes('PRIVATE_THOUGHT'),false);
 });
});

test('switch preserves member authorizations and source directory; rollback removes only continuation files',()=>fixture(f=>{
 fs.mkdirSync(f.target);const manager=SessionManager.create(f.source);remember(manager,'Switch history');
 manager.appendCustomEntry('team-roster',{version:1,members:[{name:'worker',role:'w',cwd:f.source,persistent:true,sessionId:'123e4567-e89b-12d3-a456-426614174000',communication:{allow:[]},createdAt:Date.now()}],pendingJobs:[],completedJobs:[]});
 const migration=prepareMigration(planMigration('switch',f.target,f.source),manager,{});
 const next=SessionManager.open(migration.sessionFile);const roster=next.getBranch().filter(e=>e.customType==='team-roster').at(-1).data;
 assert.equal(roster.members[0].cwd,f.source);assert.ok(fs.existsSync(f.source));
 rollbackMigration(migration);assert.equal(fs.existsSync(migration.sessionFile),false);assert.ok(fs.existsSync(manager.getSessionFile()));assert.ok(fs.existsSync(migration.backup));
}));

test('rename refuses overwrite and containment, and missing child memory rolls back the directory',()=>fixture(f=>{
 fs.mkdirSync(f.target);assert.throws(()=>planMigration('rename',f.target,f.source),/already exists/);fs.rmdirSync(f.target);
 assert.throws(()=>planMigration('rename',path.join(f.source,'nested'),f.source),/inside/);
 const manager=SessionManager.create(f.source);remember(manager,'Recovery history');
 manager.appendCustomEntry('team-roster',{version:1,members:[{name:'worker',role:'w',cwd:f.source,persistent:true,sessionId:'123e4567-e89b-12d3-a456-426614174000',turns:2,communication:{allow:[]},createdAt:Date.now()}],pendingJobs:[],completedJobs:[]});
 process.chdir(f.source);
 assert.throws(()=>prepareMigration(planMigration('rename','2',f.source),manager,{}),/Cannot locate/);
 assert.ok(fs.existsSync(f.source));assert.equal(fs.existsSync(f.target),false);assert.equal(process.cwd(),f.source);
}));

test('custom session directories remain usable after rename, including storage inside the project',()=>fixture(f=>{
 const sessions=path.join(f.source,'sessions');const manager=SessionManager.create(f.source,sessions);remember(manager,'CUSTOM_STORAGE_MEMORY');
 const migration=prepareMigration(planMigration('rename','2',f.source),manager,{});
 const expected=path.join(f.target,'sessions');assert.equal(path.dirname(migration.sessionFile),expected);
 assert.equal(SessionManager.continueRecent(f.target,expected).getSessionId(),SessionManager.open(migration.sessionFile).getSessionId());
 assert.ok(fs.existsSync(migration.backup));
 rollbackMigration(migration);assert.ok(fs.existsSync(manager.getSessionFile()));assert.equal(fs.existsSync(f.target),false);
}));

test('path rebasing never changes prefix siblings or paths outside the original project',()=>fixture(f=>{
 assert.equal(rebase(f.source+'-other',f.source,f.target),f.source+'-other');
 assert.equal(rebase(path.join(f.source,'sub'),f.source,f.target),path.join(f.target,'sub'));
}));
