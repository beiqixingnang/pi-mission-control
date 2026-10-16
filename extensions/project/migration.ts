/** Portable session continuations. Historical message bodies are never rewritten. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getAgentDir, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
type ReadonlySessionManager = ExtensionContext["sessionManager"];
import { readRoster, type RosterSnapshot } from "../team/roster.ts";

export type Action = "rename" | "switch";
export interface Plan { action: Action; source: string; target: string; }
export interface PreparedMigration {
	plan: Plan;
	backup: string;
	journal: string;
	sessionFile: string;
	createdFiles: string[];
	processCwd: string;
	renamed: boolean;
}
export function inside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}
export function rebase(value: string, source: string, target: string): string {
	return inside(source, value) ? path.join(target, path.relative(source, value)) : value;
}
export function planMigration(action: Action, target: string, cwd: string): Plan {
	if (!target.trim() || target.includes("\0")) throw new Error("Provide a directory name or path.");
	const source = fs.realpathSync.native(cwd);
	if (source === path.parse(source).root) throw new Error("A filesystem root cannot be moved or used as a migration source.");
	// A bare new name denotes a sibling, not a child of the current directory.
	const base = action === "rename" ? path.dirname(source) : source;
	const requested = path.resolve(base, target);
	let destination: string;
	if (action === "switch") {
		destination = fs.realpathSync.native(requested);
		if (!fs.statSync(destination).isDirectory()) throw new Error("The target must be an existing directory.");
	} else {
		if (fs.existsSync(requested)) throw new Error("The rename destination already exists; it will not be overwritten.");
		const parent = fs.realpathSync.native(path.dirname(requested));
		const name = path.basename(requested);
		if (process.platform === "win32" && (/[<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) throw new Error("Invalid Windows directory name.");
		destination = path.join(parent, name);
		if (inside(source, destination) || inside(destination, source)) throw new Error("The rename target cannot contain or be inside the source directory.");
		// Renaming a package that Pi loads by its old absolute path would break the next reload.
		if (inside(source, path.dirname(fileURLToPath(import.meta.url)))) throw new Error("Install Pi Mission Control outside this workspace before renaming its directory.");
	}
	if (path.relative(source, destination) === "") throw new Error("The target is already the current workspace.");
	return { action, source, target: destination };
}
function continuationDir(directory: string, cwd: string, plan: Plan): string | undefined {
	if (path.relative(directory, SessionManager.create(cwd).getSessionDir()) === "") return undefined;
	return plan.action === "rename" ? rebase(directory, plan.source, plan.target) : directory;
}
export function snapshot(manager: ReadonlySessionManager, file: string): void {
	const header = manager.getHeader();
	if (!header) throw new Error("The current session has no header.");
	fs.writeFileSync(file, [header, ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
}
export function writeJournal(migration: PreparedMigration, state: string, error?: string) {
	const value = { version: 1, ...migration, state, error, updatedAt: new Date().toISOString() };
	const temporary = migration.journal + ".tmp";
	fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(temporary, migration.journal);
}
/** Call only after current work and all child processes have stopped. */
export function prepareMigration(plan: Plan, manager: ReadonlySessionManager, childFiles: Record<string, string>, emptyChildren: string[] = []): PreparedMigration {
	if (!manager.getSessionFile()) throw new Error("An ephemeral --no-session conversation cannot be migrated. Start a persistent session first.");
	const storage = path.join(getAgentDir(), "project-migrations", randomUUID());
	if (inside(plan.source, getAgentDir())) throw new Error("Pi's agent directory must be outside the workspace being migrated.");
	fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
	const migration: PreparedMigration = { plan, backup: path.join(storage, "original.jsonl"), journal: path.join(storage, "migration.json"), sessionFile: "", createdFiles: [], processCwd: process.cwd(), renamed: false };
	snapshot(manager, migration.backup);
	writeJournal(migration, "prepared");
	try {
		if (plan.action === "rename") {
			// Windows holds process.cwd open. Leave it before renaming its ancestor.
			if (inside(plan.source, migration.processCwd)) process.chdir(path.dirname(plan.source));
			if (fs.existsSync(plan.target)) throw new Error("The rename destination now exists; nothing was overwritten.");
			fs.renameSync(plan.source, plan.target);
			migration.renamed = true;
			writeJournal(migration, "renamed");
		}
		const continuation = SessionManager.forkFrom(migration.backup, plan.target, continuationDir(manager.getSessionDir(), plan.source, plan));
		migration.sessionFile = continuation.getSessionFile()!;
		migration.createdFiles.push(migration.sessionFile);
		const leaf = manager.getLeafId();
		if (leaf) continuation.branch(leaf);
		const branch = manager.getBranch();
		const roster = readRoster(branch);
		if (roster) {
			const updated: RosterSnapshot = JSON.parse(JSON.stringify(roster));
			updated.pendingJobs = [];
			for (const member of updated.members) {
				if (plan.action !== "rename") continue; // A different project grants no new member directories.
				const previousCwd = member.cwd;
				member.cwd = rebase(previousCwd, plan.source, plan.target);
				if (member.workspace) {
					member.workspace.root = rebase(member.workspace.root, plan.source, plan.target);
					member.workspace.extraReadRoots = member.workspace.extraReadRoots.map(root => rebase(root, plan.source, plan.target));
				}
				if (previousCwd === member.cwd) continue;
				let sourceFile = childFiles[member.name] ?? SessionManager.findById(previousCwd, member.sessionId!);
				if (sourceFile) sourceFile = rebase(sourceFile, plan.source, plan.target);
				if (sourceFile && fs.existsSync(sourceFile)) {
					const child = SessionManager.forkFrom(sourceFile, member.cwd, continuationDir(path.dirname(sourceFile), previousCwd, plan));
					migration.createdFiles.push(child.getSessionFile()!);
					member.sessionId = child.getSessionId();
				} else if (emptyChildren.includes(member.name)) {
					member.sessionId = randomUUID(); // The running child explicitly confirmed an empty history.
				} else {
					throw new Error(`Cannot locate the saved conversation for ${member.name}; migration stopped to avoid losing member history.`);
				}
			}
			continuation.appendCustomEntry("team-roster", updated);
		}
		const goal = [...branch].reverse().find(entry => entry.type === "custom" && entry.customType === "goal-state") as { data?: any } | undefined;
		if (goal?.data && !["completed", "stopped"].includes(goal.data.status)) {
			continuation.appendCustomEntry("goal-state", { ...goal.data, pending: [], status: "paused", pauseCause: undefined, reason: "Workspace changed. Review paths and verification commands, then explicitly /goal resume." });
		}
		continuation.appendCustomEntry("project-migration", { version: 1, ...plan, backup: migration.backup, previousSessionId: manager.getSessionId() });
		continuation.appendCustomMessageEntry("project-location", `Workspace ${plan.action === "rename" ? "renamed" : "switched"}: ${plan.source} -> ${plan.target}. Resolve future relative paths from ${plan.target}. Historical messages are unchanged. Goal and supervisor are paused; review absolute paths in commands before resuming.`, true);
		writeJournal(migration, "ready");
		return migration;
	} catch (error) {
		rollbackMigration(migration);
		throw error;
	}
}
export function rollbackMigration(migration: PreparedMigration) {
	for (const file of migration.createdFiles) fs.rmSync(file, { force: true });
	if (migration.renamed) {
		if (fs.existsSync(migration.plan.source)) throw new Error(`Cannot roll back: source exists. Recovery journal: ${migration.journal}`);
		if (inside(migration.plan.target, process.cwd())) process.chdir(path.dirname(migration.plan.target));
		fs.renameSync(migration.plan.target, migration.plan.source);
		migration.renamed = false;
	}
	if (fs.existsSync(migration.processCwd)) process.chdir(migration.processCwd);
	writeJournal(migration, "rolled-back");
}
