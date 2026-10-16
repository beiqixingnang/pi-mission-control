import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {hostDir} from '../../../scripts/host.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const {createJiti}=await import(pathToFileURL(path.join(hostDir,'node_modules/jiti/lib/jiti.mjs')));
const jiti=createJiti(import.meta.url,{});const {JobGraph}=await jiti.import(path.join(root,'extensions/team/job-graph.ts'));
function harness(){
 const jobs=new Map(),records=new Map(),calls=[],ends=[],started=[],acks=[];let graph;
 graph=new JobGraph({jobs,records,epoch:()=>1,closed:()=>false,persist(){},
  dispatch(member,message,timeout,signal,job){let done;const value=new Promise(resolve=>{done=resolve;});calls.push({member,message,job,done});graph.markRunning(job);return value;},
  abort(job){const call=calls.findLast(c=>c.job===job);call?.done({ok:false,error:'aborted'});},
  start(job){started.push(job.id);},finish(job,result){const end={id:job.id,deliveryId:'d-'+job.id,sequence:ends.length+1,...result};ends.push(end);return end;},ack(ids){acks.push(...ids);}});
 return {graph,jobs,records,calls,ends,started,acks};
}
test('supervisor remains pending until child delivery is reviewed; task ancestry and Goal scope are inherited',async()=>{
 const h=harness();try{
  const supervisor={name:'supervisor'},executor={name:'executor'};
  const rootJob=h.graph.start(supervisor,'inspect',10000,'batch',{goalId:'goal'});const parent=h.jobs.get(rootJob.id);
  const child=h.graph.start(executor,'verify',10000,'off',{parent});
  assert.equal(h.records.get(child.id).parentId,rootJob.id);assert.equal(h.records.get(child.id).goalId,'goal');assert.equal(h.records.get(child.id).batchId,parent.record.batchId);
  h.calls[0].done({ok:true,reply:'waiting'});await delay(0);assert.equal(h.records.get(rootJob.id).state,'waiting');assert.equal(h.ends.length,0);
  h.calls[1].done({ok:true,reply:'receipt ready'});await delay(0);assert.equal(h.ends.length,1);assert.equal(h.calls.length,3);assert.match(h.calls[2].message,/receipt ready/);assert.ok(h.jobs.has(rootJob.id));
  h.calls[2].done({ok:true,reply:'review passed'});assert.equal((await rootJob.result).reply,'review passed');assert.equal(h.jobs.size,0);assert.equal(h.ends.length,2);assert.ok(h.acks.includes('d-'+child.id));
 }finally{h.graph.dispose();}
});
test('cancelling an ancestor cancels grandchildren while preserving unrelated tasks',async()=>{
 const h=harness();try{
  const a=h.graph.start({name:'a'},'a',10000,'batch'),b=h.graph.start({name:'b'},'b',10000,'off',{parent:h.jobs.get(a.id)}),c=h.graph.start({name:'c'},'c',10000,'off',{parent:h.jobs.get(b.id)}),other=h.graph.start({name:'other'},'unrelated',10000,'off');
  h.graph.cancel(h.jobs.get(a.id),'cancel');await a.result;await b.result;await c.result;assert.ok(h.jobs.has(other.id));
  for(const id of [a.id,b.id,c.id])assert.equal(h.records.get(id).state,'cancelled');h.calls.at(-1).done({ok:true,reply:'done'});await other.result;
 }finally{h.graph.dispose();}
});
test('synchronous child replies are not redelivered as a second model request',async()=>{
 const h=harness();try{
  const parent=h.graph.start({name:'p'},'p',10000,'off');const child=h.graph.start({name:'c'},'c',10000,'off',{parent:h.jobs.get(parent.id)});h.records.get(child.id).deliveryMode='reply';
  h.calls[1].done({ok:true,reply:'sync'});await child.result;h.calls[0].done({ok:true,reply:'integrated'});await parent.result;assert.equal(h.calls.length,2);
 }finally{h.graph.dispose();}
});
test('scheduled reports wake only the owner while descendants remain pending',async()=>{
 const h=harness();try{
  const parent=h.graph.start({name:'p'},'p',10000,'off'),child=h.graph.start({name:'c'},'c',10000,'off',{parent:h.jobs.get(parent.id)});
  h.calls[0].done({ok:true,reply:'waiting'});await delay(0);h.graph.reportAfter(h.jobs.get(parent.id),5);await delay(15);
  assert.match(h.calls.at(-1).message,/scheduled report/);assert.ok(h.jobs.has(child.id));h.graph.cancel(h.jobs.get(parent.id),'cleanup');await parent.result;
 }finally{h.graph.dispose();}
});

test('failed ancestors do not start an accidental review after cancelling children',async()=>{
 const h=harness();try{const parent=h.graph.start({name:'p'},'p',10000,'off');h.graph.start({name:'c'},'c',10000,'off',{parent:h.jobs.get(parent.id)});h.calls[0].done({ok:false,error:'provider failure'});assert.equal((await parent.result).ok,false);await delay(0);assert.equal(h.calls.length,2);assert.equal(h.jobs.size,0);}finally{h.graph.dispose();}
});

test('queue timeout is distinct from a member timeout and does not claim a test was started',async()=>{
 const jobs=new Map(),records=new Map();const graph=new JobGraph({jobs,records,epoch:()=>1,closed:()=>false,persist(){},dispatch:()=>new Promise(()=>{}),abort(){},start(){},finish:(job,result)=>({id:job.id,...result}),ack(){}});
 try{const task=graph.start({name:'busy'},'queued',10000,'off',{queueTimeout:5});await delay(15);assert.equal((await task.result).ok,false);assert.equal(records.get(task.id).timeoutLayer,'queue');assert.equal(records.get(task.id).processState,'not-started');}finally{graph.dispose();}
});

test('explicit blocking retains the task until cancellation or a new authorized attempt',async()=>{
 const h=harness();try{const task=h.graph.start({name:'worker'},'work',10000,'off');h.graph.block(h.jobs.get(task.id),'toolchain unavailable');h.calls[0].done({ok:true,reply:'blocked'});await delay(0);assert.equal(h.records.get(task.id).state,'blocked');assert.equal(h.ends.length,0);h.graph.cancel(h.jobs.get(task.id),'operator action');await task.result;assert.equal(h.records.get(task.id).state,'cancelled');}finally{h.graph.dispose();}
});
