import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { WorkspaceAccess, resolveInput, type ResolvedWorkspace } from "./policy.ts";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";

export interface SandboxConfig {
	engine: "podman";
	image: string;
	cpus?: number;
	memoryMb?: number;
	pidsLimit?: number;
	maxSeconds?: number;
}

export interface SandboxProbe {
	available: boolean;
	error?: string;
	imageId?: string;
}

export interface SandboxRunStatus {
	receipt: Record<string, unknown>;
	processState: "running" | "stopped" | "unknown";
	error?: string;
}

interface SandboxPolicy {
	root: string;
	access: "read-only" | "read-write";
	extraReadRoots: string[];
	execution: string;
	sandbox?: SandboxConfig;
}

interface SandboxArgs {
	command: string;
	timeoutSeconds?: number;
	cwd?: string;
}

const PODMAN = "podman";
const DEFAULT_CPUS = 1;
const DEFAULT_MEMORY_MB = 512;
const DEFAULT_PIDS = 256;
const DEFAULT_MAX_SECONDS = 300;
const MAX_MAX_SECONDS = 3600;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CLI_OUTPUT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 128;
const COMMAND_MAX_BYTES = 64 * 1024;
const RUN_ID_MAX = 96;
const EXCLUDED = new Set([".git", ".pi", ".agents", "node_modules", ".mission-control"]);

class CliAbortError extends Error {
	readonly reason: "cancelled" | "timeout";
	stdout = "";
	stderr = "";
	truncated = false;
	constructor(reason: "cancelled" | "timeout") {
		super(reason === "timeout" ? "Podman operation timed out." : "Podman operation cancelled.");
		this.name = "CliAbortError";
		this.reason = reason;
	}
}

class WorkspaceConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceConflictError";
	}
}

class OutputLog {
	private bytes = 0;
	private queue: Promise<void> = Promise.resolve();
	private failed = false;
	constructor(private readonly filePath: string, private readonly maxBytes: number) {}
	write(chunk: Buffer) {
		if (this.failed || !chunk.length || this.bytes >= this.maxBytes) return;
		const copy = Buffer.from(chunk.subarray(0, Math.min(chunk.length, this.maxBytes - this.bytes)));
		this.bytes += copy.length;
		this.queue = this.queue.then(() => fs.appendFile(this.filePath, copy)).catch(() => { this.failed = true; });
	}
	async flush() { await this.queue; }
}

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
}

interface SnapshotFile {
	relative: string;
	sha256: string;
	size: number;
	mode: number;
	stagePath?: string;
}

interface SnapshotBudget {
	bytes: number;
	entries: number;
}

interface HostEntry {
	kind: "absent" | "file" | "directory" | "unsafe";
	sha256?: string;
}

interface ExportPlan {
	writes: SnapshotFile[];
	deletes: string[];
	artifacts: string[];
}

function textError(cause: unknown, fallback = "Sandbox operation failed.") {
	const message = cause instanceof Error ? cause.message : String(cause);
	const clean = message.replace(/[\x00-\x1f\x7f]/g, " ").trim();
	return (clean || fallback).slice(0, 4096);
}

function checkString(value: unknown, name: string, maxBytes: number, allowControls = false) {
	if (typeof value !== "string" || !value || /[\x00]/.test(value) || (!allowControls && /[\x01-\x1f\x7f]/.test(value)) || Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`Invalid ${name}.`);
}

