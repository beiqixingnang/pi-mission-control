/**
 * Agent Team extension
 *
 * Turns sub-agents into a persistent "team": the current conversation is the
 * lead, and each team member is a long-lived `pi --mode rpc` child process with
 * its own context window, identity, and model.
 *
 * Unlike the one-shot `subagent` example, members stay alive between calls,
 * can be messaged repeatedly, and carry their own conversation history.
 *
 * Tools:
 *   team_spawn      create a member
 *   team_send       send a task/message to one member (optionally wait for reply)
 *   team_broadcast  send the same message to every member
 *   team_collect    wait for busy members and collect their latest replies
 *   team_list       show the roster
 *   team_disband    stop and remove a member
 *   team_tasks      shared task board (add / update / list)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	getPackageDir,
	type ExtensionAPI,
	type ExtensionContext,
	RpcClient,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	prepareWorkspaceLaunch,
	WorkspaceSchema,
	SandboxSchema,
	type ResolvedWorkspace,
} from "../workspace/launch.ts";
import { promptAndWaitSafely } from "./rpc.ts";
import { POLICY_ENV, bridgeTools } from "../workspace/policy.ts";
import { BRIDGE_ENV, MEMBER_ENV, communication, createParentBridge, mayCommunicate, validMemberName, type MessageRequest, type MessageResponse, type ParentBridge } from "./messaging.ts";
import { ROSTER_TYPE, readRoster, type MemberDefinition, type RosterSnapshot } from "./roster.ts";
import { newDelivery, descendants, type TaskRecord, type Delivery } from "./tasks.ts";
import { JobGraph } from "./job-graph.ts";

/** Shape of the launch plan returned by the lead-owned workspace helper. */
type WorkspaceLaunchPlan = Awaited<ReturnType<typeof prepareWorkspaceLaunch>>;

// ---------------------------------------------------------------------------
// Types and state
// ---------------------------------------------------------------------------

type MemberStatus = "idle" | "working" | "error" | "stopped";

interface TranscriptItem {
	role: "lead" | "member";
	text: string;
	at: number;
}

interface TeamMember {
	definition: MemberDefinition;
	bridge?: ParentBridge;
	name: string;
	role: string;
	client: RpcClient;
	status: MemberStatus;
	model?: string;
	tools?: string[];
	/** Resolved workspace policy when the member runs restricted. */
	workspace?: ResolvedWorkspace;
	/** Effective working directory of the member process. */
	cwd?: string;
	promptFilePath?: string;
	createdAt: number;
	workStartedAt?: number;
	monitorActivity?: string;
	lastActivityAt: number;
	lastMessageAt?: number;
	lastReply?: string;
	error?: string;
	turns: number;
	partial: string;
	transcript: TranscriptItem[];
	/** Resolves when the member's currently queued run settles. */
	queue: Promise<void>;
	activeJobId?: string;
	contextJobId?: string;
	waitAbort?: AbortController;
	activeDone?: Promise<void>;
	stopped?: boolean;
	/** Incrementing this cancels this member's queued work without affecting peers. */
	cancellationGeneration?: number;
	onPartial?: (text: string) => void;
}

type NotifyPolicy = "batch" | "immediate" | "off";
interface Completion {
	id: string;
	parentId?: string;
	rootId?: string;
	batchId?: string;
	owner?: string;
	inputHash?: string;
	inputSummary?: string;
	resultPaths?: string[];
	deliveryId?: string;
	sequence?: number;
	timeoutLayer?: string;
	processState?: string;
	member: string;
	goalId?: string;
	ok: boolean;
	reply?: string;
	error?: string;
}
interface BackgroundJob {
	id: string;
	member: TeamMember;
	goalId?: string;
	notify: NotifyPolicy;
	epoch: number;
	cancelled: boolean;
	finished: boolean;
	record: TaskRecord;
	ownDone: boolean;
	ownResult?: { ok: boolean; reply?: string; error?: string };
	childResults: Completion[];
	resolve(result: { ok: boolean; reply?: string; error?: string }): void;
	queueTimer?: ReturnType<typeof setTimeout>;
	reportTimer?: ReturnType<typeof setTimeout>;
}

type TaskStatus = "todo" | "doing" | "done" | "blocked";

interface TeamTask {
	id: string;
	title: string;
	assignee?: string;
	status: TaskStatus;
	note?: string;
	createdAt: number;
	updatedAt: number;
}

