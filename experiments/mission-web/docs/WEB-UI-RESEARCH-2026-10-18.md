# TUI 与浏览器共用 Mission Control：可行性调研

日期：2026-10-18，Asia/Shanghai。项目基线为2.0.20、提交c20c391；运行依据为本机Pi1.3.0及仓库内固定源码。DeepSeek Harness对照版本为1517a4dbca0a2789ff1d41ba439600f8547d23fa。在线主线文档用于确认公开API的定位，不把固定版本参考称为上游最新实现。

本轮仅交付调研和可点击界面草图。没有增加真实浏览器控制API，没有修改生产插件、原会话状态或硬件执行。草图中的任务、消息和操作结果均为虚构示例。

## 结论

可以实现“启动Pi后，继续用原TUI，也能打开本机端口里的图形工作台”。推荐先在现有扩展中加入可选浏览器服务，让两端访问同一个AgentSession和MissionKernel。浏览器提供独立HTML界面，复用公开历史和运行状态，不依靠终端画面识别状态，也不为同一会话再启动一个调度核心。

第一版不需要Electron。先完成Web界面和控制协议；需要安装包、系统托盘、原生菜单及终端关闭后继续运行时，再评估独立Host与桌面壳。Electron解决窗口和桌面生命周期，双端状态一致仍由共享运行核心负责。

可行性来自公开接口及当前代码，尚未通过真实TUI与真实浏览器同时修改同一会话的端到端验收。

## 参考实现

| 参考 | 已核对的事实 | 对本项目的意义 |
| --- | --- | --- |
| Pi RPC | 常驻子进程，通过JSONL接收命令并发送响应和事件；SDK适合同进程Node集成 | GUI不必通过键盘模拟CLI，未来Web-only模式可接RPC Host |
| Pi SDK | AgentSession持有对话、队列、模型及扩展，支持prompt/steer/followUp/abort和事件订阅 | 可为同一会话设计多个入口，双端并发规则仍须实现 |
| Pi扩展API | 注册CLI flag和命令、订阅公开事件、调用宿主消息能力 | 可先在插件中加Web入口，保留原生TUI及安装方式 |
| DeepSeek Harness Web | 固定版本的dsh --profile web启动Web Host，提供聊天、模型/设置及历史界面，支持端口和浏览器启动 | 直接对应“终端启动，浏览器查看和操作” |
| DeepSeek Harness Desktop | 固定版本文档明确说明Electron承载完整Web应用、共用Host，并补充IPC和原生能力 | 可以先Web再桌面；不能据此认定它已支持TUI/Web同时控制同一会话 |
| Electron | 主进程管理应用和窗口，渲染进程显示Web内容，原生能力通过受控桥接提供 | 桌面封装不是双入口的前置条件 |

DeepSeek Harness的连接层还区分连接代次、快照与增量；启动URL换取会话cookie，检查Host/Origin。这些机制可借鉴，其整套动态插件框架和RPC复用层无需搬入当前项目。

## 路线比较

| 路线 | 与现有TUI同时操作 | 工作量来源 | 建议 |
| --- | --- | --- | --- |
| A. 在Pi扩展内启动Web服务 | 可以接入当前进程 | 公开投影、认证用户命令、事件广播及前端 | 第一期推荐 |
| B. 独立Host拥有SDK/RPC，浏览器和终端作为客户端 | 需要终端附着能力，不能直接把原TUI变成RPC客户端 | Host生命周期、终端适配、会话切换、扩展UI | 脱离终端运行或多会话并行时考虑 |
| C. Electron优先 | 有桌面GUI，仍需解决同一会话的终端入口 | A/B的协议，加安装、签名、更新和桌面退出行为 | Web稳定后再做 |
| D. 浏览器显示PTY终端 | 可以呈现TUI，但仍是终端交互 | PTY、终端模拟、输入独占及进程管理 | 可作辅助终端页，不作为成员/目标/恢复的主要图形界面 |

