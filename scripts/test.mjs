import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hostDir} from './host.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agentDir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-workbench-unit-'));
fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({retry:{enabled:false},cacheWarming:'off'}));
const files=['extensions/team/tests/sandbox-process.test.mjs','extensions/project/tests/identity.test.mjs','extensions/team/tests/task-tree.test.mjs','extensions/workspace/tests/sandbox.test.mjs','extensions/workspace/tests/sandbox-live.test.mjs','extensions/project/tests/migration.test.mjs','extensions/project/tests/runtime.test.mjs','extensions/goal/tests/goal-team.test.mjs','extensions/goal/tests/team-wake.test.mjs','extensions/agent-monitor/tests/monitor.test.mjs','extensions/agent-monitor/tests/layout.test.mjs','extensions/agent-monitor/tests/viewer.test.mjs','extensions/run-control/tests/run-control.test.mjs','extensions/subagent/tests/cancel.test.mjs','extensions/workspace/tests/workspace.test.mjs','extensions/retry-any/tests/retry.test.mjs','extensions/team/tests/messaging.test.mjs','extensions/team/tests/process-integration.test.mjs','extensions/supervisor/tests/supervisor.test.mjs','scripts/package.test.mjs','scripts/tests/lifecycle-integration.test.mjs'];
const namePattern=process.argv.slice(2).find(arg=>arg.startsWith('--test-name-pattern='));
const requested=process.argv.slice(2).filter(arg=>!arg.startsWith('--test-name-pattern=')).map(file=>file.replace(/\\/g,'/'));
for(const file of requested)if(!files.includes(file)){fs.rmSync(agentDir,{recursive:true,force:true});throw new Error(`Unknown test file: ${file}`);}
const selected=requested.length?requested:files;
const child=spawn(process.execPath,['--unhandled-rejections=strict','--test',...(namePattern?[namePattern]:[]),...selected],{cwd:root,env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH??''),PI_TEST_PACKAGE_DIR:hostDir,PI_CODING_AGENT_DIR:agentDir},stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;fs.rmSync(agentDir,{recursive:true,force:true});});
child.on('exit',code=>{process.exitCode=code??1;fs.rmSync(agentDir,{recursive:true,force:true});});