function validateNumber(value: number | undefined, name: string, minimum: number, maximum: number, fallback: number) {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Invalid sandbox ${name}.`);
	return value;
}

function validateConfig(config: SandboxConfig): Required<SandboxConfig> {
	if (!config || typeof config !== "object" || config.engine !== "podman") throw new Error("Sandbox engine must be podman.");
	checkString(config.image, "sandbox image", 512);
	if (/\s/.test(config.image)) throw new Error("Invalid sandbox image.");
	return {
		engine: "podman",
		image: config.image,
		cpus: validateNumber(config.cpus, "cpus", 0.01, 64, DEFAULT_CPUS),
		memoryMb: validateNumber(config.memoryMb, "memoryMb", 64, 64 * 1024, DEFAULT_MEMORY_MB),
		pidsLimit: Math.floor(validateNumber(config.pidsLimit, "pidsLimit", 16, 32_768, DEFAULT_PIDS)),
		maxSeconds: Math.floor(validateNumber(config.maxSeconds, "maxSeconds", 1, MAX_MAX_SECONDS, DEFAULT_MAX_SECONDS)),
	};
}

function inside(root: string, target: string) {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function workspaceLabel(root: string) {
	return createHash("sha256").update(root, "utf8").digest("hex");
}

function validRunId(runId: unknown): runId is string {
	return typeof runId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId);
}


async function canonicalDirectory(input: unknown, name: string) {
	checkString(input, name, 32 * 1024);
	const absolute = resolveInput(input as string, process.cwd());
	let stat;
	try { stat = await fs.lstat(absolute); }
	catch (cause) { throw new Error(`${name} is unavailable: ${textError(cause)}`); }
	if (stat.isSymbolicLink()) throw new Error(`${name} cannot be a symbolic link.`);
	if (!stat.isDirectory()) throw new Error(`${name} must be a directory.`);
	const canonical = await fs.realpath(absolute);
	if (!(await fs.stat(canonical)).isDirectory()) throw new Error(`${name} must be a directory.`);
	return canonical;
}

async function validatePolicy(policy: SandboxPolicy) {
	if (!policy || typeof policy !== "object") throw new Error("Sandbox policy is required.");
	if (policy.execution !== "sandbox") throw new Error("Sandbox execution is not enabled by this policy.");
	if (policy.access !== "read-only" && policy.access !== "read-write") throw new Error("Invalid sandbox access mode.");
	const root = await canonicalDirectory(policy.root, "sandbox root");
	if (!Array.isArray(policy.extraReadRoots) || policy.extraReadRoots.length > 20 || policy.extraReadRoots.some(value => typeof value !== "string")) throw new Error("Sandbox extraReadRoots must contain at most 20 directories.");
	const extraReadRoots: string[] = [];
	for (const value of policy.extraReadRoots) extraReadRoots.push(await canonicalDirectory(value, "sandbox extra read root"));
	const all = [root, ...extraReadRoots];
	for (let i = 0; i < all.length; i++) {
		for (let j = i + 1; j < all.length; j++) {
			if (inside(all[i], all[j]) || inside(all[j], all[i])) throw new Error("Sandbox roots must be separate and non-overlapping.");
		}
	}
	return { root, extraReadRoots };
}

function safeRelative(relative: string) {
	if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid sandbox relative path.");
}

export function validateSandboxExportPath(root: string, relative: string) {
	safeRelative(relative);
	if (relative.includes("\\")) throw new Error("Invalid sandbox output path.");
	const parts = relative.split("/");
	if (parts.some(part => EXCLUDED.has(part.toLowerCase()))) throw new Error("Sandbox output may not modify protected metadata or dependency directories.");
	if (/^(?:@|file:\/\/|~)/i.test(relative)) throw new Error("Invalid sandbox output path.");
	const target = resolveInput(relative, root);
	if (!inside(root, target)) throw new Error("Sandbox path escaped its root.");
	return target;
}

function absoluteRelative(root: string, relative: string) {
	const target = validateSandboxExportPath(root, relative);
	return target;
}

async function inspectHostPath(root: string, relative: string): Promise<HostEntry> {
	const target = absoluteRelative(root, relative);
	const parts = relative.split("/");
	let current = root;
	for (let i = 0; i < parts.length; i++) {
		current = path.join(current, parts[i]);
		let stat;
		try { stat = await fs.lstat(current); }
		catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
			throw cause;
		}
		if (stat.isSymbolicLink()) return { kind: "unsafe" };
		if (stat.isFile() && stat.nlink > 1) return { kind: "unsafe" };
		if (i < parts.length - 1 && !stat.isDirectory()) return { kind: "unsafe" };
		if (!stat.isFile() && !stat.isDirectory()) return { kind: "unsafe" };
	}
	const stat = await fs.lstat(target);
	if (stat.isDirectory()) return { kind: "directory" };
	if (!stat.isFile() || stat.nlink > 1) return { kind: "unsafe" };
	return { kind: "file", sha256: await hashRegularFile(target) };
}

async function hashRegularFile(filePath: string, budget?: SnapshotBudget) {
	const handle = await fs.open(filePath, "r");
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink > 1 || before.size > MAX_FILE_BYTES) throw new Error("Workspace file is not a bounded regular file.");
		const hash = createHash("sha256");
		let bytes = 0;
		const buffer = Buffer.alloc(64 * 1024);
		while (true) {
			const read = await handle.read(buffer, 0, buffer.length, null);
			if (!read.bytesRead) break;
			bytes += read.bytesRead;
			if (bytes > MAX_FILE_BYTES || (budget && budget.bytes + bytes > MAX_SNAPSHOT_BYTES)) throw new Error("Workspace file exceeds the sandbox byte limit during hashing.");
			hash.update(buffer.subarray(0, read.bytesRead));
		}
		const after = await handle.stat();
		if (!after.isFile() || after.nlink > 1 || after.size !== before.size || bytes !== before.size) throw new WorkspaceConflictError("Workspace file changed while it was being read.");
		return hash.digest("hex");
	} finally { await handle.close(); }
}

function sourceMode(mode: number, writable: boolean) {
	if (!writable) return (mode & 0o111) ? 0o555 : 0o444;
	return (mode & 0o111) ? 0o777 : 0o666;
}

async function copyRegularFile(source: string, destination: string, writable: boolean, budget: SnapshotBudget, relative: string, signal?: AbortSignal): Promise<SnapshotFile> {
	if (signal?.aborted) throw new CliAbortError("cancelled");
	const handle = await fs.open(source, "r");
	let output;
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink > 1) throw new Error(`Unsafe workspace file skipped: ${relative}`);
		if (before.size > MAX_FILE_BYTES || budget.bytes + before.size > MAX_SNAPSHOT_BYTES) throw new Error("Sandbox snapshot exceeds its byte limit.");
		await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
		output = await fs.open(destination, "w", sourceMode(before.mode, writable));
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(64 * 1024);
		let bytes = 0;
		while (true) {
			if (signal?.aborted) throw new CliAbortError("cancelled");
			const read = await handle.read(buffer, 0, buffer.length, null);
			if (!read.bytesRead) break;
			const chunk = buffer.subarray(0, read.bytesRead);
			bytes += read.bytesRead;
			if (bytes > MAX_FILE_BYTES || budget.bytes + bytes > MAX_SNAPSHOT_BYTES) throw new Error("Sandbox snapshot exceeds its byte limit during copy.");
			await output.write(chunk);
			hash.update(chunk);
		}
		const after = await handle.stat();
		if (!after.isFile() || after.nlink > 1 || after.size !== before.size || bytes !== before.size) throw new WorkspaceConflictError(`Workspace file changed while being snapshotted: ${relative}`);
		await fs.chmod(destination, sourceMode(before.mode, writable));
		budget.bytes += bytes;
		return { relative, sha256: hash.digest("hex"), size: bytes, mode: sourceMode(before.mode, writable), stagePath: destination };
	} finally { await output?.close(); await handle.close(); }
}

async function makeTreeReadOnly(directory: string): Promise<void> {
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const target = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			await makeTreeReadOnly(target);
			await fs.chmod(target, 0o555);
		} else if (entry.isFile()) await fs.chmod(target, 0o444);
	}
	await fs.chmod(directory, 0o555);
}

async function snapshotDirectory(source: string, destination: string, writable: boolean, budget: SnapshotBudget, signal?: AbortSignal): Promise<Map<string, SnapshotFile>> {
	const files = new Map<string, SnapshotFile>();
	await fs.mkdir(destination, { recursive: true, mode: writable ? 0o777 : 0o700 });
	const visit = async (currentSource: string, currentDestination: string, relativeDirectory: string, depth: number): Promise<void> => {
		if (signal?.aborted) throw new CliAbortError("cancelled");
		if (depth > MAX_DEPTH) throw new Error("Sandbox snapshot exceeds its directory depth limit.");
		const children = await fs.readdir(currentSource, { withFileTypes: true });
		for (const entry of children) {
			if (++budget.entries > MAX_ENTRIES) throw new Error("Sandbox snapshot exceeds its entry limit.");
			if (signal?.aborted) throw new CliAbortError("cancelled");
			if (EXCLUDED.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
			const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			const src = path.join(currentSource, entry.name);
			const dst = path.join(currentDestination, entry.name);
			let stat;
			try { stat = await fs.lstat(src); }
			catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue; throw cause; }
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				await fs.mkdir(dst, { recursive: true, mode: writable ? 0o777 : 0o700 });
				await visit(src, dst, relative, depth + 1);
				if (writable) await fs.chmod(dst, 0o777);
			} else if (stat.isFile()) {
				if (stat.nlink > 1) continue;
				const copied = await copyRegularFile(src, dst, writable, budget, relative, signal);
				files.set(relative, copied);
			}
		}
	};
	await visit(source, destination, "", 0);
	if (!writable) await makeTreeReadOnly(destination);
	else {
		await fs.chmod(destination, 0o777);
	}
	return files;
}

async function scanDirectory(source: string, budget: SnapshotBudget, signal?: AbortSignal): Promise<Map<string, SnapshotFile>> {
	const files = new Map<string, SnapshotFile>();
	const visit = async (currentSource: string, relativeDirectory: string, depth: number): Promise<void> => {
		if (signal?.aborted) throw new CliAbortError("cancelled");
		if (depth > MAX_DEPTH) throw new Error("Sandbox output exceeds its directory depth limit.");
		const children = await fs.readdir(currentSource, { withFileTypes: true });
		for (const entry of children) {
			if (++budget.entries > MAX_ENTRIES) throw new Error("Sandbox output exceeds its entry limit.");
			if (signal?.aborted) throw new CliAbortError("cancelled");
			if (EXCLUDED.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
			const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			const src = path.join(currentSource, entry.name);
			let stat;
			try { stat = await fs.lstat(src); }
			catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue; throw cause; }
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) await visit(src, relative, depth + 1);
			else if (stat.isFile() && stat.nlink === 1) {
				if (stat.size > MAX_FILE_BYTES || budget.bytes + stat.size > MAX_SNAPSHOT_BYTES) throw new Error("Sandbox output exceeds its byte limit.");
				const hash = await hashRegularFile(src, budget);
				budget.bytes += stat.size;
				files.set(relative, { relative, sha256: hash, size: stat.size, mode: stat.mode & 0o777, stagePath: src });
			}
		}
	};
	await visit(source, "", 0);
	return files;
}

async function ensureRunDirectory(root: string, runId: string) {
	let current = root;
	for (const segment of [".mission-control", "runs"]) {
		current = path.join(current, segment);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Sandbox run metadata path is unsafe.");
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
			await fs.mkdir(current, { mode: 0o700 });
		}
	}
	const runDirectory = path.join(current, runId);
	await fs.mkdir(runDirectory, { mode: 0o700 });
	return runDirectory;
}

async function atomicWrite(filePath: string, content: string) {
	const temporary = `${filePath}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await fs.rename(temporary, filePath);
	} finally {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
	}
}

