/** Persisted task and delivery identities shared by lead and member dispatch. */
import { createHash, randomUUID } from "node:crypto";
export type TaskState = "queued" | "running" | "waiting" | "blocked" | "completed" | "failed" | "cancelled" | "interrupted";
export interface TaskRecord {
 id:string;projectId?:string;parentId?:string;rootId:string;batchId:string;member:string;owner:string;goalId?:string;
 message:string;inputHash:string;inputSummary:string;createdAt:number;updatedAt:number;state:TaskState;
 queueTimeoutMs:number;runTimeoutMs:number;blockedReason?:string;deliveryMode?:"reply"|"wake";attemptOf?:string;resultPaths:string[];reply?:string;error?:string;
 timeoutLayer?:"queue"|"member"|"process"|"message";processState?:"not-started"|"stopped"|"unknown";
}
export interface Delivery {
 id:string;content?:string;inputSummary?:string;taskId:string;parentId?:string;batchId:string;inputHash:string;resultPaths:string[];
 from:string;to:string;sequence:number;createdAt:number;delivered:boolean;
}
export const inputHash=(message:string)=>createHash("sha256").update(message).digest("hex");
export function taskRecord(id:string,member:string,message:string,timeout:number,parent?:TaskRecord,goalId?:string,batchId?:string):TaskRecord{
 return {id,projectId:parent?.projectId,member,message,owner:parent?.member??"lead",parentId:parent?.id,rootId:parent?.rootId??id,batchId:parent?.batchId??batchId??randomUUID(),goalId:parent?.goalId??goalId,inputHash:inputHash(message),inputSummary:message.slice(0,500),createdAt:Date.now(),updatedAt:Date.now(),state:"queued",queueTimeoutMs:timeout,runTimeoutMs:timeout,resultPaths:[]};
}
export function newDelivery(task:TaskRecord,sequence:number):Delivery{
 return {id:randomUUID(),content:task.reply??task.error,inputSummary:task.inputSummary,taskId:task.id,parentId:task.parentId,batchId:task.batchId,inputHash:task.inputHash,resultPaths:[...task.resultPaths],from:task.member,to:task.owner,sequence,createdAt:Date.now(),delivered:false};
}
export function descendants(records:Iterable<TaskRecord>,id:string):Set<string>{
 const result=new Set([id]),all=[...records];let grew=true;
 while(grew){grew=false;for(const task of all)if(task.parentId&&result.has(task.parentId)&&!result.has(task.id)){result.add(task.id);grew=true;}}
 return result;
}
export function restoreTasks(value:unknown):TaskRecord[]{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>2000)throw new Error("Invalid task tree snapshot.");
 const seen=new Set<string>();
 return value.map(raw=>{
  const t=raw as TaskRecord;
  if(!t||typeof t.id!=="string"||seen.has(t.id)||typeof t.member!=="string"||typeof t.message!=="string"||t.message.length>200000||typeof t.rootId!=="string"||typeof t.owner!=="string"||typeof t.batchId!=="string"||typeof t.inputHash!=="string"||!Number.isFinite(t.createdAt)||!Number.isFinite(t.updatedAt)||!Array.isArray(t.resultPaths)||t.resultPaths.some(p=>typeof p!=="string")||!["queued","running","waiting","blocked","completed","failed","cancelled","interrupted"].includes(t.state))throw new Error("Invalid task tree record.");
  seen.add(t.id);return JSON.parse(JSON.stringify(t));
 });
}
export function restoreDeliveries(value:unknown):Delivery[]{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>4000)throw new Error("Invalid delivery snapshot.");
 const seen=new Set<string>();return value.map(raw=>{const d=raw as Delivery;if(!d||typeof d.id!=="string"||seen.has(d.id)||typeof d.taskId!=="string"||typeof d.from!=="string"||typeof d.to!=="string"||typeof d.batchId!=="string"||typeof d.inputHash!=="string"||!Number.isSafeInteger(d.sequence)||typeof d.delivered!=="boolean"||!Array.isArray(d.resultPaths)||d.resultPaths.some(p=>typeof p!=="string"))throw new Error("Invalid delivery record.");seen.add(d.id);return JSON.parse(JSON.stringify(d));});
}
