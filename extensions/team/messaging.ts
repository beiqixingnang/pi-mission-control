import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MEMBER_ENV = "PI_TEAM_MEMBER";
export const BRIDGE_ENV = "PI_TEAM_BRIDGE";
export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_TIMEOUT_MS = 2_147_481_647;
const MAX_LINE_BYTES = 128 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 32 * 1024 * 1024;

export interface Communication { allow: string[] }
export interface BridgeConfig {
	version: 1;
	member: string;
	token: string;
	directory: string;
}
export interface MessageRequest {
	version: 1;
	kind: "message";
	id: string;
	token: string;
	to: string;
	message: string;
	wait: boolean;
	expiresAt: number;
	operation?: "task" | "note" | "wait" | "status" | "cancel";
	taskId?: string;
	reportAfterMs?: number;
	blockedReason?:string;
}
export interface CancelRequest {
	version: 1;
	kind: "cancel";
	id: string;
	token: string;
}
export interface MessageResponse {
	version: 1;
	id: string;
	ok: boolean;
	reply?: string;
	error?: string;
	jobId?: string;
	timeoutLayer?: "message" | "member" | "queue" | "process";
	processState?:string;
}
export const validMemberName = (name: unknown): name is string => typeof name === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(name) && name !== "lead";
export const validRequestId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id);
export function communication(value: unknown): Communication {
	if (value === undefined) return { allow: [] };
	if (!value || typeof value !== "object" || !Array.isArray((value as Communication).allow) || (value as Communication).allow.length > 100 || (value as Communication).allow.some(name => name !== "lead" && !validMemberName(name))) throw new Error("communication.allow must contain at most 100 member names (or lead).");
	return { allow: [...new Set((value as Communication).allow)] };
}
export function mayCommunicate(from: string, to: string, roster: ReadonlyMap<string, { communication: Communication }>): boolean {
	if (from === to) return false;
	if (from === "lead") return roster.has(to);
	if (to === "lead") return roster.has(from);
	const sender = roster.get(from), recipient = roster.get(to);
	return !!sender && !!recipient && (sender.communication.allow.includes(to) || recipient.communication.allow.includes(from));
}
export function parseBridgeConfig(raw: string | undefined, member: string | undefined): BridgeConfig | undefined {
	try {
		const value = JSON.parse(raw || "null");
		if (value?.version !== 1 || !validMemberName(member) || value.member !== member || !validRequestId(value.token) || typeof value.directory !== "string" || !path.isAbsolute(value.directory)) return undefined;
		return { version: 1, member, token: value.token, directory: value.directory };
	} catch { return undefined; }
}
export function parseRequest(value: unknown, config: BridgeConfig): MessageRequest | CancelRequest {
	const request = value as MessageRequest | CancelRequest;
	if (!request || request.version !== 1 || !validRequestId(request.id) || request.token !== config.token) throw new Error("TEAM_MESSAGE_DENIED: invalid bridge request.");
	if (request.kind === "cancel") return { version: 1, kind: "cancel", id: request.id, token: request.token };
	if (request.kind !== "message" || (request.to !== "lead" && !validMemberName(request.to)) || typeof request.message !== "string" || !request.message.trim() || request.message.length > MAX_MESSAGE_CHARS || typeof request.wait !== "boolean" || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= Date.now() || request.expiresAt - Date.now() > MAX_TIMEOUT_MS + 2000) throw new Error("TEAM_MESSAGE_DENIED: invalid or expired message.");
	if(request.operation!==undefined&&!["task","note","wait","status","cancel"].includes(request.operation))throw new Error("TEAM_MESSAGE_DENIED: invalid operation.");
	if(request.taskId!==undefined&&(typeof request.taskId!=="string"||request.taskId.length>150))throw new Error("TEAM_MESSAGE_DENIED: invalid task id.");
	if(request.reportAfterMs!==undefined&&(!Number.isSafeInteger(request.reportAfterMs)||request.reportAfterMs<1000||request.reportAfterMs>86400000))throw new Error("TEAM_MESSAGE_DENIED: invalid report time.");
	if(request.blockedReason!==undefined&&(typeof request.blockedReason!=="string"||!request.blockedReason.trim()||request.blockedReason.length>4000))throw new Error("TEAM_MESSAGE_DENIED: invalid blocker.");
	return { version: 1, kind: "message", id: request.id, token: request.token, to: request.to, message: request.message, wait: request.wait, expiresAt: request.expiresAt, operation: request.operation, taskId:request.taskId, reportAfterMs:request.reportAfterMs,blockedReason:request.blockedReason };
}