Pi的TUI和RPC是不同启动模式。另起一个pi --mode rpc读取当前会话，不等于附着现有TUI进程；Mission Control还有owner lock，不允许两个调度核心同时拥有同一会话。A直接在已有所有者中增加入口。

## 推荐架构与现有能力

~~~mermaid
flowchart TB
  T["原生 Pi TUI"] --> C["共享用户命令入口"]
  W["浏览器工作台"] --> H["本机 Web API · 身份与请求校验"]
  H --> C
  C --> K["同一个 AgentSession 与 MissionKernel"]
  K --> D["原 SQLite / Session JSONL / 产物"]
  K --> P["公开状态投影与事件广播"]
  P --> T
  P --> W
~~~

这是拟议架构。原生聊天和TUI组件仍归宿主管理；Mission Control动作逐步收敛到共享处理函数，浏览器不复制一份生命周期逻辑。

| 代码 | 已有能力 | 需要增加的接入 |
| --- | --- | --- |
| runtime/kernel.ts | 目标、成员、任务、提醒、用户控制、epoch/revision及恢复计划 | 用户动作适配、命令接纳、广播 |
| runtime/store.ts | 单会话所有权、事务、审计事件、产物引用 | UI请求幂等记录、状态版本；浏览器不直接写库 |
| extensions/mission-control/index.ts | 当前kernel、宿主事件、TUI命令和44个模型工具 | Web生命周期及共享服务，保留模型权限规则 |
| extensions/mission-control/lead-history.ts | 主对话公开流投影 | 增加Web订阅出口 |
| runtime/rpc-worker.ts | 成员公开文字与工具进度、受管执行 | 广播公开事件，不重新启动成员 |
| runtime/transcript.ts | LF分页读取和退役会话索引 | 有界历史API及游标 |
| runtime/public.ts | 过滤私有推理、签名、系统正文 | Web复用公开投影，不直接提供原始日志 |
| runtime/roster.ts | 当前成员一人一行 | Web使用相同成员规则 |

现有runtime/bridge.ts是成员实例通信桥，使用随机端口、Bearer token和任务epoch；它不是浏览器控制API，也没有页面、浏览器身份和事件订阅。建议新增独立Web入口，不将成员token交给浏览器。

## 启动、退出与所有权

建议的接口如下，目前尚未实现：

~~~text
pi -r --mission-web --mission-web-port 4318
/mission web open
/mission web status
/mission web off
~~~

支持指定端口或自动分配端口，成功后在TUI显示打开地址。端口冲突只让Web入口失败，不终止Pi或任务；关闭Web服务不暂停目标、不取消成员。

关闭标签页、刷新网页、浏览器断线都不改变任务状态。退出Pi才会关闭同进程Web服务，现有中断恢复规则继续生效。若要关闭终端仍持续工作，需要独立Host拥有会话，不能让浏览器标签页负责保活。

第一期跟随当前Pi进程及活动会话。切换会话、reload或迁移时更新服务代次，旧页面动作被拒绝并要求重取快照，不能写到另一个会话。多个Pi窗口可用不同端口；不承诺首版用一个端口管理所有窗口。

## 命令、事件与并发

建议初期采用HTTP POST提交命令、SSE推送公开状态和流。普通聊天不需要持续双向数据通道；若后续增加交互PTY，再引入WebSocket。SSE支持事件id和重连；HTTP/1下存在每来源连接数量限制，应每页一条流复用订阅，不给每个成员各开一条连接。

| 拟议接口 | 行为 |
| --- | --- |
| GET /api/session | 版本、会话、代次、状态版本、能力及快照 |
| GET /api/events | 一条SSE，包含bootId/sessionId/generation/sequence |
| GET /api/history | 指定已授权主/成员身份，按公开游标分页 |
| POST /api/messages | 用户消息、请求id、空闲/steer/followUp策略 |
| POST /api/actions | 白名单用户动作、预期会话与revision/epoch |
| GET /api/requests/:id | 查询已接收/执行中/完成/失败，供超时后核对 |

