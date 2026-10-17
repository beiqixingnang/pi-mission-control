# Mission Control v2 实现规格

旧版问题、新版完整执行链和保证边界见[旧版与v2机制对照](MECHANISMS.md)，实际测试结果见[验证记录](VALIDATION.md)。

## 组成

`extensions/mission-control/index.ts`为唯一协调入口，另加载独立压缩扩展。`runtime/`拥有SQLite状态、任务调度、进程执行、持久消息箱、时钟和产物；`extensions/mission-control/member.ts`只负责成员工具及带实例token的本机协调通信。UI只查询核心状态。

采用Node内置`node:sqlite`，事务提交后发布变化；每个Pi session有独立数据库和owner lock，按稳定sessionId保存于Pi agent目录的mission-control/v2/。持久表分为members、tasks、deliveries、schedules、meta、有限审计events。用户输入和结果保存在不可变产物文件中，数据库只放有界摘要和引用。

根任务自动开启mission与维护器。Goal为mission的可选结构化目标，不拥有另一套pending列表。完成通知通过pending→leased→admitted→response-observed推进；只允许一个idle唤醒预留。`response-observed`只表示宿主观察到成功响应，不宣称LLM业务处理exactly-once。错误/未启动预留回到pending，用户停止保留消息。

成员每次任务回合启动独立Pi RPC进程，使用相同持久child sessionId。进程与任务epoch绑定，成员等待后进程关闭，子任务交付时在同一child session启动复核回合。受限HTTP bridge仅监听127.0.0.1、校验随机token和当前task epoch；发送者身份由服务器确定；旧实例请求拒绝。

RPC客户端使用process.execPath、Windows隐藏窗口、POSIX独立进程组；输出有界，消息按LF解析。进程退出、超时、abort分别处理并等待受管进程结束。异常退出时不自动重跑有副作用命令。

沿用经过核对的独立Podman快照/写回后端及路径检查器；不沿用旧workspace扩展的host工具映射。新成员read/write/edit均是受控工具，host命令单列为可信能力。额外扩展由用户配置，不由模型指定。

持久调度支持ISO一次性与固定间隔提醒；常规进度报告与安全维护分开。调度投递先写持久消息箱再推进nextAt，在同一数据库事务完成；周期错过只补最近一次，不积压旧提醒。

Pi会话只保存极小版本描述和有界wake消息；不注册替换`/export`、`/copy`、editor或全局Escape。详情面板使用public custom UI，状态区使用public widget。

## 当前实现文件与状态提交点

| 文件 | 职责 |
| --- | --- |
| runtime/store.ts | 单session SQLite事务、owner lock、规范化状态、不可变产物、有限审计事件 |
| runtime/kernel.ts | 自动mission、任务树、任务epoch、组内等待/复核、取消与恢复、固定报告、消息租约/重试 |
| runtime/rpc-worker.ts | 公开Pi RPC协议、独立进程组、Windows隐藏窗口、环境允许项、受管进程树退出 |
| runtime/bridge.ts | 本机capability bridge、请求体上限、实例token身份认证 |
| runtime/jsonl.ts | 严格LF记录解析，保留JSON字符串内U+2028/U+2029 |
| runtime/public.ts | 公开文本提取、私有结构过滤、流式主/成员导出 |
| runtime/arguments.ts | 可选null/空值归一化、非空任务模式选择、权限配置冲突检查 |
| runtime/transcript.ts | 有界反向LF分页、未完成尾记录处理、成员历史会话枚举 |
| runtime/reconnect.ts | 固定间隔重连预算、取消等待和上下文超限分流 |
| runtime/relocation.ts | 工作区校验、LF历史复制、SQLite/产物迁移、恢复日志与回滚 |
| runtime/summarize.ts | 输入分块、内容哈希缓存、截断拒绝和层次合并 |
| runtime/web.ts | 搜索provider适配、有限响应、public目标校验和DNS固定连接 |
| extensions/mission-control/index.ts | 唯一lead工具/命令入口、Pi生命周期适配和有界消息 |
| extensions/mission-control/member.ts | 成员文件/host/容器工具、team bridge和父进程存活检测 |
| extensions/mission-control/ui.ts | 公开widget与详情面板、稳定成员排序和宽度约束 |
| extensions/mission-control/viewer.ts | 全屏任务树、目标/提醒页、Pi Markdown成员对话、成员消息和逻辑复制 |
| extensions/mission-control/presentation.ts | 真实Theme类型、按可见列宽填充底色、无边框消息行 |
| extensions/mission-control/compaction.ts | Pi原生compact/tree hook接入独立摘要模型 |
| extensions/mission-control/reconnect.ts | 主/成员提供方失败hook与用户重连配置，补充原生恢复 |
| extensions/mission-control/project.ts | 用户工作区操作、精确授权及原生宿主替换 |
| extensions/project/identity.ts | 复用的稳定项目身份、路径别名和跨进程注册锁 |

