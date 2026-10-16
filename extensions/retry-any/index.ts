/** Retry assistant provider errors with bounded exponential backoff. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";

type UnknownRecord = Record<string, unknown>;
type RetryConfig = { maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number; coreRetryEnabled: boolean };
type AssistantStatus = "error" | "aborted" | "success" | undefined;

const DEFAULT_CONFIG: RetryConfig = { maxRetries: 5, baseDelayMs: 1_000, maxAgentDelayMs: 30_000, coreRetryEnabled: true };
const HARD_MAX_RETRIES = 100;
const HARD_MAX_DELAY_MS = 300_000;
const CUSTOM_TYPE = "retry-any";

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readRetryObject(source: unknown): UnknownRecord | undefined {
	if (!isRecord(source)) return undefined;
	if (isRecord(source.retry)) return source.retry;
	if (typeof source.get === "function") {
		try {
			const retry = (source.get as (key: string) => unknown)("retry");
			if (isRecord(retry)) return retry;
		} catch { /* fail closed below */ }
	}
	return undefined;
}
function settingSources(pi: ExtensionAPI, ctx: unknown): unknown[] {
	const sources: unknown[] = [];
	for (const value of [pi, ctx]) {
		if (!isRecord(value)) continue;
		if (typeof value.getSettings === "function") {
			try { sources.push((value.getSettings as () => unknown)()); } catch { /* continue */ }
		}
		if (isRecord(value.settingsManager)) {
			const manager = value.settingsManager;
			if (typeof manager.getSettings === "function") {
				try { sources.push((manager.getSettings as () => unknown)()); } catch { /* continue */ }
			}
			sources.push(manager);
		}
		if ("settings" in value) sources.push(value.settings);
		sources.push(value);
	}
	return sources;
}
function parseBoundedInteger(value: unknown, fallback: number, max: number): number | undefined {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
	return Math.min(value, max);
}
function readConfig(pi: ExtensionAPI, ctx: unknown): RetryConfig {
	let raw: UnknownRecord | undefined;
	for (const source of settingSources(pi, ctx)) {
		raw = readRetryObject(source);
		if (raw) break;
	}
	if (!raw) return { ...DEFAULT_CONFIG };
	const coreRetryEnabled = raw.enabled === undefined ? DEFAULT_CONFIG.coreRetryEnabled : raw.enabled === true;
	const maxRetries = raw.enabled === false ? 0 : parseBoundedInteger(raw.maxRetries, DEFAULT_CONFIG.maxRetries, HARD_MAX_RETRIES);
	const baseDelayMs = parseBoundedInteger(raw.baseDelayMs, DEFAULT_CONFIG.baseDelayMs, HARD_MAX_DELAY_MS);
	const maxAgentDelayMs = parseBoundedInteger(raw.maxAgentDelayMs, DEFAULT_CONFIG.maxAgentDelayMs, HARD_MAX_DELAY_MS);
	if (maxRetries === undefined || baseDelayMs === undefined || maxAgentDelayMs === undefined) return { maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0, coreRetryEnabled };
	return { maxRetries, baseDelayMs, maxAgentDelayMs, coreRetryEnabled };
}
function assistantMessage(entry: unknown): UnknownRecord | undefined {
	if (!isRecord(entry)) return undefined;
	const message = entry.type === "message" ? entry.message : entry;
	return isRecord(message) && message.role === "assistant" ? message : undefined;
}
function latestAssistantMessage(entries: unknown): UnknownRecord | undefined {
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const message = assistantMessage(entries[i]);
		if (message) return message;
	}
	return undefined;
}
/** Use the host's actual classifier rather than a second, drifting regex list. */
function isBuiltInRetryable(text: string | undefined): boolean {
	return isRetryableAssistantError({ stopReason: "error", errorMessage: text } as any);
}
function backoffMs(retryNumber: number, config: RetryConfig): number {
	if (config.baseDelayMs === 0 || config.maxAgentDelayMs === 0) return 0;
	return Math.min(config.baseDelayMs * 2 ** Math.min(retryNumber - 1, 52), config.maxAgentDelayMs);
}
function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise(resolve => {
		if (signal?.aborted) { resolve(false); return; }
		const finish = (ok: boolean) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(ok); };
		const abort = () => finish(false);
		const timer = setTimeout(() => finish(true), ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}
function hasPendingMessages(ctx: unknown): boolean {
	if (!isRecord(ctx) || typeof ctx.hasPendingMessages !== "function") return true;
	try { return (ctx.hasPendingMessages as () => unknown).call(ctx) !== false; } catch { return true; }
}

export default function (pi: ExtensionAPI) {
	let retryCount = 0;
	let assistantStatus: AssistantStatus;
	let assistantError: string | undefined;
	let generation = 0;
	let backoffAbort: AbortController | undefined;
	function reset() { backoffAbort?.abort();backoffAbort=undefined;generation++; retryCount = 0; assistantStatus = undefined; assistantError = undefined; }
	pi.events.on("workbench:stop", reset);
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", reset);
	pi.on("before_agent_start", reset);
	pi.on("agent_start", () => { assistantStatus = undefined; assistantError = undefined; });
	pi.on("message_end", event => {
		if (event.message.role !== "assistant") return;
		assistantError = typeof event.message.errorMessage === "string" ? event.message.errorMessage : undefined;
		if (event.message.stopReason === "aborted") assistantStatus = "aborted";
		else if (event.message.stopReason === "error" || assistantError) assistantStatus = "error";
		else if (event.message.stopReason === "stop") assistantStatus = "success";
		else assistantStatus = undefined;
	});
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome === "aborted" || assistantStatus === "aborted") { reset(); return; }
		if (event.outcome === "completed") { reset(); return; }
		if (!Array.isArray(event.entries)) return;
		const entries = event.entries;
		const message = latestAssistantMessage(entries);
		if (message?.stopReason === "aborted") { reset(); return; }
		const messageError = typeof message?.errorMessage === "string" ? message.errorMessage : assistantError;
		if (message?.stopReason === "stop" || message?.stopReason === "toolUse" || message?.stopReason === "length") return;
		const providerError = event.outcome === "error" || assistantStatus === "error" || message?.stopReason === "error" || Boolean(messageError);
		if (!providerError) return;
		const config = readConfig(pi, ctx);
		// Core owns its known transient patterns. This extension fills in unknown
		// upstream errors such as arbitrary gateway/model-selection messages.
		if (config.coreRetryEnabled && isBuiltInRetryable(messageError)) return;
		if (retryCount >= config.maxRetries || hasPendingMessages(ctx)) return;
		const nextRetry = retryCount + 1;
		const delayMs = backoffMs(nextRetry, config);
		retryCount = nextRetry;
		const expected = generation;
		const controller = new AbortController();
		backoffAbort = controller;
		const abort = () => controller.abort();
		ctx.signal?.addEventListener("abort", abort, { once:true });
		if (ctx.signal?.aborted) controller.abort();
		let waited: boolean;
		try { waited = await wait(delayMs, controller.signal); }
		finally { ctx.signal?.removeEventListener("abort",abort);if(backoffAbort===controller)backoffAbort=undefined; }
		if (!waited || generation !== expected) return;
		if (hasPendingMessages(ctx)) { reset(); return; }
		return {
			entries: [...entries, { type: "custom_message" as const, customType: CUSTOM_TYPE, content: `The provider request failed. Retry the user's request now (retry ${nextRetry} of ${config.maxRetries}).`, display: true, details: { retry: nextRetry, maxRetries: config.maxRetries, delayMs, error: messageError } }],
			continue: true,
		};
	});
}
