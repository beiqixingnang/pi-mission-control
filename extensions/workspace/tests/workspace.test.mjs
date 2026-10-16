import test from 'node:test';
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
import {hostDir} from '../../../scripts/host.mjs';
const pkg=hostDir;
const {loadExtensions,createExtensionRuntime}=await import(pathToFileURL(path.join(pkg,'dist/core/extensions/loader.js')));
const {createEventBus}=await import(pathToFileURL(path.join(pkg,'dist/core/event-bus.js')));
const {createJiti}=await import(pathToFileURL(path.join(pkg,'node_modules/jiti/lib/jiti.mjs')));
const require=createRequire(path.join(pkg,'package.json'));
const jiti=createJiti(import.meta.url,{alias:{typebox:require.resolve('typebox'),'@earendil-works/pi-coding-agent':path.join(pkg,'dist/index.js')}});
const {prepareWorkspaceLaunch}=await jiti.import(path.resolve(here,'../launch.ts'));
const {discoverAgents}=await jiti.import(path.resolve(here,'../../subagent/agents.ts'));
const {createAgentSession,DefaultResourceLoader,SettingsManager,SessionManager}=await import(pathToFileURL(path.join(pkg,'dist/index.js')));
const {WorkspaceAccess,resolveWorkspace,resolveInput,POLICY_ENV,toolAlias}=await import(pathToFileURL(path.resolve(here,'../policy.ts')));

async function fixture(fn){
 let base=await fs.mkdtemp(path.join(os.tmpdir(),'pi-workspace-test-'));
 if(process.platform==='win32')base=realpathSync.native(base);
 const root=path.join(base,'project'),extra=path.join(base,'docs'),outside=path.join(base,'outside');
 for(const dir of [root,extra,outside])await fs.mkdir(dir);
 await fs.writeFile(path.join(root,'inside.txt'),'INSIDE_MARKER\nneedle here\n');await fs.writeFile(path.join(extra,'reference.txt'),'REFERENCE_MARKER');await fs.writeFile(path.join(outside,'secret.txt'),'OUTSIDE_SECRET');
 try{await fn({base,root,extra,outside});}finally{await fs.rm(base,{recursive:true,force:true});}
}
async function guardHarness(f,access='read-write'){
 const policy=await resolveWorkspace({root:f.root,extraReadRoots:[f.extra],access},f.base);
 const previous=process.env[POLICY_ENV];process.env[POLICY_ENV]=JSON.stringify(policy);
 const runtime=createExtensionRuntime();let active=['workspace_read','workspace_write','workspace_edit','workspace_ls','workspace_find','workspace_grep','bash','subagent','codemode'];runtime.getActiveTools=()=>active;runtime.setActiveTools=tools=>{active=tools;};
 const originalCwd=process.cwd();let loaded;
 try{process.chdir(f.root);loaded=await loadExtensions([path.resolve(here,'../index.ts')],f.root,createEventBus(),runtime);}finally{process.chdir(originalCwd);if(previous===undefined)delete process.env[POLICY_ENV];else process.env[POLICY_ENV]=previous;}
 assert.deepEqual(loaded.errors,[]);const extension=loaded.extensions[0];
 const ctx={cwd:f.root,model:undefined,ui:{notify(){}}};
 const hooks=async(name,event={})=>{let result;for(const handler of extension.handlers.get(name)||[])result=await handler({type:name,...event},ctx);return result;};
 // Extension runs in a child whose actual process.cwd is root. Tests load its
 // definition in-process, so use absolute paths to exercise the same guard.
 const tool=async(name,args)=>{name=toolAlias(name);const decision=await hooks('tool_call',{toolName:name,input:args});if(decision?.block)return {isError:true,reason:decision.reason};return extension.tools.get(name).definition.execute('probe',args,undefined,undefined,ctx);};
 await hooks('session_start');return {policy,extension,ctx,hooks,tool,active:()=>active};
}

