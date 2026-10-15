import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostDir} from '../../../scripts/host.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.join(hostDir,'package.json'));
const {createJiti}=await import(pathToFileURL(path.join(hostDir,'node_modules/jiti/lib/jiti.mjs')));
const jiti=createJiti(import.meta.url,{alias:{typebox:require.resolve('typebox'),'@earendil-works/pi-coding-agent':path.join(hostDir,'dist/index.js')}});
const messaging=await jiti.import(path.resolve(here,'../messaging.ts'));
const roster=await jiti.import(path.resolve(here,'../roster.ts'));

test('communication ACL allows lead and configured member pairs, denies unrelated members',()=>{
 const members=new Map([['cpu-supervisor',{communication:{allow:['cpu-builder']}}],['cpu-builder',{communication:{allow:[]}}],['gpu-builder',{communication:{allow:[]}}]]);
 assert.equal(messaging.mayCommunicate('lead','gpu-builder',members),true);
 assert.equal(messaging.mayCommunicate('cpu-supervisor','cpu-builder',members),true);
 assert.equal(messaging.mayCommunicate('cpu-builder','cpu-supervisor',members),true);
 assert.equal(messaging.mayCommunicate('cpu-builder','gpu-builder',members),false);
});

test('persisted roster rejects malformed identities and preserves valid communication/workspace state',()=>{
 const snapshot={version:1,members:[{name:'cpu-supervisor',role:'supervisor',cwd:path.resolve(os.tmpdir(),'pi-project'),persistent:true,sessionId:'123e4567-e89b-12d3-a456-426614174000',communication:{allow:['cpu-builder']},createdAt:1}],pendingJobs:[],completedJobs:[]};
 const parsed=roster.readRoster([{type:'custom',customType:'team-roster',data:snapshot}]);assert.equal(parsed.members[0].communication.allow[0],'cpu-builder');
 assert.throws(()=>roster.readRoster([{type:'custom',customType:'team-roster',data:{...snapshot,members:[{...snapshot.members[0],sessionId:'bad'}]}}]));
});

test('bridge request parser rejects forged tokens and oversized destinations',()=>{
 const config={version:1,member:'cpu-supervisor',token:'123e4567-e89b-12d3-a456-426614174000',directory:'C:/tmp'};
 assert.throws(()=>messaging.parseRequest({version:1,kind:'message',id:'123e4567-e89b-12d3-a456-426614174001',token:'wrong',to:'cpu-builder',message:'x',wait:false,expiresAt:Date.now()+1000},config),/TEAM_MESSAGE_DENIED/);
 assert.throws(()=>messaging.communication({allow:['bad name']}),/communication/);
});
