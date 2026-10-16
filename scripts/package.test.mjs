import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {hostDir} from './host.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(hostDir,'package.json'));
const {createJiti}=await import(pathToFileURL(path.join(hostDir,'node_modules/jiti/lib/jiti.mjs')));
const jiti=createJiti(import.meta.url,{alias:{'@earendil-works/pi-coding-agent':path.join(hostDir,'dist/index.js'),typebox:require.resolve('typebox')}});
const {discoverAgents}=await jiti.import(path.join(root,'extensions/subagent/agents.ts'));

test('package supplies worker/planner/scout/reviewer without editing user agent files',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'pi-workbench-presets-'));
 try{
  const found=discoverAgents(cwd,'user').agents;
  for(const name of ['worker','planner','scout','reviewer'])assert.ok(found.some(agent=>agent.name===name));
  assert.ok(found.some(agent=>agent.source==='package'));
  assert.equal(discoverAgents(cwd,'project').agents.length,0);
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});

test('manifest includes only runtime entry points and does not auto-load test drivers',async()=>{
 const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
 assert.equal(manifest.pi.extensions.length,10);
 for(const file of manifest.pi.extensions){assert.ok(file.endsWith('/index.ts'));assert.ok(!file.includes('/tests/'));await fs.access(path.join(root,file));}
 for(const name of ['@earendil-works/pi-coding-agent','@earendil-works/pi-ai','@earendil-works/pi-tui','typebox']){assert.equal(manifest.peerDependencies[name],'*');assert.ok(!manifest.dependencies?.[name]);}
});