test('launch binds cwd, disables commands/resources, and passes immutable policy to child',()=>fixture(async f=>{
 const plan=await prepareWorkspaceLaunch({baseCwd:f.base,workspace:{root:'project',access:'read-only',extraReadRoots:['docs']}});
 assert.equal(plan.cwd,await fs.realpath(f.root));assert.equal(plan.workspace.access,'read-only');
 for(const flag of ['--no-extensions','--no-mcp','--no-context-files','--no-skills','--no-approve'])assert.ok(plan.args.includes(flag));
 assert.equal(plan.args[plan.args.indexOf('--tools')+1],'workspace_read,workspace_ls,workspace_find,workspace_grep,workspace_team_message');assert.equal(JSON.parse(plan.env[POLICY_ENV]).root,plan.cwd);
 await assert.rejects(prepareWorkspaceLaunch({baseCwd:f.base,cwd:f.outside,workspace:{root:f.root}}),/cwd must be inside/);
}));
test('unrestricted cwd remains compatible; unsupported sandbox and unsafe tools fail before spawn',()=>fixture(async f=>{
 const legacy=await prepareWorkspaceLaunch({baseCwd:f.base,cwd:'project',tools:['bash','read']});assert.deepEqual(legacy.args,['--tools','bash,read']);assert.deepEqual(legacy.env,{});
 await assert.rejects(prepareWorkspaceLaunch({baseCwd:f.base,workspace:{root:f.root},tools:['bash']}),/not available/);
 await assert.rejects(prepareWorkspaceLaunch({baseCwd:f.base,workspace:{root:f.root,access:'read-only'},tools:['write']}),/not available/);
 await assert.rejects(prepareWorkspaceLaunch({baseCwd:f.base,workspace:{root:f.root,execution:'sandbox'}}),/unavailable/);
 assert.ok((await prepareWorkspaceLaunch({baseCwd:f.base,workspace:{root:f.root},tools:[]})).args.includes('--no-tools'));
}));
test('relative traversal, absolute escapes, prefix siblings and file URLs are denied',()=>fixture(async f=>{
 const access=new WorkspaceAccess(await resolveWorkspace({root:f.root},f.base),f.root);
 for(const input of ['../outside/secret.txt',path.join(f.outside,'secret.txt'),f.root+'-other/secret.txt',pathToFileURL(path.join(f.outside,'secret.txt')).href])await assert.rejects(access.authorize(input),/WORKSPACE_DENIED/);
 assert.equal((await access.read('inside.txt')).toString().startsWith('INSIDE_MARKER'),true);
}));
test('extra roots are readable only and read-only policy blocks both edit and mkdir',()=>fixture(async f=>{
 const access=new WorkspaceAccess(await resolveWorkspace({root:f.root,extraReadRoots:[f.extra]},f.base),f.root);
 assert.equal((await access.read(path.join(f.extra,'reference.txt'))).toString(),'REFERENCE_MARKER');
 await assert.rejects(access.write(path.join(f.extra,'x.txt'),'x'),/outside/);
 const ro=new WorkspaceAccess(await resolveWorkspace({root:f.root,access:'read-only'},f.base),f.root);
 await assert.rejects(ro.mkdir('new'),/read-only/);await assert.rejects(ro.write('inside.txt','modified'),/read-only/);
 assert.match(await fs.readFile(path.join(f.root,'inside.txt'),'utf8'),/INSIDE_MARKER/);
}));
test('junction traversal and missing children below outside junctions are denied',()=>fixture(async f=>{
 await fs.symlink(f.outside,path.join(f.root,'escape'),'junction');
 const access=new WorkspaceAccess(await resolveWorkspace({root:f.root},f.base),f.root);
 for(const target of ['escape/secret.txt','escape/new/deep.txt'])await assert.rejects(access.authorize(target,true,true),/links|junction/);
 await assert.rejects(access.read('escape/secret.txt'),/links|junction/);
}));
test('hardlinks cannot disclose outside data or overwrite their external target',()=>fixture(async f=>{
 await fs.link(path.join(f.outside,'secret.txt'),path.join(f.root,'hard.txt'));
 const access=new WorkspaceAccess(await resolveWorkspace({root:f.root},f.base),f.root);
 await assert.rejects(access.read('hard.txt'),/hard-linked/);await assert.rejects(access.write('hard.txt','overwrite'),/hard-linked/);
 assert.equal(await fs.readFile(path.join(f.outside,'secret.txt'),'utf8'),'OUTSIDE_SECRET');
}));
test('nested writes and exact edits work inside, protected metadata remains unchanged',()=>fixture(async f=>{
 const h=await guardHarness(f);const file=path.join(f.root,'nested','result.txt');
 await h.tool('write',{path:file,content:'before value'});await h.tool('edit',{path:file,edits:[{oldText:'before',newText:'after'}]});
 assert.equal(await fs.readFile(file,'utf8'),'after value');
 for(const dir of ['.pi','.agents','.git'])await assert.rejects(h.tool('write',{path:path.join(f.root,dir,'escape.ts'),content:'x'}),/protected/);
 await assert.rejects(fs.stat(path.join(f.root,'.pi')),/ENOENT/);
}));
test('guard blocks shell, MCP, codemode and all nested delegation, including direct hook calls',()=>fixture(async f=>{
 const h=await guardHarness(f,'read-only');assert.deepEqual(h.active(),['workspace_read','workspace_ls','workspace_find','workspace_grep']);
 for(const name of ['bash','powershell','subagent','team_spawn','codemode','mcp__file__read','write','edit'])assert.equal((await h.hooks('tool_call',{toolName:name,input:{}})).block,true);
 assert.equal((await h.hooks('user_bash')).result.exitCode,1);
 const read=await h.tool('read',{path:path.join(f.root,'inside.txt')});assert.match(read.content[0].text,/INSIDE_MARKER/);
 await assert.rejects(h.tool('read',{path:path.join(f.outside,'secret.txt')}),/WORKSPACE_DENIED/);
}));
test('safe find, grep and ls never follow junctions or outside hardlinks',()=>fixture(async f=>{
 await fs.symlink(f.outside,path.join(f.root,'escape'),'junction');await fs.link(path.join(f.outside,'secret.txt'),path.join(f.root,'hard.txt'));
 const h=await guardHarness(f);
 const found=await h.tool('find',{path:f.root,pattern:'**/*.txt'});assert.match(found.content[0].text,/inside.txt/);assert.doesNotMatch(found.content[0].text,/secret|hard.txt|escape/);
 const grep=await h.tool('grep',{path:f.root,pattern:'MARKER'});assert.match(grep.content[0].text,/INSIDE_MARKER/);assert.doesNotMatch(grep.content[0].text,/OUTSIDE_SECRET/);
 const listing=await h.tool('ls',{path:f.root});assert.doesNotMatch(listing.content[0].text,/escape|hard.txt/);
 await assert.rejects(h.tool('grep',{path:f.root,pattern:'.*',literal:false}),/literal/);
}));
test('missing guard cannot expose ordinary builtin tools through a restricted allowlist',()=>fixture(async f=>{
 const settings=SettingsManager.inMemory({cacheWarming:'off'});
 const loader=new DefaultResourceLoader({cwd:f.root,agentDir:process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(),'.pi/agent'),settingsManager:settings,noExtensions:true,noContextFiles:true,noSkills:true,noPromptTemplates:true,noThemes:true});await loader.reload();
 const {session}=await createAgentSession({cwd:f.root,resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.inMemory(f.root),tools:['workspace_read','workspace_write']});
 try{assert.deepEqual(session.getActiveToolNames(),[]);}finally{session.dispose();}
}));

