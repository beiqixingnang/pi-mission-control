/** A local-only, three-row activity widget. No model messages or inference calls. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanText, isTerminal, renderMonitor, type AgentSnapshot, type AgentStatus } from "./render.ts";

const KEY = "agent-monitor";
const statuses = new Set<AgentStatus>(["starting", "working", "idle", "done", "error", "stopped"]);
const MAX_ENTRIES = 100;

export default function (pi: ExtensionAPI) {
	const entries = new Map<string, AgentSnapshot>();
	let ctx: ExtensionContext | undefined;
	let enabled = true;
	let mounted = false;
	let requestRender: (() => void) | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let redraw: ReturnType<typeof setTimeout> | undefined;

	function stopTimers() {
		if (ticker) clearInterval(ticker);
		if (redraw) clearTimeout(redraw);
		ticker = undefined;
		redraw = undefined;
	}
	function detach() {
		stopTimers();
		if (mounted && ctx?.mode === "tui") ctx.ui.setWidget(KEY, undefined);
		mounted = false;
		requestRender = undefined;
	}
	function prune() {
		const now = Date.now();
		for (const [id, entry] of entries) if (isTerminal(entry) && now - (entry.finishedAt ?? entry.updatedAt) >= 10000) entries.delete(id);
		// Bound history without dropping live team members or running subagents.
		if (entries.size > MAX_ENTRIES) {
			for (const [id, entry] of entries) {
				if (isTerminal(entry)) entries.delete(id);
				if (entries.size <= MAX_ENTRIES) break;
			}
		}
	}
	function refresh() {
		prune();
		if (!enabled || !entries.size || ctx?.mode !== "tui") { detach(); return; }
		if (!mounted) {
			mounted = true;
			ctx.ui.setWidget(KEY, tui => {
				requestRender = () => tui.requestRender();
				return {
					render: (width: number) => ctx ? renderMonitor([...entries.values()], width, Date.now(), (color, text) => ctx!.ui.theme.fg(color, text)) : [],
					invalidate() {},
					dispose() { requestRender = undefined; },
				};
			}, { placement: "aboveEditor" });
		}
		if (!ticker) {
			ticker = setInterval(refresh, 1000);
			ticker.unref?.();
		}
		requestRender?.();
	}
	function schedule() {
		if (!enabled || ctx?.mode !== "tui") return;
		if (!mounted) { refresh(); return; }
		if (redraw) return;
		redraw = setTimeout(() => { redraw = undefined; refresh(); }, 120);
		redraw.unref?.();
	}

	pi.events.on("agent-monitor:update", data => {
		if (!ctx || !data || typeof data !== "object") return;
		const update = data as Partial<AgentSnapshot>;
		if (typeof update.id !== "string" || !update.id || (update.kind !== "team" && update.kind !== "subagent") || !statuses.has(update.status!)) return;
		const now = Date.now();
		const previous = entries.get(update.id);
		const entry: AgentSnapshot = {
			id: update.id, kind: update.kind,
			name: cleanText(typeof update.name === "string" ? update.name : previous?.name || update.id, 64),
			status: update.status!, model: typeof update.model === "string" ? cleanText(update.model, 160) : previous?.model,
			workspace: typeof update.workspace === "string" ? cleanText(update.workspace, 500) : previous?.workspace,
			access: typeof update.access === "string" ? cleanText(update.access, 24) : previous?.access,
			activity: typeof update.activity === "string" ? cleanText(update.activity, 160) : ["done", "stopped", "error"].includes(update.status!) ? "" : previous?.activity,
			output: typeof update.output === "string" ? cleanText(update.output, 1000) : previous?.output,
			alive: typeof update.alive === "boolean" ? update.alive : previous?.alive,
			startedAt: typeof update.startedAt === "number" && Number.isFinite(update.startedAt) ? update.startedAt : previous?.startedAt ?? now,
			updatedAt: now,
		};
		if (isTerminal(entry)) entry.finishedAt = previous?.finishedAt ?? now;
		entries.set(entry.id, entry);
		prune();
		schedule();
	});
	pi.events.on("agent-monitor:remove", data => {
		const id = (data as { id?: unknown } | undefined)?.id;
		if (typeof id === "string") entries.delete(id);
		schedule();
	});
	pi.on("session_start", (_event, context) => {
		detach(); entries.clear(); ctx = context; enabled = true;
	});
	pi.on("session_tree", () => { entries.clear(); detach(); });
	pi.on("session_shutdown", () => { detach(); entries.clear(); ctx = undefined; });

	pi.registerCommand("agents", {
		description: "Compact agent monitor: on|off|status. Shows up to three rows above the editor without model calls.",
		handler: async (args, context) => {
			ctx = context;
			const command = args.trim() || "status";
			if (command === "on") { enabled = true; refresh(); }
			else if (command === "off") { enabled = false; detach(); }
			else if (command !== "status") { context.ui.notify("用法：/agents on|off|status", "warning"); return; }
			prune();
			const details = [...entries.values()].map(entry => `${entry.kind === "team" ? "团队" : "子任务"} ${entry.name}: ${entry.status}${entry.model ? ` (${entry.model})` : ""}${entry.workspace ? `\n  工作区：${entry.workspace} (${entry.access || "受限"})` : ""}${entry.activity ? ` · ${entry.activity}` : ""}${entry.output ? `\n  ${cleanText(entry.output, 240)}` : ""}`);
			context.ui.notify([`智能体状态区：${enabled ? "开启" : "隐藏"}，当前 ${entries.size} 项。`, ...details].join("\n"), "info");
		},
	});
}
