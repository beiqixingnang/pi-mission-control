import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import type { SandboxConfig } from "./sandbox.ts";
export interface WorkspaceOptions {
	root: string;
	access?: "read-only" | "read-write";
	extraReadRoots?: string[];
	execution?: "disabled" | "sandbox" | "host";
	sandbox?:SandboxConfig;
}
export interface ResolvedWorkspace {
	root: string;
	access: "read-only" | "read-write";
	extraReadRoots: string[];
	execution: "disabled" | "sandbox" | "host";
	sandbox?:SandboxConfig;
}
export const POLICY_ENV = "PI_AGENT_WORKSPACE_POLICY";
export const readableTools = ["read", "ls", "find", "grep"];
export const writableTools = ["write", "edit"];
export const bridgeTools = ["team_message", "team_wait", "team_task_status", "team_task_cancel"];
export const toolAlias = (name: string) => `workspace_${name}`;
export const allowedTools = (policy: ResolvedWorkspace) => [...readableTools, ...(policy.access === "read-write" ? writableTools : []), ...(policy.execution==="sandbox"?["exec","exec_status"]:policy.execution==="host"?["bash"]:[]), ...bridgeTools];
export function inside(root: string, target: string) {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export function resolveInput(input: string, cwd: string): string {
	if (typeof input !== "string" || !input || /[\x00-\x1f\x7f]/.test(input)) throw new Error("WORKSPACE_DENIED: invalid path.");
	let value = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
	if (value.startsWith("@")) value = value.slice(1);
	if (value.startsWith("file://")) value = fileURLToPath(value);
	if (value === "~") value = os.homedir();
	else if (/^~[\\/]/.test(value)) value = path.join(os.homedir(), value.slice(2));
	if (process.platform === "win32") {
		const shell = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
		if (shell) value = `${shell[1]}:/${shell[2] ?? ""}`;
		// Reject UNC/device namespaces, ADS, drive-relative paths, Win32 aliases,
		// and trailing-dot/space spellings that can disagree with path.resolve().
		if (/^[\\/]{2}/.test(value) || /^[a-z]:(?![\\/])/i.test(value) || /:/.test(value.replace(/^[a-z]:/i, ""))) throw new Error("WORKSPACE_DENIED: device, UNC, stream, and drive-relative paths are not supported.");
		for (const part of value.replace(/^[a-z]:[\\/]?/i, "").split(/[\\/]/)) {
			if (part === "." || part === ".." || !part) continue;
			if (/[. ]$/.test(part) || /~\d/.test(part) || /^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[<>"|?*]/.test(part)) throw new Error("WORKSPACE_DENIED: ambiguous Windows path.");
		}
	}
	return path.resolve(cwd, value);
}
async function canonicalDirectory(input: string, cwd: string) {
	const absolute = resolveInput(input, cwd);
	const canonical = await fs.realpath(absolute);
	if (!(await fs.stat(canonical)).isDirectory()) throw new Error(`Workspace root must be a directory: ${absolute}`);
	return canonical;
}
export async function resolveWorkspace(options: WorkspaceOptions, baseCwd: string): Promise<ResolvedWorkspace> {
	if (!options || typeof options !== "object" || typeof options.root !== "string") throw new Error("Workspace requires a root directory.");
	if (options.access !== undefined && !["read-only", "read-write"].includes(options.access)) throw new Error("Invalid workspace access mode.");
	if (options.execution !== undefined && !["disabled", "sandbox","host"].includes(options.execution)) throw new Error("Invalid workspace execution mode.");
	let sandbox:SandboxConfig|undefined;
	if (options.execution === "sandbox") {
		if(!options.sandbox)throw new Error("Workspace sandbox execution is unavailable: configure workspace.sandbox with a local Podman image. Host commands are never a fallback.");
		const {probeSandbox}=await import("./sandbox.ts");const probe=await probeSandbox(options.sandbox);
		if(!probe.available||!probe.imageId)throw new Error(`Workspace sandbox backend unavailable: ${probe.error}`);
		sandbox={...options.sandbox,image:probe.imageId};
	}else if(options.execution==="host"){
		if(options.sandbox!==undefined)throw new Error("Host execution cannot include a sandbox profile.");
	}else if(options.sandbox!==undefined)throw new Error("Set execution:sandbox to authorize a command backend.");
	if (options.extraReadRoots !== undefined && (!Array.isArray(options.extraReadRoots) || options.extraReadRoots.length > 20 || options.extraReadRoots.some(root => typeof root !== "string"))) throw new Error("extraReadRoots must be an array of at most 20 directory paths.");
	const root = await canonicalDirectory(options.root, baseCwd);
	const extraReadRoots = [...new Set(await Promise.all((options.extraReadRoots ?? []).map(extra => canonicalDirectory(extra, baseCwd))))];
	for (const extra of extraReadRoots) {
		if (inside(root, extra) || inside(extra, root)) throw new Error("Extra read roots must be separate from the primary workspace; overlapping roots are ambiguous.");
	}
	return { root, access: options.access ?? "read-write", extraReadRoots, execution: sandbox?"sandbox":options.execution??"disabled",...(sandbox?{sandbox}:{}) };
}

/** Checks at the point of filesystem access; a file-tool policy, not an OS sandbox. */
export class WorkspaceAccess {
	readonly readRoots: string[];
	readonly policy: ResolvedWorkspace;
	readonly cwd: string;
	readonly protectedWriteRoots: string[];
	constructor(policy: ResolvedWorkspace, cwd: string, protectedWriteRoots: string[] = []) {
		this.policy = policy;
		this.cwd = cwd;
		this.protectedWriteRoots = protectedWriteRoots;
		this.readRoots = [policy.root, ...policy.extraReadRoots];
	}
	async authorize(input: string, write = false, allowMissing = false): Promise<string> {
		const target = resolveInput(input, this.cwd);
		if (write && this.policy.access !== "read-write") throw new Error("WORKSPACE_DENIED: this member is read-only.");
		const roots = write ? [this.policy.root] : this.readRoots;
		const owner = roots.find(root => inside(root, target));
		if (!owner) throw new Error("WORKSPACE_DENIED: path is outside the authorized workspace roots.");
		if (write) {
			if (this.protectedWriteRoots.some(root => inside(root, target))) throw new Error("WORKSPACE_DENIED: Pi runtime/configuration is protected.");
			if (path.relative(this.policy.root, target).split(path.sep).some(segment => [".pi", ".agents", ".git"].includes(segment.toLowerCase()))) throw new Error("WORKSPACE_DENIED: agent configuration and Git metadata are protected.");
		}
		// Validate every component instead of only the final realpath. An allowed
		// symlink pointing elsewhere cannot be used by read or recursive search.
		let current = owner;
		const parts = path.relative(owner, target).split(path.sep).filter(Boolean);
		for (const part of ["", ...parts]) {
			if (part) current = path.join(current, part);
			let stat;
			try { stat = await fs.lstat(current); }
			catch (error) {
				if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return target;
				throw error;
			}
			if (stat.isSymbolicLink()) throw new Error("WORKSPACE_DENIED: symbolic links and junctions are not traversed.");
			if (stat.isFile() && stat.nlink > 1) throw new Error("WORKSPACE_DENIED: hard-linked files are not accessible in restricted mode.");
			if (!stat.isFile() && !stat.isDirectory()) throw new Error("WORKSPACE_DENIED: special filesystem objects are not accessible.");
			const canonical = await fs.realpath(current);
			if (!inside(owner, canonical)) throw new Error("WORKSPACE_DENIED: canonical path escapes its workspace root.");
		}
		return target;
	}
	async read(input: string): Promise<Buffer> {
		const target = await this.authorize(input);
		const handle = await fs.open(target, "r");
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.nlink > 1) throw new Error("WORKSPACE_DENIED: only regular, unlinked files can be read.");
			if (stat.size > 20 * 1024 * 1024) throw new Error("Restricted file reads are limited to 20 MiB per file.");
			await this.authorize(target);
			return await handle.readFile();
		} finally { await handle.close(); }
	}
	async mkdir(input: string) {
		const target = await this.authorize(input, true, true);
		await fs.mkdir(target, { recursive: true });
		await this.authorize(target, true);
	}
	async write(input: string, content: string) {
		const target = await this.authorize(input, true, true);
		let handle;
		try {
			try { handle = await fs.open(target, "r+"); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				handle = await fs.open(target, "wx");
			}
			const stat = await handle.stat();
			if (!stat.isFile() || stat.nlink > 1) throw new Error("WORKSPACE_DENIED: only regular, unlinked files can be written.");
			await this.authorize(target, true);
			await handle.truncate(0);
			await handle.writeFile(content, "utf8");
		} finally { await handle?.close(); }
	}
}
