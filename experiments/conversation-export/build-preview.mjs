import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
const root=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(process.argv[2]??'../../.reference/artifacts/v2/export-research-2026-10-19/preview');
const bodyFile=process.argv[3]?path.resolve(process.argv[3]):undefined;
fs.mkdirSync(path.join(out,'pages'),{recursive:true});
const safe=(value)=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
const manifest={version:1,demo:true,title:'处理器源码盘点与阶段验收',exportedAt:'2026-10-19 10:00:00 +08:00',
  roots:[{id:'root',title:'处理器源码盘点与阶段验收',selected:true},{id:'old',title:'审查环境准备',selected:false}],
  channels:[{id:'lead',name:'主对话',model:'gpt-6.1-sol',status:'协调中',count:4800,rounds:1},
    {id:'cpu-a',name:'luna-cpu-a',model:'gpt-6-luna',status:'本批已完成',count:2400,rounds:4},
    {id:'cpu-b',name:'luna-cpu-b',model:'gpt-6-luna',status:'本批已完成',count:2400,rounds:3},
    {id:'gpu',name:'luna-gpu',model:'gpt-6-luna',status:'交接中止',count:2400,rounds:4}],
  goals:[],files:{},pageSize:80,windowSize:40,bodyParts:[],bodyBytes:0};
