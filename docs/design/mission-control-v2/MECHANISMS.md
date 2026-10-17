# 旧版与 Mission Control v2 的机制对照

日期：2026-10-17。本文描述当前代码实际采用的机制；研究阶段的旧版证据保留在`docs/research/2026-10-17-agent-mechanisms/`，动态验证及未验证项见[VALIDATION.md](VALIDATION.md)。

## 核心改变

旧版由team、goal、supervisor等扩展分别持有状态，并通过事件互相协作。存在重复状态快照、监督检查提前触发和交付确认时机不一致等具体问题。v2将任务、成员、消息、调度和恢复集中到一个运行核心，Pi扩展只负责公开宿主事件、工具和UI接入。

模型负责理解目标、拆分工作、选择成员和判断交付质量；代码负责已接收任务的生命周期、结果保存、通知重试及用户控制。后者不再依赖模型自行记得开启Goal或定时任务。但这不意味着代码能够独立判断模型是否正确理解需求，或模型填写的验收证据是否真实充分。

| 关注点 | 旧版已确认问题或限制 | v2实际机制 |
| --- | --- | --- |
| 派工与自动维护 | 多个扩展分别管理Goal、监督和待处理消息，启用与恢复存在协调缺口 | session启动维护循环；首次根派工自动ensureMission；结果投递独立于显式Goal |
| 进度检查 | team:job-start调用schedule(0)，可绕过用户设置的报告间隔 | 任务调度、完成事件、固定进度报告独立判断，start不改写lastReportAt |
| 结果确认 | 普通Team通知监听了未被该API路径调用的扩展message_end；Goal另有提前ACK | pending、leased、admitted、observed分开，检查请求上下文和成功响应 |
| 主会话忙时 | 历史中出现多条已经过时的通知持续进入主会话 | 结果留在SQLite消息箱；空闲且无原生排队输入时，至多预留一批唤醒 |
| 成员执行权限 | 早期文件工具不足以执行工作，后来host映射又绕过文件路径包装 | 明确files/host/sandbox三种执行方式；文件工具始终经过检查；host明确可信无OS隔离 |
| 状态落盘 | 所分析日志98.2458%字节来自重复team-roster和goal-state快照 | 主日志只写一次v2描述；数据库持有运行状态；大输入输出单独保存为产物 |
| 压缩 | 仅切换摘要模型不能避免单次巨大请求 | 有界分块、内容哈希缓存、分层合并、失败保留历史 |
| Pi界面兼容 | 旧实现依赖界面接管，原生导出仍受大日志影响 | 公开widget/custom接口；不替换export/copy/editor/footer/Escape；另提供流式公开导出 |

98.2458%是历史磁盘记录比例，不是历史模型实际收到的上下文比例。旧版问题有固定版本及日志边界，不能据此推断每次历史运行都触发了所有问题。

## 一次完整派工如何运行

1. Pi载入`index.ts`，按Pi session ID打开`mission-control/v2/<sessionId>/state.sqlite`，取得owner lock，启动本机成员通信bridge和维护循环。并非每次维护检查都会请求模型。
2. 主模型创建成员并派发任务。`dispatch()`检查成员、任务树、执行状态和上限，再通过`ensureMission()`自动建立或接续Mission。自动目标首先取最近用户输入；`goal_start`可进一步明确目标和验收项，不是派工或唤醒的前提。
3. 任务进入queued。运行核心受并行数、同一成员串行限制和链式依赖约束，决定何时进入running。
4. `rpc-worker.ts`启动真实独立Pi RPC子进程，使用成员的模型、思考级别、工具清单和持久session ID。主会话不替成员转执行普通命令。
5. 主模型若已无独立工作，可调用`mission_wait`结束当前回合。正常结束回复也不会关闭维护。Pi本身继续运行，运行核心监视成员；不需要主模型不断请求状态维持后台任务。
6. 成员回合结束后，运行核心取得公开结果、关闭受管进程，先保存不可变结果文件，再在同一SQLite事务中保存任务终态和结果通知。
7. 主会话忙时，通知留在消息箱。主会话空闲且没有原生排队输入时，核心选择一批通知，通过Pi公开`sendMessage(..., {triggerTurn:true})`启动新主回合。
8. 只有确认通知进入请求上下文，且本轮成功响应后，才将交付标为observed；失败、中止或未启动会保留待处理结果并有限重试。

`mission_wait`用于TUI/RPC等常驻模式。一遍执行后退出的print/json模式在派工调用中等待成员结果，避免Pi退出后遗留无人协调的后台任务。

## 身份和状态为什么分开

- member ID表示成员身份，child session ID表示其会话历史；正常后续任务和复核回合复用该会话。
- task ID表示一次具体工作，parent/root/dependency记录上下游关系。显式重试创建新任务，通过attemptOf指回原任务。
- epoch表示该任务当前执行轮次。启动、取消或恢复边界会更新它，迟到的旧实例请求不能成为当前执行结果。
- delivery ID表示一份具体通知；batch ID/generation表示一次主会话唤醒预留。成员存在、任务完成和主模型已看到结果不是同一个状态。

