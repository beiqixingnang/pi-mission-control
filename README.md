# Pi Mission Control v2

非官方Pi插件包。v2将成员任务、消息交付、Goal和调度收敛到一个持久运行核心：**派发任务即自动登记维护，完成唤醒不要求模型先创建Goal或开启监督器**。

当前版本 **2.0.11**，时间功能恢复为纯插件实现：成员显示时间，主会话通过插件时间线查看，不修改Pi程序。验证结果见[验证记录](docs/design/mission-control-v2/VALIDATION.md)。真实模型网关兼容、整夜运行和各平台实际工具链仍待验收。

需要 **Node.js 24+、Pi 1.3.x**。本轮在Windows / Node24.16 / Pi1.3.0做了真实Pi离线provider、成员RPC、原生HTML导出、host命令/进程树和本机Podman验证。GitHub Ubuntu也已执行离线套件；离线provider测试不等于真实模型兼容性认证。

## 安装与切换

```powershell
pi install C:/tools/pi-mission-control
```

本地安装直接加载此目录。新窗口按package.json只加载两个v2入口；旧十个协调扩展不再通过本包清单启用。不要同时启用v1散装扩展和v2。

切换前先在旧窗口停止成员任务并退出Pi，再开启新窗口。**不要在真实测试或命令仍运行时直接 `/reload`。** v2不导入并重跑v1活动任务，不改写旧主/成员日志。v1代码仍在Git历史和当前未启用目录中。

## 日常使用

可以直接告诉模型：

> 建立CPU执行员与监督员、GPU执行员与监督员。执行员在各自仓库实现和测试，监督员独立审查，组内返工自行闭环。只有阶段交付、真实阻塞或裁决才找主会话。持续推进当前目标，按小时汇报。

模型用`team_spawn`建成员、`team_send`派发。首次派发自动建立工作会话，保存最近用户目标，启用维护、完成唤醒和默认一小时进度检查。`goal_start`只用于补充明确验收条件；是否有Goal不影响成员交付。`goal_update`和`goal_stop`管理目标生命周期，`team_disband`归档成员身份，临时`subagent`在任务收束后自动退出活动成员列表；历史通过`lifecycle_history`保留。

主模型用`mission_wait`结束当前生成，成员继续工作。结果进入持久消息箱，主会话空闲时集中开启一个新回合；忙时不向Pi原生follow-up无限排队。常规成员进度合并保存，不单独唤醒；结果、失败、裁决及计划报告触发处理。

**模型工具不能关闭维护器。** 目标、成员和提醒可以通过明确的生命周期工具更新、暂停或关闭；完成的目标、结束的一次性提醒和临时成员退出活动列表，历史仍可查询。回答临时问题不会改变维护或报告设置。兼容工具`supervisor_control`只能查询状态，`off/interval`会被拒绝。

任务completed表示成员回合收束并保存了交付，不等于产品验收通过。`mission_complete`/`goal_finish`要求无未完成任务、无未交付结果，以及每条验收条件的证据；证据质量仍需模型和用户复核。

## 用户控制

| 操作 | 行为 |
| --- | --- |
| `/mission` | 打开团队任务树工作台，可选择成员进入公开对话；Tab切换目标/提醒 |
| `/mission view 成员名` | 直接打开指定成员的对话查看器 |
| `/agents [成员名]` | 打开全屏团队工作台，或直接进入指定成员 |
| `/mission status` | 查询当前状态 |
| `/mission time` 或 `/mission timeline` | 打开当前主会话的公开时间线，显示保存时间和工具耗时 |
| `/mission start 目标 \| 条件一 \| 条件二` | 主动建立明确目标；派发任务也会自动建立 |
| `/mission pause` | 暂停新派工和主会话唤醒，已运行成员可收束，结果保留 |
| `/mission resume` | 用户明确恢复，并给予新的接续预算 |
| `/mission stop` | 取消任务树和受管执行，保留身份及证据 |
| `/stop` | 明确停止主回合和当前任务树；保留Pi原生Escape语义 |
| `/mission report 3600` | 设置常规进度间隔，不改变完成/失败通知 |
| `/mission schedules` | 查看持久提醒 |
| `/mission unschedule ID` | 结束指定提醒，不影响任务维护 |
| `/mission reconcile 任务ID` | 检查并停止残留进程后，用户确认unknown执行已结束，允许新attempt |
| `/mission export 文件.jsonl` | LF流式导出主/成员公开历史，过滤私有块与重复状态 |

Pi原生Esc继续停止当前主回合，不替换成全局停止；成员继续工作、结果保留，自动唤醒暂时抑制。发送新指令解除这次回合中断抑制；用户通过`/mission pause/stop`暂停时则必须明确resume。详情面板Esc只返回，不取消任务。

