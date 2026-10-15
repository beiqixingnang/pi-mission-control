/** Child-only messaging capability. It never accepts a path or launches a process. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendLog, BRIDGE_ENV, LogReader, MAX_MESSAGE_CHARS, MAX_TIMEOUT_MS, MEMBER_ENV, parseBridgeConfig, validMemberName, validRequestId, type BridgeConfig, type MessageRequest, type MessageResponse } from "./messaging.ts";
import { POLICY_ENV } from "../workspace/policy.ts";

interface Pending {
	finish(response: MessageResponse): void;
}
export function createBridgeClient(config: BridgeConfig) {
	const pending = new Map<string, Pending>();
	const reader = new LogReader(config, "responses.jsonl");
	let writes = Promise.resolve();
	let timer: ReturnType<typeof setInterval> | undefined;
	let polling = false, stopped = false;
	const append = (value: unknown) => {
		const next = writes.then(() => appendLog(config, "outbox.jsonl", value));
		writes = next.catch(() => {});
		return next;
	};
	const stop = (reason = "Team member bridge stopped.") => {
		stopped = true;
		if (timer) clearInterval(timer);
		timer = undefined;
		for (const [id, request] of pending) request.finish({ version: 1, id, ok: false, error: reason });
	};
	const poll = async () => {
		if (polling || stopped) return;
		polling = true;
		try {
			for (const value of await reader.read()) {
				const response = value as MessageResponse;
				if (!response || response.version !== 1 || !validRequestId(response.id) || typeof response.ok !== "boolean" || (response.reply !== undefined && typeof response.reply !== "string") || (response.error !== undefined && typeof response.error !== "string") || (response.jobId !== undefined && typeof response.jobId !== "string")) continue;
				pending.get(response.id)?.finish(response);
			}
		} catch (error) { stop(String((error as Error)?.message ?? error)); }
		finally { polling = false; }
	};
	async function send(params: { to: string; message: string; wait?: boolean; timeoutMs?: number }, signal?: AbortSignal): Promise<MessageResponse> {
		const id = randomUUID();
		const fail = (error: string): MessageResponse => ({ version: 1, id, ok: false, error });
		const timeout = params.timeoutMs ?? 600_000;
		if (stopped || signal?.aborted) return fail("Team message was cancelled or the bridge is stopped.");
		if ((params.to !== "lead" && !validMemberName(params.to)) || params.to === config.member || typeof params.message !== "string" || !params.message.trim() || params.message.length > MAX_MESSAGE_CHARS || (params.wait !== undefined && typeof params.wait !== "boolean") || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) return fail("Invalid team message, recipient, or timeout.");
		if (params.to === "lead" && params.wait !== false) return fail("Messages to the lead require wait:false; the lead replies through team_send.");
		if (pending.size >= 32) return fail("Too many pending team messages.");
		return new Promise(resolve => {
			let finished = false;
			let deadline: ReturnType<typeof setTimeout> | undefined;
			const finish = (response: MessageResponse) => {
				if (finished) return;
				finished = true;
				if (deadline) clearTimeout(deadline);
				signal?.removeEventListener("abort", abort);
				pending.delete(id);
				if (!pending.size && timer) { clearInterval(timer); timer = undefined; }
				resolve(response);
			};
			const cancel = (reason: string) => {
				finish(fail(reason));
				void append({ version: 1, kind: "cancel", id, token: config.token }).catch(() => {});
			};
			const abort = () => cancel("Team message was cancelled.");
			pending.set(id, { finish });
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) { abort(); return; }
			deadline = setTimeout(() => cancel(`Team message timed out after ${timeout} ms.`), timeout + 2000);
			deadline.unref?.();
			if (!timer) { timer = setInterval(() => { void poll(); }, 100); timer.unref?.(); }
			const request: MessageRequest = { version: 1, kind: "message", id, token: config.token, to: params.to, message: params.message, wait: params.wait !== false, expiresAt: Date.now() + timeout };
			void append(request).catch(error => finish(fail(String((error as Error)?.message ?? error))));
		});
	}
	return { send, stop };
}

export default function (pi: ExtensionAPI) {
	const config = parseBridgeConfig(process.env[BRIDGE_ENV], process.env[MEMBER_ENV]);
	if (!config) return;
	const bridge = createBridgeClient(config);
	pi.on("session_shutdown", () => bridge.stop());
	const toolName = process.env[POLICY_ENV] ? "workspace_team_message" : "team_message";
	pi.registerTool({
		name: toolName, label: "Team: message teammate",
		description: "Send a self-contained message to an authorized teammate. The parent enforces the roster communication ACL. wait:true returns their reply; wait:false queues work and confirms acceptance. To inform the lead use to:'lead', wait:false. Messaging never grants additional file or execution access.",
		promptGuidelines: ["Use team_message only for allowed collaboration. A denied file or command request is not permission to ask a teammate to bypass your workspace policy. Messages to the lead require wait:false. Avoid synchronous cycles; use wait:false when a teammate may be waiting for your current task."],
		parameters: Type.Object({
			to: Type.String({ minLength: 1, maxLength: 32 }),
			message: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CHARS }),
			wait: Type.Optional(Type.Boolean({ default: true })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS })),
		}, { additionalProperties: false }),
		async execute(_id, params, signal) {
			const response = await bridge.send(params, signal);
			return {
				content: [{ type: "text" as const, text: response.ok ? response.reply ?? `Message accepted by ${params.to}${response.jobId ? ` (job ${response.jobId})` : ""}.` : response.error || "Team message denied." }],
				details: response,
				...(response.ok ? {} : { isError: true }),
			};
		},
	});
}