function podmanEnvironment() {
	const env: Record<string, string> = {};
	if (process.env.PATH) env.PATH = process.env.PATH;
	for (const key of ["HOME","APPDATA","LOCALAPPDATA","XDG_CONFIG_HOME","CONTAINER_HOST","CONTAINER_CONNECTION","CONTAINER_SSHKEY","PODMAN_CONNECTIONS_CONF","CONTAINERS_CONF"]) if(process.env[key])env[key]=process.env[key]!;
	if (process.platform === "win32") {
		for (const key of ["SystemRoot", "WINDIR", "PATHEXT", "USERPROFILE"]) if (process.env[key]) env[key] = process.env[key]!;
	}
	return env;
}

function boundedOutput(chunks: Buffer[], seen: { bytes: number; stored: number }, chunk: Buffer, maxBytes: number, onOutput?: (chunk: Buffer) => void) {
	seen.bytes += chunk.length;
	const remaining = maxBytes - seen.stored;
	if (remaining <= 0) return;
	const retained = Buffer.from(chunk.subarray(0, Math.min(chunk.length, remaining)));
	seen.stored += retained.length;
	chunks.push(retained);
	onOutput?.(retained);
}

function limitOutput(value: string, maxBytes: number) {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	const marker = Buffer.from("\n[Sandbox output truncated]", "utf8");
	if (maxBytes <= marker.length) return marker.subarray(0, maxBytes).toString("utf8");
	return bytes.subarray(0, maxBytes - marker.length).toString("utf8") + marker.toString("utf8");
}