原生`/export`、复制、输入框、footer、模型选择和会话树保留。**既有约1GB旧日志仍可能触发Pi原生HTML整体字符串化限制**；v2不改写它，另提供流式公开导出。公开导出是有界可读记录，不是包含所有私有字段的无损备份。

## 实时查看成员

输入框正上方常驻横向任务看板，显示目标、进度汇报时间、最近定时提醒，以及每个成员的状态和当前工具。成员各占一整行，没有左右分栏；看板按终端高度限制为4–10行，超出的成员在`/agents`工作台查看。进入工作台时看板暂时隐藏，退出后恢复。

输入`/agents`或`/mission`后，用↑↓选择任务或成员，←→折叠/展开下游任务，Enter进入对应公开对话；Tab切换目标/验收及定时提醒，t打开主会话时间线。更多成员可滚动选择。

对话页使用和主 Pi 对话相同的 Markdown、代码块和工具结果层次，显示任务消息、公开回复、工具参数、返回和错误。成员文字流与工具已经上报的进度会实时显示；工具本身没有进度事件时，需要等它返回，不虚构中间输出。长内容默认折叠，Enter展开；↑↓选择消息、PgUp/PgDn滚动，Home加载更早记录，End回到最新，f暂停/恢复跟随，`[`/`]`切换该成员历史会话。`m`打开 Pi 原生编辑器给当前成员发消息：成员运行时发送 steer，成员空闲时创建新回合。`c`复制当前逻辑消息，不包含边框、分隔线或其他面板内容。Esc先回团队，再退出工作台。主会话正在运行时也可使用这些用户命令。

动作块使用Pi原生主题底色：执行中、成功、错误分别对应宿主工具面板样式，回复保持普通背景。命令直接显示命令文本，编辑显示增删行；`c`复制仍保留完整原始参数，包括未在预览中显示的超时等字段。看板和动作块均不添加竖向边框；工作台使用全屏路由，终端选择时没有邻列的分隔线。

查看器不发模型请求、不接管成员会话、不暂停任务、不确认交付；不提供隐式发送消息或修改权限。只展示公开内容，过滤思考、签名及私有系统正文。日志按LF分页读取，忽略尚未写完的尾记录；窗口、缓存和单条展示均有上限，超大记录会提示略过，不是无损备份或任意日志文件浏览器。

从2.0.x更新无需另开Pi会话。先等成员任务收束并结束当前主回合，再`/reload`，或正常退出后恢复该会话；运行中直接reload仍会将旧执行记为中断。v1状态不会因此自动迁移。若曾加载2.0.7原生时间补丁，撤回后需正常重启一次，清除进程内旧代码。

2.0.3的成员视图存在主题色适配崩溃，2.0.4已修复。若Pi已因此退出，本地路径安装加载更新后，在原工作目录运行`pi -r`选择原会话，再用`/agents`查看；不用删除日志或重建已保存的成员。崩溃前尚未完成的执行仍按中断恢复规则处理。

## 消息时间

成员对话和主会话插件时间线显示每条公开消息的本地时间，跨天补日期；命令显示运行时长/最终耗时，缺少旧时间时明确标注。c复制仍不包含显示时间。

`/mission time`打开带时间的主会话查看页，支持实时公开增量、LF历史分页、暂停跟随与复制，m返回Pi原生输入框。原生主对话保持Pi自己的显示。2.0.7补丁方案已撤回，本机六个文件已恢复；旧维护脚本仅保留status/restore，禁止apply。实现和旧版本清理见[时间机制](docs/design/mission-control-v2/TIMESTAMPS.md)。

## 成员与权限

```json
{
  "name": "cpu-executor",
  "role": "在批准范围内实现、测试并保存证据",
  "model": "provider/model-id",
  "thinkingLevel": "max",
  "workspace": {
    "root": "D:/projects/cpu",
    "access": "read-write",
    "execution": "host"
  },
  "communication": { "allow": ["cpu-reviewer"] }
}
```

通信ACL是有向的，发送者allow必须包含接收者；双方互通需分别配置。成员始终可向lead发分类note。组内`team_message`创建下游任务，`team_wait`结束成员回合，下游完成后自动恢复同一成员会话复核。向祖先重新派工会拒绝，应使用note。

| execution | 文件工具 | 命令能力 |
| --- | --- | --- |
| `files` | 工作区路径、读写和链接检查 | 无命令，适合只读调查/审查 |
| `host` | 仍经过受控路径工具 | bash、Windows powershell拥有宿主用户权限；不是OS沙箱 |
| `sandbox` | 同样有路径检查 | 显式本机Podman镜像、快照、禁网络、资源限制及产物写回；失败不回退host |

