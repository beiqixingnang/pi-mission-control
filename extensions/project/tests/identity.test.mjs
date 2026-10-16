import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostDir} from '../../../scripts/host.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const identityFile=path.join(root,'extensions/project/identity.ts');
const jitiUrl=pathToFileURL(path.join(hostDir,'node_modules/jiti/lib/jiti.mjs')).href;
const {createJiti}=await import(jitiUrl);
const require=createRequire(path.join(hostDir,'package.json'));
const alias={'@earendil-works/pi-coding-agent':path.join(hostDir,'dist/index.js'),typebox:require.resolve('typebox')};
const loadIdentity=()=>createJiti(import.meta.url,{alias,moduleCache:false,fsCache:false}).import(identityFile);
const identity=await loadIdentity();
const {getProjectIdentity,relocateProject,associateProjectSession,resolveProjectPath,lookupProject}=identity;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unknownId='123e4567-e89b-42d3-a456-426614174000';
function waitForMessage(child,type){
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{clearTimeout(timer);child.off('message',message);child.off('close',closed);child.off('error',failed);};
  const failed=error=>{cleanup();reject(error);};
  const closed=code=>failed(new Error(`Identity child exited (${code}) before ${type}`));
  const message=value=>{if(value?.type===type){cleanup();resolve(value);}};
  const timer=setTimeout(()=>failed(new Error(`Identity child did not send ${type}`)),30000);
  child.on('message',message);child.once('close',closed);child.once('error',failed);
  if(child.exitCode!==null||child.signalCode!==null)closed(child.exitCode);
 });
}

async function fixture(fn){
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'pi-project-identity-')));
 const source=path.join(base,'1'),target=path.join(base,'2'),third=path.join(base,'3'),agent=path.join(base,'agent');
 fs.mkdirSync(source);fs.mkdirSync(agent);
 const previousAgent=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agent;
 const registry=path.join(agent,'projects','registry.json');
 const session=name=>{const file=path.join(agent,'sessions',name+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({message:`Historical evidence from ${source}`})+'\n');return file;};
 try{return await fn({base,source,target,third,agent,registry,session});}
 finally{if(previousAgent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousAgent;fs.rmSync(base,{recursive:true,force:true});}
}

test('identity registration is canonical, stable and writes only outside the workspace',()=>fixture(f=>{
 const evidence=path.join(f.source,'notes.txt');fs.writeFileSync(evidence,'original evidence');
 const project=getProjectIdentity(f.source);
 assert.match(project.id,uuid);assert.equal(project.currentPath,fs.realpathSync.native(f.source));
 assert.deepEqual(project.previousPaths,[]);assert.deepEqual(project.sessions,[]);
 assert.deepEqual(getProjectIdentity(f.source),project);
 assert.deepEqual(fs.readdirSync(f.source),['notes.txt']);assert.equal(fs.readFileSync(evidence,'utf8'),'original evidence');
 assert.equal(fs.existsSync(path.join(f.source,'.pi','project-id.json')),false);
 const saved=JSON.parse(fs.readFileSync(f.registry,'utf8'));
 assert.equal(saved.version,1);assert.deepEqual(saved.projects,[project]);
 project.previousPaths.push(path.join(f.base,'forged'));project.sessions.push(path.join(f.base,'forged-session'));
 assert.deepEqual(lookupProject(project.id).previousPaths,[]);assert.deepEqual(getProjectIdentity(f.source).sessions,[]);
}));