function runPodman(args: string[], options: { signal?: AbortSignal; timeoutMs?: number; maxOutput?: number; cwd?: string; onOutput?: (chunk: Buffer) => void } = {}): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) return reject(new CliAbortError("cancelled"));
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const outputSeen = { bytes: 0, stored: 0 };
		const maxOutput = options.maxOutput ?? MAX_CLI_OUTPUT_BYTES;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let abortReason: "cancelled" | "timeout" | undefined;
		let child: ChildProcessWithoutNullStreams | undefined;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			action();
		};
		const onAbort = () => {
			abortReason = "cancelled";
			try { child?.kill(); } catch { /* process may already be gone */ }
		};
		try {
			child = spawn(PODMAN, args, { cwd: options.cwd, env: podmanEnvironment(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (cause) {
			return finish(() => reject(cause));
		}
		if (!child) return finish(() => reject(new Error("Podman process was not created.")));
		child.stdout?.on("data", (chunk: Buffer) => boundedOutput(stdout, outputSeen, chunk, maxOutput, options.onOutput));
		child.stderr?.on("data", (chunk: Buffer) => boundedOutput(stderr, outputSeen, chunk, maxOutput, options.onOutput));
		child.once("error", cause => finish(() => reject(cause)));
		child.once("close", code => finish(() => {
			if (abortReason) {
				const aborted = new CliAbortError(abortReason);
				aborted.stdout = Buffer.concat(stdout).toString("utf8");
				aborted.stderr = Buffer.concat(stderr).toString("utf8");
				aborted.truncated = outputSeen.bytes > maxOutput;
				return reject(aborted);
			}
			resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), truncated: outputSeen.bytes > maxOutput });
		}));
		if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutMs !== undefined) timer = setTimeout(() => {
			abortReason = "timeout";
			try { child.kill(); } catch { /* process may already be gone */ }
		}, options.timeoutMs);
	});
}

function cliFailure(result: CliResult, operation: string) {
	if (result.code === 0) return;
	const detail = (result.stderr || result.stdout || `exit code ${result.code ?? "unknown"}`).trim();
	throw new Error(`${operation} failed: ${detail.slice(0, 2048)}`);
}

