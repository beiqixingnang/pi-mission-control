(() => {
  'use strict';
  const M=JSON.parse(document.getElementById('archive-boot').textContent),main=document.getElementById('main');
  const state={view:'overview',root:'root',selected:'source-1',channel:'lead',offset:0,round:'all',goal:'all',bodyPart:0,bodyRecord:null,searchEpoch:0};
  const cache=new Map(),loading=new Map();let renderEpoch=0;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const label=s=>({accepted:'已验收',active:'进行中',planned:'待开始',blocked:'受阻'}[s]??s);
  const channel=id=>M.channels.find(c=>c.id===id);
  const currentGoals=()=>M.goals.filter(g=>g.root===state.root);
  const goal=id=>M.goals.find(g=>g.id===id);
  const badge=s=>`<span class="status ${esc(s)}">${esc(label(s))}</span>`;
  const stamp=t=>new Date(t).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const cacheBytes=()=>[...cache.keys()].reduce((sum,k)=>sum+M.files[k].bytes,0);
  window.MissionArchive={receive(key,data){
    if(!M.files[key])return;
    cache.delete(key);cache.set(key,data);
    while(cache.size>4||cacheBytes()>8*1024*1024)cache.delete(cache.keys().next().value);
    loading.get(key)?.resolve(data);
  }};
  async function load(key) {
    if(cache.has(key)){const data=cache.get(key);cache.delete(key);cache.set(key,data);return data;}
    if(loading.has(key))return loading.get(key).promise;
    const file=M.files[key];if(!file||!/^pages\/[a-z0-9-]+\.js$/.test(file.path))throw Error('分卷索引无效');
    let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});
    loading.set(key,{resolve,reject,promise});
    const script=document.createElement('script');script.src=file.path;
    script.onload=()=>{if(!cache.has(key))reject(Error(`分卷没有返回数据：${file.path}`));script.remove();loading.delete(key);updateFoot();};
    script.onerror=()=>{script.remove();loading.delete(key);reject(Error(`找不到分卷 ${file.path}。请完整解压归档目录，不要只复制 index.html。`));};
    document.head.append(script);return promise;
  }
  function updateFoot() {
    const f=document.getElementById('foot');f.textContent='设计预览使用示例数据，验收状态不代表真实硬件进度。归档为只读快照。';
    f.dataset.cachedPages=cache.size;f.dataset.cachedBytes=cacheBytes();f.dataset.visibleMessages=document.querySelectorAll('.message').length;
  }
  function nav() {
    document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view));
    document.getElementById('channels').innerHTML=M.channels.map((c,i)=>`<button class="channel ${state.view==='chat'&&state.channel===c.id?'active':''}" data-channel="${c.id}" aria-label="打开${esc(c.name)}"><span class="avatar">${['M','A','B','G'][i]}</span><span><strong>${esc(c.name)}</strong><div class="details">${c.count.toLocaleString()} 条 · ${c.rounds===1?'主会话':c.rounds+' 轮任务'}</div></span></button>`).join('');
  }
  const rootSelect=()=>`<select id="root-select" aria-label="选择主目标">${M.roots.map(r=>`<option value="${r.id}" ${r.id===state.root?'selected':''}>${r.selected?'当前 · ':'历史 · '}${esc(r.title)}</option>`).join('')}</select>`;
  function heading(title,sub,selector=true) {return `<div class="page-title"><div><div class="eyebrow">MISSION ARCHIVE / 离线阅读</div><h1>${esc(title)}</h1><p class="subtitle">${esc(sub)}</p></div>${selector?rootSelect():''}</div>`;}
  function stats() {
    const gs=currentGoals(),counts=l=>{const a=gs.filter(g=>g.level===l);return `${a.filter(g=>g.state==='accepted').length}<small> / ${a.length}</small>`;};
    return `<div class="stats"><div class="stat"><div class="stat-label">主目标状态</div><div class="stat-value" style="font-size:20px">${label(goal(state.root).state)}</div><div class="stat-sub">保留全部主目标与切换历史</div></div><div class="stat"><div class="stat-label">二级目标 · 已验收</div><div class="stat-value">${counts(2)}</div><div class="stat-sub">按阶段登记验收与依赖</div></div><div class="stat"><div class="stat-label">三级目标 · 已验收</div><div class="stat-value">${counts(3)}</div><div class="stat-sub">任务完成不自动等于目标验收</div></div><div class="stat"><div class="stat-label">对话记录 · 主 / 成员</div><div class="stat-value">12,000<small> 条</small></div><div class="stat-sub">1 个主会话 · 3 名成员 · 多轮归并</div></div></div>`;
  }
  function goalRows(expandAll=false) {
    const gs=currentGoals(),parents=gs.filter(g=>g.level===2);
    return parents.map((s,i)=>{
      const children=gs.filter(g=>g.parent===s.id),accepted=children.filter(g=>g.state==='accepted').length;
      const row=`<div class="goal-row ${state.selected===s.id?'selected':''}" data-goal="${s.id}" role="button" tabindex="0" aria-label="查看目标${esc(s.title)}"><span class="goal-mark ${s.state}">${s.state==='accepted'?'✓':i+1}</span><div><div class="goal-name">${esc(s.title)}</div><div class="goal-note">${s.depends?.length?'依赖上一阶段验收 · ':'阶段目标 · '}${children.length} 个三级目标</div></div><div class="goal-right"><span class="goal-note">${accepted}/${children.length}</span>${badge(s.state)}</div></div>`;
      return row+((expandAll||s.id==='source')?children.map(g=>`<div class="goal-row child ${state.selected===g.id?'selected':''}" data-goal="${g.id}" role="button" tabindex="0" aria-label="查看目标${esc(g.title)}"><span class="goal-mark ${g.state}">${g.state==='accepted'?'✓':'·'}</span><div><div class="goal-name">${esc(g.title)}</div><div class="goal-note">${esc(channel(g.member)?.name??'主对话')} · revision ${g.revision}</div></div>${badge(g.state)}</div>`).join(''):'');
    }).join('');
  }
  function details() {
    const g=goal(state.selected)??currentGoals().find(g=>g.level===3)??goal(state.root);
    return `<aside><div class="card side-card"><div class="side-heading">目标详情 / 验收证据</div>${badge(g.state)}<h3>${esc(g.title)}</h3><div class="side-meta">${esc(g.id)} · revision ${g.revision} · ${g.level} 级目标</div><ul class="criteria ${g.state}">${(g.criteria??['依赖下级目标的独立验收','保留完整证据与范围变更历史']).map(c=>`<li>${esc(c)}</li>`).join('')}</ul><div class="side-heading">证据登记</div>${(g.evidence??[{type:'acceptance',label:'下级验收记录',path:'关联 acceptanceId 与目标 revision',note:''}]).map(e=>`<div class="evidence"><div class="type">${{artifact:'产物引用',tool:'工具回执',statement:'模型声明',acceptance:'下级验收'}[e.type]}</div><strong>${esc(e.label)}</strong><code>${esc(e.path||e.note)}</code></div>`).join('')}<div class="note">证据按目标版本关联。模型声明、文件身份与行为验证保持各自状态，不混算为完成。</div><button class="primary" id="related-chat">查看关联对话 →</button></div><div class="resume"><strong>从哪里继续</strong><p>按成员保留最后 checkpoint、未审范围和准确文件位置；一个成员的多轮任务放在同一入口。</p><button data-channel="cpu-b">查看 luna-cpu-b 交接记录 →</button></div></aside>`;
  }
  async function overview(all=false) {
    const leaves=currentGoals().filter(g=>g.level===3),accepted=leaves.filter(g=>g.state==='accepted').length;
    main.innerHTML=heading(all?'目标树与验收':goal(state.root).title,all?'阶段顺序、目标版本、完成证据与关联对话一起保留。':'导出时刻的工作全貌：做到了哪里，依据是什么，下一步从哪里继续。')+stats()+`<div class="layout"><section>${all?'':`<div class="card"><div class="card-title"><h2>当前目标</h2><small>${state.root==='root'?'已激活':'历史目标'} · revision ${goal(state.root).revision}</small></div><div class="card-content"><p class="summary">完整盘点 CPU / GPU 已批准功能的源码实现，逐模块对照锁定参考，形成可追溯的实现状态、验证欠账和剩余工作清单。</p><div class="progress"><span style="width:${leaves.length?accepted/leaves.length*100:0}%"></span></div><div class="progress-note"><span>三级目标已验收 ${accepted} / ${leaves.length}</span><span>阅读覆盖 ≠ 功能实现 ≠ 行为验证</span></div></div></div>`}<div class="card ${all?'':'section-gap'}"><div class="card-title"><h2>${all?'全部层级目标':'阶段与子目标'}</h2><small>主目标 → 阶段 → 交付项</small></div>${goalRows(all)}</div>${all?'':`<div class="card section-gap"><div class="card-title"><h2>关键过程</h2><button class="wide-link" data-channel="lead">查看主对话 →</button></div><div class="timeline"><div class="event"><time>09:06</time>三名成员提交交接续点<p>保留原身份与全部任务轮次；批次收束不等于总目标完成。</p></div><div class="event"><time>08:45</time>主会话压缩完成<p>原始对话继续保留，压缩检查点作为历史事件展示。</p></div></div></div>`}</section>${details()}</div>`;
  }
  async function chat() {
    const epoch=++renderEpoch,ch=channel(state.channel),page=Math.floor(state.offset/M.pageSize),rows=await load(ch.pages[page]);if(epoch!==renderEpoch)return;
    const start=state.offset%M.pageSize,visible=rows.slice(start,start+M.windowSize).filter(r=>(state.round==='all'||String(r.round)===state.round)&&(state.goal==='all'||r.goal===state.goal));
    const selectedGoal=state.goal==='all'?null:goal(state.goal);
    main.innerHTML=heading(ch.name,`${ch.model} · 导出时：${ch.status} · ${ch.rounds} 轮任务按成员归并`,false)+`<div class="chat-top"><select id="round-select" aria-label="筛选任务轮次"><option value="all">全部任务轮次</option>${Array.from({length:ch.rounds},(_,i)=>`<option value="${i+1}" ${state.round===String(i+1)?'selected':''}>第 ${i+1} 轮任务</option>`).join('')}</select><select id="goal-filter" aria-label="筛选目标"><option value="all">全部关联目标</option>${M.goals.filter(g=>g.level===3).map(g=>`<option value="${g.id}" ${state.goal===g.id?'selected':''}>${esc(g.title)}</option>`).join('')}</select><span class="side-meta">${selectedGoal?'精确绑定目标与 revision':'旧记录缺少绑定时应明确标注，不推测归属'}</span></div><div class="layout"><section class="card"><div class="card-title"><h2>公开对话与工具记录</h2><small>每次显示最多 ${M.windowSize} 条</small></div><div class="messages">${visible.length?visible.map(r=>`<article class="message ${r.kind}" data-id="${r.id}"><div class="message-head"><strong>${{user:'任务指令',assistant:ch.name,tool:'工具调用与返回',checkpoint:'检查点'}[r.kind]}</strong><time>${stamp(r.time)}</time><span class="source-pill">第 ${r.round} 轮</span><span class="source-pill">${esc(goal(r.goal)?.title??'未绑定目标')}</span><span style="margin-left:auto">#${r.sequence+1}</span></div>${r.kind==='tool'?`<details><summary>${esc(r.text.split('\n')[0])} · 展开工具返回</summary><pre>${esc(r.text)}</pre></details>`:`<p>${esc(r.text)}</p>`}${r.longBody?`<button class="long-open" data-long="${r.sequence}">查看长工具输出 · ${(r.bodyBytes/1048576).toFixed(1)} MiB · 原文分段</button>`:''}</article>`).join(''):'<div class="empty">当前窗口没有符合筛选条件的记录。请切换页码或条件。</div>'}</div><div class="pager"><span>显示 ${state.offset+1}–${Math.min(state.offset+M.windowSize,ch.count)} / ${ch.count.toLocaleString()}</span><button id="previous-page" ${state.offset===0?'disabled':''}>上一页</button><button id="next-page" ${state.offset+M.windowSize>=ch.count?'disabled':''}>下一页</button><button id="last-page">最后一页</button></div></section>${details()}</div>`;
    main.dataset.channel=ch.id;main.dataset.offset=state.offset;updateFoot();
  }
  async function render() {state.searchEpoch++;nav();try{if(state.view==='chat')await chat();else {renderEpoch++;await overview(state.view==='goals');}updateFoot();}catch(e){main.innerHTML=`<div class="error">${esc(e.message)}</div>`;}}
  async function showBody(part) {
    const r=state.bodyRecord;state.bodyPart=Math.max(0,Math.min(part,r.longBody.length-1));
    const index=state.bodyPart,value=await load(r.longBody[index]);if(index!==state.bodyPart)return;document.getElementById('body-content').textContent=value;
    document.getElementById('body-position').textContent=`正文 ${state.bodyPart+1} / ${r.longBody.length} 段 · 合计 ${(r.bodyBytes/1048576).toFixed(1)} MiB`;
    document.getElementById('body-prev').disabled=state.bodyPart===0;
    document.getElementById('body-next').disabled=state.bodyPart===r.longBody.length-1;
    updateFoot();
  }
  document.addEventListener('click',async e=>{
    const v=e.target.closest('[data-view]'),c=e.target.closest('button[data-channel]'),g=e.target.closest('[data-goal]');
    if(v){state.view=v.dataset.view;await render();}
    else if(c){state.view='chat';state.channel=c.dataset.channel;state.offset=0;state.goal='all';state.round='all';await render();}
    else if(g){state.selected=g.dataset.goal;await render();}
    else if(e.target.id==='related-chat'){const g=goal(state.selected);state.view='chat';state.channel=g?.member??'lead';state.goal=g?.level===3?g.id:'all';state.offset=0;await render();}
    else if(['previous-page','next-page','last-page'].includes(e.target.id)){const ch=channel(state.channel);state.offset=e.target.id==='last-page'?Math.floor((ch.count-1)/M.windowSize)*M.windowSize:Math.max(0,state.offset+(e.target.id==='next-page'?M.windowSize:-M.windowSize));await render();}
    else if(e.target.dataset.long!==undefined){const ch=channel(state.channel),rs=await load(ch.pages[Math.floor(Number(e.target.dataset.long)/M.pageSize)]);state.bodyRecord=rs.find(r=>r.sequence===Number(e.target.dataset.long));await showBody(0);document.getElementById('body-dialog').showModal();}
    else if(e.target.id==='close-body')document.getElementById('body-dialog').close();
    else if(['body-prev','body-next','body-last'].includes(e.target.id))await showBody(e.target.id==='body-last'?state.bodyRecord.longBody.length-1:state.bodyPart+(e.target.id==='body-next'?1:-1));
    else if(e.target.id==='integrity'){state.searchEpoch++;main.innerHTML=heading('档案信息与完整性','范围、缺失记录与读取策略需要明确展示。',false)+`<div class="card integrity-list"><p>本预览：12,000 条合成记录，${Object.keys(M.files).length} 个分卷；单条正文 ${(M.bodyBytes/1048576).toFixed(1)} MiB。</p><p>正文存储：完整分段；页面每次只显示 40 条记录或一段正文。</p><p>来源：主对话 + 3 名成员，各轮会话按稳定成员身份归并。</p><p>目标树：示例主目标、二/三级目标、验收标准、证据种类、revision 和对话关联。</p><p>正式导出还需：逐卷 SHA-256、SQLite 一致性快照、完整 LF 前缀边界、遗漏/损坏/未绑定/未嵌入附件清单。</p><p>此页面验证展示与分卷读取，不是已经安装的联合导出功能。</p></div>`;}
  });
  document.addEventListener('change',async e=>{if(e.target.id==='root-select'){state.root=e.target.value;state.selected=currentGoals().find(g=>g.level===3)?.id;await render();}else if(e.target.id==='round-select'){state.round=e.target.value;state.offset=state.round==='all'?0:Math.floor((Number(state.round)-1)*channel(state.channel).count/channel(state.channel).rounds/M.windowSize)*M.windowSize;await render();}else if(e.target.id==='goal-filter'){state.goal=e.target.value;await render();}});
  document.getElementById('search-form').addEventListener('submit',async e=>{
    e.preventDefault();const q=document.getElementById('search').value.trim();if(!q)return;
    const epoch=++state.searchEpoch;renderEpoch++;const results=[];let scanned=0,limited=false;
    main.innerHTML=heading('搜索对话记录',`正在逐卷检索「${q}」；可随时切换其他视图。`,false)+'<div class="card" id="search-results"></div>';
    try{outer:for(const ch of M.channels)for(const key of ch.pages){
      if(epoch!==state.searchEpoch||!document.getElementById('search-results'))return;
      const rows=await load(key);scanned+=rows.length;
      for(const r of rows){let match=r.text.includes(q);if(!match&&r.longBody){let tail='';for(const bodyKey of r.longBody){if(epoch!==state.searchEpoch||!document.getElementById('search-results'))return;const body=await load(bodyKey);if((tail+body).includes(q)){match=true;break;}tail=q.length>1?body.slice(-(q.length-1)):'';}}
        if(match)results.push({ch,r});if(results.length>=100){limited=true;break outer;}}
      document.getElementById('search-results').textContent=`已检索 ${scanned.toLocaleString()} 条，找到 ${results.length} 条…`;
      await new Promise(r=>setTimeout(r,0));
    }
    const box=document.getElementById('search-results');if(!box)return;
    box.innerHTML=`<div class="card-title"><h2>${limited?'至少 ':''}${results.length} 条匹配</h2><small>${limited?'达到显示上限，请缩小关键词':`已检索 ${scanned.toLocaleString()} 条`}</small></div>`+results.map(({ch,r})=>`<button class="search-result" data-result="${r.id}"><strong>${esc(ch.name)} · #${r.sequence+1}</strong><p>${esc(r.text.slice(0,160))}</p><small>${esc(goal(r.goal)?.title??'未绑定目标')} · 第 ${r.round} 轮</small></button>`).join('');
    box.querySelectorAll('[data-result]').forEach(b=>b.addEventListener('click',async()=>{const hit=results.find(x=>x.r.id===b.dataset.result);state.view='chat';state.channel=hit.ch.id;state.goal='all';state.round='all';state.offset=Math.floor(hit.r.sequence/M.windowSize)*M.windowSize;await render();document.querySelector(`[data-id="${hit.r.id}"]`)?.scrollIntoView({block:'center'});}));
    updateFoot();}catch(err){main.innerHTML=`<div class="error">${esc(err.message)}</div>`;}
  });
  document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('[data-goal]'))e.target.click();});
  render();
})();