test('foreign-platform paths coexist with a new native identity without rebinding either project',()=>fixture(f=>{
 const foreignPaths=process.platform==='win32'?path.posix:path.win32;
 const foreignRoot=process.platform==='win32'?'/__pi_foreign_platform__':'Z:\\__pi_foreign_platform__';
 const foreign={id:unknownId,currentPath:foreignPaths.join(foreignRoot,'Project'),previousPaths:[foreignPaths.join(foreignRoot,'OldProject')],sessions:[foreignPaths.join(foreignRoot,'sessions','history.jsonl')]};
 fs.mkdirSync(path.dirname(f.registry),{recursive:true});fs.writeFileSync(f.registry,JSON.stringify({version:1,projects:[foreign]}));
 const native=getProjectIdentity(f.source),session=f.session('native');
 assert.notEqual(native.id,foreign.id);assert.equal(native.currentPath,fs.realpathSync.native(f.source));
 const associated=associateProjectSession(native.id,session);
 assert.deepEqual(lookupProject(foreign.id),foreign);assert.deepEqual(lookupProject(foreign.currentPath),foreign);
 assert.deepEqual(lookupProject(foreign.previousPaths[0]),foreign);
 assert.equal(resolveProjectPath(foreign.id,foreignPaths.join(foreign.previousPaths[0],'src','index.ts')),foreignPaths.join(foreign.currentPath,'src','index.ts'));
 assert.equal(resolveProjectPath(foreign.id,foreign.previousPaths[0]+'-sibling'),foreign.previousPaths[0]+'-sibling');
 assert.throws(()=>associateProjectSession(native.id,foreign.sessions[0]),/native absolute path/);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.registry,'utf8')).projects,[foreign,associated]);
 assert.equal(getProjectIdentity(f.source).id,native.id);assert.equal(fs.existsSync(path.join(f.source,'.pi')),false);
}));

test('Windows path comparisons fold case while POSIX path comparisons preserve it on every host',()=>fixture(f=>{
 const windows={id:unknownId,currentPath:'Z:\\__pi_path_case__\\Project',previousPaths:[],sessions:[]};
 const upper={id:'123e4567-e89b-42d3-a456-426614174001',currentPath:'/__pi_path_case__/Project',previousPaths:[],sessions:[]};
 const lower={id:'123e4567-e89b-42d3-a456-426614174002',currentPath:'/__pi_path_case__/project',previousPaths:[],sessions:[]};
 fs.mkdirSync(path.dirname(f.registry),{recursive:true});fs.writeFileSync(f.registry,JSON.stringify({version:1,projects:[windows,upper,lower]}));
 const native=getProjectIdentity(f.source);
 assert.equal(lookupProject('z:\\__PI_PATH_CASE__\\PROJECT').id,windows.id);
 assert.equal(lookupProject(upper.currentPath).id,upper.id);assert.equal(lookupProject(lower.currentPath).id,lower.id);
 assert.equal(lookupProject('/__PI_PATH_CASE__/PROJECT'),undefined);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.registry,'utf8')).projects,[windows,upper,lower,native]);
}));

test('native realpath treats directory symlinks and normalized paths as the same workspace',()=>fixture(f=>{
 const sub=path.join(f.source,'sub');fs.mkdirSync(sub);
 const project=getProjectIdentity(f.source);
 assert.equal(getProjectIdentity(sub+path.sep+'..').id,project.id);
 const link=path.join(f.base,'linked-workspace');
 try{fs.symlinkSync(f.source,link,process.platform==='win32'?'junction':'dir');}
 catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code))return;throw error;}
 assert.equal(getProjectIdentity(link).id,project.id);assert.equal(lookupProject(link).id,project.id);
 assert.equal(JSON.parse(fs.readFileSync(f.registry,'utf8')).projects.length,1);
}));