function immutableImageId(output: string) {
	const match = output.match(/(?:sha256:)?[0-9a-f]{64}/i);
	if (!match) return undefined;
	const value = match[0].toLowerCase();
	return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

async function inspectSandbox(config: Required<SandboxConfig>, signal?: AbortSignal): Promise<SandboxProbe> {
	try {
		const result = await runPodman(["image", "inspect", "--format={{.Id}}", "--", config.image], { signal, timeoutMs: 30_000, maxOutput: MAX_CLI_OUTPUT_BYTES });
		if (result.code !== 0) return { available: false, error: textError(result.stderr || result.stdout || "Podman could not inspect the local image.") };
		const imageId = immutableImageId(result.stdout);
		if (!imageId) return { available: false, error: "Podman returned no immutable image ID." };
		return { available: true, imageId };
	} catch (cause) {
		if (cause instanceof CliAbortError && signal?.aborted) throw cause;
		return { available: false, error: textError(cause, "Podman is unavailable.") };
	}
}

export async function probeSandbox(config: SandboxConfig): Promise<SandboxProbe> {
	try {
		const validated = validateConfig(config);
		return await inspectSandbox(validated);
	} catch (cause) {
		return { available: false, error: textError(cause) };
	}
}

function parseContainerId(output: string) {
	const value = output.trim().split(/\s+/)[0] ?? "";
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error("Podman returned an invalid container ID.");
	return value;
}

function containerPath(container: string, target: string) {
	if (!/^([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/.test(container)) throw new Error("Invalid private container reference.");
	if (!target.startsWith("/")) throw new Error("Invalid private container path.");
	return `${container}:${target}`;
}

async function podmanCall(args: string[], signal: AbortSignal | undefined, operation: string, maxOutput = MAX_CLI_OUTPUT_BYTES) {
	const result = await runPodman(args, { signal, timeoutMs: 120_000, maxOutput });
	cliFailure(result, operation);
	return result;
}

function createArguments(config: Required<SandboxConfig>, imageId: string, name: string, writable: boolean, runId: string, workspaceSha256: string) {
	const args = [
		"create",
		"--pull=never",
		"--name", name,
		"--network", "none",
		"--label", `run-id=${runId}`,
		"--label", `workspace-sha256=${workspaceSha256}`,
		"--read-only",
		"--image-volume", "ignore",
		"--env", "HOME=/tmp",
		"--timeout", String(config.maxSeconds + 120),
		"--entrypoint", "/bin/sh",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--pids-limit", String(config.pidsLimit),
		"--memory", `${config.memoryMb}m`,
		"--cpus", String(config.cpus),
		"--user", "65534:65534",
		"--workdir", "/",
		"--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m",
	];
	if (writable) args.push("--tmpfs", "/workspace:rw,nosuid,nodev,size=256m,mode=1777");
	args.push(imageId, "-c", "while :; do sleep 3600; done");
	return args;
}

async function copyDirectoryToContainer(source: string, container: string, destination: string, contents: boolean, signal?: AbortSignal) {
	const sourcePath = contents ? `${source}${path.sep}.` : source;
	await podmanCall(["cp", sourcePath, containerPath(container, destination)], signal, "Copying sandbox files");
}

async function copyDirectoryFromContainer(container: string, source: string, destination: string, signal?: AbortSignal) {
	await fs.mkdir(destination, { recursive: true, mode: 0o700 });
	await podmanCall(["cp", containerPath(container, source), destination], signal, "Collecting sandbox output", MAX_CLI_OUTPUT_BYTES);
}

async function readControlledReceipt(root: string, runId: string): Promise<Record<string, unknown>> {
	if (!validRunId(runId)) throw new Error("Invalid sandbox run ID.");
	let current = root;
	for (const segment of [".mission-control", "runs", runId]) {
		current = path.join(current, segment);
		let stat;
		try { stat = await fs.lstat(current); }
		catch (cause) { throw new Error(`Sandbox run is unavailable: ${textError(cause)}`); }
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Sandbox run metadata path is unsafe.");
	}
	const receiptPath = path.join(current, "receipt.json");
	const stat = await fs.lstat(receiptPath);
	if (!stat.isFile() || stat.nlink > 1 || stat.size > 1024 * 1024) throw new Error("Sandbox receipt is unsafe.");
	let parsed: unknown;
	try { parsed = JSON.parse((await fs.readFile(receiptPath, "utf8"))); }
	catch (cause) { throw new Error(`Sandbox receipt is invalid: ${textError(cause)}`); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Sandbox receipt is invalid.");
	return parsed as Record<string, unknown>;
}

export async function inspectSandboxRun(policy: SandboxPolicy, runId: string): Promise<SandboxRunStatus> {
	const validatedPolicy = await validatePolicy(policy);
	const receipt = await readControlledReceipt(validatedPolicy.root, runId);
	const expectedWorkspaceSha256 = workspaceLabel(validatedPolicy.root);
	const expectedContainerName = `pi-sandbox-${runId}`;
	if (receipt.runId !== runId || receipt.workspaceSha256 !== expectedWorkspaceSha256 || (receipt.containerName !== undefined && receipt.containerName !== expectedContainerName)) {
		return { receipt, processState: "unknown", error: "Sandbox receipt does not belong to this workspace/run." };
	}
	const inspected = await runPodman(["container", "inspect", "--format={{json .}}", "--", expectedContainerName], { timeoutMs: 30_000, maxOutput: MAX_CLI_OUTPUT_BYTES });
	if (inspected.code !== 0) {
		const detail = textError(inspected.stderr || inspected.stdout || "Podman could not inspect the sandbox container.");
		const noContainer = /no such container|no container with name|container .*not found|does not exist/i.test(detail);
		const stopped = noContainer && receipt.state !== "running" && receipt.containerStopped === true;
		return { receipt, processState: stopped ? "stopped" : "unknown", error: detail };
	}
	let detail: any;
	try {
		const parsed = JSON.parse(inspected.stdout);
		detail = Array.isArray(parsed) ? parsed[0] : parsed;
	} catch (cause) {
		return { receipt, processState: "unknown", error: `Podman returned invalid container status: ${textError(cause)}` };
	}
	const labels = detail?.Config?.Labels;
	if (!labels || labels["run-id"] !== runId || labels["workspace-sha256"] !== expectedWorkspaceSha256) {
		return { receipt, processState: "unknown", error: "Sandbox container labels do not match this workspace/run." };
	}
	const running = detail?.State?.Running === true || detail?.State?.Status === "running";
	return { receipt, processState: running ? "running" : "stopped" };
}

function createExportAuthorizer(root: string) {
	const policy: ResolvedWorkspace = { root, access: "read-write", extraReadRoots: [], execution: "disabled" };
	const access = new WorkspaceAccess(policy, root, [getAgentDir(), getPackageDir()]);
	return async (relative: string) => {
		const target = validateSandboxExportPath(root, relative);
		await access.authorize(target, true, true);
		return target;
	};
}

async function normalizedExportRoot(directory: string) {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	if (entries.length === 1 && entries[0].name === "workspace" && entries[0].isDirectory()) return path.join(directory, "workspace");
	return directory;
}

async function planExport(root: string, baseline: Map<string, SnapshotFile>, outputRoot: string, signal?: AbortSignal): Promise<ExportPlan> {
	const scanBudget = { bytes: 0, entries: 0 };
	const finalFiles = await scanDirectory(outputRoot, scanBudget, signal);
	const authorizeExport = createExportAuthorizer(root);
	const all = new Set([...baseline.keys(), ...finalFiles.keys()]);
	const conflicts: string[] = [];
	for (const relative of [...all].sort()) {
		if (signal?.aborted) throw new CliAbortError("cancelled");
		await authorizeExport(relative);
		const current = await inspectHostPath(root, relative);
		const original = baseline.get(relative);
		if (current.kind === "unsafe" || current.kind === "directory" || (original && (current.kind !== "file" || current.sha256 !== original.sha256)) || (!original && current.kind !== "absent")) conflicts.push(relative);
	}
	if (conflicts.length) throw new WorkspaceConflictError(`Workspace changed while sandbox ran: ${conflicts.slice(0, 16).join(", ")}`);
	const writes: SnapshotFile[] = [];
	const deletes: string[] = [];
	for (const [relative, file] of finalFiles) {
		const original = baseline.get(relative);
		if (!original || original.sha256 !== file.sha256) writes.push(file);
	}
	for (const relative of baseline.keys()) if (!finalFiles.has(relative)) deletes.push(relative);
	return { writes, deletes, artifacts: [...writes.map(file => absoluteRelative(root, file.relative)), ...deletes.map(relative => absoluteRelative(root, relative))].sort() };
}

async function ensureParentDirectories(root: string, relative: string) {
	const parts = relative.split("/");
	parts.pop();
	let current = root;
	for (const part of parts) {
		current = path.join(current, part);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new WorkspaceConflictError(`Unsafe output parent: ${path.relative(root, current)}`);
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
			await fs.mkdir(current, { mode: 0o755 });
		}
	}
}

async function readRegularFileBytes(filePath: string) {
	const handle = await fs.open(filePath, "r");
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink > 1 || before.size > MAX_FILE_BYTES) throw new Error("Unsafe sandbox output file.");
		const chunks: Buffer[] = [];
		const buffer = Buffer.alloc(64 * 1024);
		let bytes = 0;
		while (true) {
			const read = await handle.read(buffer, 0, buffer.length, null);
			if (!read.bytesRead) break;
			bytes += read.bytesRead;
			if (bytes > MAX_FILE_BYTES) throw new Error("Sandbox output exceeds its byte limit during export.");
			chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
		}
		const after = await handle.stat();
		if (!after.isFile() || after.nlink > 1 || after.size !== before.size || bytes !== before.size) throw new WorkspaceConflictError("Sandbox output changed while it was being exported.");
		return Buffer.concat(chunks, bytes);
	} finally { await handle.close(); }
}

async function readStageFile(file: SnapshotFile) {
	if (!file.stagePath) throw new Error("Sandbox output file has no staging path.");
	const stat = await fs.lstat(file.stagePath);
	if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_FILE_BYTES) throw new Error("Unsafe sandbox output file.");
	return readRegularFileBytes(file.stagePath);
}