test('present but malformed agent presets never disappear into unrestricted defaults',()=>fixture(async f=>{
 const dir=path.join(f.root,'.pi','agents');await fs.mkdir(dir,{recursive:true});
 for(const [name,workspace] of [['bad-root','workspace: { access: read-only }'],['bad-access','workspace:\n  root: .\n  access: readonly'],['bad-type','workspace: invalid-string']]){
  await fs.writeFile(path.join(dir,`${name}.md`),`---\nname: ${name}\ndescription: test\n${workspace}\n---\nTest only.`);
 }
 const agents=discoverAgents(f.root,'project').agents;assert.equal(agents.length,3);
 for(const agent of agents){assert.notEqual(agent.workspace,undefined);await assert.rejects(prepareWorkspaceLaunch({baseCwd:f.root,workspace:agent.workspace}));}
}));

test('invalid policy, overlapping read roots, inherited delegation and Windows aliases fail closed',()=>fixture(async f=>{
 for(const workspace of [null,[],{root:''},{root:f.root,access:'typo'},{root:f.root,execution:'host'},{root:f.root,extraReadRoots:[f.base]}])await assert.rejects(prepareWorkspaceLaunch({baseCwd:f.base,workspace}));
 const prior=process.env[POLICY_ENV];process.env[POLICY_ENV]='{}';try{await assert.rejects(prepareWorkspaceLaunch({baseCwd:f.base}),/cannot create nested/);}finally{if(prior===undefined)delete process.env[POLICY_ENV];else process.env[POLICY_ENV]=prior;}
 if(process.platform==='win32')for(const p of ['C:relative.txt','C:/temp/x:stream','\\\\server\\share\\x','\\\\?\\C:\\x','NUL.txt','CONIN$','CONOUT$','PROGRA~1/x','file. '])assert.throws(()=>resolveInput(p,f.root),/WORKSPACE_DENIED/);
}));