任务主要路径为queued→running→completed/failed；有下游工作时进入waiting，然后queued(review)→running(review)。另有cancelled和interrupted。completed仅表示成员回合已正常收束，不等于产品验收通过。

## 团队成员如何协作和复核

成员通过仅监听127.0.0.1的bridge通信。每个执行实例取得随机token，服务器根据token确定发送者，并校验task ID和epoch，不能只相信请求正文里自报的身份。

有向allow清单决定该成员能向哪些同伴派工或发note。把工作派给祖先成员形成等待环时会被拒绝。同一个request ID重试可返回已有结果；若换了正文却复用ID则拒绝。

例如主会话给监督员A任务，A给执行员B派工，然后单独调用team_wait：A的当前回合结束、进程退出、任务保留waiting，不占持续执行槽。B完成后，结果进入A的消息箱；运行核心用A原child session启动review回合。A检查结果、补充处理后才向上交付。A即使忘了调用team_wait而直接结束，核心看到其下游仍未收束或尚待复核，也不会立即把父任务登记为完成。

普通progress会合并，不单独唤醒主会话。运行中的同伴收到允许的note时，通过Pi公开RPC steer接入。失败和裁决请求可以升级给主会话。是否拆对了任务、复核是否充分，仍取决于模型和实际验收。

## 消息为什么不会按旧方式持续排队

消息生命周期区分四步：

1. pending：数据库中有结果，尚未尝试向主会话交付。
2. leased：为一个唤醒批次预留，不能被其他批次同时领取。
3. admitted：宿主已启动对应回合；context hook还要确认该批消息进入实际请求上下文。
4. observed：宿主观察到该请求之后的成功响应。

一次最多取8条，每条摘要最多2000字符，完整结果通过产物路径按需读取。只有一个自动唤醒预留；主会话busy时不为每个成员事件向原生followUp队列追加一条请求。旧generation的唤醒会被拒绝；取消任务会处理其尚未确认通知，旧epoch结果不能覆写当前任务。

失败有退避和次数限制，默认最多3次。仍失败则显示attention、保留结果等待明确恢复，不无限请求。observed不是“模型理解正确”或“副作用恰好一次”的保证。若模型执行了操作但响应失败，后续模型仍须检查产物和实际工作状态，不能盲目重做。

## Goal、维护和定时提醒的关系

Mission拥有目标、验收项、任务和继续预算。Goal工具编辑同一份目标数据，不再持有另一份团队pending清单。结果事件可以直接触发交付，不需要等待整点报告或另一个定时器。

维护循环约每秒检查一次，通常只是读取本地状态，不代表每秒调用模型。固定进度报告按lastReportAt及用户间隔判断，派工start不提前报告。没有未完成任务、目标仍active时，核心生成继续通知；连续3个没有任务或目标进展的自动回合会进入attention。

模型工具不能pause/stop整个Mission、关闭维护或删除提醒；用户可用`/mission pause|resume|stop`控制。pause停止新的自动派工和唤醒，已运行成员可继续收束；stop还会取消活动任务。原生Escape只中止当前主回合，并暂缓自动唤醒，直到新用户输入；显式humanPaused仍需`/mission resume`解除。普通问答不会解除用户暂停。

模型仍可通过mission_decision提出有理由的用户裁决，或通过mission_complete申请完成。完成前代码要求无活动任务、相关结果已进入处理流程，以及每个验收项都有证据文本。代码不能独立证明证据文本为真，业务验收仍需模型或用户核实。

默认4个并行执行、单任务回合10分钟、Mission继续预算12小时/200个自动主回合/200万主模型输出token、每小时进度报告；这些值可配置。主模型输出预算不等于全团队总费用预算。

提醒支持带时区ISO时间、多久以后和固定秒数间隔。提醒入消息箱和nextAt推进在同一事务；错过多个周期只生成最近一次，不补发一夜旧提醒。暂不支持日历cron/daily/weekly；Pi进程关闭或机器休眠时不能继续执行。

## 隔离与权限究竟限制什么

| 模式 | 能做什么 | 强制边界 |
| --- | --- | --- |
| files | 受控文件读取/搜索，读写成员可写入工作区 | 不提供命令工具；路径、额外只读根和链接由WorkspaceAccess检查 |
| host | 上述文件工具及可信宿主bash；Windows另有原生PowerShell | 文件工具仍受控，但shell拥有宿主用户权限，没有OS沙箱 |
| sandbox | 文件工具及显式Podman命令 | 命令使用隔离快照、只读参考、无网络、资源限制和校验后的产物写回；后端不可用即拒绝 |

read-only与host同时配置会被拒绝，因为宿主shell无法靠文件工具包装限制为只读。sandbox不自动拉镜像、不自动降级host。独立进程和成员工作目录不等于Git worktree或系统级隔离；当前不会自动为每个成员创建worktree。

