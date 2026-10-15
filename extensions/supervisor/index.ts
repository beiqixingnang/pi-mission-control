/**
 * Supervisor timer — a session-only, in-process watchdog for autonomous work.
 *
 * When enabled, the supervisor wakes the main Pi on a bounded interval with a
 * custom `triggerTurn` message while an active Goal or pending team jobs exist.
 * It never overlaps check turns, never queues more than one outstanding check,
 * and stops on session shutdown/tree/reload. Every timer is `unref()`'d, so it
 * can never keep the process alive after exit.
 *
 * Session-scoped by design: nothing is persisted and the watchdog is idle
 * (off) by default. Enable it explicitly with `/supervisor on`. It also honours
 * `team:job-start` / `team:job-end` from the bundled team extension, and reads
 * `goal-state` session entries for active Goal detection (the bundled goal
 * extension persists state instead of emitting events).
 *
 * Fail-closed rules:
 *   - no message unless enabled AND active work exists;
 *   - never while the main model is busy or has queued input;
 *   - at most one check turn outstanding;
 *   - recovery nudges only for provider/assistant errors, only while work is
 *     active, and only a bounded number of consecutive attempts.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_ENABLED = false;
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 3_600_000;
const RECOVERY_DELAY_MS = 3_000;
const CHECK_GRACE_MS = 2_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const MAX_PENDING_JOBS = 500;
const CHECK_TYPE = "supervisor-check";
const STATUS_KEY = "supervisor";

const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}…` : text);
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface GoalView {
	status?: string;
	objective?: string;
	pending: number;
}

interface PendingJob {
	member?: string;
	goalId?: string;
	at: number;
}

/**
 * Best-effort extraction of a run outcome from an `agent_end` event. Pi's event
 * shape has varied across releases, so we probe the known fields and fall back
 * to the last assistant message. Unknown shapes return `undefined` (fail closed).
 */
function outcomeOf(event: unknown): string | undefined {
	const data = event as Record<string, unknown> | undefined;
	if (!data || typeof data !== "object") return undefined;
	if (typeof data.outcome === "string") return data.outcome;
	if (data.error) return "error";
	if (data.success === false) return "error";
	const single = (data as { message?: unknown }).message;
	const list = Array.isArray((data as { messages?: unknown }).messages)
		? ((data as { messages: unknown[] }).messages)
		: single
			? [single]
			: [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const message = item as Record<string, unknown>;
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error" || message.errorMessage || message.error) return "error";
		if (message.stopReason === "aborted") return "aborted";
	}
	return undefined;
}

