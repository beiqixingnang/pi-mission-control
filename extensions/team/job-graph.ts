import { taskRecord, type TaskRecord } from "./tasks.ts";
export interface Outcome {ok:boolean;reply?:string;error?:string}
export interface GraphJob<M> {
 id:string;member:M;goalId?:string;notify:"batch"|"immediate"|"off";epoch:number;cancelled:boolean;finished:boolean;
 record:TaskRecord;ownDone:boolean;ownResult?:Outcome;childResults:Array<{id:string;deliveryId?:string;sequence?:number;resultPaths?:string[]}&Outcome>;
 resolve(value:Outcome):void;cleanupSignal?:()=>void;queueTimer?:ReturnType<typeof setTimeout>;reportTimer?:ReturnType<typeof setTimeout>;
}
interface Hooks<M> {
 jobs:Map<string,GraphJob<M>>;records:Map<string,TaskRecord>;epoch():number;closed():boolean;persist():void;
 dispatch(member:M,message:string,timeout:number,signal:AbortSignal|undefined,job:GraphJob<M>):Promise<Outcome>;
 abort(job:GraphJob<M>):void;start(job:GraphJob<M>):void;waiting?(job:GraphJob<M>):void;
 finish(job:GraphJob<M>,value:Outcome,suppress:boolean):GraphJob<M>["childResults"][number];ack(ids:string[]):void;
}
export class JobGraph<M extends {name:string}> {
 constructor(private hooks:Hooks<M>){}
 start(member:M,message:string,timeout:number,notify:GraphJob<M>["notify"],options:{signal?:AbortSignal;goalId?:string;parent?:GraphJob<M>;queueTimeout?:number;batchId?:string;attemptOf?:string}={}){
  if(message.length>200000)throw new Error("Task message exceeds 200000 characters.");
  const h=this.hooks;
  if(h.records.size>=2000){const old=[...h.records.values()].find(t=>!h.jobs.has(t.id)&&![...h.jobs.values()].some(j=>j.record.rootId===t.id));if(old)h.records.delete(old.id);else throw new Error("Task tree is full.");}
  const id=`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
  const record=taskRecord(id,member.name,message,timeout,options.parent?.record,options.goalId,options.batchId);
  record.queueTimeoutMs=options.queueTimeout??timeout;record.attemptOf=options.attemptOf;
  let resolve!:(value:Outcome)=>void;const result=new Promise<Outcome>(done=>{resolve=done;});
  const job:GraphJob<M>={id,member,record,goalId:record.goalId,notify,epoch:h.epoch(),cancelled:false,finished:false,ownDone:false,childResults:[],resolve};
  h.records.set(id,record);h.jobs.set(id,job);
  if(options.signal){const onAbort=()=>this.cancel(job,"Member request cancelled; descendant tasks cancelled, member session retained.");options.signal.addEventListener("abort",onAbort,{once:true});job.cleanupSignal=()=>options.signal!.removeEventListener("abort",onAbort);if(options.signal.aborted){onAbort();return {id,result};}}
  job.queueTimer=setTimeout(()=>{record.timeoutLayer="queue";this.cancel(job,"Queue timeout: no member turn or test process was started.");},record.queueTimeoutMs);job.queueTimer.unref?.();
  h.persist();h.start(job);
  void h.dispatch(member,message,timeout,options.signal,job).then(value=>this.completeRun(job,value),error=>this.completeRun(job,{ok:false,error:String(error)}));
  return {id,result};
 }
 markRunning(job:GraphJob<M>){if(job.queueTimer)clearTimeout(job.queueTimer);job.queueTimer=undefined;job.record.state="running";job.record.updatedAt=Date.now();}
 private completeRun(job:GraphJob<M>,value:Outcome){
  if(job.finished)return;job.ownDone=true;job.ownResult=value;
  if(!value.ok){job.ownDone=false;if(/timed out|timeout/i.test(value.error??"")){job.record.timeoutLayer="member";job.record.processState="unknown";}this.cancelChildren(job,"Ancestor task failed or timed out.");this.finish(job,value);return;}
  this.advance(job);
 }
 private children(job:GraphJob<M>){return [...this.hooks.jobs.values()].filter(child=>child.record.parentId===job.id);}
 private advance(job:GraphJob<M>,report=false){
  const h=this.hooks;if(job.finished||job.cancelled||!job.ownDone||h.closed())return;
  if(job.record.blockedReason){job.record.state="blocked";h.waiting?.(job);h.persist();return;}
  const children=this.children(job);
  if(children.length&&!report){job.record.state="waiting";h.waiting?.(job);h.persist();return;}
  const completed=job.childResults.splice(0).sort((a,b)=>(a.sequence??0)-(b.sequence??0));
  if(!completed.length&&!report){this.finish(job,job.ownResult!);return;}
  job.ownDone=false;job.record.state="queued";
  job.queueTimer=setTimeout(()=>{job.record.timeoutLayer="queue";this.cancel(job,"Queue timeout while waiting to review deliveries.");},job.record.queueTimeoutMs);job.queueTimer.unref?.();
  const message=`[Task ${job.id}: ${report?"scheduled report":"descendant delivery"}]\n${completed.map(r=>`Delivery ${r.deliveryId}; task ${r.id}; artifacts ${(r.resultPaths??[]).join(", ")}\n${r.ok?r.reply:r.error}`).join("\n\n")}\nOutstanding children: ${children.map(c=>`${c.id} (${c.member.name}, ${c.record.state})`).join(", ")||"none"}. Review the receipts directly. If work remains, call team_wait alone to sleep. Do not repeat delivered tests without new evidence or an explicit reason.`;
  h.persist();
  void h.dispatch(job.member,message,job.record.runTimeoutMs,undefined,job).then(value=>{h.ack(completed.map(c=>c.deliveryId!).filter(Boolean));this.completeRun(job,value);},error=>this.completeRun(job,{ok:false,error:String(error)}));
 }
 private finish(job:GraphJob<M>,value:Outcome,suppress=false){
  if(job.finished)return;const h=this.hooks;job.finished=true;job.cleanupSignal?.();if(job.queueTimer)clearTimeout(job.queueTimer);if(job.reportTimer)clearTimeout(job.reportTimer);
  h.jobs.delete(job.id);job.record.state=job.cancelled?"cancelled":value.ok?"completed":"failed";job.record.updatedAt=Date.now();job.record.reply=value.reply?.slice(0,12000);job.record.error=value.error;
  job.resolve(value);
  if(job.epoch!==h.epoch()||h.closed())return;
  const completion=h.finish(job,value,suppress);
  const parent=job.record.parentId?h.jobs.get(job.record.parentId):undefined;
  if(parent&&!parent.cancelled){if(job.record.deliveryMode!=="reply")parent.childResults.push(completion);else if(completion.deliveryId)h.ack([completion.deliveryId]);this.advance(parent,!value.ok);}
 }
 private cancelChildren(job:GraphJob<M>,reason:string){for(const child of this.children(job))this.cancel(child,`${job.id}: ${reason}`);}
 cancel(job:GraphJob<M>,reason:string){
  if(job.finished)return;job.cancelled=true;job.notify="off";this.cancelChildren(job,reason);
  job.record.processState=job.record.state==="queued"?"not-started":"unknown";this.hooks.abort(job);this.finish(job,{ok:false,error:reason},true);
 }
 note(job:GraphJob<M>,completion:GraphJob<M>["childResults"][number],urgent=false){job.childResults.push(completion);this.advance(job,urgent);}
 block(job:GraphJob<M>,reason:string){job.record.blockedReason=reason;job.record.state="blocked";this.hooks.persist();}
 reportAfter(job:GraphJob<M>,milliseconds:number){
  if(job.reportTimer)clearTimeout(job.reportTimer);
  job.reportTimer=setTimeout(()=>{job.reportTimer=undefined;this.advance(job,true);},milliseconds);job.reportTimer.unref?.();
 }
 dispose(){for(const job of this.hooks.jobs.values()){job.cleanupSignal?.();if(job.queueTimer)clearTimeout(job.queueTimer);if(job.reportTimer)clearTimeout(job.reportTimer);job.resolve({ok:false,error:"Session ended; task retained as interrupted."});}}
}
