/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	prepareWorkspaceLaunch,
	WorkspaceSchema,
	type ResolvedWorkspace,
	type WorkspaceOptions,
} from "../workspace/launch.ts";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

/** Shape of the launch plan returned by the lead-owned workspace helper. */
type WorkspaceLaunchPlan = Awaited<ReturnType<typeof prepareWorkspaceLaunch>>;

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	runId?:string;
	agent: string;
	agentSource: "package" | "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	cwd?: string;
	workspace?: ResolvedWorkspace;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

const MONITOR_OUTPUT_CAP = 1000;

/** Keep only the most recent visible output for the monitor, never thinking text. */
function boundMonitorOutput(output: string): string {
	if (output.length <= MONITOR_OUTPUT_CAP) return output;
	return output.slice(-MONITOR_OUTPUT_CAP);
}

function getAssistantText(message: Message): string {
	if (message.role !== "assistant") return "";
	for (const part of message.content) {
		if (part.type === "text") return part.text;
	}
	return "";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

type MonitorStatus = "starting" | "working" | "idle" | "done" | "error" | "stopped";

interface MonitorUpdate {
	id: string;
	kind: "subagent";
	name: string;
	status: MonitorStatus;
	model?: string;
	activity?: string;
	output?: string;
	startedAt?: number;
	updatedAt?: number;
	lastMessageAt?: number;
	/** True while the subagent process is running; false on every terminal state. */
	alive?: boolean;
	cwd?: string;
	workspace?: string;
	access?: string;
}

interface ActiveSubagent {
	id:string;
	invocationId?:string;
	agent:string;
	status:MonitorStatus;
	controller:AbortController;
	done:Promise<void>;
	startedAt:number;
}
interface DispatchDefaults {
	runId?:string;
	invocationId?:string;
	registerRun?:(run:ActiveSubagent)=>(()=>void);
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Invocation-level workspace; per-step values override it, agent presets are the fallback. */
	workspace?: WorkspaceOptions;
	report?: (update: MonitorUpdate) => void;
	conversation?: (id:string,messages:unknown[])=>void;
}

async function runSingleAgent(
	defaultCwd:string, defaults:DispatchDefaults, agents:AgentConfig[], agentName:string, task:string,
	cwd:string|undefined, workspace:WorkspaceOptions|undefined, step:number|undefined,
	signal:AbortSignal|undefined,onUpdate:OnUpdateCallback|undefined,makeDetails:(results:SingleResult[])=>SubagentDetails,
):Promise<SingleResult>{
	const id=randomUUID(),controller=new AbortController();
	const abort=()=>controller.abort();signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
	let markDone:()=>void=()=>{};const done=new Promise<void>(resolve=>{markDone=resolve;});
	const remove=defaults.registerRun?.({id,invocationId:defaults.invocationId,agent:agentName,status:"starting",controller,done,startedAt:Date.now()});
	try{return {...await runSingleAgentBody(defaultCwd,{...defaults,runId:id},agents,agentName,task,cwd,workspace,step,controller.signal,onUpdate,makeDetails),runId:id};}
	catch(error){
		// A targeted child cancellation is a failed result for that child, not a
		// rejection that abandons still-running siblings in a parallel invocation.
		if(!controller.signal.aborted||signal?.aborted)throw error;
		return {runId:id,agent:agentName,agentSource:agents.find(agent=>agent.name===agentName)?.source??"unknown",task,exitCode:1,messages:[],stderr:"Subagent task was cancelled.",stopReason:"aborted",errorMessage:"Subagent task was cancelled.",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:0,contextTokens:0,turns:0},step};
	}finally{remove?.();signal?.removeEventListener("abort",abort);markDone();}
}