function describeError(event: unknown): string | undefined {
	const data = event as Record<string, unknown> | undefined;
	if (!data || typeof data !== "object") return undefined;
	if (typeof data.error === "string" && data.error) return data.error;
	if (typeof data.errorMessage === "string" && data.errorMessage) return data.errorMessage;
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let enabled = DEFAULT_ENABLED;
	let intervalMs = DEFAULT_INTERVAL_MS;
	let currentCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;
	let dead = false;
	let checkInFlight = false;
	let recoveryRequested = false;
	let recoveryAttempts = 0;
	let checks = 0;
	let lastCheckAt: number | undefined;
	let lastOutcome: string | undefined;
	let lastError: string | undefined;
	let pendingError: string | undefined;
	let pendingAborted = false;
	const pendingJobs = new Map<string, PendingJob>();

	// -------------------------------------------------------------------
	// State helpers
	// -------------------------------------------------------------------

	function stopTimer() {
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	function resetRuntime() {
		pendingJobs.clear();
		checkInFlight = false;
		recoveryRequested = false;
		recoveryAttempts = 0;
		lastOutcome = undefined;
		lastError = undefined;
		pendingError = undefined;
		pendingAborted = false;
	}

	function readGoal(): GoalView | undefined {
		const branch = currentCtx?.sessionManager?.getBranch?.();
		if (!Array.isArray(branch)) return undefined;
		let data: unknown;
		for (const entry of branch) {
			if (entry && entry.type === "custom" && entry.customType === "goal-state") data = entry.data;
		}
		if (!data || typeof data !== "object") return undefined;
		const value = data as Record<string, unknown>;
		return {
			status: typeof value.status === "string" ? value.status : undefined,
			objective: typeof value.objective === "string" ? value.objective : undefined,
			pending: Array.isArray(value.pending) ? value.pending.length : 0,
		};
	}

	function workActive(): boolean {
		if (pendingJobs.size > 0) return true;
		const goal = readGoal();
		if (!goal) return false;
		return goal.pending > 0 || goal.status === "running" || goal.status === "waiting";
	}

	function mainIdle(ctx: ExtensionContext): boolean {
		try {
			return typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
		} catch {
			return false;
		}
	}

	function mainHasQueuedInput(ctx: ExtensionContext): boolean {
		try {
			return typeof ctx.hasPendingMessages === "function" ? ctx.hasPendingMessages() : false;
		} catch {
			// Unknown queue state: do not risk piling another message on top.
			return true;
		}
	}

	// -------------------------------------------------------------------
	// Scheduling and checks
	// -------------------------------------------------------------------

	function schedule(delay = intervalMs) {
		if (dead || !enabled || !currentCtx) return;
		const expected = generation;
		stopTimer();
		timer = setTimeout(() => {
			timer = undefined;
			if (expected !== generation || dead || !enabled) return;
			tick();
		}, Math.max(0, delay));
		timer.unref?.();
	}

	function tick() {
		const ctx = currentCtx;
		if (dead || !enabled || !ctx) return;
		// A finished check turn must not block later checks: if the session has been
		// idle for longer than the start grace, no check turn can still be running.
		if (checkInFlight && mainIdle(ctx) && (!lastCheckAt || Date.now() - lastCheckAt > CHECK_GRACE_MS)) checkInFlight = false;
		const wasRecovery = recoveryRequested;
		recoveryRequested = false;
		if (!workActive()) {
			updateUI();
			schedule();
			return;
		}
		if (checkInFlight || !mainIdle(ctx) || mainHasQueuedInput(ctx)) {
			schedule();
			return;
		}
		sendCheck(ctx, wasRecovery ? "recovery" : "interval");
		schedule();
	}

	function sendCheck(_ctx: ExtensionContext, reason: "interval" | "recovery") {
		const goal = readGoal();
		const lines = [
			`[supervisor] ${reason === "recovery" ? "Recovery" : "Periodic"} check #${checks + 1}.`,
			goal ? `Goal ${goal.status ?? "unknown"}${goal.objective ? `: ${clip(goal.objective, 200)}` : ""}.` : "",
			pendingJobs.size ? `${pendingJobs.size} team job(s) pending.` : "",
			reason === "recovery" && lastError ? `Previous main-model error: ${clip(lastError, 500)}` : "",
			reason === "recovery"
				? "Take one concrete recovery step: retry, fix the failure, or report the blocker. Do not repeat completed work."
				: "Check progress since the last check. Integrate finished team results, report blockers, and continue with one concrete next step. Do not repeat completed work.",
		].filter(Boolean);
		checks++;
		lastCheckAt = Date.now();
		checkInFlight = true;
		updateUI();
		try {
			pi.sendMessage(
				{
					customType: CHECK_TYPE,
					content: lines.join("\n"),
					display: true,
					details: { reason, goal: goal?.status, pendingJobs: pendingJobs.size, check: checks },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			lastError = undefined;
		} catch (error) {
			checkInFlight = false;
			lastError = errorMessage(error);
		}
		updateUI();
	}

	function requestRecovery(error: string) {
		if (!enabled || dead || !workActive()) return;
		if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) return;
		recoveryAttempts++;
		lastError = error;
		recoveryRequested = true;
		schedule(RECOVERY_DELAY_MS);
	}

	function handleAgentEnd(event: unknown, ctx: ExtensionContext) {
		currentCtx = ctx;
		let outcome = outcomeOf(event);
		if (!outcome) outcome = pendingError ? "error" : pendingAborted ? "aborted" : undefined;
		const error = pendingError ?? (outcome === "error" ? describeError(event) : undefined);
		lastOutcome = outcome;
		pendingError = undefined;
		pendingAborted = false;
		checkInFlight = false;
		updateUI();
		if (outcome === "completed") recoveryAttempts = 0;
		// Only a genuine provider/assistant error triggers recovery; a user
		// abort must not fight the user's interrupt.
		if (outcome === "error") requestRecovery(error ?? "Main model reported an error.");
	}

	// -------------------------------------------------------------------
	// UI / status
	// -------------------------------------------------------------------

	function statusLine(): string | undefined {
		if (!enabled) return undefined;
		const goal = readGoal();
		const active = !!goal && (goal.status === "running" || goal.status === "waiting");
		if (checkInFlight) return "Supervisor: checking…";
		if (active) return `Supervisor: on · goal ${goal!.status}${pendingJobs.size ? ` · ${pendingJobs.size} jobs` : ""}`;
		if (pendingJobs.size) return `Supervisor: on · ${pendingJobs.size} jobs`;
		return "Supervisor: idle";
	}

	function updateUI() {
		const ctx = currentCtx;
		if (!ctx || ctx.mode !== "tui") return;
		try {
			ctx.ui?.setStatus?.(STATUS_KEY, statusLine());
		} catch {
			// UI updates must never affect supervision.
		}
	}

	function statusText(): string {
		const goal = readGoal();
		const active = !!goal && (goal.status === "running" || goal.status === "waiting");
		return [
			`Supervisor: ${enabled ? "on" : "off"}${dead ? " (session ended)" : ""}; interval ${Math.round(intervalMs / 1000)}s.`,
			`Work: ${active ? `goal ${goal!.status}` : "no active goal"}${pendingJobs.size ? `, ${pendingJobs.size} pending team job(s)` : ", no pending team jobs"}.`,
			`Checks: ${checks}${lastCheckAt ? ` (last ${new Date(lastCheckAt).toLocaleTimeString()})` : ""}${checkInFlight ? " · a check turn is outstanding" : ""}.`,
			lastOutcome ? `Last main-model outcome: ${lastOutcome}.` : "",
			lastError ? `Last error: ${clip(lastError, 300)}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	// -------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		generation++;
		stopTimer();
		dead = false;
		enabled = DEFAULT_ENABLED;
		intervalMs = DEFAULT_INTERVAL_MS;
		checks = 0;
		lastCheckAt = undefined;
		currentCtx = ctx;
		resetRuntime();
		if (enabled) schedule();
		updateUI();
	});

	pi.on("session_tree", (_event, ctx) => {
		generation++;
		stopTimer();
		currentCtx = ctx;
		// Background jobs cannot survive a branch change; do not carry them over.
		resetRuntime();
		if (enabled) schedule();
		updateUI();
	});

	pi.on("session_shutdown", () => {
		generation++;
		dead = true;
		stopTimer();
		currentCtx = undefined;
		resetRuntime();
	});

	pi.on("agent_end", (event, ctx) => handleAgentEnd(event, ctx));
	pi.on("turn_end", () => {
		checkInFlight = false;
	});

	pi.on("message_end", (event) => {
		const message = (event as unknown as { message?: unknown } | undefined)?.message as Record<string, unknown> | undefined;
		if (!message || message.role !== "assistant") return;
		if (message.stopReason === "error" || message.errorMessage) {
			pendingError = typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : "Assistant reported an error.";
		} else if (message.stopReason === "aborted") {
			pendingAborted = true;
		}
	});

	// Team background jobs (emitted by the bundled team extension). Adding an
	// observer must never change their payloads.
	pi.events.on("team:job-start", (data) => {
		const job = data as { id?: unknown; member?: unknown; goalId?: unknown } | undefined;
		if (!job || typeof job.id !== "string" || !job.id) return;
		if (pendingJobs.size >= MAX_PENDING_JOBS) return;
		pendingJobs.set(job.id, {
			member: typeof job.member === "string" ? job.member : undefined,
			goalId: typeof job.goalId === "string" ? job.goalId : undefined,
			at: Date.now(),
		});
		recoveryAttempts = 0;
		updateUI();
		if (enabled && !dead) schedule(0);
	});

	pi.events.on("team:job-end", (data) => {
		const job = data as { id?: unknown } | undefined;
		if (!job || typeof job.id !== "string") return;
		pendingJobs.delete(job.id);
		recoveryAttempts = 0;
		updateUI();
	});

	// Forward-compatible goal hook. The bundled goal extension persists state to
	// session entries rather than emitting events, so readGoal() is the primary
	// source; if a future goal build emits `goal:state`, react promptly.
	pi.events.on("goal:state", () => {
		if (enabled && !dead) schedule(0);
	});

	// -------------------------------------------------------------------
	// Control command
	// -------------------------------------------------------------------

	pi.registerCommand("supervisor", {
		description: "Session-only supervisor watchdog: on|off|status|interval <seconds>. When on, it wakes the main model on an interval while a Goal or team jobs are active.",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			dead = false;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const command = parts[0] ?? "status";
			const value = parts[1];

			const applyInterval = (raw: string): boolean => {
				const seconds = Number(raw);
				if (!Number.isFinite(seconds)) {
					ctx.ui.notify(`Invalid supervisor interval: ${raw}`, "warning");
					return false;
				}
				const candidate = Math.round(seconds * 1000);
				if (candidate < MIN_INTERVAL_MS || candidate > MAX_INTERVAL_MS) {
					ctx.ui.notify(`Supervisor interval must be between ${MIN_INTERVAL_MS / 1000}s and ${MAX_INTERVAL_MS / 1000}s.`, "warning");
					return false;
				}
				intervalMs = candidate;
				if (enabled) schedule();
				return true;
			};

			if (command === "on") {
				enabled = true;
				if (value !== undefined) applyInterval(value);
				schedule();
				updateUI();
				ctx.ui.notify(statusText(), "info");
				return;
			}
			if (command === "off") {
				enabled = false;
				stopTimer();
				updateUI();
				ctx.ui.notify("Supervisor disabled for this session.", "info");
				return;
			}
			if (command === "interval") {
				if (value === undefined) {
					ctx.ui.notify(`Current supervisor interval: ${Math.round(intervalMs / 1000)}s.`, "info");
					return;
				}
				applyInterval(value);
				updateUI();
				return;
			}
			if (command !== "status") {
				ctx.ui.notify("Usage: /supervisor on|off|status|interval <seconds>", "warning");
				return;
			}
			ctx.ui.notify(statusText(), "info");
			updateUI();
		},
	});
}