成员子进程的环境按允许项构造，已知provider凭据和用户明确允许的变量可能继承。Pi仍按自身配置解析凭据，不宣称每成员凭据隔离。额外worker扩展由用户配置，不能把应用层token当作防御同一用户下任意host命令的系统安全边界。

取消、超时会终止受管进程树；容器按本次身份停止并留下收据。无法确认进程结束时保存unknown，阻止该成员再次派工，要求用户检查残留后`/mission reconcile <taskId>`。重启把原running任务记为interrupted并通知主会话，不自动重跑可能有副作用的命令。未正常收束的成员session保留日志但退役，避免不完整tool-call历史被下次执行继承。

## 压缩、联网、TUI和原生能力

独立摘要模型接入Pi原生compact/tree hook。默认单次输入上限24000字符，并受摘要模型上下文窗口约束；不是把整个1M上下文换模型重发一次。按有界片段生成摘要，缓存键包含模型、输出预算和正文哈希，再分层合并。成功片段可以复用；错误、空输出或截断取消本次替换，保留原历史，不静默退回巨大默认请求。尚未配置独立模型时仍使用Pi原生压缩。

web_search支持Exa及配置的Brave/SearXNG，只发送查询；web_fetch限制响应和时间、检查目标地址与重定向，并固定已校验DNS结果。搜索与抓取不等于沙箱成员取得网络权限；成员不自动获得这些联网工具。

TUI从运行核心查询真实状态，不维护第二份任务数据库。2.0.5使用公开widget的aboveEditor位置显示横向看板：目标、下次报告、最近定时提醒，以及稳定排序的成员状态/当前工具/等待原因；每个成员独占整行，宽窄屏均无左右分栏。高度为max(4,min(10,floor(终端行数/3)))，多余成员在全屏工作台查看。打开工作台暂时隐藏widget，返回时恢复。没有接管私有layoutRoot。

2.0.1补齐了可选择的任务树和成员对话；2.0.3将其改成全屏工作台：`/agents`先显示AGENTS状态、目标、等待和失败数量，Enter进入成员；`/mission`与`/mission view`仍兼容。成员页使用Pi Markdown和语义消息块，工具调用/返回与错误有自己的层次，`m`走原生编辑器发送给当前成员，`c`复制当前逻辑消息。没有永久右侧分栏，所以终端选择不会跨到邻列；查看器只读日志和公开运行事件，发送由kernel显式路由，不改变delivery确认。

2.0.5将动作块映射到Pi原生userMessageBg/toolPendingBg/toolSuccessBg/toolErrorBg，回复无额外背景。按toolCallId关联当前页中的调用与返回；命令显示command正文，编辑显示oldText/newText的增删行；原始参数JSON另行保留供逻辑复制。panelLine按可见列宽补齐底色，不插入边框。结果不在当前分页窗口时调用按待返回显示，切入包含返回的记录后才显示最终结果。

原生导出、复制、编辑器、footer、Escape、会话树和模型选择不被同名覆盖。切换分支会暂停Mission，需显式恢复，避免结果自动接入另一个分支。大量状态不再反复写入Pi主日志；公开导出严格按LF逐条读取，过滤内部思考、签名、系统正文和状态快照。公开导出有摘录上限，不是无损备份，也不能修复已有1GB历史的原生HTML整体字符串化限制。

## 旧会话和验证边界

v2状态按Pi session ID保存，v2→v2重载保留成员、用户暂停和待处理通知；旧运行任务不会自动重放。v1的team-roster/goal-state不是v2数据库的导入格式，没有旧版团队、Goal和定时任务的自动迁移。旧原始日志保留；正式使用建议新Pi会话配合交接文档。

真实Pi集成使用离线确定性provider，但执行的宿主事件、RPC子进程、文件工具、Windows命令和取消是真实流程。真实Podman测试使用本机已有镜像。真实GPT/DeepSeek网关、整夜负载、跨平台动态运行和完整终端交互尚未验收，不以通过本地测试替代这些结论。

## 代码入口

- `runtime/store.ts`：SQLite事务、owner lock、成员/任务/通知/提醒、不可变产物。
- `runtime/kernel.ts`：ensureMission、dispatch、任务树、epoch、tick/pump、交付确认、取消和恢复。
- `runtime/rpc-worker.ts`：真实Pi RPC子进程、显式工具、持久成员session、steer和进程树回收。
- `runtime/bridge.ts`与`extensions/mission-control/member.ts`：本机实例认证、成员通信和受控执行工具。
- `extensions/mission-control/index.ts`：Pi生命周期事件、context确认、公开工具与用户命令。
- `runtime/summarize.ts`与`extensions/mission-control/compaction.ts`：分块摘要、缓存和Pi压缩hook。
- `runtime/public.ts`、`runtime/web.ts`、`extensions/mission-control/ui.ts`：公开导出、联网和界面。