普通可写执行员默认host，只读成员默认files。read-only+host会拒绝，因为命令能写宿主文件。环境仅继承系统运行项、已知provider密钥变量和用户显式inheritEnv；这不等于不同OS用户的凭据隔离。

容器配置示例：

```json
{
  "root": "D:/projects/cpu",
  "access": "read-write",
  "execution": "sandbox",
  "sandbox": {
    "engine": "podman",
    "image": "本地镜像ID",
    "cpus": 2,
    "memoryMb": 2048,
    "maxSeconds": 600
  }
}
```

不会自动安装Podman、下载镜像或修改系统策略。Windows bash可能是WSL，原生Windows路径/工具优先用powershell；容器用镜像内`/bin/sh`。

`subagent`支持单次、tasks并行、chain依赖顺序，同样自动维护。scout/planner/reviewer默认files只读。`team_cancel`只取消指定子树或成员工作；`team_resume`在审查证据后创建新attempt。

2.0.1兼容可选字段被填为null、空数组和空容器配置的调用：空tasks不会遮住有效chain，空chain不会把并行任务变成依赖链。多个非空任务模式会明确拒绝；有效容器配置与files/host冲突仍会拒绝，不自动提升权限。派工前先校验全部条目，避免参数错误产生半支团队。

## 恢复和持续运行边界

状态保存于`<Pi agent目录>/mission-control/v2/<sessionId>/state.sqlite`，大输入/交付在artifacts，成员Pi日志在sessions。owner lock阻止同会话被两个窗口同时调度。

重启/reload不重跑旧running/waiting任务，保留interrupted记录并发恢复通知；需要新attempt。未正常收束的成员session退役，下一attempt使用新sessionId，旧日志保留，避免回放缺少toolResult的历史。未启动排队工作、消息箱和提醒意图持久保存。

如果进程结束无法确认，该成员不能直接再次派工；先检查和停止残留进程，再用`/mission reconcile 任务ID`明确确认。它不会自行终止未知外部进程。

**维护器依赖Pi进程存活。关闭Pi或系统休眠期间不会启动模型回合。** 恢复后扫描到期提醒，循环提醒只补最近一次。没有安装独立服务、Windows计划任务或cron。失败恢复有退避与次数上限，预算耗尽明确显示需要处理。

默认预算：4并行、每任务10分钟、主任务12小时、200次自动接续、2,000,000主模型输出token，不含所有成员完整计费。用户配置`<Pi agent目录>/mission-control.json`：

```json
{
  "maxParallel": 4,
  "taskTimeoutMs": 600000,
  "progressIntervalMs": 3600000,
  "maxMissionMs": 43200000,
  "maxAutonomousTurns": 200,
  "maxOutputTokens": 2000000,
  "defaultExecution": "host",
  "workerExtensions": [],
  "inheritEnv": [],
  "searchProvider": "exa"
}
```

自定义provider由扩展注册时，将受信任扩展路径加入workerExtensions；模型不能指定加载任意扩展。Pi的models/auth正文不被插件复制。

## 独立压缩模型

```text
/compaction-model provider/model-id
/compaction-model status
/compaction-model off
```

保留`PI_COMPACTION_SUMMARY_MODEL`和`<Pi agent目录>/compaction-summary.json`：

```json
{
  "model": "provider/summary-model",
  "maxTokens": 4096,
  "maxInputChars": 24000
}
```

按有界字符预算逐块摘要、分层合并，完成块按内容哈希缓存。截断、空结果、工具调用或错误会取消本次压缩并保留历史与缓存，**不静默回退发送同一个巨型请求**。未配置时保留Pi默认压缩。

字符预算是保守估算，不等于所有provider的精确tokenizer；真实模型/网关仍需分别验证。

旧版同名命令、配置文件和环境变量继续有效。环境变量优先于文件，空白环境值忽略；status会显示配置来源。`PI_COMPACTION_DEBUG=1`保留阶段诊断，只记录模型与阶段，不写入对话正文、摘要或私有块。摘要模型设置也会传给成员进程。显式环境变量仍覆盖命令写入的配置，界面会给出说明。

## 工作区切换与改名

```text
/project status
/project switch "D:/projects/another project"
/project rename new-name
/project resolve "D:/projects/old-name/evidence.txt"
```

在同一个Pi窗口延续对话，重建新cwd的原生工具、资源和项目指令；保留原会话及备份，新延续会话使用新ID。关闭后可在新目录`pi -r`找到它；自定义会话存储也保留。switch不移动原目录，rename不覆盖既有目标、不能跨盘搬迁；本插件及Pi agent存储须位于被改名目录之外。