以上接口仅是设计。写操作有序接纳，不能让长模型请求一直占用控制队列，否则无法在执行中暂停、steer或取消。接纳与最终完成分开记录；读请求、事件流和中断不被长请求阻塞。

两端同时发送消息时按明确队列策略接纳，不启动第二个主执行循环。状态修改依靠版本校验和幂等键；重连或超时后先查原请求，不能自动重放派工、消息、迁移等副作用。

SSE应先订阅再取得有版本的基线，或缓冲基线后的增量；事件缺口明确重取快照。慢客户端可以丢弃可替代的预览并重取状态，不能用浏览器回压拖住调度核心。刷新浏览器不确认模型已消费成员结果。

## 容易遗漏的真实用户身份

Pi1.3.0的sendUserMessage()以source="extension"提交，RPC使用source="rpc"；本插件仅在source="interactive"时调用onHumanInput()，更新humanVersion并登记新的人工答复。因此网页只调用sendUserMessage()，不足以让现有业务裁决识别为新的人类答复。

需要认证浏览器用户入口：先校验会话、代次、权限和请求，再准确登记一次人工输入，并交给宿主接纳；失败、超时和重试不能重复增加humanVersion。不能让模型或普通扩展凭自报source伪装成人工答复，也不能把所有RPC输入都当成人类授权。

网页用户按钮执行用户控制规则，模型工具继续执行模型权限规则。把44个模型工具做成通用HTTP执行器，不等于完成了用户控制。

恢复页面读取现有recoveryPlan，列出成员、任务、epoch、产物和检查说明。unknown先检查进程及产物，确认旧执行已结束后提交证据；目标仍是no_progress时再恢复进度。预算耗尽显示具体限额，用户暂停、工作区授权和业务裁决各走自己的流程。

勾选框只是用户声明，不是独立的进程检查证据。核对成功不代表新任务完成，也不会自动重放旧命令。直接提供用户操作控件可减少“模型有工具但仍要求用户敲命令”的往返，同时保留服务端状态校验。

## 界面建议

可点击草图：同目录web-ui-concept.html。它无外部依赖，所有交互只改变页面示例。

| 区域 | 显示和操作 |
| --- | --- |
| 左侧 | 当前项目、主对话、当前成员、历史入口；成员一人一个入口 |
| 中间 | 用户与公开回复、流式文字、工具卡片和输入框，明确接收者 |
| 页签 | 对话、团队、目标、定时任务、事件记录 |
| 团队 | 状态、当前任务、等待原因、查看对话及消息入口；历史尝试放在成员内 |
| 目标 | 定义、逐条验收与证据、活动耗时和显式限额 |
| 定时任务 | 报告间隔、一次性/周期提醒、下一次、编辑/暂停/删除 |
| 右侧 | 主回复、成员、目标的独立状态，下一次报告、最近活动及明确控制 |
| 恢复表单 | 阻塞原因、准确身份、需要检查的内容、证据及动作结果 |

主/成员共用消息组件，但接收者明确区分。主模型忙时默认后续队列，用户可明确改为steer；“中断主回复”和“停止任务树”不使用模糊的同一按钮。日志、列表和工具大输出应分页或虚拟化，不能把旧大日志整体放入DOM。

宽屏三列，中屏收起右侧并提供操作菜单，窄屏采用页签、抽屉及局部滚动表格。草图验证了430px无整页溢出，但尚未补齐移动端全部操作入口；第一阶段以桌面浏览器为主要验收环境。

前端建议React、TypeScript和Vite，便于共用消息组件、类型化API及浏览器开发验证；这是工程选择，不要求复制DSH的动态插件体系。本轮没有安装这些依赖。最终静态资源随插件发布，用户启动时无需运行前端开发服务器。

## 分期与能力边界