### 完成与投递

成员RPC的agent_settled之后读取sessionFile，再关闭受管Pi进程；公开交付写不可变产物，任务终态与outbox入箱在同一SQLite事务。任务completed只代表成员回合完成，不是产品验证通过。若根任务有下游，保持waiting，全部下游终态后在同一成员session的新回合复核，复核结束才交付root结果。

lead空闲且无Pi排队输入时，消息箱租约一次选最多8条，每条摘要最多2000字符。保存lease之后调用Pi发送API；发送API返回不确认送达。before_agent_start检查batch/generation并标admitted；context hook确认该batch进入请求；成功响应后agent_settled才标observed。失败、未启动、abort保持pending并有限退避。业务副作用仍需幂等，observed不承诺exactly-once理解/执行。

lead主动team_collect或同步等待时，toolResult的有界details标记delivery IDs，进入context后才admitted，成功响应后观察确认。不会再等待一个只对public事件发出的message_end。组内note到正在运行成员走公开RPC steer；投递尝试和结果确认同样分开。普通progress按报告周期合并，不单独启动lead回合。

### 用户控制与自动维护

根派工自动ensureMission，不依赖模型goal_start；维护器从session启动即存在。模型没有pause/stop/delete-schedule工具，supervisor_control只兼容查询。回答临时问题不改变目标/报告。用户等待裁决状态收到新用户输入可重新处理，但humanPaused仍必须/mission resume。用户resume恢复失败投递的尝试额度和预算。

运行中的任务超时会abort并结束受管进程树；结束状态不能确认时保留unknown。该成员禁止再次派工，只有用户检查残留进程后/mission reconcile明确确认才解除。异常收束的成员session退役，旧记录不删除，避免不完整工具调用历史被下一attempt重放。

### 原生Pi兼容

TUI/RPC是常驻异步模式；print/json一次性模式在派工工具中join结果，避免宿主按原设计退出而截断后台任务。不会为维护而改变Pi一次性退出行为。

新sidecar只在主日志保存一次schema/session/状态目录描述，大状态不进Pi custom快照。导出、clipboard、footer、输入与Escape不替换。v2自定义导出为公开有界记录；旧1GB日志的原生HTML整体序列化限制没有被假称修复。

### 明确未提供的范围

当前没有跨Pi进程退出仍工作的独立daemon、OS启动项、原生Windows token沙箱或日历cron/daily/weekly规则。仅支持显式容器强制后端和可信host。没有为真实provider网关做协议认证；Ubuntu GitHub离线套件已执行，实际Linux硬件项目与长期负载仍未验证。TUI以公开widget/详情面板呈现，未实现读取私有layoutRoot的永久右栏。

### 2.0.1补充：派工兼容和只读对话查看

2.0.3把查看器改成全屏工作台。`/agents`是主入口，`/mission`与`/mission view`继续兼容。团队页先显示稳定的AGENTS状态摘要和任务树；成员页用Pi `Markdown`组件渲染用户任务、成员回复、工具调用、工具返回和错误。工具块默认折叠，逻辑复制通过宿主`copyToClipboard`回调，不复制终端边框或其他面板。`m`通过Pi原生editor收集文本，然后由kernel决定对运行成员steer或创建新任务；查看和发送不会伪装成主模型消息，也不会自动确认成员交付。

2.0.4修正主题适配：颜色参数限定为Pi导出的ThemeColor，Markdown字体样式调用Theme.italic/underline/strikethrough，不把字体样式名当作色名。custom渲染不处于slash命令的异步try/catch内，因此MissionPanel.render自身兜底，返回不依赖主题的错误页供Esc退出。类型检查、真实Pi主题测试与渲染故障注入分别验证token、正常输出和宿主异常边界；无主题mock不能作为主题兼容性证据。

### 2.0.5：横向看板和动作底色

`index.ts.refresh`通过公开`ctx.ui.setWidget`的`placement: aboveEditor`固定放置看板，工厂接收Pi真实theme；不替换editor或footer。`ui.ts.board`直接从kernel快照生成目标、下一报告时间、最近有效提醒和成员行。终端高度由stdout.rows提供，普通看板最多max(4,min(10,floor(rows/3)))行，其中三行摘要、一行入口，其余留给成员；超出数量在入口行提示。顺序保持稳定，没有成员轮播。完整任务树和提醒列表仍在工作台。