async function applyExport(root: string, baseline: Map<string, SnapshotFile>, plan: ExportPlan) {
	const authorizeExport = createExportAuthorizer(root);
	for (const file of plan.writes) {
		await authorizeExport(file.relative);
		const current = await inspectHostPath(root, file.relative);
		const original = baseline.get(file.relative);
		if (current.kind === "unsafe" || current.kind === "directory" || (original && (current.kind !== "file" || current.sha256 !== original.sha256)) || (!original && current.kind !== "absent")) throw new WorkspaceConflictError(`Workspace changed before exporting: ${file.relative}`);
		await ensureParentDirectories(root, file.relative);
		const target = absoluteRelative(root, file.relative);
		const temporary = `${target}.${randomUUID()}.sandbox.tmp`;
		const content = await readStageFile(file);
		let targetMode = file.mode;
		if (original) {
			const currentStat = await fs.stat(target);
			targetMode = currentStat.mode & 0o777;
		}
		try {
			await fs.writeFile(temporary, content, { mode: targetMode, flag: "wx" });
			try { await fs.rename(temporary, target); }
			catch (cause) {
				if (!((cause as NodeJS.ErrnoException).code === "EEXIST" || (cause as NodeJS.ErrnoException).code === "EPERM" || (cause as NodeJS.ErrnoException).code === "ENOTEMPTY")) throw cause;
				await fs.rm(target, { force: true });
				await fs.rename(temporary, target);
			}
			await fs.chmod(target, targetMode).catch(() => undefined);
		} finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
	}
	for (const relative of plan.deletes) {
		await authorizeExport(relative);
		const original = baseline.get(relative)!;
		const current = await inspectHostPath(root, relative);
		if (current.kind !== "file" || current.sha256 !== original.sha256) throw new WorkspaceConflictError(`Workspace changed before deleting: ${relative}`);
		await fs.unlink(absoluteRelative(root, relative));
	}
}

