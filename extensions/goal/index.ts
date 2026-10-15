/** Goal mode: persistent objectives, bounded continuation, and team-result wakeups. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Status = "running" | "waiting" | "paused" | "blocked" | "completed" | "stopped";
interface Completion {
	id: string;
	member: string;
	goalId?: string;
	ok: boolean;
	reply?: string;
	error?: string;
	notified?: boolean;
}
interface Goal {
	version: 1;
	id: string;
	objective: string;
	criteria: string[];
	verificationCommands: string[];
	status: Status;
	/** Only provider failures are eligible for an automatic supervisor recovery. */
	pauseCause?: "provider-error";
	reason?: string;
	createdAt: number;
	updatedAt: number;
	budgetStartedAt: number;
	maxContinuations: number;
	continuations: number;
	maxMinutes: number;
	maxOutputTokens: number;
	outputTokens: number;
	pending: Array<{ id: string; member: string }>;
	results: Completion[];
	evidence?: Array<{ criterion: number; evidence: string }>;
	verification?: Array<{ command: string; ok: boolean; output: string }>;
}
const STATE_TYPE = "goal-state";
const active = (goal: Goal | undefined): goal is Goal => !!goal && (goal.status === "running" || goal.status === "waiting");
const clip = (text: string, limit = 6000) => text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
const textResult = (text: string, details: unknown, isError = false) => ({
	content: [{ type: "text" as const, text }], details: details === undefined ? undefined : JSON.parse(JSON.stringify(details)), ...(isError ? { isError: true } : {}),
});
const StartParams = Type.Object({
	objective: Type.String({ minLength: 1, maxLength: 12000 }),
	criteria: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { minItems: 1, maxItems: 30 })),
	verificationCommands: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 10 })),
	maxContinuations: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
	maxMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440 })),
	maxOutputTokens: Type.Optional(Type.Integer({ minimum: 100, maximum: 2000000 })),
});