async function runSingleAgentBody(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	stepWorkspace: WorkspaceOptions | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	const model = agent?.model ?? dispatchDefaults.model;

	const monitorId = dispatchDefaults.runId ?? randomUUID();
	const monitorName = step !== undefined ? `${agentName} (step ${step})` : agentName;
	let monitorStartedAt: number | undefined;
	let monitorMessageAt:number|undefined;
	let monitorTerminal = false;
	let monitorCwd: string | undefined;
	let monitorWorkspace: string | undefined;
	let monitorAccess: string | undefined;

	const report = (status: MonitorStatus, extra?: { activity?: string; output?: string; model?: string }) => {
		if (monitorTerminal) return;
		const now = Date.now();
		if (monitorStartedAt === undefined) monitorStartedAt = now;
		const terminal = status === "done" || status === "error" || status === "stopped";
		if (terminal) monitorTerminal = true;
		const emit = dispatchDefaults.report;
		if (!emit) return;
		emit({
			id: monitorId,
			kind: "subagent",
			name: monitorName,
			status,
			model: extra?.model ?? model,
			activity: extra?.activity,
			output: extra?.output !== undefined ? boundMonitorOutput(extra.output) : undefined,
			startedAt: monitorStartedAt,
			updatedAt: now,
			lastMessageAt:monitorMessageAt,
			alive: !terminal,
			cwd: monitorCwd,
			workspace: monitorWorkspace,
			access: monitorAccess,
		});
	};

	report("starting", { model });
	if(signal?.aborted){report("stopped");throw new Error("Subagent was aborted");}
	dispatchDefaults.conversation?.(monitorId,[{role:"user",content:task,timestamp:Date.now()}]);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		const message = `Unknown agent: "${agentName}". Available agents: ${available}.`;
		report("error", { output: message });
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: message,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const effectiveWorkspace = stepWorkspace ?? dispatchDefaults.workspace ?? agent.workspace;
	let plan: WorkspaceLaunchPlan;
	try {
		plan = await prepareWorkspaceLaunch({ baseCwd: defaultCwd, cwd, workspace: effectiveWorkspace, tools: agent.tools });
	} catch (error) {
		const message = `Workspace validation failed: ${error instanceof Error ? error.message : String(error)}`;
		report("error", { output: message });
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: message,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			cwd,
			errorMessage: message,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	// The helper owns tool selection: legacy `--tools` or `--no-tools` + restricted flags + guard.
	args.push(...plan.args);
	monitorCwd = plan.cwd;
	monitorWorkspace = plan.workspace?.root;
	monitorAccess = plan.workspace?.access;

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
		cwd: plan.cwd,
		workspace: plan.workspace,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	let wasAborted = false;
	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);

		let procErrorMessage: string | undefined;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: plan.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...plan.env },
			});
			let buffer = "";
			let streamedText = "";
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let killProc: (() => void) | undefined;
			let settled = false;

			const settle = (code: number) => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				if (signal && killProc) signal.removeEventListener("abort", killProc);
				resolve(code);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "agent_start") {
					report("working");
					return;
				}

				if (event.type === "message_start" && event.message?.role === "assistant") {
					streamedText = "";
					return;
				}

				if (event.type === "message_update") {
					const ame = event.assistantMessageEvent;
					if (ame?.type === "text_delta" && typeof ame.delta === "string") {
						streamedText = boundMonitorOutput(streamedText + ame.delta);
						monitorMessageAt=Date.now();
						report("working", { activity: "输出中", output: streamedText });
					} else if (ame?.type === "thinking_start" || ame?.type === "thinking_delta") {
						// Thinking metadata only: never forward thinking text.
						report("working", { activity: "思考中" });
					}
					return;
				}

				if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
					report("working", { activity: `工具 ${event.toolName}` });
					return;
				}

				if (event.type === "turn_end") {
					report("working", { activity: "等待响应", output: streamedText });
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					dispatchDefaults.conversation?.(monitorId,[msg]);
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
						streamedText = getAssistantText(msg);
						if(streamedText.trim())monitorMessageAt=msg.timestamp??Date.now();
						report("working", { output: streamedText });
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				settle(code ?? 0);
			});

			proc.on("error", (error) => {
				procErrorMessage = error instanceof Error ? error.message : String(error);
				settle(1);
			});

			if (signal) {
				killProc = () => {
					wasAborted = true;
					const pid = proc.pid;
					if (pid && process.platform === "win32") {
						const systemRoot = process.env.SystemRoot || "C:\\Windows";
						const taskkill = spawn(path.join(systemRoot, "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
						taskkill.once("error", () => {});
					} else if (pid) {
						try { process.kill(-pid, "SIGTERM"); } catch { /* fallback below */ }
					}
					proc.kill("SIGTERM");
					killTimer = setTimeout(() => {
						if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
					}, 1500);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		// Monitor output never includes raw stderr (may contain sensitive configuration).
		const failureMessage = currentResult.errorMessage || procErrorMessage;
		if (wasAborted || currentResult.stopReason === "aborted") {
			report("stopped", { output: currentResult.errorMessage || "Subagent stopped" });
		} else if (exitCode !== 0 || currentResult.stopReason === "error") {
			report("error", { output: failureMessage || `Subagent exited with code ${exitCode}` });
		} else {
			report("done", { output: getFinalOutput(currentResult.messages) });
		}
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} catch (error) {
		if (!monitorTerminal) {
			const message = error instanceof Error ? error.message : String(error);
			if (wasAborted) report("stopped", { output: message });
			else report("error", { output: message });
		}
		throw error;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	workspace: Type.Optional(WorkspaceSchema),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	workspace: Type.Optional(WorkspaceSchema),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	wait:Type.Optional(Type.Boolean({default:true,description:"Default true waits for the result. Set false to run in the background so the lead can continue, inspect or cancel it; completion wakes the lead."})),
	notify:Type.Optional(StringEnum(["batch","off"] as const,{description:"For background invocations: batch (default) sends one completion; off only stores the result."})),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	wait: Type.Optional(Type.Boolean({ default: true, description: "Default true waits for the invocation. Set false to run in background; completion wakes the lead." })),
	notify: Type.Optional(StringEnum(["batch", "off"] as const, { description: "Background notification policy; default batch." })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	workspace: Type.Optional(WorkspaceSchema),
});

export default function (pi: ExtensionAPI) {
	// Monitor generation: bumped when the session tears down or the tree moves so
	// late callbacks from a previous generation cannot repopulate the monitor.
	let monitorEpoch = 0;
	const controllers=new Map<AbortController,Promise<void>>();
	const invocations=new Map<string,AbortController>();
	const activeRuns=new Map<string,ActiveSubagent>();
	const completed=new Map<string,AgentToolResult<SubagentDetails>>();
	let cancellationEpoch=0;
	const stopRuns=()=>{cancellationEpoch++;for(const controller of controllers.keys())controller.abort();};
	pi.events.on("workbench:stop",data=>{stopRuns();(data as {pending?:Promise<unknown>[]})?.pending?.push(...controllers.values());});
	pi.on("session_shutdown", () => {
		completed.clear();
		stopRuns();
		monitorEpoch++;
	});
	pi.on("session_tree", () => {
		stopRuns();
		monitorEpoch++;
	});

	pi.registerTool({name:"subagent_list",label:"Subagent: active runs",description:"List active ordinary subagents and their runId/invocationId. Use subagent_cancel to interrupt one; this does not disband persistent team members.",parameters:Type.Object({}),async execute(){
		const runs=[...activeRuns.values()].map(({id,invocationId,agent,status,startedAt})=>({runId:id,invocationId,agent,status,startedAt}));
		return {content:[{type:"text" as const,text:JSON.stringify({runs,invocations:[...invocations.keys()]},null,2)}],details:{runs,invocations:[...invocations.keys()]}};
	}});
	async function cancelRuns(params:{runId?:string;invocationId?:string;agent?:string}){
		if(Number(!!params.runId)+Number(!!params.invocationId)+Number(!!params.agent)!==1)return {content:[{type:"text" as const,text:"Specify exactly one of runId, invocationId or agent."}],details:undefined,isError:true};
		if(params.invocationId){
			const controller=invocations.get(params.invocationId);
			if(!controller)return {content:[{type:"text" as const,text:"Unknown or finished invocation."}],details:undefined,isError:true};
			const done=controllers.get(controller);controller.abort();await done;
			return {content:[{type:"text" as const,text:`Cancelled invocation ${params.invocationId}.`}],details:{invocationId:params.invocationId,cancelled:true}};
		}
		const matches=params.runId?[activeRuns.get(params.runId)].filter((run):run is ActiveSubagent=>!!run):[...activeRuns.values()].filter(run=>run.agent===params.agent);
		if(matches.length!==1)return {content:[{type:"text" as const,text:matches.length?"Multiple runs have this agent name; use a runId from subagent_list.":"Unknown or already finished subagent."}],details:undefined,isError:true};
		const run=matches[0];run.controller.abort();await run.done;
		return {content:[{type:"text" as const,text:`Cancelled ${run.agent} run ${run.id}; unrelated runs continue.`}],details:{runId:run.id,cancelled:true}};
	}
	pi.registerTool({name:"subagent_cancel",label:"Subagent: cancel task",executionMode:"parallel",description:"Interrupt a running ordinary subagent by runId, one unambiguous agent name, or a whole invocationId. Other invocations/parallel siblings keep running. Use subagent_list for IDs.",parameters:Type.Object({runId:Type.Optional(Type.String()),invocationId:Type.Optional(Type.String()),agent:Type.Optional(Type.String())}),async execute(_id,params){return cancelRuns(params);}});
	pi.registerTool({name:"subagent_collect",label:"Subagent: background result",description:"Read the completed result of a background ordinary subagent invocation, or report pending without polling/waiting. Last 100 results retained.",parameters:Type.Object({invocationId:Type.String()}),async execute(_id,params){
		const result=completed.get(params.invocationId);if(result)return result;
		return {content:[{type:"text" as const,text:invocations.has(params.invocationId)?"Invocation is still running; wait for automatic completion.":"Unknown or expired invocation."}],details:{invocationId:params.invocationId,pending:invocations.has(params.invocationId)}};
	}});
	pi.registerCommand("subagent-cancel",{description:"Cancel a run/invocation by ID: /subagent-cancel <id>",handler:async(args,ctx)=>{const id=args.trim();const result=await cancelRuns(invocations.has(id)?{invocationId:id}:{runId:id});ctx.ui.notify(result.content.map(item=>item.text).join("\n"),result.isError?"warning":"info");}});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		executionMode:"parallel",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user": bundled presets, overridden by ${path.join(getAgentDir(), "agents")}.`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		promptGuidelines: ["When the user asks a subagent to stay within a directory, set workspace.root and access. cwd alone only changes the default directory. Restricted subagents have file tools only, no host shell or nested delegation."],
		parameters: SubagentParams,

		async execute(_toolCallId, params, parentSignal, onUpdate, ctx) {
			if(invocations.has(_toolCallId))throw new Error("Duplicate active subagent invocation ID.");
			const invocationEpoch=cancellationEpoch;
			const ownedParentSignal=params.wait===false?undefined:parentSignal;
			let markDone:()=>void=()=>{};
			const done=new Promise<void>(resolve=>{markDone=resolve;});
			const controller=new AbortController();controllers.set(controller,done);invocations.set(_toolCallId,controller);
			const abort=()=>controller.abort();ownedParentSignal?.addEventListener("abort",abort,{once:true});if(ownedParentSignal?.aborted)abort();
			const signal=controller.signal;
			pi.events.emit("subagent:run-start",{id:_toolCallId});
			const monitorGeneration=monitorEpoch;
			const runInvocation=async()=>{
			try {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const epoch = monitorGeneration;
			const dispatchDefaults: DispatchDefaults = {
				invocationId:_toolCallId,
				registerRun:run=>{activeRuns.set(run.id,run);return ()=>activeRuns.delete(run.id);},
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
				workspace: params.workspace,
				conversation:(id,messages)=>{if(epoch===monitorEpoch)pi.events.emit("agent-monitor:conversation",{id,messages});},
				report: (update) => {
					const active=activeRuns.get(update.id);if(active)active.status=update.status;
					if (epoch !== monitorEpoch) return;
					try {
						pi.events.emit("agent-monitor:update", update);
					} catch {
						/* a monitor consumer must never affect subagent execution */
					}
				},
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd ?? params.cwd,
						step.workspace,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd ?? params.cwd,
						t.workspace,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
			}finally{controllers.delete(controller);invocations.delete(_toolCallId);markDone();ownedParentSignal?.removeEventListener("abort",abort);pi.events.emit("subagent:run-end",{id:_toolCallId});}
			};
			if(params.wait!==false)return runInvocation();
			const scope:{goalId?:string}={};pi.events.emit("team:scope",scope);
			const member=`subagent:${params.agent??"workflow"}`;
			pi.events.emit("team:job-start",{id:_toolCallId,member,goalId:scope.goalId});
			const finish=(result:AgentToolResult<SubagentDetails>)=>{
				completed.set(_toolCallId,result);if(completed.size>100)completed.delete(completed.keys().next().value!);
				if(monitorGeneration!==monitorEpoch||invocationEpoch!==cancellationEpoch)return;
				const ok=!result.isError&&!result.details?.results.some(isFailedResult);
				const reply=result.content.filter(block=>block.type==="text").map(block=>block.text).join("\n");
				pi.events.emit("team:job-end",{id:_toolCallId,member,goalId:scope.goalId,ok,reply:ok?reply:undefined,error:ok?undefined:reply});
				if(!scope.goalId&&params.notify!=="off")pi.sendMessage({customType:"subagent-results",content:`Background invocation ${_toolCallId} ${ok?"completed":"failed or cancelled"}:\n${reply.slice(0,20000)}`,display:true,details:{invocationId:_toolCallId}},{triggerTurn:true,deliverAs:"followUp"});
			};
			void runInvocation().then(finish,error=>finish({content:[{type:"text",text:String((error as Error)?.message??error)}],details:{mode:"single",agentScope:params.agentScope??"user",projectAgentsDir:null,results:[]},isError:true}));
			return {content:[{type:"text" as const,text:`Started background invocation ${_toolCallId}. Use subagent_cancel to interrupt it; completion wakes the lead unless notifications are off.`}],details:{invocationId:_toolCallId,background:true}};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
