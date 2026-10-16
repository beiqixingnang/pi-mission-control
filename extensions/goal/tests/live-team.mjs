import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
import {hostDir} from '../../../scripts/host.mjs';
const packageDir=hostDir;
const {RpcClient}=await import(pathToFileURL(path.join(packageDir,'dist/modes/rpc/rpc-client.js')));
const {promptAndWaitSafely}=await import(pathToFileURL(path.resolve(here,'../../team/rpc.ts')));
const outputDir=process.env.PI_GOAL_TEST_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'pi-goal-team-live-'));
const leadModel=process.env.PI_LIVE_LEAD_MODEL;
const memberAModel=process.env.PI_LIVE_MEMBER_MODEL_A||process.env.PI_LIVE_MEMBER_MODEL;
const memberBModel=process.env.PI_LIVE_MEMBER_MODEL_B||process.env.PI_LIVE_MEMBER_MODEL;
if(!leadModel||!memberAModel||!memberBModel)throw new Error('Set PI_LIVE_LEAD_MODEL and PI_LIVE_MEMBER_MODEL (or PI_LIVE_MEMBER_MODEL_A/B) before running the live Goal test.');
fs.mkdirSync(outputDir,{recursive:true});
const client=new RpcClient({cliPath:path.join(packageDir,'dist/bundle/cli.js'),cwd:outputDir,args:['--no-session','--no-skills','--no-prompt-templates','--no-context-files','--model',leadModel,'--extension',path.join(here,'integration-driver.ts'),'--tools','probe_dispatch,probe_checkpoint,goal_start,goal_status,goal_finish,goal_wait,goal_pause,team_spawn,team_send,team_broadcast,team_disband,bash']});
const lifecycle=[];const tools=[];const errors=[];let accepted=false;let finalText='';let timer;let finish;let fail;
const done=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
// The promise is observed immediately even if startup/prompt acceptance fails.
void done.catch(()=>{});
const unsubscribe=client.onEvent(event=>{
  if(['agent_start','agent_settled'].includes(event.type)) {
    const record={type:event.type,at:Date.now(),aborted:event.aborted};lifecycle.push(record);console.log(JSON.stringify(record));
    if(event.type==='agent_settled'&&accepted)finish();
  }
  if(event.type==='tool_execution_end') {
    tools.push({name:event.toolName,isError:!!event.isError});
    console.log(JSON.stringify({tool:event.toolName,isError:!!event.isError}));
    if(event.toolName==='goal_finish'&&!event.isError&&event.result?.details?.status==='completed')accepted=true;
  }
  if(event.type==='message_end'&&event.message?.role==='custom')console.log(JSON.stringify({customType:event.message.customType,at:Date.now()}));
  if(event.type==='message_end'&&event.message?.role==='assistant') {
    const m=event.message;
    const text=m.content.filter(b=>b.type==='text').map(b=>b.text).join('');if(text.trim())finalText=text;
    if(m.stopReason==='error'||m.stopReason==='aborted'){errors.push(m.errorMessage||m.stopReason);fail(new Error(m.errorMessage||m.stopReason));}
  }
  if(event.type==='extension_error'){errors.push(event.error);fail(new Error(event.error));}
});
try {
  await client.start();await client.setAutoRetry(false);
  timer=setTimeout(()=>fail(new Error('Integration deadline exceeded (180 seconds).')),180000);
  await Promise.all([promptAndWaitSafely(client,'Run the Goal/team integration test. Call probe_dispatch exactly once as the only tool call now. It will end this run while real members work. When automatically woken, finish the goal with evidence, then reply GOAL_TEAM_PASS.',undefined,180000),done]);
  const starts=lifecycle.filter(e=>e.type==='agent_start');const settles=lifecycle.filter(e=>e.type==='agent_settled');
  assert.ok(starts.length>=2,'Expected an actual new lead run after member completion');
  assert.ok(settles.length>=2,'Expected initial idle settlement and post-wake settlement');
  assert.ok(settles[0].at<=starts[1].at,'Lead must settle before its automatic wake');
  assert.ok(accepted,'Goal was not accepted');
  assert.equal(fs.readFileSync(path.join(outputDir,'member-a.txt'),'utf8').trim(),'323');
  assert.equal(fs.readFileSync(path.join(outputDir,'member-b.txt'),'utf8').trim(),'667');
  assert.equal(tools.filter(t=>['team_collect','team_list'].includes(t.name)).length,0,'Lead must not poll');
  const entries=await client.getEntries();
  const states=entries.entries.filter(e=>e.type==='custom'&&e.customType==='goal-state').map(e=>e.data);
  const completed=states.at(-1);assert.equal(completed.status,'completed');
  assert.ok(completed.continuations>=2,'Must test both team wake and unfinished-goal continuation');
  assert.ok(entries.entries.some(e=>e.type==='custom_message'&&e.customType==='goal-continue'),'Goal must append a real continuation message');
  assert.equal(completed.verification[0].ok,true);assert.match(completed.verification[0].output,/ARTIFACTS_VERIFIED/);
  assert.ok(states.some(s=>s.status==='waiting'&&s.pending.length===2),'Must persist both pending jobs before idle');
  const report={passed:true,outputDir,leadModel,memberModels:[memberAModel,memberBModel],leadRuns:starts.length,settlements:settles.length,automaticContinuations:completed.continuations,goalStatus:completed.status,verification:completed.verification,tools,errors,finalText,lifecycle};
  fs.writeFileSync(path.join(outputDir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){
  const report={passed:false,outputDir,error:String(error.stack||error),lifecycle,tools,errors,finalText};
  fs.writeFileSync(path.join(outputDir,'report.json'),JSON.stringify(report,null,2));console.error(JSON.stringify(report,null,2));process.exitCode=1;
}finally{
  if(timer)clearTimeout(timer);unsubscribe();
  try{await client.prompt('/probe-close');}catch{}
  await client.stop();
}