function makeReceipt(runId: string, access: SandboxPolicy["access"], state: string, startedAt: string, workspaceSha256: string) {
	return { runId, state, access, startedAt, workspaceSha256, pid: process.pid, containerStopped: true } as Record<string, unknown>;
}

async function saveReceipt(receiptPath: string, receipt: Record<string, unknown>, replace = false) {
	const content = JSON.stringify(receipt, null, 2) + "\n";
	if (replace) await atomicWrite(receiptPath, content);
	else await fs.writeFile(receiptPath, content, { encoding: "utf8", mode: 0o600 });
}

export async function runSandbox(policy: SandboxPolicy, args: SandboxArgs, signal?: AbortSignal): Promise<SandboxResult> {
	const config = validateConfig(policy?.sandbox as SandboxConfig);
	const validatedPolicy = await validatePolicy(policy);
	if (!args || typeof args !== "object") throw new Error("Sandbox arguments are required.");
	checkString(args.command, "sandbox command", COMMAND_MAX_BYTES, true);
	if (args?.cwd !== undefined) checkString(args.cwd, "sandbox cwd", 32 * 1024);
	if (args.timeoutSeconds !== undefined && (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds < 1 || args.timeoutSeconds > config.maxSeconds)) throw new Error(`Invalid sandbox timeoutSeconds; must be between 1 and maxSeconds (${config.maxSeconds}).`);
	const cwd = args.cwd === undefined ? validatedPolicy.root : resolveInput(args.cwd, validatedPolicy.root);
	if (!inside(validatedPolicy.root, cwd)) throw new Error("Sandbox cwd must be inside the workspace root.");
	const cwdRelative = path.relative(validatedPolicy.root, cwd);
	if (cwdRelative) {
		const cwdEntry = await inspectHostPath(validatedPolicy.root, cwdRelative.split(path.sep).join("/"));
		if (cwdEntry.kind !== "directory") throw new Error("Sandbox cwd must be an existing directory without links.");
	}
	const runId = randomUUID();
	if (runId.length > RUN_ID_MAX) throw new Error("Could not allocate a sandbox run ID.");
	// Backend-owned audit exception: receipts/logs are written under the authorized root even for read-only members.
	const runDirectory = await ensureRunDirectory(validatedPolicy.root, runId);
	const receiptPath = path.join(runDirectory, "receipt.json");
	const logPath = path.join(runDirectory, "output.log");
	const startedAt = new Date().toISOString();
	const workspaceSha256 = workspaceLabel(validatedPolicy.root);
	// Create the log before any Podman setup so an abrupt member exit still leaves a recovery file.
	await fs.writeFile(logPath, "", { encoding: "utf8", mode: 0o600 });
	const outputLog = new OutputLog(logPath, MAX_OUTPUT_BYTES);
	const receipt = makeReceipt(runId, policy.access, "running", startedAt, workspaceSha256);
	await saveReceipt(receiptPath, receipt);
	let staging: string | undefined;
	let containerId: string | undefined;
	let containerName: string | undefined;
	let containerCreated = false;
	let containerStopped: boolean | "unknown" = true;
	let output = "";
	let exitCode: number | null = null;
	let cancelled = Boolean(signal?.aborted);
	let timedOut = false;
	let error: string | undefined;
	let artifactPaths: string[] = [];
	let resultValue: SandboxResult | undefined;
	const setupAbort = new AbortController();
	const onAbort = () => { cancelled = true; setupAbort.abort(); };
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		if (cancelled) throw new CliAbortError("cancelled");
		const probe = await inspectSandbox(config, setupAbort.signal);
		if (!probe.available || !probe.imageId) throw new Error(probe.error || "Podman image is unavailable locally.");
		staging = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sandbox-"));
		await fs.chmod(staging, 0o700).catch(() => undefined);
		const stageWorkspace = path.join(staging, "workspace");
		const stageReference = path.join(staging, "reference");
		const budget = { bytes: 0, entries: 0 };
		const baseline = await snapshotDirectory(validatedPolicy.root, stageWorkspace, policy.access === "read-write", budget, setupAbort.signal);
		for (let index = 0; index < validatedPolicy.extraReadRoots.length; index++) {
			await snapshotDirectory(validatedPolicy.extraReadRoots[index], path.join(stageReference, String(index)), false, budget, setupAbort.signal);
		}
		if (validatedPolicy.extraReadRoots.length) await fs.chmod(stageReference, 0o555);
		containerName = `pi-sandbox-${runId}`;
		containerCreated = true;
		const created = await podmanCall(createArguments(config, probe.imageId, containerName, policy.access === "read-write", runId, workspaceSha256), setupAbort.signal, "Creating sandbox container");
		containerId = parseContainerId(created.stdout);
		containerStopped = false;
		Object.assign(receipt, { containerName, containerId, containerStopped });
		await saveReceipt(receiptPath, receipt, true);
		if (validatedPolicy.extraReadRoots.length) await copyDirectoryToContainer(stageReference, containerName, "/", false, setupAbort.signal);
		if (policy.access === "read-only") await copyDirectoryToContainer(stageWorkspace, containerName, "/", false, setupAbort.signal);
		await podmanCall(["start", containerName], setupAbort.signal, "Starting sandbox container");
		if (policy.access === "read-write") await copyDirectoryToContainer(stageWorkspace, containerName, "/workspace", true, setupAbort.signal);
		const commandController = new AbortController();
		const relayAbort = () => commandController.abort();
		setupAbort.signal.addEventListener("abort", relayAbort, { once: true });
		let timeoutHandle: NodeJS.Timeout | undefined;
		const timeoutSeconds = Math.floor(args.timeoutSeconds ?? config.maxSeconds);
		const containerCwd = cwdRelative ? `/workspace/${cwdRelative.split(path.sep).join("/")}` : "/workspace";
		timeoutHandle = setTimeout(() => { timedOut = true; commandController.abort(); }, timeoutSeconds * 1000);
		try {
			const commandResult = await runPodman(["exec", "--workdir", containerCwd, containerName, "/bin/sh", "-c", args.command], { signal: commandController.signal, timeoutMs: timeoutSeconds * 1000 + 5_000, maxOutput: MAX_OUTPUT_BYTES, onOutput: chunk => outputLog.write(chunk) });
			output = commandResult.stdout + commandResult.stderr;
			exitCode = commandResult.code;
			if (commandResult.truncated) output += "\n[Sandbox output truncated]";
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			setupAbort.signal.removeEventListener("abort", relayAbort);
		}
		await outputLog.flush();
		if (timedOut) throw new CliAbortError("timeout");
		if (cancelled) throw new CliAbortError("cancelled");
		if (policy.access === "read-write") {
			const exported = path.join(staging, "export");
			await copyDirectoryFromContainer(containerName, "/workspace", exported, setupAbort.signal);
			const exportRoot = await normalizedExportRoot(exported);
			const plan = await planExport(validatedPolicy.root, baseline, exportRoot, setupAbort.signal);
			await applyExport(validatedPolicy.root, baseline, plan);
			artifactPaths = plan.artifacts;
		}
	} catch (cause) {
		if (cause instanceof CliAbortError) {
			if (cause.stdout || cause.stderr) {
				output = cause.stdout + cause.stderr;
				if (cause.truncated) output += "\n[Sandbox output truncated]";
			}
			if (cause.reason === "timeout" || timedOut) timedOut = true;
			else cancelled = true;
		} else error = textError(cause);
	} finally {
		output = limitOutput(output, MAX_OUTPUT_BYTES);
		await outputLog.flush();
		if (containerName && containerCreated) {
			try {
				await podmanCall(["rm", "--force", containerName], undefined, "Removing sandbox container");
				containerStopped = true;
			} catch (cause) {
				containerStopped = "unknown";
				if (!error) error = textError(cause);
			}
		}
		if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
		signal?.removeEventListener("abort", onAbort);
		const ok = !error && !cancelled && !timedOut && containerStopped === true && exitCode === 0;
		const state = cancelled ? "cancelled" : timedOut ? "timed-out" : error || exitCode !== 0 ? "failed" : "completed";
		Object.assign(receipt, { state, finishedAt: new Date().toISOString(), ok, exitCode, cancelled, timedOut, containerId, containerStopped, artifactPaths, error });
		await saveReceipt(receiptPath, receipt, true).catch(() => undefined);
		resultValue = { runId, ok, exitCode, cancelled, timedOut, output, receiptPath, logPath, artifactPaths, containerStopped, ...(containerId ? { containerId } : {}), ...(error ? { error } : {}) };
	}
	return resultValue!;
}