test('sequential renames keep one UUID, every alias and every association without rebasing sibling prefixes',()=>fixture(f=>{
 const original=getProjectIdentity(f.source),first=f.session('original'),second=f.session('second'),third=f.session('third');
 const evidence=fs.readFileSync(first,'utf8');associateProjectSession(original.id,first);
 fs.renameSync(f.source,f.target);
 const renamed=relocateProject(original.id,f.source,f.target,second);
 assert.equal(renamed.id,original.id);assert.deepEqual(renamed.previousPaths,[f.source]);
 fs.renameSync(f.target,f.third);
 const latest=relocateProject(original.id,f.target,f.third,third);
 assert.equal(latest.currentPath,f.third);assert.deepEqual(latest.previousPaths,[f.source,f.target]);
 assert.deepEqual(latest.sessions,[first,second,third]);assert.equal(getProjectIdentity(f.third).id,original.id);
 for(const old of [f.source,f.target]){
  assert.equal(resolveProjectPath(original.id,old),f.third);
  assert.equal(resolveProjectPath(original.id,path.join(old,'src','index.ts')),path.join(f.third,'src','index.ts'));
  assert.equal(resolveProjectPath(original.id,old+'-sibling'),old+'-sibling');
  assert.equal(resolveProjectPath(original.id,path.join(old+'-sibling','file.ts')),path.join(old+'-sibling','file.ts'));
  assert.equal(lookupProject(old).id,original.id);
 }
 assert.equal(resolveProjectPath(original.id,path.join(f.third,'src')),path.join(f.third,'src'));
 assert.equal(resolveProjectPath(original.id,path.join(f.base,'outside')),path.join(f.base,'outside'));
 assert.equal(fs.readFileSync(first,'utf8'),evidence);assert.equal(JSON.parse(fs.readFileSync(f.registry,'utf8')).projects.length,1);
 assert.deepEqual(relocateProject(original.id,f.target,f.third,third),latest);
}));

test('associations and aliases survive module reload and a fresh process',()=>fixture(async f=>{
 const project=getProjectIdentity(f.source),original=f.session('original'),continuation=f.session('continuation');
 associateProjectSession(project.id,original);fs.renameSync(f.source,f.target);
 const committed=relocateProject(project.id,f.source,f.target,continuation);
 const reloaded=await loadIdentity();assert.deepEqual(reloaded.lookupProject(project.id),committed);
 assert.equal(reloaded.getProjectIdentity(f.target).id,project.id);
 const program=`import {createJiti} from ${JSON.stringify(jitiUrl)};
 const jiti=createJiti(import.meta.url,{alias:${JSON.stringify(alias)}});
 const api=await jiti.import(${JSON.stringify(identityFile)});
 process.stdout.write(JSON.stringify({project:api.getProjectIdentity(${JSON.stringify(f.target)}),alias:api.resolveProjectPath(${JSON.stringify(project.id)},${JSON.stringify(path.join(f.source,'src'))})}));`;
 const child=spawnSync(process.execPath,['--input-type=module','--eval',program],{encoding:'utf8',env:{...process.env,PI_CODING_AGENT_DIR:f.agent},timeout:30000,windowsHide:true});
 assert.ifError(child.error);assert.equal(child.status,0,child.stderr);
 const restarted=JSON.parse(child.stdout);assert.deepEqual(restarted.project,committed);assert.equal(restarted.alias,path.join(f.target,'src'));
}));

test('switch keeps distinct target identity while the continuation can link both projects',()=>fixture(f=>{
 fs.mkdirSync(f.target);
 const source=getProjectIdentity(f.source),target=getProjectIdentity(f.target),original=f.session('original'),continuation=f.session('continuation');
 assert.notEqual(source.id,target.id);associateProjectSession(source.id,original);
 associateProjectSession(source.id,continuation);associateProjectSession(target.id,continuation);
 assert.deepEqual(lookupProject(source.id),{...source,sessions:[original,continuation]});
 assert.deepEqual(lookupProject(target.id),{...target,sessions:[continuation]});
 assert.equal(resolveProjectPath(source.id,path.join(f.source,'src')),path.join(f.source,'src'));
 assert.equal(resolveProjectPath(target.id,path.join(f.source,'src')),path.join(f.source,'src'));
 assert.ok(fs.existsSync(f.source));
}));