const MAX_TRANSCRIPT = 40;
const MAX_REPLY_CHARS = 20000;
const DEFAULT_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Absolute path to a runnable Pi CLI, so child processes always start. */
function resolveCliPath(): string {
	const pkg = getPackageDir();
	const candidates = [
		path.join(pkg, "dist", "bundle", "cli.js"),
		path.join(pkg, "dist", "cli.js"),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	const argv1 = process.argv[1];
	if (argv1 && fs.existsSync(argv1)) return argv1;
	return path.join(pkg, "dist", "cli.js");
}

function uid(): string {
	return Math.random().toString(36).slice(2, 8);
}

function truncate(text: string, max = MAX_REPLY_CHARS): string {
	if (text.length <= max) return text;
	const omitted = text.length - max;
	return `${text.slice(0, max)}\n\n…[truncated ${omitted} chars]…`;
}

/** Pull the final assistant text out of a run's event stream. */
function extractText(events: any[]): string {
	let text = "";
	for (const event of events) {
		if (event?.type !== "message_end") continue;
		const message = event.message;
		if (message?.role !== "assistant") continue;
		const content = message.content;
		if (Array.isArray(content)) {
			const joined = content
				.filter((block: any) => block?.type === "text")
				.map((block: any) => block.text)
				.join("");
			if (joined.trim()) text = joined;
		} else if (typeof content === "string" && content.trim()) {
			text = content;
		}
	}
	return text;
}

function nowIso(at: number): string {
	return new Date(at).toISOString().replace("T", " ").slice(0, 19);
}

function statusIcon(status: MemberStatus): string {
	switch (status) {
		case "working":
			return "⏳";
		case "idle":
			return "✓";
		case "error":
			return "✗";
		default:
			return "•";
	}
}

function taskIcon(status: TaskStatus): string {
	switch (status) {
		case "todo":
			return "[ ]";
		case "doing":
			return "[~]";
		case "done":
			return "[x]";
		case "blocked":
			return "[!]";
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// The explicit child bridge is the only team capability in member processes.
	// In particular, a resumed member session must never restore the lead roster.
	if (process.env[MEMBER_ENV] || process.env[POLICY_ENV]) return;
	const members = new Map<string, TeamMember>();
	const definitions = new Map<string, MemberDefinition>();
	const spawning = new Set<string>();
	const startingClients = new Set<RpcClient>();
	const tasks: TeamTask[] = [];
	const jobs = new Map<string, BackgroundJob>();
	const history: Completion[] = [];
	let notifications: Completion[] = [];
	let wakeEnabled = true;
	let epoch = 0;
	let closing = false;
	let taskGeneration = 0;
	let wakeSuppressed = false;
	const messageAborts = new Set<AbortController>();
	let deliveryError: string | undefined;
	let currentCtx: ExtensionContext | undefined;
	const taskTree = new Map<string, TaskRecord>();
	let deliveries: Delivery[] = [];
	let deliverySequence = 0;
	const queuedDeliveries = new Set<string>();
	const waitingFor = new Map<string, { from: string; to: string }>();
	const restoreErrors = new Map<string, string>();

	let restoreFailed = false;
	function persist() {
		if (!currentCtx || restoreFailed) return;
		const snapshot: RosterSnapshot = {
			version: 1,
			members: [...definitions.values()].filter(member => member.persistent),
			pendingJobs: [...jobs.values()].map(job => ({ id: job.id, member: job.member.name, goalId: job.goalId })),
			completedJobs: history.slice(-100),
			taskTree: [...taskTree.values()],
			deliveries: deliveries.slice(-4000),
			board: tasks.map(task => ({...task})),
		};
		pi.appendEntry(ROSTER_TYPE, JSON.parse(JSON.stringify(snapshot)));
	}

	function reportMember(member: TeamMember, activity?: string) {
		if (closing || member.stopped || members.get(member.name) !== member) return;
		if (activity !== undefined) member.monitorActivity = activity;
		pi.events.emit("agent-monitor:update", {
			id: `team:${member.name}`, kind: "team", name: member.name, status: member.status,
			model: member.model, alive: true, activity: member.monitorActivity,
			workspace: member.workspace?.root, access: member.workspace?.access, cwd: member.cwd,
			output: (member.partial || (member.status === "idle" ? member.lastReply || "" : "")).slice(-1000),
			startedAt: member.workStartedAt ?? member.createdAt, updatedAt: member.lastActivityAt, lastMessageAt:member.lastMessageAt,
		});
	}
	function removeMember(name: string) { pi.events.emit("agent-monitor:remove", { id: `team:${name}` }); }

	function deliver(results: Completion[]): boolean {
		if (closing || wakeSuppressed || !wakeEnabled || !results.length) return false;
		const request = { results: results.filter(item=>!item.deliveryId||!queuedDeliveries.has(item.deliveryId)).sort((a,b)=>(a.sequence??0)-(b.sequence??0)) };
		if(!request.results.length)return true;
		pi.events.emit("team:before-wake", request);
		if (!request.results.length) return true;
		try {
			pi.sendMessage({ customType: "team-results", display: true, details: { results: request.results, deliveryIds: request.results.map(item=>item.deliveryId).filter(Boolean) },
				content: "Background team work finished. Review the results and continue the user's task.\n\n" + request.results.map(result => `Member ${result.member}, job ${result.id}, batch ${result.batchId}, delivery ${result.deliveryId}, input ${result.inputHash}, artifacts ${(result.resultPaths??[]).join(", ")||"none"}: ${result.ok ? "completed" : "FAILED"}\n${truncate(result.ok ? result.reply || "(empty reply)" : result.error || "Unknown failure", 12000)}`).join("\n\n"),
			}, { triggerTurn: true, deliverAs: "followUp" });
			for(const item of request.results)if(item.deliveryId)queuedDeliveries.add(item.deliveryId);
			deliveryError = undefined;
			return true;
		} catch (error) { deliveryError = String((error as Error)?.message ?? error); return false; }
	}
	function flush() {
		if ([...jobs.values()].some(job => job.notify !== "off" && !job.goalId && !job.record.parentId) || !notifications.length) return;
		const results = notifications.slice();
		if (deliver(results)) notifications.splice(0, results.length);
	}
	function finishJob(job: BackgroundJob, value: {ok:boolean;reply?:string;error?:string}, suppress=false): Completion {
		const delivery=newDelivery(job.record,++deliverySequence);if(!job.record.parentId&&job.notify==="off")delivery.delivered=true;deliveries.push(delivery);
		const completion:Completion={id:job.id,member:job.member.name,goalId:job.goalId,parentId:job.record.parentId,rootId:job.record.rootId,batchId:job.record.batchId,owner:job.record.owner,inputHash:job.record.inputHash,inputSummary:job.record.inputSummary,resultPaths:job.record.resultPaths,deliveryId:delivery.id,sequence:delivery.sequence,timeoutLayer:job.record.timeoutLayer,processState:job.record.processState,...value};
		history.push({...completion,reply:completion.reply?truncate(completion.reply,12000):undefined});if(history.length>100)history.splice(0,history.length-100);
		persist();pi.events.emit("team:job-end",completion);
		if(!job.record.parentId&&!suppress&&!wakeSuppressed&&job.notify!=="off")if(job.notify!=="immediate"||!deliver([completion]))notifications.push(completion);
		flush();return completion;
	}
	function acknowledge(ids:string[]){for(const delivery of deliveries)if(ids.includes(delivery.id))delivery.delivered=true;persist();}
	const graph=new JobGraph<TeamMember>({jobs:jobs as any,records:taskTree,epoch:()=>epoch,closed:()=>closing,persist,
		dispatch:(member,message,timeout,signal,job)=>dispatch(member,message,timeout,undefined,signal,job as BackgroundJob),
		abort:job=>{if(job.member.activeJobId===job.id)job.member.waitAbort?.abort();},
		start:job=>pi.events.emit("team:job-start",{id:job.id,member:job.member.name,goalId:job.goalId,parentId:job.record.parentId,rootId:job.record.rootId}),
		waiting:job=>{job.member.status="idle";reportMember(job.member,"等待下游任务交付");},
		finish:(job,value,suppress)=>finishJob(job as BackgroundJob,value,suppress),ack:acknowledge,
	});
	function cancelJob(job:BackgroundJob,reason:string){graph.cancel(job,reason);}
	function startJob(member:TeamMember,message:string,timeout:number,notify:NotifyPolicy,signal?:AbortSignal,goalId?:string,parent?:BackgroundJob,queueTimeout=timeout,batchId?:string,attemptOf?:string){
		const scope:{goalId?:string}={goalId:parent?.goalId??goalId};if(!scope.goalId)pi.events.emit("team:scope",scope);
		const projectScope:{projectId?:string}={};pi.events.emit("project:scope",projectScope);
		const started=graph.start(member,message,timeout,notify,{signal,goalId:scope.goalId,parent,queueTimeout,batchId,attemptOf});
		const record=taskTree.get(started.id);if(record){record.projectId=parent?.record.projectId??projectScope.projectId;persist();}
		return started;
	}
	function background(member:TeamMember,message:string,timeout:number,notify:NotifyPolicy,queueTimeout=timeout,batchId?:string){return startJob(member,message,timeout,notify,undefined,undefined,undefined,queueTimeout,batchId).id;}
	pi.events.on("team:delivery-ack", data => {acknowledge((data as {ids:string[]}).ids);});
	pi.on("message_end", event => {
		const message=event.message as any;
		if((message.customType==="team-results"||message.customType==="team-member-message")&&Array.isArray(message.details?.deliveryIds))acknowledge(message.details.deliveryIds);
	});
	pi.events.on("team:cancel-goal", data => {
		const goalId = (data as { goalId?: string } | undefined)?.goalId;
		if (!goalId) return;
		const request=data as {goalId?:string;pending?:Promise<unknown>[]};
		const affected=[...jobs.values()].filter(job=>job.goalId===goalId);
		const pending=[...new Set(affected.map(job=>job.member.queue))];
		for (const job of affected) cancelJob(job, "Goal stopped by the user.");
		request.pending?.push(Promise.allSettled(pending));
	});

	pi.events.on("agent-monitor:history",data=>{
		const request=data as {id?:string;promise?:Promise<unknown[]>};
		const member=members.get(request?.id?.replace(/^team:/,"")??"");
		if(member)request.promise=member.client.getMessages();
	});
	pi.events.on("workbench:stop", data => {
		taskGeneration++;wakeSuppressed=true;notifications=[];
		for(const controller of messageAborts)controller.abort();
		for(const job of [...jobs.values()])cancelJob(job,"用户全局停止");
		for(const member of members.values())member.waitAbort?.abort();
		const pending=Promise.allSettled([...members.values()].map(member=>member.queue));
		(data as {pending?:Promise<unknown>[]})?.pending?.push(pending);
	});
	pi.on("input", event => {
		if(event.source!=="extension" && !event.text.startsWith("/"))wakeSuppressed=false;
	});

	pi.registerCommand("team-wake", {
		description: "Automatic team notifications: on|off|status. Goal-mode jobs use their Goal controller.",
		handler: async (args, ctx) => {
			const value = args.trim() || "status";
			if (value === "on") { wakeEnabled = true; flush(); }
			else if (value === "off") wakeEnabled = false;
			else if (value !== "status") { ctx.ui.notify("Usage: /team-wake on|off|status", "warning"); return; }
			ctx.ui.notify(`Team automatic wake: ${wakeEnabled ? "on" : "off"}; ${jobs.size} background jobs; ${notifications.length} held notifications.${deliveryError ? ` Delivery error: ${deliveryError}` : ""}`, "info");
		},
	});

	async function writeSystemPrompt(memberName: string, content: string): Promise<string> {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-team-"));
		const file = path.join(dir, `member-${memberName}.md`);
		await withFileMutationQueue(file, async () => {
			await fs.promises.writeFile(file, content, { encoding: "utf-8", mode: 0o600 });
		});
		return file;
	}

	function removePromptFile(member: TeamMember): void {
		if (!member.promptFilePath) return;
		try {
			fs.rmSync(path.dirname(member.promptFilePath), { recursive: true, force: true });
		} catch {
			// best effort
		}
		member.promptFilePath = undefined;
	}

	function attachEvents(member: TeamMember): void {
		// Pi 1.2.0 exposes its child handle at runtime but has no public exit
		// subscription. Observe it passively when available; no RPC/model polling.
		const child = (member.client as unknown as { process?: { once?: (event: string, listener: (...args: any[]) => void) => unknown } }).process;
		child?.once?.("exit", (code: number | null) => {
			if (closing || member.stopped || members.get(member.name) !== member) return;
			member.stopped = true;
			member.status = "error";
			member.error = `Member process exited (code=${code}).`;
			member.definition.interrupted = true;
			persist();
			void member.bridge?.stop();
			pi.events.emit("agent-monitor:update", { id: `team:${member.name}`, kind: "team", name: member.name, status: "error", alive: false, activity: "进程退出", output: member.error, model: member.model, workspace: member.workspace?.root, access: member.workspace?.access, cwd: member.cwd });
			member.waitAbort?.abort();
		});
		member.client.onEvent((event: any) => {
			if (closing || member.stopped || members.get(member.name) !== member) return;
			member.lastActivityAt=Date.now();
			if (event?.type === "message_end" && event.message) {
				pi.events.emit("agent-monitor:conversation",{id:`team:${member.name}`,messages:[event.message]});
				if(event.message.role==="assistant"&&event.message.content?.some((block:any)=>block.type==="text"&&block.text.trim()))member.lastMessageAt=event.message.timestamp??Date.now();
			}
			if (event?.type === "agent_start") {
				member.status = "working";
				member.partial = "";
				reportMember(member, "等待响应");
			} else if (
				event?.type === "message_update" &&
				event.assistantMessageEvent?.type === "text_delta"
			) {
				member.partial += event.assistantMessageEvent.delta ?? "";
				member.lastMessageAt=Date.now();
				member.onPartial?.(member.partial);
				reportMember(member, "输出中");
			} else if (event?.type === "message_update" && ["thinking_start", "thinking_delta"].includes(event.assistantMessageEvent?.type)) {
				// Activity only. Never forward thinking content into the monitor.
				reportMember(member, "思考中");
			} else if (event?.type === "tool_execution_start" || event?.type === "tool_execution_update") {
				reportMember(member, `工具 ${event.toolName || "执行中"}`);
			} else if (event?.type === "agent_settled") {
				if (member.status !== "error") member.status = "idle";
				reportMember(member, member.status === "error" ? "任务失败" : "等待任务");
			}
		});
	}

	/** Queue one message for a member and (by default) wait for the reply. */
	function dispatch(
		member: TeamMember,
		message: string,
		timeoutMs: number,
		onPartial?: (text: string) => void,
		signal?: AbortSignal,
		job?: BackgroundJob,
	): Promise<{ ok: boolean; reply?: string; error?: string }> {
		const queuedGeneration = taskGeneration;
		const queuedMemberGeneration = member.cancellationGeneration ?? 0;
		const run = member.queue.then(async () => {
			if (queuedMemberGeneration !== (member.cancellationGeneration ?? 0) || queuedGeneration !== taskGeneration || closing || member.stopped || members.get(member.name) !== member || signal?.aborted || (job && (job.cancelled || job.finished || job.epoch !== epoch))) return { ok: false, error: "Team task was cancelled." };
			member.activeJobId = job?.id;
			if(job){graph.markRunning(job);member.contextJobId=job.id;}
			let markActiveDone:()=>void=()=>{};
			const activeDone=new Promise<void>(resolve=>{markActiveDone=resolve;});
			member.activeDone=activeDone;
			member.status = "working";
			member.partial = "";
			member.error = undefined;
			member.onPartial = onPartial;
			member.lastActivityAt = Date.now();
			member.workStartedAt = member.lastActivityAt;
			member.definition.interrupted = true;
			persist();
			// A new task must not display the previous reply as current output.
			pi.events.emit("agent-monitor:update", { id: `team:${member.name}`, kind: "team", name: member.name, status: "working", alive: true, model: member.model, activity: "等待响应", output: "", startedAt: member.workStartedAt, workspace: member.workspace?.root, access: member.workspace?.access, cwd: member.cwd });
			member.transcript.push({ role: "lead", text: message, at: Date.now() });
			const waitAbort = new AbortController();
			member.waitAbort = waitAbort;
			const abort = () => waitAbort.abort();
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const assigned=job?`[Task ${job.id}; parent ${job.record.parentId??"lead"}; batch ${job.record.batchId}; project ${job.record.projectId??"unbound"}; goal ${job.goalId??"none"}]\n${message}`:message;
				const events = await promptAndWaitSafely(member.client, assigned, undefined, timeoutMs, waitAbort.signal);
				if(job)for(const event of events as any[]){const data=event.result?.details??event.message?.details;if(data&&typeof data==="object"){const paths=[data.receiptPath,data.logPath,...(Array.isArray(data.artifactPaths)?data.artifactPaths:[])];for(const location of paths)if(typeof location==="string"&&job.record.resultPaths.length<200&&!job.record.resultPaths.includes(location))job.record.resultPaths.push(location);}}
				const assistant = events.filter(event => event?.type === "message_end" && event.message?.role === "assistant").at(-1)?.message;
				if (assistant?.stopReason === "error" || assistant?.stopReason === "aborted") throw new Error(assistant.errorMessage || `Member response ${assistant.stopReason}.`);
				if (!assistant) throw new Error("Member completed without an assistant response.");
				if (job?.cancelled || member.stopped || (job && job.epoch !== epoch)) throw new Error("Team task was cancelled.");
				const reply = extractText(events) || member.partial;
				member.lastReply = reply;
				member.turns += 1;
				member.transcript.push({ role: "member", text: reply, at: Date.now() });
				if (member.transcript.length > MAX_TRANSCRIPT) {
					member.transcript.splice(0, member.transcript.length - MAX_TRANSCRIPT);
				}
				member.status = "idle";
				reportMember(member, "等待任务");
				return { ok: true, reply };
			} catch (error) {
				// A timed-out RPC wait does not stop the model. Await its abort before
				// releasing the member queue, so the next task cannot overlap it.
				let forcedStop = false;
				if (!member.stopped) {
					let deadline: ReturnType<typeof setTimeout> | undefined;
					try {
						await Promise.race([member.client.abort(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error("Member abort timed out")),2000);})]);
					} catch { member.stopped = true; forcedStop = true; member.definition.interrupted = true;await member.client.stop().catch(() => {}); }
					finally { if(deadline)clearTimeout(deadline); }
				}
				const cancelled = waitAbort.signal.aborted || job?.cancelled;
				member.status = cancelled && !member.stopped ? "idle" : "error";
				member.error = cancelled && !member.stopped ? undefined : String((error as Error)?.message ?? error);
				if (forcedStop && !closing && members.get(member.name) === member) pi.events.emit("agent-monitor:update", { id: `team:${member.name}`, kind: "team", name: member.name, status: "error", alive: false, activity: "连接失败", output: member.error });
				else reportMember(member, cancelled ? "任务已取消 · 等待新任务" : "任务失败");
				return { ok: false, error: cancelled ? "Team task was cancelled." : member.error };
			} finally {
				markActiveDone();
				if(member.activeDone===activeDone)member.activeDone=undefined;
				signal?.removeEventListener("abort", abort);
				if (member.waitAbort === waitAbort) member.waitAbort = undefined;
				if (member.activeJobId === job?.id) member.activeJobId = undefined;
				member.onPartial = undefined;
				member.lastActivityAt = Date.now();
				if (!closing && members.get(member.name) === member) {
					member.definition.interrupted = member.stopped || waitAbort.signal.aborted;
					member.definition.turns = member.turns;
					member.definition.lastMessageAt=member.lastMessageAt;
					member.definition.lastReply = member.lastReply ? truncate(member.lastReply, 12000) : undefined;
					persist();
				}
			}
		});
		// Keep the serialization chain alive even when a run fails.
		member.queue = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	async function disposeAll(suppressEvents = false): Promise<void> {
		graph.dispose();
		if (!suppressEvents) for (const job of [...jobs.values()]) cancelJob(job, "Team disbanded.");
		epoch++;
		for (const job of jobs.values()) job.cancelled = true;
		jobs.clear();
		notifications = [];
		history.length = 0;
		tasks.length = 0;
		deliveryError = undefined;
		for (const client of [...startingClients]) await client.stop().catch(() => {});
		startingClients.clear();
		for (const name of spawning) removeMember(name);
		for (const member of members.values()) {
			removeMember(member.name);
			member.stopped = true;
			member.waitAbort?.abort();
			await member.bridge?.stop().catch(() => {});
			try {
				await member.client.stop();
			} catch {
				// best effort
			}
			removePromptFile(member);
			member.status = "stopped";
		}
		members.clear();
	}

	async function restoreRoster(ctx: ExtensionContext) {
		currentCtx = ctx;
		taskTree.clear();deliveries=[];deliverySequence=0;queuedDeliveries.clear();tasks.length=0;
		restoreFailed = false;
		restoreErrors.clear();
		let snapshot: RosterSnapshot | undefined;
		try { snapshot = readRoster(ctx.sessionManager.getBranch()); }
		catch (error) { restoreFailed = true; restoreErrors.set("roster", String((error as Error)?.message ?? error)); return; }
		if (!snapshot) return;
		for(const record of snapshot.taskTree??[]){
			if(["queued","running","waiting"].includes(record.state)){record.state="interrupted";record.error="Session restarted. Work was not replayed; use team_resume explicitly.";record.processState="unknown";}
			taskTree.set(record.id,record);
		}
		deliveries=snapshot.deliveries??[];deliverySequence=Math.max(0,...deliveries.map(d=>d.sequence));
		const acknowledged=new Set<string>();for(const entry of ctx.sessionManager.getBranch() as any[]){const message=entry.message??entry;if(Array.isArray(message.details?.deliveryIds))for(const id of message.details.deliveryIds)acknowledged.add(id);}
		for(const delivery of deliveries)if(acknowledged.has(delivery.id))delivery.delivered=true;
		tasks.push(...(snapshot.board??[]));
		notifications=snapshot.completedJobs.filter(item=>item.deliveryId&&deliveries.some(d=>d.id===item.deliveryId&&!d.delivered&&d.to==="lead")&&!item.goalId);
		const pendingMembers = new Set(snapshot.pendingJobs.map(job => job.member));
		history.push(...snapshot.completedJobs.slice(-100));
		// Install the complete snapshot before any child can cause another write.
		for (const definition of snapshot.members) {
			definition.interrupted = pendingMembers.has(definition.name) || definition.interrupted;
			definitions.set(definition.name, definition);
		}
		for (const definition of snapshot.members) {
			if (members.has(definition.name) || spawning.has(definition.name)) continue;
			try {
				const result = await spawnMember({ __definition: definition }, ctx);
				if (result.isError) restoreErrors.set(definition.name, result.content.map(item => item.text).join("\n"));
			} catch (error) { restoreErrors.set(definition.name, String((error as Error)?.message ?? error)); }
		}
	}

	pi.on("session_start", async (_event, ctx) => { closing = false; await restoreRoster(ctx); });
	pi.events.on("project:prepare", data => {
		const request = data as { pending: Promise<unknown>[]; childFiles: Record<string, string>; emptyChildren: string[] };
		// Close idle clients too: Windows keeps their cwd handles open.
		closing = true;
		request.pending.push((async () => {
			for (const member of members.values()) {
				if (!member.definition.persistent || member.stopped) continue;
				const state = await member.client.getState();
				if (state.sessionFile) request.childFiles[member.name] = state.sessionFile;
				if (state.messageCount === 0) request.emptyChildren.push(member.name);
			}
			persist();
			await disposeAll(true);
		})());
	});
	pi.events.on("project:resume", data => {
		if (currentCtx) {
			closing = false;
			(data as { pending: Promise<unknown>[] }).pending.push(restoreRoster(currentCtx));
		}
	});
	pi.on("session_shutdown", async () => {
		if (!closing) persist();
		closing = true;
		await disposeAll(true);
	});
	pi.on("session_tree", async (_event, ctx) => {
		closing = true;
		await disposeAll(true);
		definitions.clear();
		tasks.length = 0;
		closing = false;
		await restoreRoster(ctx);
	});

	function rosterSummary(): string {
		if (members.size === 0) return "(no team members)";
		return Array.from(members.values())
			.map((m) => `${m.name} (${m.role}) [${m.status}]`)
			.join(", ");
	}

	function memberNotFound(name: string) {
		return {
			content: [
				{
					type: "text" as const,
					text: `No team member named "${name}". Current roster: ${rosterSummary()}. Use team_spawn first.`,
				},
			],
			details: { error: "not_found", name },
			isError:true,
		};
	}

	// -------------------------------------------------------------------
	// team_spawn
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "team_spawn",
		label: "Team: spawn member",
		executionMode: "sequential",
		description: [
			"Create a persistent team member: a long-lived sub-agent with its own isolated context window, identity, and conversation history.",
			"Use this to build a team, then delegate work with team_send / team_broadcast.",
			"Members stay alive between calls and remember previous messages, so you can assign follow-ups.",
			"The lead (you) keeps the plan and talks only to members; a member's reply is all you see.",
		].join(" "),
		promptGuidelines: ["When the user limits a member to a directory, specify workspace.root and access, not cwd alone. Restricted members have file tools only; do not request bash or nested delegation. Omit workspace to retain legacy unrestricted behavior."],
		parameters: Type.Object({
			name: Type.String({ description: "Unique roster name, e.g. \"alice\"." }),
			role: Type.String({ description: "One-line role, e.g. \"backend implementer\" or \"code reviewer\"." }),
			systemPrompt: Type.Optional(
				Type.String({ description: "Extra standing instructions for this member." }),
			),
			model: Type.Optional(
				Type.String({ description: "provider/model id. Omit to inherit the lead's current model." }),
			),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: "Allowlist of tools, e.g. [\"read\",\"grep\",\"find\",\"ls\"] for a read-only member.",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the lead's cwd." })),
			workspace: Type.Optional(WorkspaceSchema),
			persistent: Type.Optional(Type.Boolean({ default: true, description: "Persist the member definition and isolated child session across reload/restart of this main session. Default true." })),
			communication: Type.Optional(Type.Object({ allow: Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 100, description: "Member names this member may message; the lead can always message every member." }) }, { additionalProperties: false })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			return spawnMember(params, ctx, onUpdate);
		},
	});

	// -------------------------------------------------------------------
	// team_send
	// -------------------------------------------------------------------

	async function routeMemberMessage(from:string,request:MessageRequest,signal:AbortSignal):Promise<Omit<MessageResponse,"version"|"id">>{
		if(wakeSuppressed||closing||signal.aborted)return {ok:false,error:"Team is stopped; requests were not accepted."};
		const sender=members.get(from);if(!sender)return {ok:false,error:"Unknown sender."};
		const parent=jobs.get(sender.activeJobId??sender.contextJobId??"");
		const operation=request.operation??"task";
		if(["wait","status","cancel"].includes(operation)){
			if(!parent)return {ok:false,error:"No active assigned task. Ask the lead to dispatch a task before waiting."};
			const allowed=descendants(taskTree.values(),parent.id);
			if(operation==="cancel"){
				if(!request.taskId||request.taskId===parent.id||!allowed.has(request.taskId))return {ok:false,error:"Only this task's descendants may be cancelled."};
				const child=jobs.get(request.taskId);if(child)cancelJob(child,`Cancelled by owner ${from}`);
			}
			if(operation==="wait"&&request.blockedReason){
				graph.block(parent,request.blockedReason);
				const delivery=newDelivery(parent.record,++deliverySequence);deliveries.push(delivery);
				const owner=parent.record.parentId?jobs.get(parent.record.parentId):undefined;
				const blocked={id:parent.id,deliveryId:delivery.id,sequence:delivery.sequence,ok:false,error:`Blocked: ${request.blockedReason}`};
				if(owner)graph.note(owner,blocked,true);
				else if(wakeEnabled){pi.sendMessage({customType:"team-member-message",display:true,content:`Task ${parent.id} blocked: ${request.blockedReason}`,details:{deliveryIds:[delivery.id],taskId:parent.id}},{triggerTurn:true,deliverAs:"followUp"});}
				pi.events.emit("team:blocked",{goalId:parent.goalId,taskId:parent.id,reason:request.blockedReason});persist();
			}
			const pending=[...jobs.values()].filter(job=>job.id!==parent.id&&allowed.has(job.id)).map(job=>({id:job.id,member:job.member.name,state:job.record.state}));
			if(operation==="wait"&&request.reportAfterMs&&pending.length)graph.reportAfter(parent,request.reportAfterMs);
			return {ok:true,jobId:parent.id,reply:JSON.stringify({taskId:parent.id,goalId:parent.goalId,blocked:!!parent.record.blockedReason,pending,tree:[...taskTree.values()].filter(task=>allowed.has(task.id)).map(({message,...task})=>task)})};
		}
		if(request.to==="lead"){
			if(request.wait)return {ok:false,error:"Messages to the lead require wait:false."};
			if(queuedDeliveries.has(request.id)||deliveries.some(d=>d.id===request.id))return {ok:true,jobId:request.id};
			const identity=parent?.record;
			const delivery:Delivery={id:request.id,taskId:identity?.id??request.id,parentId:identity?.parentId,batchId:identity?.batchId??request.id,inputHash:identity?.inputHash??"note",resultPaths:identity?.resultPaths??[],from,to:"lead",sequence:++deliverySequence,createdAt:Date.now(),delivered:false};
			deliveries.push(delivery);persist();
			try{pi.sendMessage({customType:"team-member-message",content:`Message from ${from}; task ${delivery.taskId}; delivery ${delivery.id}; sequence ${delivery.sequence}:\n\n${request.message}`,display:true,details:{...delivery,deliveryIds:[delivery.id]}},{triggerTurn:true,deliverAs:"followUp"});queuedDeliveries.add(delivery.id);return {ok:true,jobId:request.id};}catch(error){return {ok:false,error:String(error)};}
		}
		const recipient=await reusableMember(request.to);
		const roster=new Map([...members].map(([name,member])=>[name,{communication:member.definition.communication}]));
		if(!recipient||!mayCommunicate(from,request.to,roster))return {ok:false,error:"TEAM_MESSAGE_DENIED: communication ACL denied."};
		let ancestor=parent;while(ancestor){if(ancestor.member===recipient){
			if(operation==="note"){
				const delivery:Delivery={id:request.id,taskId:parent!.id,parentId:parent!.record.parentId,batchId:parent!.record.batchId,inputHash:parent!.record.inputHash,resultPaths:parent!.record.resultPaths,from,to:recipient.name,sequence:++deliverySequence,createdAt:Date.now(),delivered:false};
				if(!deliveries.some(d=>d.id===request.id)){deliveries.push(delivery);graph.note(ancestor,{id:parent!.id,deliveryId:delivery.id,sequence:delivery.sequence,resultPaths:delivery.resultPaths,ok:true,reply:request.message});persist();}
				return {ok:true,jobId:request.id};
			}
			return {ok:false,error:"Task cycle denied: use operation:'note' for a report, or wait for descendant deliveries instead of assigning back to an ancestor."};
		}ancestor=ancestor.record.parentId?jobs.get(ancestor.record.parentId):undefined;}
		const forwarded=`[Message from teammate ${from}; parent task ${parent?.id??"unscoped"}]\n\n${request.message}`;
		const controller=new AbortController();const abort=()=>controller.abort();
		if(request.wait){messageAborts.add(controller);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();}
		const job=startJob(recipient,forwarded,Math.max(1,request.expiresAt-Date.now()),"off",request.wait?controller.signal:undefined,parent?.goalId,parent);
		if(request.wait){const record=taskTree.get(job.id);if(record)record.deliveryMode="reply";}
		if(!request.wait)return {ok:true,jobId:job.id};
		try{const value=await job.result;return value.ok?{ok:true,jobId:job.id,reply:value.reply}:{ok:false,jobId:job.id,error:value.error,timeoutLayer:taskTree.get(job.id)?.timeoutLayer,processState:taskTree.get(job.id)?.processState};}finally{messageAborts.delete(controller);signal.removeEventListener("abort",abort);}
	}

	async function spawnMember(params: any, ctx: any, onUpdate?: any) {
		currentCtx = ctx;
		if (params.__definition) {
			const saved = params.__definition as MemberDefinition;
			params = { ...params, name: saved.name, role: saved.role, systemPrompt: saved.systemPrompt, model: saved.model, tools: saved.tools, cwd: saved.cwd, workspace: saved.workspace, persistent: true, communication: saved.communication, __definition: saved };
		}
		const name = String(params.name).trim();
			if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
				return {
					content: [{ type: "text" as const, text: `Invalid member name "${name}". Use letters, digits, _ or - (max 32).` }],
					details: { error: "invalid_name" },
				};
			}
			if (members.has(name) || spawning.has(name)) {
				return {
					content: [{ type: "text" as const, text: `A member named "${name}" already exists. Pick another name or use team_send/team_disband.` }],
					details: { error: "duplicate_name", name },
				};
			}

			const inheritedModel =
				params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

		const comm = communication(params.communication);
		const persistent = params.__definition?.persistent ?? params.persistent !== false;
		const sessionId = params.__definition?.sessionId ?? (persistent ? randomUUID() : undefined);
			const effectiveTools = params.tools ? [...new Set([...params.tools, ...bridgeTools])] : params.tools;

			const systemPrompt = [
				`You are "${name}", a member of an agent team led by another agent.`,
				`Your role: ${params.role}.`,
				"You work in your own isolated context window. Work autonomously and completely on each task.",
				"When you finish a task, reply with a concise, self-contained report: what you did, the files or commands involved, key findings, and any blocker.",
				"That reply is the only thing the lead sees, so do not assume the lead has read your files or tool output.",
				"Use the provided team_message tool (workspace_team_message in restricted workspaces) to message allowed teammates or notify the lead with wait:false. The parent validates each pair's ACL.",
"Downstream tasks belong to your assigned task. After dispatching with wait:false, call team_wait ALONE to sleep until child deliveries arrive; use reportAfterMs only for an agreed progress check. Read receipt/log paths directly, do not ask the lead to rerun tests. A delivery ID is historical evidence: do not execute it twice.",
				params.systemPrompt ?? "",
			]
				.filter((part) => part && part.trim())
				.join("\n\n");

			spawning.add(name);
			const spawnEpoch = epoch;
			// Resolve cwd, tool selection, restricted flags and policy env first. A
			// validation failure must surface as a normal tool error with no subprocess.
			let plan: WorkspaceLaunchPlan;
			try {
				plan = await prepareWorkspaceLaunch({ baseCwd: ctx.cwd, cwd: params.cwd, workspace: params.workspace, tools: effectiveTools });
				if (closing || spawnEpoch !== epoch) throw new Error("Team session changed while workspace was being validated.");
			} catch (error) {
				spawning.delete(name);
				return {
					content: [
						{
							type: "text" as const,
							text: `Workspace validation failed for "${name}": ${(error as Error)?.message ?? String(error)}`,
						},
					],
					details: { error: "workspace_invalid", name },
					isError: true,
				};
			}
			const memberCwd = plan.cwd;
			const memberWorkspace = plan.workspace;

			// Runtime args only; the helper owns tool selection (legacy --tools, or
			// --no-tools + restricted flags + guard extension when restricted).
		const definition: MemberDefinition = params.__definition ?? { name, role: params.role, systemPrompt: params.systemPrompt, model: inheritedModel, thinkingLevel: ctx.thinkingLevel, tools: effectiveTools, cwd: memberCwd, workspace: memberWorkspace, persistent, sessionId, communication: comm, createdAt: Date.now() };
			const bridgePath = fileURLToPath(new URL("./member-bridge.ts", import.meta.url));
			const bridge = await createParentBridge(os.tmpdir(), name, (request, signal) => routeMemberMessage(name, request, signal));
			const args = [...plan.args];
			if (!args.includes("--no-extensions")) args.push("--no-extensions");
			args.push("--extension", bridgePath);
			if (persistent) args.push("--session-id", sessionId!); else args.push("--no-session");
			if (inheritedModel) args.push("--model", inheritedModel);
			if (!params.model && ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);

			pi.events.emit("agent-monitor:update", { id: `team:${name}`, kind: "team", name, status: "starting", alive: false, model: inheritedModel, activity: "启动进程", output: "", startedAt: Date.now(), workspace: memberWorkspace?.root, access: memberWorkspace?.access, cwd: memberCwd });
			let promptFilePath: string | undefined;
			let client: RpcClient | undefined;
			try {
				if (closing) throw new Error("Team runtime is shutting down.");
				promptFilePath = await writeSystemPrompt(name, systemPrompt);
				args.push("--append-system-prompt", promptFilePath);

				client = new RpcClient({
					cliPath: resolveCliPath(),
					cwd: memberCwd,
					args,
					env: { ...plan.env, [MEMBER_ENV]: name, [BRIDGE_ENV]: JSON.stringify(bridge.config) },
				});
				startingClients.add(client);
				await client.start();
				await client.getState();
				if (closing || spawnEpoch !== epoch) throw new Error("Team session changed while the member was starting.");
				startingClients.delete(client);

				const member: TeamMember = {
					definition,
					bridge,
					name,
					role: params.role,
					client,
					status: "idle",
					model: inheritedModel,
					tools: effectiveTools,
					workspace: memberWorkspace,
					cwd: memberCwd,
					promptFilePath,
					createdAt: definition.createdAt,
					lastActivityAt: Date.now(),
					turns: definition.turns ?? 0,
					lastReply: definition.lastReply,
					lastMessageAt:definition.lastMessageAt,
					partial: "",
					transcript: [],
					queue: Promise.resolve(),
				};
				attachEvents(member);
				members.set(name, member);
				definitions.set(name, definition);
				persist();
				reportMember(member, "等待任务");

				onUpdate?.({
					content: [{ type: "text", text: `Spawned ${name} (${params.role}).` }],
					details: { name, cwd: memberCwd, workspace: memberWorkspace },
				});

				return {
					content: [
						{
							type: "text" as const,
							text: `Spawned team member "${name}" (${params.role})${inheritedModel ? ` on ${inheritedModel}` : ""}${memberWorkspace ? ` in workspace ${memberWorkspace.root} (${memberWorkspace.access})` : ""}. Roster: ${rosterSummary()}. Delegate with team_send.`,
						},
					],
						details: { name, model: inheritedModel, tools: effectiveTools, cwd: memberCwd, workspace: memberWorkspace, communication: comm, persistent },
				};
			} catch (error) {
				if (!closing && spawnEpoch === epoch) pi.events.emit("agent-monitor:update", { id: `team:${name}`, kind: "team", name, status: "error", alive: false, model: inheritedModel, activity: "启动失败", workspace: memberWorkspace?.root, access: memberWorkspace?.access, cwd: memberCwd });
				if (bridge) await bridge.stop().catch(() => {});
				if (client) startingClients.delete(client);
				await client?.stop().catch(() => {});
				if (promptFilePath) {
					try {
						fs.rmSync(path.dirname(promptFilePath), { recursive: true, force: true });
					} catch {
						// ignore
					}
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to spawn "${name}": ${(error as Error)?.message ?? String(error)}`,
						},
					],
					details: { error: "spawn_failed", name },
					isError: true,
				};
			} finally { spawning.delete(name); }
		}

	async function cancelMember(name: string, reason: string) {
		const member = members.get(name);
		if (!member) return memberNotFound(name);
		member.cancellationGeneration = (member.cancellationGeneration ?? 0) + 1;
		const affected=new Set<string>();for(const job of jobs.values())if(job.member===member)for(const id of descendants(taskTree.values(),job.id))affected.add(id);
		const pending=[...new Set([...jobs.values()].filter(job=>affected.has(job.id)).map(job=>job.member.queue))];
		for (const job of [...jobs.values()]) if (job.member === member) cancelJob(job, reason);
		member.waitAbort?.abort(reason);
		await Promise.allSettled(pending);
		persist();
		return { content:[{type:"text" as const,text:`Cancelled current and queued work for ${name}. Member identity and conversation are retained.`}],details:{name,cancelled:true,retained:true,processAlive:!member.stopped,sessionId:member.definition.sessionId} };
	}
	pi.registerTool({
		name:"team_cancel",label:"Team: cancel work",executionMode:"parallel",
		description:"Cancel a member's current and queued work by name, or one async job by jobId, without disbanding the member or deleting its conversation. Other members continue.",
		promptGuidelines:["Use team_cancel to interrupt or replace a member task. Reserve team_disband for removing members. team_send with wait:false leaves the lead free to call team_cancel."],
		parameters:Type.Object({name:Type.Optional(Type.String()),jobId:Type.Optional(Type.String()),reason:Type.Optional(Type.String({maxLength:2000}))}),
		async execute(_id,params){
			if(Number(!!params.name)+Number(!!params.jobId)!==1)return {content:[{type:"text" as const,text:"Specify exactly one of name or jobId."}],details:undefined,isError:true};
			const reason=params.reason||"Task cancelled by the lead.";
			if(params.name)return cancelMember(params.name,reason);
			const job=jobs.get(params.jobId!);
			if(!job)return {content:[{type:"text" as const,text:"Unknown or already finished job."}],details:{jobId:params.jobId},isError:true};
			const affected=descendants(taskTree.values(),job.id);
			const pending=[...new Set([...jobs.values()].filter(child=>affected.has(child.id)).map(child=>child.member.queue))];
			cancelJob(job,reason);
			await Promise.allSettled(pending);
			return {content:[{type:"text" as const,text:`Cancelled job ${job.id}; member ${job.member.name} retained.`}],details:{jobId:job.id,name:job.member.name,cancelled:true,retained:true}};
		},
	});
	pi.registerCommand("team-cancel",{description:"Cancel a member's current/queued tasks without removing it: /team-cancel <name>",handler:async(args,ctx)=>{const result=await cancelMember(args.trim(),"Task cancelled with /team-cancel");ctx.ui.notify(result.content.map(item=>item.text).join("\n"),"info");}});

	async function reusableMember(name:string){
		const existing=members.get(name);
		if(!existing?.stopped)return existing;
		await existing.bridge?.stop().catch(()=>{});
		removePromptFile(existing);members.delete(name);
		const restored=await spawnMember({__definition:existing.definition},currentCtx!);
		if(restored.isError)return undefined;
		return members.get(name);
	}

	pi.registerTool({name:"team_configure",label:"Team: configure execution",executionMode:"sequential",description:"Enable an isolated command backend or disable execution for an idle restricted member. Preserves its workspace roots, file access, identity and conversation; never grants unrestricted host tools.",parameters:Type.Object({name:Type.String(),execution:Type.Union([Type.Literal("disabled"),Type.Literal("sandbox")]),sandbox:Type.Optional(SandboxSchema)}),
		async execute(_id,args,_signal,_update,ctx){
			const member=members.get(args.name);if(!member)return memberNotFound(args.name);
			if(!member.workspace)return {content:[{type:"text" as const,text:"This tool configures restricted members only."}],details:undefined,isError:true};
			if([...jobs.values()].some(job=>job.member===member)||member.status==="working")return {content:[{type:"text" as const,text:"Finish or cancel this member's tasks before changing its execution backend."}],details:undefined,isError:true};
			try{
				const workspace={...member.workspace,execution:args.execution,sandbox:args.execution==="sandbox"?args.sandbox:undefined};
				const tools=member.definition.tools?member.definition.tools.filter(tool=>tool!=="exec"):undefined;
				if(tools&&args.execution==="sandbox")tools.push("exec");
				const plan=await prepareWorkspaceLaunch({baseCwd:ctx.cwd,cwd:member.cwd,workspace,tools});
				const saved=JSON.parse(JSON.stringify(member.definition));const updated={...saved,workspace:plan.workspace,tools};
				member.stopped=true;await member.bridge?.stop();await member.client.stop();removePromptFile(member);members.delete(member.name);
				const changed=await spawnMember({__definition:updated},ctx);
				if(changed.isError){await spawnMember({__definition:saved},ctx);return changed;}
				return changed;
			}catch(error){return {content:[{type:"text" as const,text:String((error as Error).message)}],details:undefined,isError:true};}
		},
	});
	pi.registerTool({name:"team_tree",label:"Team: task tree",description:"Inspect durable task ancestry, queue/run state, delivery identities, artifacts and timeout layers. Restored tasks stay interrupted until explicitly resumed.",parameters:Type.Object({taskId:Type.Optional(Type.String())}),
		async execute(_id,params){const selected=params.taskId?descendants(taskTree.values(),params.taskId):undefined;const records=[...taskTree.values()].filter(t=>!selected||selected.has(t.id)).map(({message,...record})=>record);return {content:[{type:"text" as const,text:truncate(JSON.stringify(records,null,2))}],details:{tasks:records,deliveries:deliveries.filter(d=>!selected||selected.has(d.taskId))}};},
	});
	pi.registerTool({name:"team_resume",label:"Team: resume saved task",executionMode:"sequential",description:"Explicitly redispatch a saved interrupted/failed/cancelled task as a new attempt. Never automatically rerun historical results.",parameters:Type.Object({taskId:Type.String()}),
		async execute(_id,params){
			const saved=taskTree.get(params.taskId);
			if(!saved||!["interrupted","cancelled","failed","blocked"].includes(saved.state))return {content:[{type:"text" as const,text:"Only interrupted, cancelled, blocked or failed tasks can be resumed."}],details:undefined,isError:true};
			const member=await reusableMember(saved.member);if(!member)return memberNotFound(saved.member);wakeSuppressed=false;
			const scope:{projectId?:string;pathMappings?:unknown}={};pi.events.emit("project:scope",scope);
			const message=`[Explicitly resumed attempt of ${saved.id}. Historical path mappings: ${JSON.stringify(scope.pathMappings??[])}. Resolve evidence paths against the current workspace; do not alter old evidence.]\n${saved.message}`;
			const parent=saved.parentId?jobs.get(saved.parentId):undefined;
			const next=startJob(member,message,saved.runTimeoutMs,parent?"off":"batch",undefined,parent?.goalId,parent,saved.queueTimeoutMs,undefined,saved.id);
			const old=jobs.get(saved.id);if(old)cancelJob(old,"Replaced by an explicitly resumed attempt.");
			return {content:[{type:"text" as const,text:`Resumed ${saved.id} as ${next.id}.`}],details:{jobId:next.id,attemptOf:saved.id}};
		},
	});
	pi.registerTool({
		name: "team_send",
		label: "Team: send to member",
		description: [
			"Send a task or message to one team member and, by default, wait for its reply.",
			"Work is serialized per member: messages to the same member run one after another.",
			"To run members in parallel, issue several team_send calls in the same turn (they run concurrently), or use team_broadcast.",
			"For long jobs use wait=false; completion automatically wakes the lead when the background batch drains. No polling is needed.",
		].join(" "),
		promptGuidelines: ["Use team_send or team_broadcast with wait:false to let members work while the lead ends its turn. Completion wakes the lead automatically; do not repeatedly poll team_list/team_collect. In Goal mode call goal_wait alone after dispatch."],
		parameters: Type.Object({
			to: Type.String({ description: "Roster name of the member." }),
			message: Type.String({ description: "The task or message. Be specific and self-contained." }),
			wait: Type.Optional(
				Type.Boolean({
					description: "Wait for the member to finish and return its reply. Default true. Set false to dispatch asynchronously.",
					default: true,
				}),
			),
			notify: Type.Optional(StringEnum(["batch", "immediate", "off"] as const, { description: "Async notification policy; default batch wakes after all background jobs drain. Goal mode controls its own wakeups." })),
			queueTimeoutMs: Type.Optional(Type.Integer({minimum:1,maximum:2147483647,description:"Maximum queue wait, separate from member response timeoutMs."})),
			timeoutMs: Type.Optional(
				Type.Number({ minimum: 1, maximum: 2147483647, description: `Max wait in ms. Default ${DEFAULT_TIMEOUT_MS}.` }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const member = await reusableMember(params.to);
			if (!member) return memberNotFound(params.to);
			const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

			if (params.wait === false) {
				wakeSuppressed=false;
				const jobId = background(member, params.message, timeout, params.notify ?? "batch",params.queueTimeoutMs??timeout);
				return {
					content: [
						{
							type: "text" as const,
							text: `Dispatched job ${jobId} to "${params.to}" (async). Completion wakes the lead automatically unless notifications are off.`,
						},
					],
					details: { to: params.to, async: true, jobId },
				};
			}

			const tracked=startJob(member,params.message,timeout,"off",signal,undefined,undefined,params.queueTimeoutMs??timeout);
			const result = await tracked.result;

			if (!result.ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Member "${member.name}" failed: ${result.error}\n\nRoster: ${rosterSummary()}`,
						},
					],
					details: { to: member.name, error: result.error, jobId:tracked.id,timeoutLayer:taskTree.get(tracked.id)?.timeoutLayer,processState:taskTree.get(tracked.id)?.processState,resultPaths:taskTree.get(tracked.id)?.resultPaths },
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Reply from ${member.name} (${member.role}):\n\n${truncate(result.reply ?? "(empty reply)")}`,
					},
				],
				details: { to: member.name, jobId:tracked.id,turns: member.turns, status: member.status,resultPaths:taskTree.get(tracked.id)?.resultPaths },
			};
		},
	});

	// -------------------------------------------------------------------
	// team_broadcast
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "team_broadcast",
		label: "Team: broadcast",
		description:
			"Send the same message to every team member and, by default, wait for all replies. Useful for announcements or asking everyone for input.",
		parameters: Type.Object({
			message: Type.String({ description: "The message sent to all members." }),
			wait: Type.Optional(Type.Boolean({ description: "Wait for all replies. Default true.", default: true })),
			notify: Type.Optional(StringEnum(["batch", "immediate", "off"] as const, { description: "Async notification policy, default batch. Goal mode controls its own wakeups." })),
			timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 2147483647, description: `Max wait per member in ms. Default ${DEFAULT_TIMEOUT_MS}.` })),
		}),
		async execute(_toolCallId, params, signal) {
			const all = Array.from(members.values());
			wakeSuppressed=false;
			if (all.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No team members. Use team_spawn first." }],
					details: { count: 0 },
				};
			}
			const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const batchId=randomUUID();

			if (params.wait === false) {
				const jobIds = all.map(member => background(member, params.message, timeout, params.notify ?? "batch",timeout,batchId));
				return {
					content: [
						{ type: "text" as const, text: `Broadcast ${jobIds.length} async jobs. Completion wakes the lead automatically unless notifications are off.` },
					],
					details: { count: all.length, async: true, jobIds },
				};
			}

			const results = await Promise.all(
				all.map(async (member) => ({ member, result: await startJob(member, params.message, timeout, "off", signal,undefined,undefined,timeout,batchId).result })),
			);

			const lines = results.map(({ member, result }) =>
				result.ok
					? `### ${member.name} (${member.role})\n${truncate(result.reply ?? "(empty reply)")}`
					: `### ${member.name} (${member.role}) — FAILED\n${result.error}`,
			);
			return {
				content: [{ type: "text" as const, text: lines.join("\n\n") }],
				details: { count: all.length },
			};
		},
	});

	// -------------------------------------------------------------------
	// team_collect
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "team_collect",
		label: "Team: collect replies",
		description:
			"Wait for busy members to finish, then return their latest replies. Use after dispatching with wait=false or team_send wait=false.",
		parameters: Type.Object({
			jobIds: Type.Optional(Type.Array(Type.String(), { maxItems: 100, description: "Retrieve specific completed async jobs by ID (last 100 retained), including jobs with notifications off. Pending IDs are reported without waiting." })),
			names: Type.Optional(
				Type.Array(Type.String(), { description: "Members to collect. Default: all members." }),
			),
		}),
		async execute(_toolCallId, params) {
			if (params.jobIds?.length) {
				const results = params.jobIds.map(id => history.find(result => result.id === id) ?? { id, pending: jobs.has(id), error: jobs.has(id) ? undefined : "Unknown or expired job ID." });
				return { content: [{ type: "text" as const, text: truncate(JSON.stringify(results, null, 2)) }], details: { results } };
			}
			const targets = params.names?.length
				? params.names.map((name) => members.get(name)).filter((m): m is TeamMember => Boolean(m))
				: Array.from(members.values());

			if (targets.length === 0) {
				return {
					content: [{ type: "text" as const, text: `Nothing to collect. Roster: ${rosterSummary()}` }],
					details: { count: 0 },
				};
			}

			await Promise.all(targets.map((member) => member.queue.catch(() => {})));

			const lines = targets.map((member) => {
				const marker = statusIcon(member.status);
				if (member.error) return `${marker} ${member.name}: ERROR — ${member.error}`;
				return `${marker} ${member.name}: ${truncate(member.lastReply ?? "(no reply yet)")}`;
			});
			return {
				content: [{ type: "text" as const, text: lines.join("\n\n") }],
				details: { count: targets.length },
			};
		},
	});

	// -------------------------------------------------------------------
	// team_list
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "team_list",
		label: "Team: roster",
		description: "Show the current team roster: each member's role, status, model, turn count, and last reply tail.",
		parameters: Type.Object({}),
		async execute() {
			if (members.size === 0) {
				return {
					content: [{ type: "text" as const, text: restoreErrors.size ? `Team restoration failed: ${[...restoreErrors].map(([name, error]) => `${name}: ${error}`).join("\n")}` : "The team is empty. Use team_spawn to add members." }],
					details: { count: 0, restoringErrors: Object.fromEntries(restoreErrors) },
				};
			}
			const lines = Array.from(members.values()).map((member) => {
				const head = `${statusIcon(member.status)} ${member.name} — ${member.role}`;
				const meta = [
					`model=${member.model ?? "inherited"}`,
					`status=${member.status}`,
					`turns=${member.turns}`,
					`cwd=${member.cwd ?? "(lead cwd)"}`,
					`workspace=${member.workspace ? `${member.workspace.root} (${member.workspace.access})` : "none"}`,
					`persistent=${member.definition.persistent}, interrupted=${!!member.definition.interrupted}`,
					`peers=${member.definition.communication.allow.join(",") || "none"}`,
					`last=${member.turns ? nowIso(member.lastActivityAt) : "never"}`,
				].join(", ");
				const tail = member.error
					? `error: ${member.error}`
					: member.lastReply
						? `last reply: ${member.lastReply.slice(0, 200)}`
						: "no replies yet";
				return `${head}\n    ${meta}\n    ${tail}`;
			});
			const open = tasks.filter((t) => t.status !== "done").length;
			return {
				content: [
					{
						type: "text" as const,
						text: `Roster (${members.size} members, ${open} open tasks, ${jobs.size} background jobs, auto-wake ${wakeEnabled ? "on" : "off"}):\n\n${lines.join("\n")}${deliveryError ? `\nDelivery error: ${deliveryError}` : ""}`,
					},
				],
				details: { count: members.size, restoringErrors: Object.fromEntries(restoreErrors), members: Array.from(members.values()).map((member) => ({ name: member.name, cwd: member.cwd, workspace: member.workspace, persistent: member.definition.persistent, sessionId: member.definition.sessionId, interrupted: member.definition.interrupted, communication: member.definition.communication })) },
			};
		},
	});

	// -------------------------------------------------------------------
	// team_disband
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "team_disband",
		label: "Team: disband member",
		description: "Stop one member's process and remove it from the roster. Use name \"*\" to disband the whole team.",
		parameters: Type.Object({
			name: Type.String({ description: "Roster name, or \"*\" for everyone." }),
		}),
		async execute(_toolCallId, params) {
			if (params.name === "*") {
				const count = members.size;
				definitions.clear();
				persist();
				await disposeAll();
				return {
					content: [{ type: "text" as const, text: `Disbanded all ${count} members.` }],
					details: { count },
				};
			}
			const member = members.get(params.name);
			if (!member) return memberNotFound(params.name);
			for (const job of [...jobs.values()]) if (job.member === member) cancelJob(job, "Team member disbanded.");
			removeMember(member.name);
			member.stopped = true;
			member.waitAbort?.abort();
			try {
				await member.client.stop();
			} catch {
				// best effort
			}
				await member.bridge?.stop().catch(() => {});
				removePromptFile(member);
				members.delete(params.name);
				definitions.delete(params.name);
				persist();
			return {
				content: [
					{ type: "text" as const, text: `Disbanded "${params.name}". Roster: ${rosterSummary()}.` },
				],
				details: { name: params.name },
			};
		},
	});

	// -------------------------------------------------------------------
	// team_tasks (shared task board)
	// -------------------------------------------------------------------
	pi.registerTool({
		name: "team_tasks",
		label: "Team: shared task board",
		description:
			"A shared task board for the whole team. action=\"add\" creates a task, \"update\" changes its status/assignee/note, \"list\" shows all tasks.",
		parameters: Type.Object({
			action: StringEnum(["add", "update", "list"] as const, { description: "Operation to perform." }),
			id: Type.Optional(Type.String({ description: "Task id (for update)." })),
			title: Type.Optional(Type.String({ description: "Task title (for add)." })),
			assignee: Type.Optional(Type.String({ description: "Member name responsible, or omit." })),
			status: Type.Optional(
				StringEnum(["todo", "doing", "done", "blocked"] as const, { description: "New status (for update)." }),
			),
			note: Type.Optional(Type.String({ description: "Optional note." })),
		}),
		async execute(_toolCallId, params) {
			if (params.action === "add") {
				if (!params.title) {
					return {
						content: [{ type: "text" as const, text: "`title` is required for action=\"add\"." }],
						details: { error: "missing_title" },
					};
				}
				const task: TeamTask = {
					id: uid(),
					title: params.title,
					assignee: params.assignee,
					status: "todo",
					note: params.note,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};
				tasks.push(task);persist();
				return {
					content: [{ type: "text" as const, text: `Added task ${task.id}: ${task.title}` }],
					details: task,
				};
			}

			if (params.action === "update") {
				const task = tasks.find((t) => t.id === params.id);
				if (!task) {
					return {
						content: [{ type: "text" as const, text: `No task with id "${params.id}".` }],
						details: { error: "not_found" },
					};
				}
				if (params.status) task.status = params.status;
				if (params.assignee) task.assignee = params.assignee;
				if (params.note !== undefined) task.note = params.note;
				task.updatedAt = Date.now();persist();
				return {
					content: [{ type: "text" as const, text: `Updated task ${task.id} → ${task.status}.` }],
					details: task,
				};
			}

			if (tasks.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Task board is empty." }],
					details: { count: 0 },
				};
			}
			const lines = tasks.map(
				(t) =>
					`${taskIcon(t.status)} ${t.id} — ${t.title}${t.assignee ? ` (@${t.assignee})` : ""}${t.note ? ` — ${t.note}` : ""}`,
			);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { count: tasks.length },
			};
		},
	});
}
