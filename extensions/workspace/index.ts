/** File-tool confinement for deliberately restricted child processes. */
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, getAgentDir, getPackageDir, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { POLICY_ENV, WorkspaceAccess, allowedTools, toolAlias, resolveWorkspace, type ResolvedWorkspace } from "./policy.ts";

const MAX_OUTPUT = 48 * 1024;
function result(text: string, details?: unknown) {
	const bytes = Buffer.from(text);
	return { content: [{ type: "text" as const, text: bytes.length <= MAX_OUTPUT ? text : bytes.subarray(0, MAX_OUTPUT).toString("utf8") + "\n[Output truncated]" }], details };
}
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("Operation aborted"); };
const bounded = (value: number | undefined, fallback: number) => Math.max(1, Math.min(2000, Math.floor(value ?? fallback)));

export default async function (pi: ExtensionAPI) {
	const raw = process.env[POLICY_ENV];
	if (!raw) return; // No effect in the unrestricted lead session.
	let access: WorkspaceAccess | undefined;
	let error: string | undefined;
	try {
		const parsed = JSON.parse(raw);
		const policy = await resolveWorkspace(parsed, process.cwd());
		access = new WorkspaceAccess(policy, process.cwd(), [getAgentDir(), getPackageDir()]);
		await access.authorize(process.cwd());
	} catch (cause) { error = String((cause as Error).message); }
	const requireAccess = () => {
		if (!access || error) throw new Error(`WORKSPACE_DENIED: invalid workspace policy: ${error || "unavailable"}`);
		return access;
	};
	const permitted = new Set(access ? allowedTools(access.policy).map(toolAlias) : []);
	pi.on("tool_call", event => {
		if (!permitted.has(event.toolName)) return { block: true, reason: `WORKSPACE_DENIED: '${event.toolName}' is not permitted. Commands, external tools, and nested agents are disabled.` };
	});
	pi.on("user_bash", () => ({ result: { output: "WORKSPACE_DENIED: commands are disabled for this member.", exitCode: 1, cancelled: false, truncated: false } }));
	pi.on("session_start", () => { pi.setActiveTools(pi.getActiveTools().filter(tool => permitted.has(tool))); });
	pi.on("before_agent_start", event => {
		event.systemPromptOptions.promptGuidelines.push(access ? `Restricted workspace: ${access.policy.root}. Access: ${access.policy.access}. Extra read-only roots: ${access.policy.extraReadRoots.join(", ") || "none"}. Use only the provided file tools; shell, external tools, and nested delegation are disabled. A denied request is not permission to ask another agent to bypass it.` : `Workspace policy failed to load; all tools are disabled. ${error}`);
	});
	pi.registerCommand("workspace", { description: "Show this member's enforced file-tool workspace policy.", handler: async (_args, ctx) => { ctx.ui.notify(access ? JSON.stringify(access.policy, null, 2) : `Workspace policy error: ${error}`, access ? "info" : "error"); } });

	function guard(definition: ToolDefinition<any, any>): ToolDefinition<any, any> {
		const original = definition.execute;
		return { ...definition, name: toolAlias(definition.name), description: definition.description + " Restricted to authorized workspace roots.", async execute(id, args, signal, update, ctx) {
			const policy = requireAccess();
			if (!permitted.has(toolAlias(definition.name))) throw new Error("WORKSPACE_DENIED: this member is read-only.");
			const writing = definition.name === "write" || definition.name === "edit";
			// Authorize BEFORE mkdir or any built-in path fallback can run.
			const target = await policy.authorize(args.path ?? ".", writing, definition.name === "write");
			checkAbort(signal);
			return original(id, { ...args, path: target }, signal, update, ctx);
		} };
	}
	const cwd = process.cwd();
	pi.registerTool(guard(createReadToolDefinition(cwd, { operations: {
		access: async target => { await requireAccess().authorize(target); },
		readFile: target => requireAccess().read(target),
		detectImageMimeType: async target => {
			const data = await requireAccess().read(target);
			if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
			if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
			if (/^GIF8[79]a/.test(data.subarray(0, 6).toString("ascii"))) return "image/gif";
			if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") return "image/webp";
			return undefined;
		},
	} })));
	pi.registerTool(guard(createWriteToolDefinition(cwd, { operations: {
		mkdir: target => requireAccess().mkdir(target),
		writeFile: (target, content) => requireAccess().write(target, content),
	} })));
	pi.registerTool(guard(createEditToolDefinition(cwd, { operations: {
		access: async target => { await requireAccess().authorize(target, true); },
		readFile: target => requireAccess().read(target),
		writeFile: (target, content) => requireAccess().write(target, content),
	} })));

	async function* walk(root: string, signal?: AbortSignal): AsyncGenerator<{ absolute: string; relative: string; directory: boolean }> {
		let visited = 0;
		const stack = [{ dir: root, depth: 0 }];
		while (stack.length && visited < 10000) {
			checkAbort(signal);
			const { dir, depth } = stack.pop()!;
			await requireAccess().authorize(dir);
			const children = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of children) {
				checkAbort(signal);
				if (++visited > 10000) return;
				if (entry.isSymbolicLink() || [".git", ".pi", ".agents", "node_modules"].includes(entry.name.toLowerCase())) continue;
				const absolute = path.join(dir, entry.name);
				try { await requireAccess().authorize(absolute); } catch { continue; }
				const directory = entry.isDirectory();
				if (!directory && !entry.isFile()) continue;
				yield { absolute, relative: path.relative(root, absolute).split(path.sep).join("/"), directory };
				if (directory && depth < 64) stack.push({ dir: absolute, depth: depth + 1 });
			}
		}
	}
	pi.registerTool({
		name: "workspace_ls", label: "ls", description: "List entries in an authorized workspace directory. Skips symbolic links and inaccessible files.",
		parameters: Type.Object({ path: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }),
		async execute(_id, args, signal) {
			const target = await requireAccess().authorize(args.path ?? ".");
			const children = await fs.readdir(target, { withFileTypes: true });
			const lines: string[] = [];
			for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
				checkAbort(signal);
				if (entry.isSymbolicLink()) continue;
				try { await requireAccess().authorize(path.join(target, entry.name)); } catch { continue; }
				lines.push(entry.name + (entry.isDirectory() ? "/" : ""));
				if (lines.length >= bounded(args.limit, 500)) break;
			}
			return result(lines.join("\n") || "(empty directory)");
		},
	});
	pi.registerTool({
		name: "workspace_find", label: "find", description: "Find workspace files by glob. Bounded native walk; skips links, .git, .pi, .agents and node_modules; does not read outside ignore/config files.",
		parameters: Type.Object({ pattern: Type.String({ maxLength: 500 }), path: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }),
		async execute(_id, args, signal) {
			const root = await requireAccess().authorize(args.path ?? ".");
			const lines: string[] = [];
			for await (const file of walk(root, signal)) {
				if (file.directory) continue;
				const candidate = args.pattern.includes("/") ? file.relative : path.basename(file.absolute);
				if (!path.matchesGlob(candidate, args.pattern)) continue;
				lines.push(file.relative);
				if (lines.length >= bounded(args.limit, 1000)) break;
			}
			return result(lines.join("\n") || "No matching files found", { traversalLimit: 10000 });
		},
	});
	pi.registerTool({
		name: "workspace_grep", label: "grep", description: "Search authorized workspace text files. Uses a literal substring by default (ignoreCase optional); regex syntax is not supported in restricted mode. Skips links, metadata and files over 2 MiB.",
		parameters: Type.Object({ pattern: Type.String({ minLength: 1, maxLength: 500 }), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String({ maxLength: 500 })), ignoreCase: Type.Optional(Type.Boolean()), literal: Type.Optional(Type.Boolean()), context: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }),
		async execute(_id, args, signal) {
			if (args.literal === false) throw new Error("Restricted grep supports literal search only. Set literal:true or omit it.");
			const root = await requireAccess().authorize(args.path ?? ".");
			const stat = await fs.stat(root);
			const files = stat.isDirectory() ? walk(root, signal) : (async function* () { yield { absolute: root, relative: path.basename(root), directory: false }; })();
			const lines: string[] = [];
			const needle = args.ignoreCase ? args.pattern.toLowerCase() : args.pattern;
			let matches = 0, bytesRead = 0;
			for await (const file of files) {
				checkAbort(signal);
				if (file.directory || (args.glob && !path.matchesGlob(file.relative, args.glob) && !path.matchesGlob(path.basename(file.absolute), args.glob))) continue;
				if ((await fs.stat(file.absolute)).size > 2 * 1024 * 1024) continue;
				let data: Buffer;
				try { data = await requireAccess().read(file.absolute); } catch { continue; }
				bytesRead += data.length;
				if (bytesRead > 20 * 1024 * 1024) break;
				if (data.includes(0)) continue;
				const content = data.toString("utf8").split(/\r?\n/);
				for (let i = 0; i < content.length; i++) {
					if (!(args.ignoreCase ? content[i].toLowerCase() : content[i]).includes(needle)) continue;
					const context = args.context ?? 0;
					for (let line = Math.max(0, i - context); line <= Math.min(content.length - 1, i + context); line++) lines.push(`${file.relative}:${line + 1}: ${content[line].slice(0, 2000)}`);
					if (++matches >= bounded(args.limit, 100)) break;
				}
				if (matches >= bounded(args.limit, 100) || Buffer.byteLength(lines.join("\n")) >= MAX_OUTPUT) break;
			}
			return result(lines.join("\n") || "No matches found", { traversalLimit: 10000, byteBudget: 20 * 1024 * 1024, literal: true });
		},
	});
}