| 阶段 | 范围 | 完成条件 |
| --- | --- | --- |
| 1. 同进程双入口 | 当前会话/成员公开历史、实时状态、消息、目标暂停/恢复、提醒、核对 | 真实TUI与浏览器双向一致，无重复执行 |
| 2. 用户交互补齐 | 模型/摘要设置、压缩、受控导出、业务裁决、共享确认框 | 人工身份、首次有效答复胜出及取消语义通过 |
| 3. 独立Host | Web-only、多会话所有权、可选终端客户端、发现/附着 | 退出终端后仍由唯一Host管理，重启边界明确 |
| 4. 可选桌面壳 | 复用Web前端，托盘、原生对话框、安装与更新 | 协议稳定后再验收平台打包与退出 |

人工身份必须在第一期入口设计时预留。首版不支持的操作显示清楚，并给出TUI继续处理的路径。

Pi RPC能转发部分select/confirm/input/editor，但custom TUI组件不能自动变成Web。现有TUI模式下，第三方扩展的原生确认框也不会自动转发到网页。第一期至少显示“等待终端确认”；完整覆盖需要共享交互broker或后续SDK/RPC Host。

现有project.ts迁移依赖ExtensionCommandContext的switchSession()/waitForIdle()等能力，普通事件上下文不能直接替代。工作区迁移、原生会话树和任意第三方自定义界面应单独适配，不承诺首版Web完整替代所有Pi功能。

## 本机服务的必要边界

默认监听127.0.0.1，有明确开关与端口。启动能力换取HttpOnly/SameSite会话cookie，检查Host/Origin和写请求凭据；不能用CORS "*"或仅凭“来自本机”识别用户。访问凭据不能写进模型上下文、任务产物或普通日志。

真实动作校验sessionId、服务代次、目标revision或任务epoch。浏览器不直接写库、不读取私有日志、不取得模型密钥或成员token。公开Markdown/工具结果按不可信内容显示，禁用脚本型HTML，文件读取限制在当前授权的产物或工作区。

跨机器、公网和多人访问不属于建议首版，后续需单独定义身份与TLS。这里是在设计能够触发宿主执行的本机网页，不是给模型另加一套审批流程。

## 真正实施时的验收

1. TUI派工后Web显示真实成员进度与结果；Web发消息后TUI看到同一条持久历史。
2. 两端同时输入和修改状态，顺序明确；刷新和重试不重复派工、发消息或回答决策。
3. 认证Web人工答复解除对应决策，普通扩展消息仍不能冒充人工输入。
4. 主回复中断、目标暂停、成员取消、提醒结束互不混淆；关标签页不改变任务状态。
5. 会话切换/reload/迁移后旧动作被拒绝，新连接取新代次，未知执行不自动重放。
6. 快照/事件无缺口或明确重取；慢客户端不阻塞调度，浏览器不越权确认模型消费。
7. 跨来源、未认证及过期动作被拒绝，分页不泄露私有字段，不整体加载大日志。
8. 端口冲突及Web故障不终止Pi；Pi退出释放服务，保留现有任务恢复语义。
9. RPC模式处理对话框和取消；以agent_settled验收收束，不把prompt接纳显示成完成。

## 本轮实际检查

- 核对上述官方资料、本地固定源码和现有插件的所有权/输入来源/公开流边界。
- 使用Codex可用的Browser能力打开隔离静态预览，检查1280×720默认视口，无整页横向溢出；保存全页截图。
- 团队页显示四行，选择gpu-executor后标题及接收者一致；输入示例只改变本页并明确提示未发送。
- 核对表单初始禁用提交，检查声明与证据齐全后启用；没有执行真实核对。
- 430×860视口主内容可见且document.scrollWidth=430，随后恢复默认视口。
- 页面错误日志为空。截图保存在本地忽略目录.reference/artifacts/web-ui-research-2026-10-18/。

草图没有连接模型、真实进程、任务API或状态同步服务。本轮未修改生产源码，因此没有重复跑生产测试套件；这些检查不能代替上述双入口验收。

## 一手来源与本地定位

在线资料：