export default function (pi: ExtensionAPI) {
	let goal: Goal | undefined;
	let currentCtx: ExtensionContext | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let wakeTimer: ReturnType<typeof setTimeout> | undefined;
	let finishing = false;
	let generation = 0;
	let providerFailed = false;

	function clearTimers() {
		if (deadline) clearTimeout(deadline);
		if (wakeTimer) clearTimeout(wakeTimer);
		deadline = undefined;
		wakeTimer = undefined;
	}
	function statusText() {
		if (!goal) return "No goal. Use /goal start <objective>.";
		return [
			`Goal ${goal.id} [${goal.status}]: ${goal.objective}`,
			...goal.criteria.map((criterion, i) => `${i + 1}. ${criterion}`),
			`Automatic continuations: ${goal.continuations}/${goal.maxContinuations}; main-model output tokens: ${goal.outputTokens}/${goal.maxOutputTokens}; time budget: ${goal.maxMinutes} min.`,
			`Pending team jobs: ${goal.pending.map(job => `${job.member} (${job.id})`).join(", ") || "none"}.`,
			goal.reason ? `Reason: ${goal.reason}` : "",
		].filter(Boolean).join("\n");
	}
	function updateUI() {
		if (currentCtx?.mode !== "tui") return;
		currentCtx.ui.setStatus("goal", goal ? `Goal: ${goal.status} · ${goal.continuations}/${goal.maxContinuations} · ${goal.pending.length} jobs` : undefined);
	}
	function publishState() {
		pi.events.emit("goal:state", goal ? { id: goal.id, status: goal.status, pauseCause: goal.pauseCause } : undefined);
	}
	function persist() {
		if (!goal || !currentCtx) return;
		goal.updatedAt = Date.now();
		// Snapshots must not share mutable arrays with in-memory session entries.
		pi.appendEntry(STATE_TYPE, JSON.parse(JSON.stringify(goal)));
		updateUI();
		publishState();
	}
	function budgetReason(checkContinuations = true): string | undefined {
		if (!goal) return undefined;
		if (Date.now() - goal.budgetStartedAt >= goal.maxMinutes * 60_000) return "Goal time budget reached. Use /goal resume to grant a fresh budget.";
		if (goal.outputTokens >= goal.maxOutputTokens) return "Goal main-model output-token budget reached. Use /goal resume to grant a fresh budget.";
		if (checkContinuations && goal.continuations >= goal.maxContinuations) return "Goal automatic-continuation budget reached. Use /goal resume to grant a fresh budget.";
		return undefined;
	}
	function pause(reason: string, status: "paused" | "blocked" = "paused", cause?: "provider-error") {
		if (!goal || goal.status === "completed" || goal.status === "stopped") return;
		goal.status = status;
		goal.pauseCause = cause;
		goal.reason = reason;
		clearTimers();
		persist();
	}
	function enforceBudget(checkContinuations = true): boolean {
		const reason = budgetReason(checkContinuations);
		if (reason) { pause(reason); return false; }
		return true;
	}
	function armDeadline() {
		if (deadline) clearTimeout(deadline);
		deadline = undefined;
		if (!active(goal)) return;
		const id = goal.id;
		const remaining = Math.max(1, goal.maxMinutes * 60_000 - (Date.now() - goal.budgetStartedAt));
		deadline = setTimeout(() => {
			if (goal?.id === id && active(goal)) {
				pause("Goal time budget reached. Use /goal resume to grant a fresh budget.");
				if (currentCtx && !currentCtx.isIdle()) currentCtx.abort();
			}
		}, remaining);
		deadline.unref?.();
	}
	function reminder() {
		return `${statusText()}\nWork toward the acceptance criteria. Use team_send/team_broadcast with wait:false to delegate. When waiting for team results, call goal_wait; completion will wake you automatically, without polling. Use goal_finish with evidence for EVERY numbered criterion only after verification. If user input is required, call goal_pause with blocked:true and explain what is needed. Do not report completion while this goal remains active.`;
	}
	function consumeResults() {
		if (!goal) return "";
		const fresh = goal.results.filter(result => !result.notified);
		for (const result of fresh) result.notified = true;
		return fresh.map(result => `Member ${result.member}, job ${result.id}: ${result.ok ? "completed" : "FAILED"}\n${result.ok ? result.reply || "(empty reply)" : result.error || "Unknown failure"}`).join("\n\n");
	}
	function continueContent(reason: string) {
		const results = consumeResults();
		return [reason, results, reminder()].filter(Boolean).join("\n\n");
	}
	function wake(reason: string) {
		if (!currentCtx || !active(goal) || goal.pending.length > 0 || !enforceBudget()) return;
		goal.status = "running";
		goal.reason = undefined;
		goal.continuations++;
		const content = continueContent(reason);
		persist();
		pi.sendMessage({ customType: "goal-wake", content, display: true, details: { goalId: goal.id } }, { triggerTurn: true, deliverAs: "followUp" });
	}
	function scheduleWake() {
		if (wakeTimer) return;
		const expectedGeneration = generation;
		wakeTimer = setTimeout(() => {
			wakeTimer = undefined;
			if (expectedGeneration !== generation || !goal?.results.some(result => !result.notified)) return;
			wake("Background team jobs have finished. Review their results and continue the goal.");
		}, 30);
	}
	function restore(ctx: ExtensionContext) {
		generation++;
		clearTimers();
		finishing = false;
		providerFailed = false;
		currentCtx = ctx;
		goal = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				const candidate = entry.data as Goal | undefined;
				if (candidate?.version === 1 && typeof candidate.id === "string" && Array.isArray(candidate.criteria) && Array.isArray(candidate.pending) && Array.isArray(candidate.results)) {
					goal = JSON.parse(JSON.stringify(candidate));
				}
			}
		}
		if (goal && (active(goal) || goal.pending.length)) {
			goal.pending = [];
			if (goal.status !== "completed" && goal.status !== "stopped") {
				goal.status = "paused";
				goal.pauseCause = undefined;
				goal.reason = "Session reloaded, restored, or branch changed. Previous background jobs cannot be resumed. Use /goal resume and redispatch unfinished work.";
			}
			persist();
		}
		updateUI();
	}
	function start(params: { objective: string; criteria?: string[]; verificationCommands?: string[]; maxContinuations?: number; maxMinutes?: number; maxOutputTokens?: number }, ctx: ExtensionContext) {
		if (goal && !["completed", "stopped"].includes(goal.status)) throw new Error("A goal already exists. Stop it with /goal stop before starting another.");
		if (typeof params.objective !== "string" || (params.criteria !== undefined && (!Array.isArray(params.criteria) || params.criteria.some(item => typeof item !== "string"))) || (params.verificationCommands !== undefined && (!Array.isArray(params.verificationCommands) || params.verificationCommands.some(item => typeof item !== "string" || !item.trim())))) throw new Error("Objective, criteria, and verification commands must contain nonempty strings.");
		const objective = params.objective.trim();
		const criteria = (params.criteria ?? [objective]).map(item => item.trim());
		if (!objective || !criteria.length || criteria.some(item => !item)) throw new Error("Objective and acceptance criteria must not be empty.");
		const bounded = (value: number | undefined, fallback: number, min: number, max: number, integer = true) => {
			const result = value ?? fallback;
			if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) throw new Error(`Invalid goal budget: ${result}.`);
			return result;
		};
		if (criteria.length > 30 || (params.verificationCommands?.length ?? 0) > 10) throw new Error("Too many criteria or verification commands.");
		clearTimers();
		currentCtx = ctx;
		goal = {
			version: 1, id: randomUUID(), objective, criteria,
			verificationCommands: (params.verificationCommands ?? []).map(command => command.trim()),
			status: "running", createdAt: Date.now(), updatedAt: Date.now(), budgetStartedAt: Date.now(),
			maxContinuations: bounded(params.maxContinuations, 20, 1, 200), continuations: 0,
			maxMinutes: bounded(params.maxMinutes, 60, 1, 1440, false),
			maxOutputTokens: bounded(params.maxOutputTokens, 100000, 100, 2000000), outputTokens: 0,
			pending: [], results: [],
		};
		persist();
		armDeadline();
		return goal;
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => { generation++; providerFailed = false; clearTimers(); currentCtx = undefined; });
	pi.on("before_agent_start", event => {
		providerFailed = false;
		if (event.messageType !== "custom" || event.message.customType !== "supervisor-check" || !goal || goal.status !== "paused" || goal.pauseCause !== "provider-error") return;
		// A scheduled recovery reuses the original budget. It cannot unpause user
		// decisions, blocked work, or an exhausted goal budget.
		if (!enforceBudget()) return;
		goal.status = "running";
		goal.pauseCause = undefined;
		goal.reason = undefined;
		persist();
		armDeadline();
	});
	pi.on("agent_settled", event => {
		if (active(goal)) {
			if (event.aborted) pause("Interrupted. Use /goal resume to continue.");
			else if (providerFailed) pause("Main model failed after retries. The supervisor may retry while enabled, or use /goal resume.", "paused", "provider-error");
		}
		providerFailed = false;
	});
	pi.on("context", event => {
		if (!active(goal)) return;
		return { messages: [...event.messages, { role: "custom" as const, customType: "goal-context", content: reminder(), display: false, timestamp: Date.now() }] };
	});
	pi.on("message_end", event => {
		if (event.message.role !== "assistant") return;
		providerFailed = event.message.stopReason === "error";
		if (!active(goal)) return;
		goal.outputTokens += event.message.usage?.output ?? 0;
	});
	pi.on("turn_end", (_event, ctx) => {
		if (!active(goal)) return;
		persist();
		// Stop an ongoing tool/response loop at a budget boundary too, not only
		// when the model voluntarily finishes its answer.
		if (goal.outputTokens >= goal.maxOutputTokens || Date.now() - goal.budgetStartedAt >= goal.maxMinutes * 60_000) {
			pause(budgetReason() || "Goal budget reached.");
			ctx.abort();
		}
	});
	pi.on("agent_before_settle", (event, ctx) => {
		if (!active(goal)) return;
		if (event.outcome !== "completed") {
			if (event.outcome === "aborted") pause("Interrupted. Use /goal resume to continue.");
			else providerFailed = true;
			// retry-any (before or after us) may still request a continuation.
			// Only agent_settled can prove that the retry chain is over.
			return;
		}
		providerFailed = false;
		if (!enforceBudget()) return;
		if (goal.pending.length) {
			goal.status = "waiting";
			persist();
			return;
		}
		if (ctx.hasPendingMessages() || event.continue) return;
		if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = undefined; }
		goal.status = "running";
		goal.continuations++;
		const content = continueContent("The goal has not been accepted yet. Continue useful work or report a blocker with goal_pause.");
		goal.updatedAt = Date.now();
		updateUI();
		publishState();
		return { entries: [
			...event.entries,
			{ type: "custom" as const, customType: STATE_TYPE, data: JSON.parse(JSON.stringify(goal)) },
			{ type: "custom_message" as const, customType: "goal-continue", content, display: true, details: { goalId: goal.id } },
		], continue: true };
	});

	// Event-bus query handlers MUST stay synchronous: the team extension reads
	// these mutations immediately after emit().
	pi.events.on("team:scope", data => {
		if (data && typeof data === "object" && goal && !["completed", "stopped"].includes(goal.status)) (data as { goalId?: string }).goalId = goal.id;
	});
	pi.events.on("team:job-start", data => {
		const job = data as { id: string; member: string; goalId?: string };
		if (!job?.id || !job.member || !goal || job.goalId !== goal.id || goal.pending.some(item => item.id === job.id)) return;
		goal.pending.push({ id: job.id, member: job.member });
		persist();
	});
	pi.events.on("team:job-end", data => {
		const job = data as Completion;
		if (!job?.id || !job.member || !goal || job.goalId !== goal.id || !goal.pending.some(item => item.id === job.id)) return;
		goal.pending = goal.pending.filter(item => item.id !== job.id);
		goal.results.push({ ...job, reply: job.reply ? clip(job.reply) : undefined, error: job.error ? clip(job.error) : undefined, notified: false });
		// Keep undelivered results; only trim old, already-delivered history.
		if (goal.results.length > 50) goal.results = goal.results.filter(item => !item.notified).concat(goal.results.filter(item => item.notified).slice(-20));
		persist();
		if (!goal.pending.length && active(goal)) scheduleWake();
	});
	pi.events.on("team:before-wake", data => {
		const request = data as { results: Completion[] };
		// Even stopped/previous goals own their jobs. Their late completions must
		// never become an unrelated normal-team wakeup.
		if (!Array.isArray(request?.results)) return;
		request.results = request.results.filter(result => !result.goalId);
	});

	pi.registerTool({
		name: "goal_start", label: "Goal: start", description: "Start persistent Goal mode when the user requests autonomous work toward a goal. Define acceptance criteria and optional verification shell commands. Do not replace an existing goal.",
		promptGuidelines: ["When the user requests Goal mode, use goal_start. Do not start Goal mode for ordinary questions.", "In Goal mode, delegate background work with wait:false, then use goal_wait. Results wake the lead automatically. Never poll team_list in a loop.", "Use goal_finish with evidence for every criterion; use goal_pause when blocked or when user input is needed."],
		parameters: StartParams, executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			try { start(params, ctx); return textResult(reminder(), goal); }
			catch (error) { return textResult(String((error as Error).message), undefined, true); }
		},
	});
	pi.registerTool({
		name: "goal_status", label: "Goal: status", description: "Show current goal state, acceptance criteria, budgets, and background jobs.", parameters: Type.Object({}),
		async execute() { if (active(goal)) enforceBudget(false); return textResult(statusText(), goal ?? null); },
	});
	pi.registerTool({
		name: "goal_wait", label: "Goal: wait", description: "End this lead run and wait for background team jobs. Use only after asynchronous dispatch. Completed jobs wake the lead automatically.",
		promptGuidelines: ["Call goal_wait as the ONLY tool call in its response, after all asynchronous dispatch calls have returned. It ends the lead run while members work."],
		parameters: Type.Object({}), executionMode: "sequential",
		async execute() {
			if (!active(goal) || !goal.pending.length) return textResult("No active background jobs to wait for. Continue the goal or inspect the results already received.", goal ?? null, true);
			goal.status = "waiting";
			persist();
			return { ...textResult(`Waiting for ${goal.pending.length} team jobs. The lead will wake when they finish.`, goal), terminate: true };
		},
	});
	pi.registerTool({
		name: "goal_pause", label: "Goal: pause", description: "Pause automatic Goal continuation. Set blocked:true if user input or an external dependency is required, and explain the reason in your response.",
		parameters: Type.Object({ reason: Type.String({ minLength: 1 }), blocked: Type.Optional(Type.Boolean()) }), executionMode: "sequential",
		async execute(_id, params) {
			if (!goal || ["completed", "stopped"].includes(goal.status)) return textResult("No unfinished goal to pause.", goal ?? null, true);
			pause(params.reason, params.blocked ? "blocked" : "paused");
			return textResult(statusText(), goal);
		},
	});
	pi.registerTool({
		name: "goal_finish", label: "Goal: accept completion", description: "Complete an active goal only after all background jobs end. Supply one evidence item for EVERY acceptance criterion (1-based). Configured verification commands must pass; they run through the bash tool with its normal hooks.",
		parameters: Type.Object({ goalId: Type.String(), evidence: Type.Array(Type.Object({ criterion: Type.Integer({ minimum: 1 }), evidence: Type.String({ minLength: 1, maxLength: 6000 }) }), { minItems: 1, maxItems: 30 }) }),
		executionMode: "sequential", reachesTools: () => ["bash"],
		async execute(_id, params, signal, _update, ctx) {
			if (!active(goal) || params.goalId !== goal.id) return textResult("Goal ID does not match an active goal.", goal ?? null, true);
			if (goal.pending.length) return textResult("Background jobs are still pending. Wait for them before accepting completion.", goal, true);
			if (finishing) return textResult("Goal verification is already in progress.", goal, true);
			const evidence = params.evidence;
			if (evidence.length !== goal.criteria.length || new Set(evidence.map(item => item.criterion)).size !== goal.criteria.length || evidence.some(item => item.criterion > goal!.criteria.length || !item.evidence.trim())) {
				return textResult("Provide exactly one nonempty evidence item for each numbered acceptance criterion.", goal, true);
			}
			if (goal.verificationCommands.length && !ctx.tools.some(tool => tool.name === "bash")) return textResult("Configured verification commands require the bash tool to be active in this session.", goal, true);
			if (!enforceBudget(false)) return textResult(statusText(), goal, true);
			const owner = goal;
			const expectedGeneration = generation;
			finishing = true;
			try {
				const verification: NonNullable<Goal["verification"]> = [];
				for (const command of owner.verificationCommands) {
					if (signal?.aborted || generation !== expectedGeneration || goal !== owner || !active(owner)) return textResult("Goal verification was interrupted.", goal ?? null, true);
					const result = await ctx.executeTool("bash", { command, timeout: 30 }, { signal });
					const output = result.result?.content?.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n") ?? "";
					verification.push({ command, ok: !result.isError, output: clip(output) });
					if (result.isError) {
						if (goal === owner && generation === expectedGeneration) { owner.verification = verification; persist(); }
						return textResult(`Acceptance check failed: ${command}\n${clip(output)}`, { verification }, true);
					}
				}
				if (signal?.aborted || generation !== expectedGeneration || goal !== owner || !active(owner)) return textResult("Goal changed or was paused during verification.", goal ?? null, true);
				owner.status = "completed";
				owner.reason = "All acceptance criteria have evidence; configured verification commands passed.";
				owner.evidence = evidence;
				owner.verification = verification;
				clearTimers();
				persist();
				return textResult(`Goal accepted.\n${statusText()}`, owner);
			} catch (error) {
				return textResult(`Goal verification failed: ${String((error as Error).message)}`, goal ?? null, true);
			} finally { finishing = false; }
		},
	});

	pi.registerCommand("goal", {
		description: "Goal mode: start <objective> | <criterion>...; status; pause; resume; stop. start also accepts a JSON object with criteria, verificationCommands and budgets.",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
			const command = match?.[1] ?? "status";
			const rest = match?.[2]?.trim() ?? "";
			try {
				if (command === "start") {
					if (!rest) throw new Error("Usage: /goal start <objective> | <acceptance criterion> ...");
					const parts = rest.split("|").map(item => item.trim());
					const params = rest.startsWith("{") ? JSON.parse(rest) : { objective: parts[0], criteria: parts.length > 1 ? parts.slice(1) : undefined };
					start(params, ctx);
					pi.sendMessage({ customType: "goal-start", content: reminder(), display: true, details: { goalId: goal!.id } }, { triggerTurn: true, deliverAs: "followUp" });
					return;
				}
				if (command === "pause") {
					pause(rest || "Paused by the user.");
					if (!ctx.isIdle()) ctx.abort();
				} else if (command === "stop") {
					if (goal && !["completed", "stopped"].includes(goal.status)) {
						goal.status = "stopped"; goal.pauseCause = undefined; goal.reason = rest || "Stopped by the user.";
						clearTimers(); persist();
						pi.events.emit("team:cancel-goal", { goalId: goal.id });
						if (!ctx.isIdle()) ctx.abort();
					}
				} else if (command === "resume") {
					if (!goal || ["completed", "stopped"].includes(goal.status)) throw new Error("No unfinished goal to resume.");
					goal.status = goal.pending.length ? "waiting" : "running";
					goal.pauseCause = undefined;
					goal.reason = undefined; goal.continuations = 0; goal.outputTokens = 0; goal.budgetStartedAt = Date.now();
					persist(); armDeadline();
					if (!goal.pending.length) wake("The user resumed this goal with a fresh budget. Continue from saved progress.");
					else ctx.ui.notify(statusText(), "info");
					return;
				} else if (command !== "status") throw new Error("Usage: /goal start|status|pause|resume|stop");
				if (active(goal)) enforceBudget(false);
				pi.sendMessage({ customType: "goal-status", content: statusText(), display: true }, { triggerTurn: false });
			} catch (error) { ctx.ui.notify(String((error as Error).message), "error"); }
		},
	});
}