`openAgents`在打开custom组件前设置agentsOpen并隐藏widget；后台刷新只重绘当前工作台，不会把看板重新插入。退出或组件异常经finally恢复看板。界面切换只影响可见组件，不改变Mission、任务状态或delivery确认。集成测试通过实际Pi命令检查aboveEditor位置、查看中持续隐藏及退出恢复。

`presentation.ts.panelLine`接受Pi导出的ThemeBg，按visibleWidth补齐行宽，再调用theme.bg；不增加边框或竖向分隔符。主看板采用customMessageBg。成员对话采用下表，颜色值由当前Pi主题决定，未硬编码绿色/红色色值。

| 内容/结果 | Pi主题背景 |
| --- | --- |
| 用户任务 | userMessageBg |
| 工具调用未见返回、实时工具进度 | toolPendingBg |
| 已成功的工具调用、工具返回 | toolSuccessBg |
| 工具错误/失败调用 | toolErrorBg |
| 压缩摘要、其他公开事件 | customMessageBg |
| 成员回复、实时回复增量 | 普通背景 |

`conversationItems`先按当前记录窗口中的toolCallId建立结果索引，然后生成语义消息。含command的调用直接预览命令；edit的oldText/newText显示增删行并用toolDiffRemoved/toolDiffAdded着色。动作正文作为换行保留的工具文本渲染，普通回复继续使用Pi Markdown；没有为动作插入多余的Markdown围栏。未加载结果所在记录时调用仍显示待返回，这是分页证据的范围，不推断未见到的执行结果。

展示文本displayBody与逻辑正文body分离；命令和编辑的body仍为完整参数JSON，因此c复制保留timeout等预览未显示的参数。逻辑复制不包含ANSI、背景填充或面板标题。终端鼠标选择仍由宿主终端负责；横向布局消除了邻列分隔符，但不能替终端改变选区范围。

可复现预览：`node --experimental-strip-types scripts/preview-mission-panel.mjs`使用临时kernel、真实安装Pi的TuiAltScreen/VStack/ScrollView/Markdown与dark主题，保存宽屏/窄屏主界面、团队页和成员页ANSI帧；`python scripts/render-terminal-preview.py`用Pillow将帧栅格化为PNG。ANSI帧和PNG位于忽略的.reference/artifacts/ui，公开纯文本快照位于docs/ui-preview-mission-panel.txt。预览的输入区是固定草稿夹具，不是用户正在运行的终端截图，也不构成真实鼠标选区验收。

真实使用暴露了`tasks:[]`遮住有效chain，以及files模式附带空sandbox对象被拒绝的问题。可选字段schema现接受null，空字段先归一化；仅一个非空task/tasks/chain生效。有效容器配置仍须显式sandbox模式，read-only+host仍拒绝。全部成员配置预检后才在同一事务接收任务，错误参数不创建半支团队。空配置更新不重置成员已有模型或文件权限。

工作台是公开custom组件，↑↓/Enter选择成员，←→展开任务树，Tab切换目标/提醒。对话通过已知成员session路径读取，不启动第二个Pi。任务启动时记录sessionFile，任务中断后仍可定位旧历史；`[`/`]`可切换成员日志，包括退役session。

历史使用64KiB块反向按字节LF扫描，每页40公开记录、扫描上限4MiB，单原始记录超过1MiB略过；缓存最多400记录且约2MiB。未以LF结束的尾记录等待写完再处理。暂停跟随保留视口并提示新记录，Home继续向前分页，End重新读取最新页。单项展开仍是有界摘录。

Pi1.3 RPC的message_update没有累计message/partial，只有assistantMessageEvent增量；WorkerPublicStream只累加text_*，不读取thinking_*。公开预览和工具progress放在成员内存状态，不按token写SQLite或Pi主日志；完成后以原始成员日志的公开投影为准。工具没有上报进度时只展示等待及最终返回。读取日志、切页、返回不会启动模型、改变Goal、取消成员或推进delivery确认。

## 实现与核对顺序

2.0.2对旧能力的逐项恢复、原生重试与插件重连关系、迁移及失败恢复细节见[PARITY.md](PARITY.md)。

1. SQLite状态/产物、控制权限、任务与消息箱不变量。
2. RPC进程、成员bridge、组内任务树与恢复。
3. Pi适配层、自动派工维护、Goal/调度、公开UI。
4. 分块摘要、联网与流式导出。
5. 真实Pi离线集成、原生导出回归、故障与权限核对，更新用户文档。
