import {JsonBody} from './storage.mjs';
import {scanJson} from './scan.mjs';

const scalarNames=new Set(['type','id','parentId','timestamp','customType','role','toolName','toolCallId','model','provider','stopReason','name']);
const exact=(p,...parts)=>p.length===parts.length&&p.every((v,i)=>v===parts[i]);
const date=value=>typeof value==='number'?new Date(value).toISOString():typeof value==='string'?value:undefined;

export async function importSession(source,index,storage,options,manifest) {
  const insertRecord=index.prepare('INSERT INTO records(source,id,parent,type,role,time,eligible,data) VALUES(?,?,?,?,?,?,?,?)');
  const insertItem=index.prepare('INSERT INTO items(record,kind,data) VALUES(?,?,?)');
  const insertBody=index.prepare('INSERT INTO item_bodies VALUES(?,?)');
  const legacyPut=index.prepare('INSERT OR REPLACE INTO legacy_members VALUES(?,?)');
  let entry,block,textCapture,jsonCapture,metaCapture,assetCapture,legacy,records=0,itemCount=0;
  const item=(kind,data)=>{
    const row=insertItem.run(entry.seq,kind,JSON.stringify(data));itemCount++;
    for(const body of [data.body,data.args])if(body?.id)insertBody.run(row.lastInsertRowid,body.id);
  };
  const finishBlock=()=>{
    if(!block)return;
    if(block.type==='text'&&block.body)item('text',{body:block.body,block:block.index});
    else if(block.type==='toolCall')item('tool-call',{args:block.args,name:block.name??'tool',callId:block.id,block:block.index});
    else if(['image','audio','video'].includes(block.type)) {
      if(block.assetWriter){const asset=block.assetWriter.finish(block.mimeType);item('attachment',{attachmentType:block.type,asset,block:block.index});manifest.embeddedAttachments=(manifest.embeddedAttachments??0)+1;}
      else{item('attachment',{attachmentType:block.type,mimeType:block.mimeType,block:block.index,notice:'This attachment type/data layout is not embedded; the omission is recorded.'});manifest.omittedAttachments++;}
    } else if(!['thinking','reasoning'].includes(block.type)&&block.type)manifest.unknownBlocks++;
    block=undefined;
  };
  const bodyTarget=p=>{
    if(exact(p,'summary'))return {set:value=>entry.summary=value,search:true};
    if(exact(p,'content')||exact(p,'message','content'))return {set:value=>item('text',{body:value}),search:true};
    if(exact(p,'message','errorMessage'))return {set:value=>entry.error=value,search:true};
    if(p.length===4&&p[0]==='message'&&p[1]==='content'&&typeof p[2]==='number'&&p[3]==='text')return {set:value=>{if(block)block.body=value;},search:true};
  };
  const metaTarget=p=>{
    if(p.length===1&&scalarNames.has(p[0]))return value=>{entry[p[0]]=value;};
    if(p.length===2&&p[0]==='message'&&scalarNames.has(p[1]))return value=>{entry.message[p[1]]=value;};
    if(p.length===4&&p[0]==='message'&&p[1]==='content'&&typeof p[2]==='number'&&['type','id','name','mimeType'].includes(p[3]))return value=>{if(block)block[p[3]]=value;};
    if(p.length===3&&p[0]==='message'&&p[1]==='usage')return value=>{entry.usage[p[2]]=value;};
    if(p.length===4&&p[0]==='data'&&p[1]==='members'&&typeof p[2]==='number'&&['id','name','sessionId','sessionFile','model'].includes(p[3]))return value=>{if(legacy)legacy[p[3]]=value;};
  };
  let redactions=0;
  const result=await scanJson(source,{
    start(){entry={message:{},usage:{},seq:Number(insertRecord.run(source.id,null,null,null,null,null,0,'{}').lastInsertRowid)};},
    token(t,p){
      const n=t.name;
      if(n==='startObject'&&p.length===3&&p[0]==='message'&&p[1]==='content'&&typeof p[2]==='number')block={index:p[2]};
      if(n==='startObject'&&p.length===3&&p[0]==='data'&&p[1]==='members')legacy={};
      if(jsonCapture){jsonCapture.writer.feed(t);if(jsonCapture.writer.done){jsonCapture.set(jsonCapture.writer.finish());jsonCapture=undefined;}}
      else if((p.length===4&&p[0]==='message'&&p[1]==='content'&&p[3]==='arguments')||exact(p,'data')) {
        if(['startObject','startArray','startString','numberValue','nullValue','trueValue','falseValue'].includes(n)) {
          const target=exact(p,'data')?value=>entry.dataBody=value:value=>{if(block)block.args=value;};
          jsonCapture={writer:new JsonBody(storage.body({search:!exact(p,'data')}),()=>redactions++),set:target};jsonCapture.writer.feed(t);
          if(jsonCapture.writer.done){target(jsonCapture.writer.finish());jsonCapture=undefined;}
        }
      }
      if(n==='startString') {
        if(block?.type==='image'&&p.length===4&&p[0]==='message'&&p[1]==='content'&&p[3]==='data'){block.assetWriter=storage.asset();assetCapture=block.assetWriter;}
        const target=!jsonCapture?bodyTarget(p):undefined;
        if(target)textCapture={writer:storage.body({search:target.search}),set:target.set};
        const setter=metaTarget(p);if(setter)metaCapture={set:setter,value:''};
      } else if(n==='stringChunk') {
        assetCapture?.append(t.value);
        textCapture?.writer.append(t.value);
        if(metaCapture){metaCapture.value+=t.value;if(metaCapture.value.length>65536)throw Error('A session identity/metadata field exceeds 64 KiB');}
      } else if(n==='endString') {
        assetCapture=undefined;
        if(textCapture){textCapture.set(textCapture.writer.finish());textCapture=undefined;}
        if(metaCapture){metaCapture.set(metaCapture.value);metaCapture=undefined;}
      } else if(['numberValue','trueValue','falseValue','nullValue'].includes(n)) {
        const value=n==='numberValue'?Number(t.value):n==='trueValue'?true:n==='falseValue'?false:null;metaTarget(p)?.(value);
        if(exact(p,'message','isError'))entry.message.isError=value;
      }
      if(n==='endObject'&&p.length===3&&p[0]==='message'&&p[1]==='content')finishBlock();
      if(n==='endObject'&&p.length===3&&p[0]==='data'&&p[1]==='members'&&legacy) {
        if(entry.customType==='team-roster'&&(legacy.sessionId||legacy.sessionFile))legacyPut.run((legacy.id??legacy.name??'legacy')+':'+(legacy.sessionId??legacy.sessionFile),JSON.stringify(legacy));legacy=undefined;
      }
    },
    end(){
      finishBlock();const m=entry.message,eligible=entry.type==='message'?['user','assistant','toolResult','custom'].includes(m.role):['compaction','custom_message','custom','context_edit','branch_summary','model_change','thinking_level_change','label','session_info'].includes(entry.type);
      if(entry.summary)item('compaction',{body:entry.summary});
      if(entry.dataBody)item('event',{body:entry.dataBody,label:entry.customType??entry.type});
      if(entry.error)item('error',{body:entry.error});
      if(entry.type==='session'){source.sessionId=entry.id;source.title=entry.name??source.title;}
      if(entry.type==='session_info'&&entry.name)source.title=entry.name;
      const meta={id:entry.id,parentId:entry.parentId,type:entry.type,customType:entry.customType,time:date(m.timestamp??entry.timestamp),role:m.role,model:m.model,provider:m.provider,stopReason:m.stopReason,toolName:m.toolName,toolCallId:m.toolCallId,isError:m.isError,usage:entry.usage};
      index.prepare('UPDATE records SET id=?,parent=?,type=?,role=?,time=?,eligible=?,data=? WHERE seq=?').run(entry.id??null,entry.parentId??null,entry.type??null,m.role??null,meta.time??null,eligible?1:0,JSON.stringify(meta),entry.seq);
      source.lastEntryId=entry.id??source.lastEntryId;records++;
      if(records%250===0){index.exec('COMMIT; BEGIN;');options.progress?.({phase:'records',source:source.id,records});}
    },progress:bytes=>options.progress?.({phase:'reading',source:source.id,bytes,total:source.end})
  },options.signal);
  manifest.redactedFields+=redactions;
  return {...result,items:itemCount};
}
