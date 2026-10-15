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
	type ResolvedWorkspace,
} from "../workspace/launch.ts";
import { promptAndWaitSafely } from "./rpc.ts";
import { POLICY_ENV } from "../workspace/policy.ts";
import { BRIDGE_ENV, MEMBER_ENV, communication, createParentBridge, mayCommunicate, validMemberName, type MessageRequest, type ParentBridge } from "./messaging.ts";
import { ROSTER_TYPE, readRoster, type MemberDefinition, type RosterSnapshot } from "./roster.ts";

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
	lastReply?: string;
	error?: string;
	turns: number;
	partial: string;
	transcript: TranscriptItem[];
	/** Resolves when the member's currently queued run settles. */
	queue: Promise<void>;
	activeJobId?: string;
	waitAbort?: AbortController;
	stopped?: boolean;
	onPartial?: (text: string) => void;
}

type NotifyPolicy = "batch" | "immediate" | "off";
interface Completion {
	id: string;
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
	let deliveryError: string | undefined;
	let currentCtx: ExtensionContext | undefined;
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
			startedAt: member.workStartedAt ?? member.createdAt, updatedAt: Date.now(),
		});
	}
	function removeMember(name: string) { pi.events.emit("agent-monitor:remove", { id: `team:${name}` }); }

	function deliver(results: Completion[]): boolean {
		if (closing || !wakeEnabled || !results.length) return false;
		const request = { results };
		pi.events.emit("team:before-wake", request);
		if (!request.results.length) return true;
		try {
			pi.sendMessage({ customType: "team-results", display: true, details: { results: request.results },
				content: "Background team work finished. Review the results and continue the user's task.\n\n" + request.results.map(result => `Member ${result.member}, job ${result.id}: ${result.ok ? "completed" : "FAILED"}\n${truncate(result.ok ? result.reply || "(empty reply)" : result.error || "Unknown failure", 12000)}`).join("\n\n"),
			}, { triggerTurn: true, deliverAs: "followUp" });
			deliveryError = undefined;
			return true;
		} catch (error) { deliveryError = String((error as Error)?.message ?? error); return false; }
	}
	function flush() {
		if ([...jobs.values()].some(job => job.notify !== "off" && !job.goalId) || !notifications.length) return;
		const results = notifications.slice();
		if (deliver(results)) notifications.splice(0, results.length);
	}
	function finishJob(job: BackgroundJob, result: { ok: boolean; reply?: string; error?: string }, suppress = false) {
		if (job.finished) return;
		job.finished = true;
		jobs.delete(job.id);
		if (closing || job.epoch !== epoch) return;
		const completion: Completion = { id: job.id, member: job.member.name, goalId: job.goalId, ...result };
		history.push({ ...completion, reply: completion.reply ? truncate(completion.reply, 12000) : undefined });
		if (history.length > 100) history.splice(0, history.length - 100);
		persist();
		pi.events.emit("team:job-end", completion);
		if (!suppress && job.notify !== "off") {
			if (job.notify !== "immediate" || !deliver([completion])) notifications.push(completion);
		}
		flush();
	}
	function cancelJob(job: BackgroundJob, reason: string) {
		job.cancelled = true;
		job.notify = "off";
		finishJob(job, { ok: false, error: reason }, true);
		if (job.member.activeJobId === job.id) job.member.waitAbort?.abort();
	}
	function startJob(member: TeamMember, message: string, timeout: number, notify: NotifyPolicy, signal?: AbortSignal, goalId?: string) {
		const scope: { goalId?: string } = { goalId };
		if (!goalId) pi.events.emit("team:scope", scope);
		const job: BackgroundJob = { id: `${Date.now().toString(36)}-${uid()}`, member, goalId: scope.goalId, notify, epoch, cancelled: false, finished: false };
		jobs.set(job.id, job);
		persist();
		pi.events.emit("team:job-start", { id: job.id, member: member.name, goalId: job.goalId });
		const result = dispatch(member, message, timeout, undefined, signal, job).then(
			result => { finishJob(job, result); return result; },
			error => { const result = { ok: false, error: String(error) }; finishJob(job, result); return result; },
		);
		return { id: job.id, result };
	}
	function background(member: TeamMember, message: string, timeout: number, notify: NotifyPolicy) {
		return startJob(member, message, timeout, notify).id;
	}
	pi.events.on("team:cancel-goal", data => {
		const goalId = (data as { goalId?: string } | undefined)?.goalId;
		if (!goalId) return;
		for (const job of [...jobs.values()]) if (job.goalId === goalId) cancelJob(job, "Goal stopped by the user.");
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
			if (event?.type === "agent_start") {
				member.status = "working";
				member.partial = "";
				reportMember(member, "等待响应");
			} else if (
				event?.type === "message_update" &&
				event.assistantMessageEvent?.type === "text_delta"
			) {
				member.partial += event.assistantMessageEvent.delta ?? "";
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
		const run = member.queue.then(async () => {
			if (closing || member.stopped || members.get(member.name) !== member || signal?.aborted || (job && (job.cancelled || job.epoch !== epoch))) return { ok: false, error: "Team task was cancelled." };
			member.activeJobId = job?.id;
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
				const events = await promptAndWaitSafely(member.client, message, undefined, timeoutMs, waitAbort.signal);
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
					try { await member.client.abort(); }
					catch { member.stopped = true; forcedStop = true; await member.client.stop().catch(() => {}); }
				}
				member.status = "error";
				member.error = String((error as Error)?.message ?? error);
				if (forcedStop && !closing && members.get(member.name) === member) pi.events.emit("agent-monitor:update", { id: `team:${member.name}`, kind: "team", name: member.name, status: "error", alive: false, activity: "连接失败", output: member.error });
				else reportMember(member, "任务失败");
				return { ok: false, error: member.error };
			} finally {
				signal?.removeEventListener("abort", abort);
				if (member.waitAbort === waitAbort) member.waitAbort = undefined;
				if (member.activeJobId === job?.id) member.activeJobId = undefined;
				member.onPartial = undefined;
				member.lastActivityAt = Date.now();
				if (!closing && members.get(member.name) === member) {
					member.definition.interrupted = member.stopped || waitAbort.signal.aborted;
					member.definition.turns = member.turns;
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
		restoreFailed = false;
		restoreErrors.clear();
		let snapshot: RosterSnapshot | undefined;
		try { snapshot = readRoster(ctx.sessionManager.getBranch()); }
		catch (error) { restoreFailed = true; restoreErrors.set("roster", String((error as Error)?.message ?? error)); return; }
		if (!snapshot) return;
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
	pi.on("session_shutdown", async () => {
		persist();
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

	async function routeMemberMessage(from: string, request: MessageRequest, signal: AbortSignal): Promise<{ ok: boolean; reply?: string; error?: string; jobId?: string }> {
		if (request.to === "lead") {
			if (request.wait) return { ok: false, error: "Messages to the lead require wait:false." };
			try {
				pi.sendMessage({ customType: "team-member-message", content: `Message from ${from}:\n\n${request.message}`, display: true, details: { from, to: "lead" } }, { triggerTurn: true, deliverAs: "followUp" });
				return { ok: true, jobId: request.id };
			} catch (error) { return { ok: false, error: String((error as Error)?.message ?? error) }; }
		}
		const sender = members.get(from);
		const recipient = members.get(request.to);
		const roster = new Map([...members].map(([name, member]) => [name, { communication: member.definition.communication }]));
		if (!sender || !recipient || !mayCommunicate(from, request.to, roster)) return { ok: false, error: "TEAM_MESSAGE_DENIED: communication ACL denied." };
		const forwarded = `[Message from teammate ${from}]\n\n${request.message}`;
		if (!request.wait) {
			void dispatch(recipient, forwarded, Math.max(1, request.expiresAt - Date.now()), undefined, signal).catch(() => {});
			return { ok: true, jobId: request.id };
		}
		const result = await dispatch(recipient, forwarded, Math.max(1, request.expiresAt - Date.now()), undefined, signal);
		return result.ok ? { ok: true, reply: result.reply } : { ok: false, error: result.error };
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
			const effectiveTools = params.tools ? [...new Set([...params.tools, "team_message"])] : params.tools;

			const systemPrompt = [
				`You are "${name}", a member of an agent team led by another agent.`,
				`Your role: ${params.role}.`,
				"You work in your own isolated context window. Work autonomously and completely on each task.",
				"When you finish a task, reply with a concise, self-contained report: what you did, the files or commands involved, key findings, and any blocker.",
				"That reply is the only thing the lead sees, so do not assume the lead has read your files or tool output.",
				"Use the provided team_message tool (workspace_team_message in restricted workspaces) to message allowed teammates or notify the lead with wait:false. The parent validates each pair's ACL.",
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
			timeoutMs: Type.Optional(
				Type.Number({ minimum: 1, maximum: 2147483647, description: `Max wait in ms. Default ${DEFAULT_TIMEOUT_MS}.` }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const member = members.get(params.to);
			if (!member) return memberNotFound(params.to);
			const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

			if (params.wait === false) {
				const jobId = background(member, params.message, timeout, params.notify ?? "batch");
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

			const result = await dispatch(member, params.message, timeout, (partial) => {
				onUpdate?.({
					content: [{ type: "text", text: `[${member.name}] ${partial.slice(-1500)}` }],
					details: { to: member.name, partial: true },
				});
			}, signal);

			if (!result.ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Member "${member.name}" failed: ${result.error}\n\nRoster: ${rosterSummary()}`,
						},
					],
					details: { to: member.name, error: result.error },
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
				details: { to: member.name, turns: member.turns, status: member.status },
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
			if (all.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No team members. Use team_spawn first." }],
					details: { count: 0 },
				};
			}
			const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

			if (params.wait === false) {
				const jobIds = all.map(member => background(member, params.message, timeout, params.notify ?? "batch"));
				return {
					content: [
						{ type: "text" as const, text: `Broadcast ${jobIds.length} async jobs. Completion wakes the lead automatically unless notifications are off.` },
					],
					details: { count: all.length, async: true, jobIds },
				};
			}

			const results = await Promise.all(
				all.map(async (member) => ({ member, result: await dispatch(member, params.message, timeout, undefined, signal) })),
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
				tasks.push(task);
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
				task.updatedAt = Date.now();
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