test('clones with the same remote and forged project markers get different registry-issued IDs',()=>fixture(f=>{
 fs.mkdirSync(f.target);
 for(const directory of [f.source,f.target]){fs.mkdirSync(path.join(directory,'.git'));fs.writeFileSync(path.join(directory,'.git','config'),'[remote "origin"]\nurl = https://example.invalid/same-repository.git\n');}
 const first=getProjectIdentity(f.source);
 fs.mkdirSync(path.join(f.target,'.pi'));const marker=path.join(f.target,'.pi','project-id.json');fs.writeFileSync(marker,JSON.stringify({id:first.id}));
 const second=getProjectIdentity(f.target);assert.notEqual(second.id,first.id);assert.match(second.id,uuid);
 assert.equal(JSON.parse(fs.readFileSync(marker,'utf8')).id,first.id);
 assert.equal(getProjectIdentity(f.source).id,first.id);
}));

test('preparation and rollback do not commit identity or aliases',()=>fixture(f=>{
 const initial=getProjectIdentity(f.source);associateProjectSession(initial.id,f.session('original'));
 const before=fs.readFileSync(f.registry,'utf8');
 // Model migration preparation and a cancelled host switch: move the directory, then restore it.
 fs.renameSync(f.source,f.target);
 assert.equal(lookupProject(initial.id).currentPath,f.source);assert.equal(lookupProject(f.target),undefined);
 assert.equal(fs.readFileSync(f.registry,'utf8'),before);
 fs.renameSync(f.target,f.source);
 assert.equal(getProjectIdentity(f.source).id,initial.id);assert.equal(fs.readFileSync(f.registry,'utf8'),before);
 assert.deepEqual(lookupProject(initial.id).previousPaths,[]);
}));

test('relocation rejects an occupied target, unknown UUID, live source and stale source without changing records',()=>fixture(f=>{
 const source=getProjectIdentity(f.source),session=f.session('continuation');fs.mkdirSync(f.target);
 const target=getProjectIdentity(f.target),before=fs.readFileSync(f.registry,'utf8');
 assert.throws(()=>relocateProject(source.id,f.source,f.target,session),/already registered/);
 assert.equal(fs.readFileSync(f.registry,'utf8'),before);
 fs.mkdirSync(f.third);
 assert.throws(()=>relocateProject(source.id,f.source,f.third,session),/source still exists/);
 assert.throws(()=>relocateProject(source.id,f.target,f.third,session),/source does not match/);
 assert.throws(()=>relocateProject(unknownId,f.source,f.third,session),/Unknown project ID/);
 assert.throws(()=>associateProjectSession('../../forged',session),/Invalid project ID/);
 assert.throws(()=>associateProjectSession(unknownId,session),/Unknown project ID/);
 assert.equal(lookupProject(unknownId),undefined);
 assert.equal(fs.readFileSync(f.registry,'utf8'),before);assert.equal(lookupProject(f.target).id,target.id);
}));

test('historical target aliases reject other projects and reused directories cannot claim them implicitly',()=>fixture(f=>{
 const original=getProjectIdentity(f.source),session=f.session('first');fs.renameSync(f.source,f.target);
 relocateProject(original.id,f.source,f.target,session);
 fs.mkdirSync(f.source);assert.throws(()=>getProjectIdentity(f.source),/historical alias/);
 fs.mkdirSync(f.third);const other=getProjectIdentity(f.third),before=fs.readFileSync(f.registry,'utf8');
 assert.throws(()=>relocateProject(other.id,f.third,f.source,session),/already registered/);
 assert.equal(fs.readFileSync(f.registry,'utf8'),before);assert.equal(lookupProject(f.source).id,original.id);
}));

test('a rename back to a previous root preserves a consistent alias list',()=>fixture(f=>{
 const project=getProjectIdentity(f.source),session=f.session('continuation');fs.renameSync(f.source,f.target);
 relocateProject(project.id,f.source,f.target,session);fs.renameSync(f.target,f.source);
 const returned=relocateProject(project.id,f.target,f.source,session);
 assert.equal(returned.id,project.id);assert.equal(returned.currentPath,f.source);assert.deepEqual(returned.previousPaths,[f.target]);
 assert.equal(resolveProjectPath(project.id,path.join(f.target,'src')),path.join(f.source,'src'));
}));

