/** Workspace relocation commands; AI execution requires a user-created one-use grant. */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { planMigration, prepareMigration, rollbackMigration, writeJournal, type Action, type Plan, type PreparedMigration } from "./migration.ts";

const result = (text: string, details: unknown = undefined, isError = false) => ({ content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) });
interface Grant { id: string; plan: Plan; sessionId: string; expiresAt: number; ctx: ExtensionCommandContext; }
export default function (pi: ExtensionAPI) {
	if (process.env.PI_TEAM_MEMBER || process.env.PI_AGENT_WORKSPACE_POLICY) return;
	let grant: Grant | undefined;
	let pending: Grant | undefined;
	let running = false;
	let dead = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let internalStop = false;
	function clear() { grant = undefined; pending = undefined; if (timer) clearTimeout(timer); timer = undefined; }
	function status(ctx: ExtensionContext) {
		if (grant && Date.now() >= grant.expiresAt) grant = undefined;
		return { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), busy: running || !!pending,
			authorization: grant ? { id: grant.id, ...grant.plan, expiresAt: grant.expiresAt } : null };
	}
	function suspendAutomation() {
		const request = { reason: "Workspace migration", pending: [] as Promise<unknown>[] };
		internalStop = true;
		try { pi.events.emit("workbench:stop", request); }
		finally { internalStop = false; }
		return Promise.all(request.pending);
	}
	async function resumeTeam() {
		const request = { pending: [] as Promise<unknown>[] };
		pi.events.emit("project:resume", request);
		await Promise.all(request.pending);
	}
	async function migrate(plan: Plan, ctx: ExtensionCommandContext) {
		if (running) throw new Error("A workspace migration is already running.");
		if (!ctx.sessionManager.getSessionFile()) throw new Error("Workspace migration requires a persistent session; --no-session is not supported.");
		if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Stop the main run and clear queued input before changing workspace.");
		// Revalidate after authorization; the source or destination may have changed.
		const fresh = planMigration(plan.action, plan.target, ctx.cwd);
		if (fresh.source !== plan.source || fresh.target !== plan.target) throw new Error("The workspace has changed since authorization. Authorize the new operation again.");
		running = true;
		let migration: PreparedMigration | undefined;
		let switchAttempted = false;
		const notices = ctx.ui;
		try {
			await suspendAutomation();
			const request = { pending: [] as Promise<unknown>[], childFiles: {} as Record<string, string>, emptyChildren: [] as string[] };
			pi.events.emit("project:prepare", request);
			await Promise.all(request.pending);
			migration = prepareMigration(fresh, ctx.sessionManager, request.childFiles, request.emptyChildren);
			process.chdir(fresh.target);
			switchAttempted = true;
			const changed = await ctx.switchSession(migration.sessionFile, { withSession: async next => {
				// Only the replacement context is legal after session invalidation.
				next.ui.notify(`Workspace: ${fresh.target}\nConversation retained. Use pi -r from this directory after restarting. Goal and supervisor remain paused.`, "info");
			} });
			if (changed.cancelled) {
				rollbackMigration(migration);
				switchAttempted = false;
				await resumeTeam();
				writeJournal(migration, "cancelled");
				notices.notify("Session switch was cancelled; the directory rename was rolled back.", "warning");
				return;
			}
			writeJournal(migration, "completed");
		} catch (error) {
			if (!switchAttempted) {
				if (migration) rollbackMigration(migration);
				await resumeTeam();
			} else if (migration) {
				// A host may already have disposed the old runtime. Keep the target and backup recoverable.
				writeJournal(migration, "switch-failed", String(error));
				console.error(`Workspace recovery: cd ${JSON.stringify(fresh.target)} then pi --session ${JSON.stringify(migration.sessionFile)}. Journal: ${migration.journal}`);
			}
			try { notices.notify(String((error as Error).message ?? error), "error"); } catch { /* Old runtime may have been invalidated. */ }
		} finally { running = false; }
	}
	function schedule() {
		if (!pending || timer || dead) return;
		timer = setTimeout(() => {
			timer = undefined;
			const operation = pending;
			if (!operation || dead) return;
			pending = undefined;
			try {
				if (Date.now() >= operation.expiresAt || operation.ctx.sessionManager.getSessionId() !== operation.sessionId) throw new Error("Workspace authorization expired or the session changed.");
				void migrate(operation.plan, operation.ctx).catch(error => {
					try { operation.ctx.ui.notify(String(error), "error"); }
					catch { console.error(`Workspace migration failed: ${String(error)}`); }
				});
			} catch (error) { try { operation.ctx.ui.notify(String(error), "error"); } catch {} }
		}, 0);
		timer.unref?.();
	}
	pi.on("session_start", () => { dead = false; clear(); });
	pi.on("session_tree", () => { clear(); });
	pi.on("session_shutdown", () => { dead = true; clear(); });
	pi.events.on("workbench:stop", () => { if (!internalStop) clear(); });
	pi.on("agent_settled", event => { if (event.aborted) clear(); else schedule(); });
	pi.registerTool({
		name: "project_status", label: "Project: status", description: "Show current workspace and any one-use user authorization for a workspace rename or switch.", parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) { const details = status(ctx); return result(JSON.stringify(details, null, 2), details); },
	});
	pi.registerTool({
		name: "project_apply", label: "Project: apply authorized change", executionMode: "sequential", exposure: "model-only",
		description: "Apply exactly the one workspace rename/switch authorized by the user with /project allow. Disabled by default. Ends this run; the workspace changes after settlement.",
		promptGuidelines: ["Workspace changes are manual by default. Never use bash to bypass this workflow. Ask the user to run /project allow rename <new-name> or /project allow switch <path> before project_apply. Authorization is single-use and expires after ten minutes.", "Call project_apply alone; do not dispatch more tools after it. It changes the workspace only after this run settles."],
		parameters: Type.Object({ authorizationId: Type.String({ minLength: 1 }) }),
		async execute(_id, params, signal, _update, ctx) {
			const allowed = grant;
			if (!allowed || allowed.id !== params.authorizationId || allowed.sessionId !== ctx.sessionManager.getSessionId() || Date.now() >= allowed.expiresAt) return result("No matching user authorization. Use /project allow rename <name> or /project allow switch <path> first.", undefined, true);
			if (pending || running || signal?.aborted) return result("Migration is pending, running, or interrupted.", undefined, true);
			grant = undefined;
			pending = allowed;
			// Suppress Goal continuation before this tool returns, without aborting its own result.
			try {
				await suspendAutomation();
				if (signal?.aborted || pending !== allowed) { pending = undefined; return result("Workspace change cancelled before settlement.", undefined, true); }
			} catch (error) { pending = undefined; throw error; }
			return { ...result(`Authorized ${allowed.plan.action} queued: ${allowed.plan.target}. The run will end before changing workspace.`, { ...allowed.plan, queued: true }), terminate: true };
		},
	});
	pi.registerCommand("project", {
		description: "Workspace: status | rename <new-name/path> | switch <path> | allow rename/switch <target> | revoke. Manual by default; AI grants are single-use.",
		handler: async (args, ctx) => {
			try {
				const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
				const command = match?.[1] ?? "status";
				let target = (match?.[2] ?? "").trim();
				if (command === "status") { ctx.ui.notify(JSON.stringify(status(ctx), null, 2), "info"); return; }
				if (command === "revoke") { clear(); ctx.ui.notify("Workspace authorization revoked.", "info"); return; }
				if (running || pending) throw new Error("A workspace change is already pending or running.");
				let action: string = command;
				if (command === "allow") { const parts = /^(rename|switch)\s+([\s\S]+)$/.exec(target); if (!parts) throw new Error("Usage: /project allow rename <name> | /project allow switch <path>"); action = parts[1]; target = parts[2].trim(); }
				if (action !== "rename" && action !== "switch") throw new Error("Usage: /project status|rename|switch|allow|revoke");
				if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) target = target.slice(1, -1);
				const plan = planMigration(action as Action, target, ctx.cwd);
				if (command === "allow") {
					grant = { id: randomUUID(), plan, ctx, sessionId: ctx.sessionManager.getSessionId(), expiresAt: Date.now() + 600_000 };
					pi.sendMessage({ customType: "project-authorization", content: `The user authorized ONE workspace ${action}: ${plan.source} -> ${plan.target}. To apply it, call project_apply alone with authorizationId ${grant.id}. Expires in ten minutes.`, display: true }, { triggerTurn: false });
					ctx.ui.notify("One-use workspace authorization granted for ten minutes. Tell the AI to proceed, or /project revoke.", "info");
					return;
				}
				grant = undefined;
				if (!ctx.isIdle()) {
					await suspendAutomation();
					ctx.abort();
					await ctx.waitForIdle();
				}
				await migrate(plan, ctx);
			} catch (error) { ctx.ui.notify(String((error as Error).message ?? error), "error"); }
		},
	});
}