~~~text
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc-extension-ui.md
https://raw.githubusercontent.com/deepseek-ai/DeepSeek-Harness/1517a4dbca0a2789ff1d41ba439600f8547d23fa/packages/bundle/web-app/README.md
https://raw.githubusercontent.com/deepseek-ai/DeepSeek-Harness/1517a4dbca0a2789ff1d41ba439600f8547d23fa/apps/desktop/README.md
https://www.electronjs.org/docs/latest/tutorial/process-model
https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
~~~

本地重点：

- vendor/pi-1.3.0/packages/coding-agent/src/core/extensions/types.ts：公开模式、输入来源、flag和消息API。
- vendor/pi-1.3.0/packages/coding-agent/src/core/agent-session.ts：sendUserMessage的extension来源及队列。
- extensions/mission-control/index.ts：唯一kernel、公开事件和interactive人工输入识别。
- runtime/kernel.ts：onHumanInput、userControl、recoveryPlan和精确恢复。
- runtime/store.ts、runtime/bridge.ts：owner lock、事务与成员通信边界。
- .reference/sources/deepseek-harness/packages/client/connection/：认证、Host/Origin、连接代次与事件。
- .reference/sources/deepseek-harness/apps/web/package.json、packages/client/web/：前端构建和界面启动。

建议从当前会话的同进程Web API、公开事件流和基础工作台开始。先证明两端共用同一会话及唯一调度核心，再扩展交互与独立Host。

根据这次提供的三张界面图，布局继续向 DSH 收敛：左侧改成应用、工作区和会话导航；顶部显示当前项目、子智能体数量、智能体团队入口和模式；主区域只保留“对话/轨迹”等会话页签。子智能体列表从顶部数量入口打开，团队入口显示成员卡片和共享任务卡片；打开成员后，标题变为“父会话 / 子智能体”上下文，而不是把所有成员长期铺在左栏。这种层级更接近“会话优先、团队按需展开”的使用方式。

本轮新增的 DSH 风格预览已验证：顶部子智能体列表、团队面板、成员上下文切换和共享任务卡片；浅色版截图为 `.reference/artifacts/web-ui-research-2026-10-18/dsh-layout-light.png`，页面错误日志为空。


## 未发布实验记录：第一版传输骨架（现已从插件剥离）

已在插件中增加同进程浏览器入口：`/mission web on [port]`、`/mission web status`、`/mission web off`。服务默认监听127.0.0.1，启动地址带一次性token并换取HttpOnly/SameSite cookie；`/api/session`和`/api/health`提供认证读取，`/api/message`接收认证用户消息，`/api/action`支持认证的pause/resume/stop/reconcile/decision白名单动作。接口回调使用当前MissionKernel和Pi的sendUserMessage，不创建第二个调度核心；浏览器输入另记`web.user-input`和`web.user-control`事件。

这是实验性的传输骨架，页面按钮尚未接入完整API；快照、成员列表、公开历史和SSE仍需继续实现。当前原型也缺少完整的请求会话代次校验、身份/来源与幂等链路，不能当作可投入使用的用户控制界面。用户要求暂不安装浏览器部分后，入口已经从当前插件移除，原型、页面和测试移到独立experiments/mission-web目录。

同时增加持久`business-only`自主策略，默认只让`mission_decision`处理业务边界。实现选择、重试、命令、文件、成员分工和格式属于批准范围内的执行细节，模型应自行决定；用户可以用`/mission policy`查看或切换到`ask-before-irreversible`。`mission_decision(kind="execution")`明确拒绝，默认策略还会拒绝明显属于实现/执行的问题描述，避免截图中“确认是否需要用户裁决”再次变成阻塞。真正的范围、验收、权限、预算、截止、发布和不可逆风险仍然保留用户裁决。

新增回归包括：Mission Web loopback认证、session snapshot、用户消息和动作回调；business-only拒绝执行问题、保留业务问题及策略持久化。完整套件仍需在本轮完成后更新统计。