const stageDefs=[['scope','范围与模块清单','accepted',3],['source','逐模块源码对照','active',4],['verify','统一导出与分批验证','planned',3],['report','汇总与阶段验收','planned',2]];
const names=[['冻结范围与输入','建立模块功能分母','分配文件与参考责任'],['CPU-A 调试与边界模块','CPU-B PMA 状态模块','GPU SIMT 与实际消费者','核对跨模块依赖与遗漏'],['全模块导出为 Verilog','第一批：组合与基础状态','第二批：流水与协议边界'],['汇总实现与验证欠账','形成逐目标验收清单']];
manifest.goals.push({id:'root',root:'root',level:1,title:manifest.title,state:'active',revision:2});
stageDefs.forEach(([id,title,state,count],i)=>{
  manifest.goals.push({id,root:'root',parent:'root',level:2,title,state,revision:1,depends:i?[stageDefs[i-1][0]]:[]});
  for(let j=0;j<count;j++)manifest.goals.push({id:`${id}-${j}`,root:'root',parent:id,level:3,title:names[i][j],state:i===0||(i===1&&j<2)?'accepted':i===1&&j===2?'active':'planned',revision:2,member:i===1?['cpu-a','cpu-b','gpu','lead'][j]:'lead',criteria:['候选源码与锁定参考的实际阅读范围可定位','保留语义判断、未审范围和精确续点','本批证据已登记，后续验证义务单独列出'],evidence:[{type:'artifact',label:'审读记录与续点',path:`audit/${id}/checkpoint-${j+1}.md`,note:'文件身份已登记；不等于已经验证所有结论'}, {type:'tool',label:'原始工具读取回执',path:`receipt/${id}-${j}`,note:'关联实际调用与返回'}, {type:'statement',label:'模型提交的语义说明',path:'',note:'模型声明；保持与已登记产物的区别'}]});
});
manifest.goals.push({id:'old',root:'old',level:1,title:'审查环境准备',state:'accepted',revision:1},{id:'old-stage',root:'old',parent:'old',level:2,title:'资料与隔离目录',state:'accepted',revision:1},{id:'old-a',root:'old',parent:'old-stage',level:3,title:'建立只读输入',state:'accepted',revision:1},{id:'old-b',root:'old',parent:'old-stage',level:3,title:'建立独立审计目录',state:'accepted',revision:1});
function shard(key,data) {
  const name=`pages/${key}.js`,text=`window.MissionArchive.receive(${safe(key)},${safe(data)});\n`;
  fs.writeFileSync(path.join(out,name),text);manifest.files[key]={path:name,bytes:Buffer.byteLength(text)};
}
// Actual synthetic 128 MiB message, split by UTF-8 decoder boundaries. It is
// never read as a whole string here or by the preview reader.
if(bodyFile&&fs.existsSync(bodyFile)) {
  const decoder=new StringDecoder('utf8');let part=0;
  for await(const chunk of fs.createReadStream(bodyFile,{highWaterMark:256*1024})) {
    const text=decoder.write(chunk);if(!text)continue;const key=`body-${part++}`;shard(key,text);manifest.bodyParts.push(key);manifest.bodyBytes+=Buffer.byteLength(text);
  }
  const last=decoder.end();if(last){const key=`body-${part++}`;shard(key,last);manifest.bodyParts.push(key);manifest.bodyBytes+=Buffer.byteLength(last);}
} else {
  for(let i=0;i<32;i++){const key=`body-${i}`;const text=`原始工具输出第 ${i+1} 段\n`+'module boundary(); // 示例\n'.repeat(2200)+(i===31?'SENTINEL_GIANT_TEXT_END_完整🙂':'');shard(key,text);manifest.bodyParts.push(key);manifest.bodyBytes+=Buffer.byteLength(text);}
}
const goals=manifest.goals.filter(g=>g.root==='root'&&g.level===3),roles=['user','assistant','tool','assistant','checkpoint'];
for(const ch of manifest.channels) {
  ch.pages=[];
  for(let start=0;start<ch.count;start+=manifest.pageSize) {
    const rows=[];
    for(let n=start;n<Math.min(start+manifest.pageSize,ch.count);n++) {
      const g=goals[n%goals.length],kind=roles[n%roles.length];
      let text=kind==='user'?`请沿当前已批准范围继续「${g.title}」。记录真实覆盖、未审文件和准确续点，保持产品输入只读。`:kind==='tool'?`read · audit/reference/module-${n}.sv\n实际读取行 1–120，工具结果成功返回。\nmodule audit_reference_${n};\n  // 实际代码正文在导出分卷中保留，阅读界面按段装载。\nendmodule`:kind==='checkpoint'?`本批 checkpoint 已落盘。目标：${g.title}。状态仍为 FULL_SHARD_INCOMPLETE；剩余源码和后续行为验证分别记录。`: `已核对「${g.title}」当前批次的源码与参考，新增证据已登记。模块的实现判断、阅读覆盖与行为验证分开记录；下一步从对应消费者继续。`;
      if(n===ch.count-1)text+=`\nARCHIVE_LAST_${ch.id}_已到最后记录`;
      rows.push({id:`${ch.id}-${n}`,sequence:n,source:ch.id,kind,goal:g.id,revision:g.revision,round:Math.min(ch.rounds,1+Math.floor(n/(ch.count/ch.rounds))),time:new Date(Date.UTC(2026,9,18,1,0,n*9)).toISOString(),text,
        ...(ch.id==='lead'&&n===2?{longBody:manifest.bodyParts,bodyBytes:manifest.bodyBytes,text:`read · Complete.sv\n这是一条实际分卷保存的合成超长工具返回，共 ${(manifest.bodyBytes/1048576).toFixed(1)} MiB；以下入口只装载当前一段，正文末尾有校验标记。`}: {})});
    }
    const key=`${ch.id}-${start/manifest.pageSize}`;shard(key,rows);ch.pages.push(key);
  }
}
fs.copyFileSync(path.join(root,'viewer.css'),path.join(out,'viewer.css'));
fs.copyFileSync(path.join(root,'viewer.js'),path.join(out,'viewer.js'));
fs.writeFileSync(path.join(out,'index.html'),fs.readFileSync(path.join(root,'index.template.html'),'utf8').replace('__BOOT__',safe(manifest)));
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({out,records:manifest.channels.reduce((n,c)=>n+c.count,0),shards:Object.keys(manifest.files).length,bodyBytes:manifest.bodyBytes,indexBytes:fs.statSync(path.join(out,'index.html')).size}));
