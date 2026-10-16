import { stripTerminalSequences,wrapTextWithAnsi,truncateToWidth,visibleWidth } from "@earendil-works/pi-tui";
export interface HistoryItem {role:string;content:string;timestamp?:number;}
export function visibleHistory(messages: unknown[]): HistoryItem[]{
	const items:HistoryItem[]=[];
	for(const value of messages.slice(-200)){
		if(!value || typeof value!=="object")continue;
		const message=value as {role?:string;content?:unknown;timestamp?:number;toolName?:string};
		if(!message.role || !["user","assistant","toolResult","custom"].includes(message.role))continue;
		let content="";
		if(typeof message.content==="string")content=message.content;
		else if(Array.isArray(message.content))content=message.content.map(block=>{
			if(block.type==="text"&&typeof block.text==="string")return block.text;
			if(block.type==="toolCall")return `工具 ${block.name}`;
			return ""; // Never expose thinking/signatures or images as terminal data.
		}).filter(Boolean).join("\n");
		if(!content.trim())continue;
		items.push({role:message.role==="toolResult"?`工具结果 ${message.toolName??""}`:message.role,content:stripTerminalSequences(content).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,"").slice(-12000),timestamp:message.timestamp});
	}
	return items;
}
export function clock(timestamp?:number,now=Date.now()){
	if(!timestamp)return "尚无消息";
	const date=new Date(timestamp),current=new Date(now);
	const time=date.toLocaleTimeString('zh-CN',{hour12:false});
	return (date.toDateString()===current.toDateString()?"":`${date.getMonth()+1}/${date.getDate()} `)+time;
}
export interface HistoryPainter { header?: (role:string,text:string,width:number)=>string; body?: (role:string,text:string,width:number)=>string; }
export function linesForHistory(items:HistoryItem[],width:number,painter:HistoryPainter={}):string[]{
	return items.flatMap(item=>{
		const header=`[${item.role}] ${clock(item.timestamp)}`;
		const headerLine=painter.header?.(item.role,header,width)??header;
		const body=item.content.split("\\n").flatMap(line=>wrapTextWithAnsi(line,width)).map(line=>painter.body?.(item.role,line,width)??line);
		return [headerLine,...body,""];
	});
}
export interface BoxStyle { title?: (text:string)=>string; body?: (text:string,filled:boolean)=>string; }
export function boxed(lines:string[],width:number,height:number,title:string,style:BoxStyle={}):string[]{
	if(width<1||height<1)return [];
	if(width<3||height<2)return [truncateToWidth(title,width)];
	const inner=width-2;
	const row=(line:string)=>"│"+truncateToWidth(line,inner)+" ".repeat(Math.max(0,inner-visibleWidth(truncateToWidth(line,inner))))+"│";
	const applyBody=style.body??((text:string,_filled:boolean)=>text),applyTitle=(text:string)=>style.title?.(text)??applyBody(text,true);
	const titleText=applyTitle("┌"+truncateToWidth(title,inner)+"─".repeat(Math.max(0,inner-visibleWidth(truncateToWidth(title,inner))))+"┐");
	const end="└"+"─".repeat(inner)+"┘";
	return [titleText,...Array.from({length:Math.max(0,height-2)},(_,i)=>applyBody(row(lines[i]??""),Boolean(lines[i]?.trim()))),applyBody(end,false)];
}
