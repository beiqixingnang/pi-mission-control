import { clock } from "./history.ts";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

export type AgentStatus = "starting" | "working" | "idle" | "done" | "error" | "stopped";
export interface AgentSnapshot {
	id: string;
	kind: "team" | "subagent";
	name: string;
	status: AgentStatus;
	model?: string;
	workspace?: string;
	access?: string;
	activity?: string;
	output?: string;
	alive?: boolean;
	startedAt: number;
	updatedAt: number;
	lastMessageAt?: number;
	finishedAt?: number;
}
export const isWorking = (entry: AgentSnapshot) => entry.status === "starting" || entry.status === "working";
export const isTerminal = (entry: AgentSnapshot) => entry.status === "done" || entry.status === "stopped" || (entry.status === "error" && entry.alive === false);

/** Model text must never carry terminal commands into a widget. */
export function cleanText(value: string, max = 1000): string {
	const plain = stripTerminalSequences(value.toWellFormed())
		.replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
		.replace(/\s+/g, " ").trim();
	return Array.from(plain).slice(-max).join("");
}
const age = (ms: number) => {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${Math.floor(seconds / 3600)}h${Math.floor(seconds / 60) % 60}m`;
};
const priority = (entry: AgentSnapshot) => isWorking(entry) ? 0 : entry.status === "error" ? 1 : entry.status === "idle" ? 2 : 3;
const labels: Record<AgentStatus, string> = { starting: "启动中", working: "执行中", idle: "空闲", done: "完成", error: "失败", stopped: "已停止" };
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
type Paint = (color: "accent" | "muted" | "success" | "error", text: string) => string;

/** At most three terminal rows, including at narrow widths and with CJK output. */
export function renderMonitor(entries: AgentSnapshot[], width: number, now = Date.now(), paint: Paint = (_color, text) => text): string[] {
	if (width < 1 || !entries.length) return [];
	const sorted = [...entries].sort((a, b) => priority(a) - priority(b) || a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	const count = (status: AgentStatus) => entries.filter(entry => entry.status === status).length;
	const running = entries.filter(isWorking).length;
	const pages = Math.ceil(sorted.length / 2);
	const page = Math.floor(now / 5000) % pages;
	const summary = [`智能体 ${entries.length}`, running ? `运行 ${running}` : "", count("idle") ? `空闲 ${count("idle")}` : "", count("done") ? `完成 ${count("done")}` : "", count("error") ? `异常 ${count("error")}` : "", pages > 1 ? `${page + 1}/${pages}` : ""].filter(Boolean).join(" · ");
	const rows = [truncateToWidth(paint("muted", summary), width)];
	for (const entry of sorted.slice(page * 2, page * 2 + 2)) {
		const working = isWorking(entry);
		const silentFor = now - entry.updatedAt;
		const icon = working ? silentFor >= 15000 ? "…" : frames[Math.floor(now / 1000) % frames.length] : entry.status === "error" ? "!" : entry.status === "idle" ? "○" : entry.status === "stopped" ? "■" : "✓";
		const kind = entry.kind === "team" ? "团队" : "子任务";
		const status = working ? `${labels[entry.status]} ${age(now - entry.startedAt)}` : labels[entry.status];
		const detail = working && silentFor >= 15000 ? `无更新 ${age(silentFor)}` : cleanText(entry.activity || "", 100);
		const rawOutput = entry.output?.trim().split(/\r?\n/).filter(line => line.trim()).at(-1) || "";
		const output = cleanText(rawOutput);
		const location = entry.workspace ? ` · ${entry.access === "read-only" ? "只读" : "可写"}:${cleanText(entry.workspace.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || entry.workspace, 24)}` : "";
		const prefix = `${icon} ${kind} ${cleanText(entry.name, 64)}${location} · ${status} · 消息 ${clock(entry.lastMessageAt,now)}${detail && detail !== labels[entry.status] ? ` · ${detail}` : ""}`;
		rows.push(truncateToWidth(paint(entry.status === "error" ? "error" : working ? "accent" : entry.status === "done" ? "success" : "muted", prefix) + (output ? paint("muted", ` │ ${output}`) : ""), width));
	}
	return rows;
}
