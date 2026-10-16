/** Adaptive local TUI monitor: compact widget, optional Pi 1.2 split layout, read-only histories. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey,wrapTextWithAnsi,truncateToWidth,type TUI } from "@earendil-works/pi-tui";
import { cleanText,isTerminal,renderMonitor,type AgentSnapshot,type AgentStatus } from "./render.ts";
import { installSidebar,type SidebarCleanup } from "./layout.ts";
import { clock,boxed,visibleHistory,linesForHistory,type HistoryItem } from "./history.ts";

const KEY="agent-monitor";
const statuses=new Set<AgentStatus>(["starting","working","idle","done","error","stopped"]);
export default function(pi:ExtensionAPI){
	const entries=new Map<string,AgentSnapshot>();
	const histories=new Map<string,HistoryItem[]>();
	const historyNames=new Map<string,string>();
	let ctx:ExtensionContext|undefined,tui:TUI|undefined;
	let enabled=true,mounted=false,mode:"auto"|"compact"|"wide"="auto";
	let requestRender:(()=>void)|undefined,restoreLayout:SidebarCleanup|undefined;
	let ticker:ReturnType<typeof setInterval>|undefined,redraw:ReturnType<typeof setTimeout>|undefined;
	let mainMessageAt:number|undefined,mainActivityAt:number|undefined,mainEndedAt:number|undefined;
	let selected=0,viewerDone:(()=>void)|undefined,viewerRefresh:(()=>void)|undefined;
	let lifecycle=0,openingViewer=false;
	let supervisor:{enabled?:boolean;intervalMs?:number;nextCheckAt?:number;checking?:boolean}|undefined;
	let detachKeys:(()=>void)|undefined;
	const wide=(width:number,height:number)=>enabled&&mode!=="compact"&&width>=(mode==="wide"?120:140)&&height>=24;
	const wideNow=()=>!!restoreLayout?.active()&&!!tui&&tui.mode==="fullscreen"&&wide(tui.terminal.columns,tui.terminal.rows);
	const goal=()=>{
		let value:any;
		for(const entry of ctx?.sessionManager?.getBranch?.()??[])if(entry.type==="custom"&&entry.customType==="goal-state")value=entry.data;
		return value;
	};
	function stopTimers(){if(ticker)clearInterval(ticker);if(redraw)clearTimeout(redraw);ticker=undefined;redraw=undefined;}
	function detach(){lifecycle++;openingViewer=false;stopTimers();restoreLayout?.();restoreLayout=undefined;detachKeys?.();detachKeys=undefined;viewerDone?.();viewerDone=undefined;
		if(mounted&&ctx?.mode==="tui")ctx.ui.setWidget(KEY,undefined);mounted=false;requestRender=undefined;tui=undefined;
	}
	function prune(){
		const now=Date.now();
		for(const [id,entry]of entries)if(isTerminal(entry)&&now-(entry.finishedAt??entry.updatedAt)>=10000)entries.delete(id);
		if(entries.size>100)for(const [id,entry]of entries){if(isTerminal(entry))entries.delete(id);if(entries.size<=100)break;}
		if(histories.size>100)for(const id of histories.keys()){if(!entries.has(id))histories.delete(id);if(histories.size<=100)break;}
	}
	function sidebar(width:number):string[]{
		const height=Math.max(4,tui?.terminal.rows??30),half=Math.floor(height/2),g=goal();
		const upper=[`主AI最后消息 ${clock(mainMessageAt)}`,`最后活动 ${clock(mainActivityAt)}`,`主AI停稳 ${clock(mainEndedAt)}`,"",g?`目标 [${g.status}]`:"尚无目标",...(g?.objective?wrapTextWithAnsi(cleanText(g.objective,2000),Math.max(1,width-4)).slice(0,3):[]),...((g?.criteria??[]).slice(0,2).map((item:string,i:number)=>`${i+1}. ${cleanText(item,150)}`)),"",`定时监督 ${supervisor?.enabled?"开启":"关闭"}`];
		if(supervisor?.enabled){
			upper.push(`周期 ${Math.round((supervisor.intervalMs??0)/1000)}s`);
			upper.push(supervisor.checking?"正在检查":supervisor.nextCheckAt?`下次 ${clock(supervisor.nextCheckAt)} · ${Math.max(0,Math.ceil((supervisor.nextCheckAt-Date.now())/1000))}s`:"等待主模型空闲");
		}
		const list=[...entries.values()];selected=Math.min(selected,Math.max(0,list.length-1));
		const lower=["Alt+J 选择 · Alt+O 查看", "Esc 全局停止 · 查看器 Esc 返回",""];
		const visibleCount=Math.max(1,Math.floor((height-half-5)/3));
		const first=Math.floor(selected/visibleCount)*visibleCount;
		for (const [offset,entry]of list.slice(first,first+visibleCount).entries()){const index=first+offset;lower.push(`${index===selected?">":" "} ${entry.name} [${entry.status}]`,`  消息 ${clock(entry.lastMessageAt)} · 活动 ${clock(entry.updatedAt)}`,`  ${cleanText(entry.output||entry.activity||"",Math.max(1,width-6))}`);}
		if(!list.length)lower.push("当前没有成员");
		return [...boxed(upper,width,half," 目标 / 定时 "),...boxed(lower,width,height-half," 智能体 ")];
	}
	function refresh(){
		prune();if(!enabled||ctx?.mode!=="tui"){detach();return;}
		if(!mounted){mounted=true;ctx.ui.setWidget(KEY,host=>{
			tui=host;requestRender=()=>host.requestRender();restoreLayout=installSidebar(host,{render:sidebar,invalidate(){}},wide);
			detachKeys=ctx!.ui.onTerminalInput?.(data=>{
				if(matchesKey(data,"alt+j")){selected=(selected+1)%Math.max(1,entries.size);requestRender?.();return {consume:true};}
				if(matchesKey(data,"alt+o")){void openViewer([...entries.keys()][selected]);return {consume:true};}
			});
			return {render:(width:number)=>{
				if(wideNow())return [];
				const rows=renderMonitor([...entries.values()],width,Date.now(),(color,text)=>ctx!.ui.theme.fg(color,text));
				if(!rows.length&&mainMessageAt)return [truncateToWidth(`主AI最后消息 ${clock(mainMessageAt)} · 最后活动 ${clock(mainActivityAt)}`,width)];
				if(rows.length&&mainMessageAt)rows[0]=truncateToWidth(rows[0]+` · 主AI ${clock(mainMessageAt)}`,width);
				return rows;
			},invalidate(){},dispose(){requestRender=undefined;}};
		},{placement:"aboveEditor"});}
		if(restoreLayout&&!restoreLayout.active()){restoreLayout();restoreLayout=undefined;}
		if(tui&&!restoreLayout)restoreLayout=installSidebar(tui,{render:sidebar,invalidate(){}},wide);
		if(!ticker){ticker=setInterval(refresh,1000);ticker.unref?.();}
		requestRender?.();viewerRefresh?.();
	}
	function schedule(){if(!enabled||ctx?.mode!=="tui")return;if(!mounted){refresh();return;}if(redraw)return;redraw=setTimeout(()=>{redraw=undefined;refresh();},120);redraw.unref?.();}
	async function openViewer(id?:string){
		if(!ctx||ctx.mode!=="tui"||viewerDone||openingViewer||!id)return;
		const expected=lifecycle;const context=ctx;openingViewer=true;
		const entry=entries.get(id),query:{id:string;promise?:Promise<unknown[]>}={id};
		pi.events.emit("agent-monitor:history",query);
		if(query.promise){try{const messages=await query.promise;if(expected!==lifecycle)return;histories.set(id,visibleHistory(messages));}catch(error){if(expected===lifecycle)context.ui.notify(`无法读取成员历史：${String(error)}`,"warning");}}
		if(expected!==lifecycle)return;
		openingViewer=false;
		let scroll=0,follow=true;
		try{await context.ui.custom<void>((host,_theme,_keys,done)=>{
			viewerDone=()=>done();viewerRefresh=()=>host.requestRender();
			return {render:(width:number)=>{
				const height=Math.max(6,Math.floor(host.terminal.rows*.85)),inner=Math.max(1,width-4);
				const history=histories.get(id)??[];
				const output=linesForHistory(history,inner);
				const live=entries.get(id)?.output;
				if(live&&!history.at(-1)?.content.endsWith(live))output.push("[实时预览]",...wrapTextWithAnsi(live,inner));
				if(!output.length)output.push("尚无可见消息。已结束的临时子任务可通过 /agents view 名称查看缓存。");
				const count=height-3;if(follow)scroll=Math.max(0,output.length-count);scroll=Math.min(scroll,Math.max(0,output.length-count));
				return boxed(["只读 · ↑↓/PgUp/PgDn 滚动 · End 跟随 · Esc 返回",...output.slice(scroll,scroll+count)],width,height,` ${entry?.name??id} 对话 `);
			},invalidate(){},handleInput(data:string){
				if(matchesKey(data,"escape")){done();return;}
				if(matchesKey(data,"up")){follow=false;scroll=Math.max(0,scroll-1);}
				if(matchesKey(data,"down")){follow=false;scroll++;}
				if(matchesKey(data,"pageUp")){follow=false;scroll=Math.max(0,scroll-10);}
				if(matchesKey(data,"pageDown")){follow=false;scroll+=10;}
				if(matchesKey(data,"end"))follow=true;host.requestRender();
			},dispose(){viewerDone=undefined;viewerRefresh=undefined;}};
		},{overlay:true,overlayOptions:{width:"90%",anchor:"center"}});}finally{viewerDone=undefined;viewerRefresh=undefined;}
	}
	pi.events.on("agent-monitor:update",data=>{
		if(!ctx||!data||typeof data!=="object")return;const update=data as Partial<AgentSnapshot>;
		if(typeof update.id!=="string"||!update.id||(update.kind!=="team"&&update.kind!=="subagent")||!statuses.has(update.status!))return;
		const previous=entries.get(update.id),now=Date.now();
		const entry:AgentSnapshot={id:update.id,kind:update.kind,name:cleanText(update.name??previous?.name??update.id,64),status:update.status!,model:update.model??previous?.model,workspace:update.workspace??previous?.workspace,access:update.access??previous?.access,
			activity:typeof update.activity==="string"?cleanText(update.activity,160):["done","stopped","error"].includes(update.status!)?"":previous?.activity,
			output:typeof update.output==="string"?cleanText(update.output,1000):previous?.output,alive:update.alive??previous?.alive,
			startedAt:update.startedAt??previous?.startedAt??now,updatedAt:update.updatedAt??now,lastMessageAt:update.lastMessageAt??previous?.lastMessageAt};
		if(isTerminal(entry))entry.finishedAt=previous?.finishedAt??now;entries.set(entry.id,entry);historyNames.set(entry.id,entry.name);prune();schedule();
	});
	pi.events.on("agent-monitor:conversation",data=>{
		if(!ctx)return;const value=data as {id:string;messages:unknown[]};if(!value?.id||!Array.isArray(value.messages))return;
		const history=histories.get(value.id)??[];histories.set(value.id,[...history,...visibleHistory(value.messages)].slice(-200));viewerRefresh?.();
	});
	pi.events.on("agent-monitor:remove",data=>{const id=(data as {id?:string})?.id;if(id)entries.delete(id);schedule();});
	pi.events.on("goal:state",schedule);
	pi.events.on("supervisor:state",data=>{supervisor=data as typeof supervisor;schedule();});
	pi.events.on("workbench:stop",()=>{viewerDone?.();});
	pi.on("message_update",event=>{mainActivityAt=Date.now();if(event.assistantMessageEvent.type==="text_delta")mainMessageAt=mainActivityAt;schedule();});
	pi.on("message_end",event=>{if(event.message.role==="assistant"){mainActivityAt=event.message.timestamp??Date.now();if(event.message.content.some(block=>block.type==="text"&&block.text.trim()))mainMessageAt=mainActivityAt;schedule();}});
	pi.on("agent_settled",()=>{mainEndedAt=Date.now();schedule();});
	pi.on("tool_execution_start",()=>{mainActivityAt=Date.now();schedule();});
	pi.on("session_start",(_event,context)=>{
		detach();entries.clear();histories.clear();historyNames.clear();ctx=context;enabled=true;mainMessageAt=undefined;mainActivityAt=undefined;mainEndedAt=undefined;
		for(const entry of context.sessionManager?.getBranch?.()??[])if(entry.type==="message"&&entry.message.role==="assistant"){
			mainActivityAt=entry.message.timestamp;if(entry.message.content.some(block=>block.type==="text"&&block.text.trim()))mainMessageAt=entry.message.timestamp;
		}
		refresh();
	});
	pi.on("session_tree",()=>{entries.clear();histories.clear();historyNames.clear();detach();});
	pi.on("session_shutdown",()=>{detach();entries.clear();histories.clear();historyNames.clear();ctx=undefined;});
	pi.registerCommand("agents",{description:"Agent UI: on|off|status|auto|compact|wide|view <name>. Alt+J selects, Alt+O opens read-only history.",handler:async(args,context)=>{
		ctx=context;const [command="status",...rest]=args.trim().split(/\s+/).filter(Boolean);
		if(command==="view"){const name=rest.join(" ");const id=[...entries].find(([id,entry])=>entry.name===name||id===name)?.[0]??[...histories.keys()].find(id=>id===name||historyNames.get(id)===name);await openViewer(id);return;}
		if(command==="off"){enabled=false;detach();return;}
		if(["auto","compact","wide"].includes(command)){mode=command as typeof mode;enabled=true;refresh();return;}
		if(command==="on"){enabled=true;refresh();return;}
		if(command!=="status"){context.ui.notify("用法 /agents on|off|status|auto|compact|wide|view 名称","warning");return;}
		prune();context.ui.notify([`智能体状态区 ${enabled?"开启":"隐藏"} · ${mode} · 当前 ${entries.size} 项`,...([...entries.values()].map(entry=>`${entry.name} [${entry.status}] · 最后消息 ${clock(entry.lastMessageAt)}${entry.workspace?`\n工作区 ${entry.workspace} (${entry.access})`:""}`))].join("\n"),"info");
	}});
}
