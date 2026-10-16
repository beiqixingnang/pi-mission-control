/** Main-session interaction controls. No inference calls and no core monkey patches. */
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export interface StopRequest {
	reason: string;
	pending: Promise<unknown>[];
}
export default function (pi: ExtensionAPI) {
	if (process.env.PI_TEAM_MEMBER || process.env.PI_AGENT_WORKSPACE_POLICY) return;
	let ctx: ExtensionContext | undefined;
	let detach: (() => void) | undefined;
	let stopping = false;
	let stopped = false;
	let generation = 0;
	let activeMain = false;
	const held: Array<{text:string;images?:ImageContent[]}> = [];
	function flushHeld(){
		if(!ctx || stopping || !ctx.isIdle() || !held.length)return;
		const messages=held.splice(0);
		pi.sendUserMessage([{type:"text",text:messages.map(message=>message.text).join("\n\n")},...messages.flatMap(message=>message.images??[])],{expandPromptTemplates:false});
	}
	const liveMembers=new Set<string>();
	const jobs = new Set<string>();
	const runs = new Set<string>();

	function status(text: string) { if (ctx?.mode === "tui") ctx.ui.setStatus("run-control", text); }
	function stop(reason: string) {
		if (!ctx || stopping) return;
		stopping = true; stopped = true;
		const expected = generation;
		status("正在全局停止…");
		const request: StopRequest = { reason, pending: [] };
		// Observers synchronously close their wake gates before child aborts settle.
		pi.events.emit("workbench:stop", request);
		ctx.abort(); // TUI's abort also restores queued user input to the editor.
		void Promise.allSettled(request.pending).then(() => {
			if (expected !== generation) return;
			stopping = false;
			status(ctx?.isIdle() ? "已停止 · Enter 发送新指令" : "成员已停止 · 正在结束主请求，Enter 可插话");
			flushHeld();
		});
	}
	pi.on("session_start", (_event, context) => {
		generation++;ctx = context;stopping = false;stopped = false;activeMain = false;held.length=0;liveMembers.clear();jobs.clear();runs.clear();detach?.();
		if (context.mode !== "tui") return;
		status("Enter 插话 · Ctrl+Q 追加 · Esc 全局停止");
		detach = context.ui.onTerminalInput(data => {
			if (!matchesKey(data, "escape")) return;
			if (!activeMain && context.isIdle() && !jobs.size && !runs.size && !liveMembers.size && !stopping) return;
			stop("用户按 Esc 全局停止");
			return { consume: true };
		});
	});
	pi.on("session_shutdown", () => { generation++;detach?.();detach=undefined;ctx=undefined;held.length=0;liveMembers.clear();jobs.clear();runs.clear(); });
	pi.on("session_tree", (_event, context) => { generation++;ctx=context;stopping=false;stopped=false;held.length=0;liveMembers.clear();jobs.clear();runs.clear(); });
	pi.on("before_agent_start", (_event, context) => { ctx=context;activeMain=true;stopped=false;status("运行中 · Enter 插话 · Ctrl+Q 追加 · Esc 全局停止"); });
	pi.on("agent_start", (_event, context) => { ctx=context;activeMain=true; });
	pi.on("agent_settled", (_event, context) => {
		ctx=context;activeMain=false;
		status(stopped ? "已停止 · Enter 发送新指令" : "Enter 发送 · Esc 停止后台成员");
		flushHeld();
	});
	pi.on("input", (event, context) => {
		ctx=context;
		if(event.source==="interactive" && stopped && (!context.isIdle() || stopping) && event.streamingBehavior!=="followUp" && !event.text.startsWith("/")){
			held.push({text:event.text,images:event.images});status("正在结束旧回合 · 新指令已保留，停止完成后立即发送");return {action:"handled" as const};
		}
		if (event.source !== "interactive" || !event.streamingBehavior) return;
		status(event.streamingBehavior === "followUp" ? "已追加到任务结束后 · Esc 全局停止" : "已插话：当前响应/工具结束后优先处理 · Esc 立即停止");
	});
	pi.events.on("agent-monitor:update",data=>{const entry=data as {id?:string;kind?:string;status?:string};if(entry?.kind!=="team"||!entry.id)return;if(entry.status==="working"||entry.status==="starting")liveMembers.add(entry.id);else liveMembers.delete(entry.id);});
	pi.events.on("agent-monitor:remove",data=>{const id=(data as {id?:string})?.id;if(id)liveMembers.delete(id);});
	pi.events.on("team:job-start", data => { const id=(data as {id?:string})?.id;if(id)jobs.add(id); });
	pi.events.on("team:job-end", data => { const id=(data as {id?:string})?.id;if(id)jobs.delete(id); });
	pi.events.on("subagent:run-start", data => { const id=(data as {id?:string})?.id;if(id)runs.add(id); });
	pi.events.on("subagent:run-end", data => { const id=(data as {id?:string})?.id;if(id)runs.delete(id); });
	pi.registerCommand("stop", { description:"Stop the main run and all member tasks; retain team identity/history and suspend automatic wakeups.", handler:async (_args,context) => {ctx=context;stop("用户执行 /stop");} });
}