/** Only fixed, parent-created regular files are opened; no caller-provided paths. */
async function openLog(config: BridgeConfig, name: "outbox.jsonl" | "responses.jsonl", mode: "r" | "a") {
	const directory = await fs.lstat(config.directory);
	if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("TEAM_MESSAGE_DENIED: invalid bridge directory.");
	const file = path.join(config.directory, name);
	const before = await fs.lstat(file);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_LOG_BYTES) throw new Error("TEAM_MESSAGE_DENIED: invalid or full bridge log.");
	const handle = await fs.open(file, mode);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_LOG_BYTES) throw new Error("TEAM_MESSAGE_DENIED: bridge log changed.");
		return handle;
	} catch (error) { await handle.close(); throw error; }
}
export async function appendLog(config: BridgeConfig, name: "outbox.jsonl" | "responses.jsonl", value: unknown): Promise<void> {
	const line = JSON.stringify(value) + "\n";
	if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("Team message exceeds the bridge line limit.");
	const handle = await openLog(config, name, "a");
	try { await handle.writeFile(line, "utf8"); } finally { await handle.close(); }
}
export class LogReader {
	private offset = 0;
	private partial = Buffer.alloc(0);
	constructor(private config: BridgeConfig, private name: "outbox.jsonl" | "responses.jsonl") {}
	async read(): Promise<unknown[]> {
		const handle = await openLog(this.config, this.name, "r");
		let chunk: Buffer;
		try {
			if ((await handle.stat()).size < this.offset) throw new Error("TEAM_MESSAGE_DENIED: bridge log was truncated.");
			const buffer = Buffer.alloc(MAX_READ_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
			this.offset += bytesRead;
			chunk = Buffer.concat([this.partial, buffer.subarray(0, bytesRead)]);
		} finally { await handle.close(); }
		const values: unknown[] = [];
		let start = 0;
		for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
			if (end - start > MAX_LINE_BYTES) throw new Error("TEAM_MESSAGE_DENIED: bridge line is too long.");
			try { values.push(JSON.parse(chunk.subarray(start, end).toString("utf8"))); } catch { /* Malformed lines never become requests. */ }
			start = end + 1;
		}
		this.partial = chunk.subarray(start);
		if (this.partial.length > MAX_LINE_BYTES) throw new Error("TEAM_MESSAGE_DENIED: bridge line is too long.");
		return values;
	}
}

export interface ParentBridge {
	config: BridgeConfig;
	stop(): Promise<void>;
}
/** Requests are authenticated against their endpoint, never an untrusted from field. */
export async function createParentBridge(directory: string, member: string, route: (request: MessageRequest, signal: AbortSignal) => Promise<Omit<MessageResponse, "version" | "id">>): Promise<ParentBridge> {
	const bridgeDir = await fs.mkdtemp(path.join(directory, "bridge-"));
	const config: BridgeConfig = { version: 1, member, token: randomUUID(), directory: bridgeDir };
	await fs.chmod(bridgeDir, 0o700);
	for (const name of ["outbox.jsonl", "responses.jsonl"]) await fs.writeFile(path.join(bridgeDir, name), "", { flag: "wx", mode: 0o600 });
	const reader = new LogReader(config, "outbox.jsonl");
	const pending = new Map<string, AbortController>();
	const seen = new Set<string>();
	let stopped = false, polling = false;
	let writes = Promise.resolve();
	const respond = (response: MessageResponse) => {
		writes = writes.then(async () => { if (!stopped) await appendLog(config, "responses.jsonl", response); });
		// A broken endpoint fails closed, including requests already in flight.
		void writes.catch(() => stop());
	};
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		for (const controller of pending.values()) controller.abort();
		pending.clear();
		void fs.rm(config.directory, { recursive: true, force: true }).catch(() => {});
	};
	const poll = async () => {
		if (stopped || polling) return;
		polling = true;
		try {
			for (const value of await reader.read()) {
				if (stopped) break;
				let request: MessageRequest | CancelRequest;
				try { request = parseRequest(value, config); }
				catch (error) {
					const id = (value as { id?: unknown } | null)?.id;
					if (validRequestId(id)) respond({ version: 1, id, ok: false, error: String((error as Error).message) });
					continue;
				}
				if (request.kind === "cancel") { pending.get(request.id)?.abort(); continue; }
				if (seen.has(request.id)) continue;
				if (seen.size >= 4096) throw new Error("Team bridge request limit reached; restart the member.");
				seen.add(request.id);
				if (pending.size >= 32) { respond({ version: 1, id: request.id, ok: false, error: "Too many pending team messages." }); continue; }
				const controller = new AbortController();
				pending.set(request.id, controller);
				const deadline = setTimeout(() => controller.abort(), Math.max(1, request.expiresAt - Date.now()));
				deadline.unref?.();
				const message = request;
				void Promise.resolve().then(() => route(message, controller.signal)).then(
					result => respond({ version: 1, id: message.id, ...result }),
					error => respond({ version: 1, id: message.id, ok: false, error: String((error as Error)?.message ?? error).slice(0, MAX_MESSAGE_CHARS) }),
				).finally(() => { clearTimeout(deadline); pending.delete(message.id); });
			}
		} catch { await stop(); }
		finally { polling = false; }
	};
	const timer = setInterval(() => { void poll(); }, 100);
	timer.unref?.();
	return { config, stop };
}