迁移先暂停维护唤醒、停止本会话管理的成员执行，再复制主历史、SQLite状态、成员日志、结果文件。主/成员历史正文不全局替换路径。rename只映射原目录内的成员权限路径；switch到另一项目保留成员原授权，不自动授权新目录。迁移后的目标和提醒保持暂停，核对路径后`/mission resume`；已停止任务需明确创建新attempt，不能自动重放。未知进程状态需要先reconcile。

AI执行工作区操作仍需要用户给一次性授权：`/project allow rename <名称>`或`/project allow switch <路径>`，然后使用`project_apply`。授权绑定当前会话、动作、目标，十分钟过期；`/project revoke`撤销。TUI/RPC在当前回合保存后切换；print/json一次性模式拒绝模型排队迁移，可先执行用户命令。

备份与日志在`<agentDir>/project-migrations/<操作ID>/`。准备失败或原生取消切换会回滚；宿主已替换后失败则保留恢复会话和日志，按提示重新打开，必要时`/project recover`完成项目身份登记。迁移复制按LF处理，Pi原生接入仍会加载历史；未在旧1GB会话上实测热迁移。

## 模型连接失败恢复

新增重连适用于主模型和成员模型，默认**10次、插件每次固定等待5秒**。不按502/429白名单筛选；提供方以error失败的自定义错误同样重连。取消、停止、切换会话会中止等待；上下文超限由压缩流程处理，工具执行错误不作为网络重连。

```text
/reconnect status
/reconnect on
/reconnect retries 10
/reconnect delay 5
```

这些用户命令将本会话设置保存到运行状态，后续成员继承。也可在`mission-control.json`中设置`"reconnect": {"enabled": true, "maxRetries": 10, "delayMs": 5000}`。没有显式enabled时尊重Pi持久配置中的retry.enabled。

Pi1.3.0自带的模型回合重试默认3次、2秒起指数退避、最长60秒，主要覆盖它识别的临时错误；插件在原生恢复结束后补充兜底。已经观察到的原生失败会计入同一连续失败预算，避免再乘上十个原生批次，但当前原生批次仍可能略超剩余额度。插件的5秒不改变原生等待参数，`/reconnect off`只关闭插件兜底；状态页分开列出两层。它们都不保证网络恢复、不会重启退出的Pi，也不主动重放已执行命令。

若希望Pi原生等待也固定为5秒，可自行在Pi的settings.json配置：

```json
{"retry":{"enabled":true,"maxRetries":10,"baseDelayMs":5000,"maxAgentDelayMs":5000}}
```

插件不会自动改写全局Pi设置。次数指提供方请求回合，不是底层HTTP库的每个网络包。

## 联网与提醒

`web_search`默认向Exa公开MCP发送查询文本；可用`searchProvider=brave`和BRAVE_API_KEY，或`searxng`和searchUrl。默认联网工具在lead，files/sandbox成员不自动获联网能力。

`web_fetch`限制public HTTP(S)、体积和重定向，检查每跳并固定已验证DNS地址连接。仅提取有界文本，不替代浏览器。返回来源/时间不代表事实已验证；服务失败明确返回错误。

2.0.6已通过真实Pi会话调用默认Exa搜索与Pi官方文档抓取，结果进入后续模型上下文。两项专用工具目前只注册给主会话；host成员可通过宿主命令联网，files/sandbox不因此获得联网能力。实现、配置与实测边界见[联网记录](docs/design/mission-control-v2/NETWORK.md)。

`schedule`支持含时区ISO一次性时间、afterSeconds或everySeconds固定间隔，也支持通过ID更新、暂停、恢复和删除；任务推进与消息入箱在同一事务完成，独立于Goal。daily/weekly/cron日历规则暂未提供，everySeconds=86400不能当成DST安全daily。

## 验证与资料

```text
npm ci --ignore-scripts --legacy-peer-deps
npm run check
npm run typecheck
npm test
```

容器实测需设置PI_SANDBOX_TEST_IMAGE为已有镜像，再运行`node scripts/test-v2.mjs tests/v2/container.test.mjs`。测试使用临时目录和离线provider，不调用真实模型。

- [产品与验收规格](docs/design/mission-control-v2/PRODUCT.md)
- [实现机制](docs/design/mission-control-v2/TECH.md)
- [旧版能力对照与恢复机制](docs/design/mission-control-v2/PARITY.md)
- [实施与验证记录](docs/design/mission-control-v2/MILESTONES.md)
- [完整验证结果与局限](docs/design/mission-control-v2/VALIDATION.md)
- [参考机制调查](docs/research/2026-10-17-agent-mechanisms/README.md)
- [安全边界](SECURITY.md)

许可证MIT。旧版`/goal`、`/supervisor`及`/agents`界面由`/mission`统一替代；不同时加载旧入口。