test('each mutation rereads disk, preserves other projects and deduplicates session associations',()=>fixture(async f=>{
 fs.mkdirSync(f.target);const first=getProjectIdentity(f.source),second=getProjectIdentity(f.target),a=f.session('a'),b=f.session('b');
 const independent=await loadIdentity();
 associateProjectSession(first.id,a);independent.associateProjectSession(second.id,b);associateProjectSession(first.id,a);
 assert.deepEqual(lookupProject(first.id).sessions,[a]);assert.deepEqual(lookupProject(second.id).sessions,[b]);
 fs.renameSync(f.source,f.third);relocateProject(first.id,f.source,f.third,b);
 assert.deepEqual(lookupProject(second.id),{...second,sessions:[b]});
 assert.equal(fs.readdirSync(path.dirname(f.registry)).some(name=>name.endsWith('.tmp')),false);
}));

test('malformed registries fail closed without replacing any original bytes',()=>fixture(f=>{
 const project=getProjectIdentity(f.source),session=f.session('continuation');
 const good=JSON.parse(fs.readFileSync(f.registry,'utf8'));
 const changed=fn=>{const value=structuredClone(good);fn(value);return JSON.stringify(value);};
 const invalid=[
  '{broken',
  'null',
  JSON.stringify({version:2,projects:[]}),
  JSON.stringify({version:1,projects:{}}),
  changed(value=>{value.projects[0].id='../../forged';}),
  changed(value=>{value.projects[0].id='123e4567-e89b-12d3-a456-426614174000';}),
  changed(value=>{value.projects[0].currentPath='relative/workspace';}),
  changed(value=>{value.projects[0].currentPath=f.source+path.sep+'..'+path.sep+'escape';}),
  changed(value=>{value.projects[0].previousPaths=[f.source];}),
  changed(value=>{value.projects[0].previousPaths=[null];}),
  changed(value=>{value.projects[0].sessions=[session,session];}),
  changed(value=>{value.projects[0].sessions=[f.source+path.sep+'..'+path.sep+'forged.jsonl'];}),
  changed(value=>{value.projects.push({...value.projects[0],id:unknownId});}),
  changed(value=>{value.projects.push({...value.projects[0],currentPath:f.target});}),
  changed(value=>{value.unrecognized='do not discard';}),
 ];
 for(const raw of invalid){
  fs.writeFileSync(f.registry,raw);
  assert.throws(()=>getProjectIdentity(f.source),/Invalid project registry/);
  assert.throws(()=>associateProjectSession(project.id,session),/Invalid project registry/);
  assert.throws(()=>lookupProject(project.id),/Invalid project registry/);
  assert.throws(()=>resolveProjectPath(project.id,f.source),/Invalid project registry/);
  assert.equal(fs.readFileSync(f.registry,'utf8'),raw);
 }
}));

test('failed atomic replacement retains the prior registry and removes its temporary file',()=>fixture(async f=>{
 const project=getProjectIdentity(f.source),first=f.session('first'),next=f.session('next');associateProjectSession(project.id,first);
 const before=fs.readFileSync(f.registry,'utf8'),originalRename=fs.renameSync;
 fs.renameSync=(source,target)=>{if(path.basename(String(target))==='registry.json')throw Object.assign(new Error('fixture atomic commit failed'),{code:'EIO'});return originalRename(source,target);};
 syncBuiltinESMExports();
 try{const failing=await loadIdentity();assert.throws(()=>failing.associateProjectSession(project.id,next),/fixture atomic commit failed/);}
 finally{fs.renameSync=originalRename;syncBuiltinESMExports();}
 assert.equal(fs.readFileSync(f.registry,'utf8'),before);assert.deepEqual(fs.readdirSync(path.dirname(f.registry)),['registry.json']);
 assert.deepEqual(lookupProject(project.id).sessions,[first]);
 assert.deepEqual(associateProjectSession(project.id,next).sessions,[first,next]);
}));

test('an agent directory within the workspace is rejected before creating a registry',()=>fixture(f=>{
 const nestedAgent=path.join(f.source,'agent');process.env.PI_CODING_AGENT_DIR=nestedAgent;
 assert.throws(()=>getProjectIdentity(f.source),/registry must be outside/);
 assert.equal(fs.existsSync(nestedAgent),false);
}));

test('traversal arguments cannot be stored or resolved and lookups never create projects',()=>fixture(f=>{
 assert.equal(lookupProject(f.source),undefined);assert.equal(fs.existsSync(f.registry),false);
 const project=getProjectIdentity(f.source),before=fs.readFileSync(f.registry,'utf8');
 assert.throws(()=>associateProjectSession(project.id,f.agent+path.sep+'..'+path.sep+'escape.jsonl'),/without traversal/);
 assert.throws(()=>resolveProjectPath(project.id,f.source+path.sep+'..'+path.sep+'escape'),/without traversal/);
 assert.throws(()=>associateProjectSession(project.id,'relative.jsonl'),/absolute path/);
 assert.equal(lookupProject(''),undefined);assert.equal(lookupProject('\0'),undefined);
 assert.equal(fs.readFileSync(f.registry,'utf8'),before);
}));

test('two fresh processes concurrently register distinct projects without losing either update',()=>fixture(async f=>{
 const original=getProjectIdentity(f.source);fs.mkdirSync(f.target);fs.mkdirSync(f.third);
 const workers=[f.target,f.third].map(directory=>{
  const program=`import fs from 'node:fs';
   import {syncBuiltinESMExports} from 'node:module';
   import {createJiti} from ${JSON.stringify(jitiUrl)};
   const jiti=createJiti(import.meta.url,{alias:${JSON.stringify(alias)}});
   const api=await jiti.import(${JSON.stringify(identityFile)});
   const originalRead=fs.readFileSync;let delay=true;
   fs.readFileSync=(file,...args)=>{
    const contents=originalRead(file,...args);
    if(file===${JSON.stringify(f.registry)}&&delay){delay=false;process.send({type:'reading'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,800);}
    return contents;
   };
   syncBuiltinESMExports();
   process.send({type:'ready'});
   await new Promise(resolve=>process.once('message',resolve));
   const project=api.getProjectIdentity(${JSON.stringify(directory)});
   fs.readFileSync=originalRead;syncBuiltinESMExports();
   process.stdout.write(JSON.stringify(project));process.disconnect();`;
  const child=spawn(process.execPath,['--input-type=module','--eval',program],{env:{...process.env,PI_CODING_AGENT_DIR:f.agent},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  let stdout='',stderr='',error;
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.on('error',value=>{error=value;});
  const done=new Promise(resolve=>child.once('close',code=>resolve({code,stdout,stderr,error})));
  return {child,done};
 });
 try{
  await Promise.all(workers.map(worker=>waitForMessage(worker.child,'ready')));
  const reading=waitForMessage(workers[0].child,'reading');workers[0].child.send('start');await reading;
  // Start the second mutation while the first process deliberately holds a registry snapshot.
  workers[1].child.send('start');
  const results=await Promise.all(workers.map(worker=>worker.done));
  for(const result of results){assert.ifError(result.error);assert.equal(result.code,0,result.stderr);}
  const projects=results.map(result=>JSON.parse(result.stdout));
  assert.notEqual(projects[0].id,projects[1].id);
  assert.deepEqual(lookupProject(original.id),original);
  for(const project of projects)assert.deepEqual(lookupProject(project.id),project);
  assert.equal(JSON.parse(fs.readFileSync(f.registry,'utf8')).projects.length,3);
  assert.equal(fs.existsSync(f.registry+'.lock'),false);
 }finally{
  for(const worker of workers)if(worker.child.exitCode===null&&worker.child.signalCode===null)worker.child.kill();
  await Promise.all(workers.map(worker=>worker.done));
 }
}));

test('malformed locks fail safely for all mutation APIs and retain their original contents',()=>fixture(f=>{
 const project=getProjectIdentity(f.source),session=f.session('continuation'),before=fs.readFileSync(f.registry,'utf8'),lock=f.registry+'.lock';
 fs.mkdirSync(f.target);
 const invalid=['{broken','null',JSON.stringify({pid:0,token:unknownId}),JSON.stringify({pid:process.pid,token:'../../forged'}),JSON.stringify({pid:process.pid,token:unknownId,extra:true})];
 for(const raw of invalid){
  fs.mkdirSync(lock);const owner=path.join(lock,'owner.json');fs.writeFileSync(owner,raw);
  assert.throws(()=>getProjectIdentity(f.source),/Invalid project registry lock/);
  assert.throws(()=>associateProjectSession(project.id,session),/Invalid project registry lock/);
  assert.throws(()=>relocateProject(project.id,f.source,f.target,session),/Invalid project registry lock/);
  assert.equal(fs.readFileSync(owner,'utf8'),raw);assert.equal(fs.readFileSync(f.registry,'utf8'),before);
  assert.deepEqual(lookupProject(project.id),project);
  fs.rmSync(lock,{recursive:true});
 }
 fs.writeFileSync(lock,'not a lock directory');
 assert.throws(()=>getProjectIdentity(f.source),/Invalid project registry lock/);
 assert.equal(fs.readFileSync(lock,'utf8'),'not a lock directory');assert.equal(fs.readFileSync(f.registry,'utf8'),before);
}));

test('a live owner lock is never removed and mutation waiting is bounded below three seconds',()=>fixture(f=>{
 const project=getProjectIdentity(f.source),session=f.session('continuation'),lock=f.registry+'.lock',before=fs.readFileSync(f.registry,'utf8');
 fs.mkdirSync(lock);const owner=path.join(lock,'owner.json'),metadata=JSON.stringify({pid:process.pid,token:unknownId});fs.writeFileSync(owner,metadata);
 assert.deepEqual(lookupProject(project.id),project);assert.equal(resolveProjectPath(project.id,f.source),f.source);
 const start=performance.now();assert.throws(()=>associateProjectSession(project.id,session),/Timed out waiting for project registry lock/);
 assert.ok(performance.now()-start<3000,'lock acquisition exceeded its retry budget');
 assert.equal(fs.readFileSync(owner,'utf8'),metadata);assert.equal(fs.readFileSync(f.registry,'utf8'),before);
 fs.rmSync(lock,{recursive:true});assert.deepEqual(associateProjectSession(project.id,session).sessions,[session]);
}));

test('a lock without owner metadata times out without being stolen or changed',()=>fixture(f=>{
 const project=getProjectIdentity(f.source),lock=f.registry+'.lock',before=fs.readFileSync(f.registry,'utf8');fs.mkdirSync(lock);
 const start=performance.now();assert.throws(()=>getProjectIdentity(f.source),/Timed out waiting for project registry lock/);
 assert.ok(performance.now()-start<3000,'incomplete-lock acquisition exceeded its retry budget');
 assert.deepEqual(fs.readdirSync(lock),[]);assert.equal(fs.readFileSync(f.registry,'utf8'),before);assert.deepEqual(lookupProject(project.id),project);
}));

test('an abandoned lock fails safely instead of deleting another process ownership metadata',()=>fixture(f=>{
 const project=getProjectIdentity(f.source),lock=f.registry+'.lock',before=fs.readFileSync(f.registry,'utf8');
 const exited=spawnSync(process.execPath,['--eval',''],{encoding:'utf8',timeout:10000,windowsHide:true});assert.ifError(exited.error);assert.equal(exited.status,0,exited.stderr);
 fs.mkdirSync(lock);const owner=path.join(lock,'owner.json'),metadata=JSON.stringify({pid:exited.pid,token:unknownId});fs.writeFileSync(owner,metadata);
 assert.throws(()=>associateProjectSession(project.id,f.session('continuation')),/Abandoned project registry lock/);
 assert.equal(fs.readFileSync(owner,'utf8'),metadata);assert.equal(fs.readFileSync(f.registry,'utf8'),before);
}));

