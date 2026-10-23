# Pi Mission Control v2

非官方Pi插件包。v2将成员任务、消息交付、Goal和调度收敛到一个持久运行核心：**派发任务即自动登记维护，完成唤醒不要求模型先创建Goal或开启监督器**。

当前版本 **2.5.3**，主对话直接获得55个插件工具。支持默认三级目标树、明确文件/批次范围、阶段依赖和逐项证据验收。子智能体默认没有任务硬截止，主模型按实际任务选择时限、工具和工作区；角色名称不再自动缩减权限。主界面简要显示目标及二、三级验收数，`/mission goals`打开详细看板。独立摘要模型支持限流、断流恢复及缓存；上下文还可切换独立笔记模式。正常工具调用不消耗失败重试额度，临时故障冷却后自动续接。TUI负责操作，静态HTML归档用于离线阅读。恢复工具见[工具接口记录](docs/design/mission-control-v2/TOOLS-2026-10-18.md)，测试边界见[验证记录](docs/design/mission-control-v2/VALIDATION.md)。

2.5.1 修复核查项：主目标验收绑定请求的目标身份；停止前结清活动计时；历史批查在预算裁剪后可用 `nextCursor` 续查，更新对应请求的 `cursor`（读取用 `offset=nextOffset`），再以 `startRequest=nextRequest` 和同一请求数组继续；canonical RPC 超限在任务中保留不含正文的结构化诊断。同版 index 已包含在当前窗口时仅提示版本。详见[修复及隔离验证索引](docs/design/mission-control-v2/REVIEW-FIXES-2026-10-20.md)。

2.5.2 兼容历史工具的空游标占位：首次搜索可以省略 `cursor`，或传空字符串/null；非空游标必须使用工具返回的 `nextCursor`。读取被排除的记忆工具回执时会明确提示改查原始消息，不再误报成记录丢失；无需重建历史索引。

需要 **Node.js 24+、Pi 1.3.x 或 1.4.x**，已验证 Pi 1.3.0 与 1.4.0。Pi 1.4.0 升级验证覆盖 Windows / Node24、WSL / Node24 和 WSL 原有 Node22，以及专用会话的同进程 `/reload`；见 [1.4.0 兼容记录](docs/design/mission-control-v2/PI-1.4.0-2026-10-22.md)。此前另做过原生HTML导出、host命令/进程树和本机Podman验证；本轮未运行需镜像的容器用例。离线provider测试不等于真实模型兼容性认证。

## 安装与切换

```powershell
pi install C:/tools/pi-mission-control
```

本地安装直接加载此目录。新窗口按package.json只加载两个v2入口；旧十个协调扩展不再通过本包清单启用。不要同时启用v1散装扩展和v2。

**v2版本升级直接在原会话执行 `/reload`，不要求重开会话。** 旧目标自动迁入新账本，保留身份、暂停、用量和已有验收证据。运行中的受管成员按既有关闭流程收束并记录中断，不自动重放命令；需要继续时检查保存的结果并显式重试。v1活动任务和旧状态快照不自动导入v2。

这条热加载保证针对插件。升级 Pi 主程序后，已运行进程不会因 `/reload` 替换整个宿主；需要在安全时点退出 Pi，再用 `pi -r` 恢复原会话，才会完整使用新宿主版本。安装或兼容检查不会自动操作正在运行的项目会话。

## 日常使用

可以直接告诉模型：

> 建立CPU执行员与监督员、GPU执行员与监督员。执行员在各自仓库实现和测试，监督员独立审查，组内返工自行闭环。只有阶段交付、真实阻塞或裁决才找主会话。持续推进当前目标，按小时汇报。

模型用`team_spawn`建成员、`team_send`派发。首次派发自动建立工作会话，保存最近用户目标，启用维护、完成唤醒和默认一小时进度检查。`goal_start`只用于补充明确验收条件；是否有Goal不影响成员交付。`goal_update`和`goal_stop`管理目标生命周期，`team_disband`归档成员身份，临时`subagent`在任务收束后自动退出活动成员列表；历史通过`lifecycle_history`保留。

主模型用`mission_wait`结束当前生成，成员继续工作。结果进入持久消息箱，主会话空闲时集中开启一个新回合；忙时不向Pi原生follow-up无限排队。常规成员进度合并保存，不单独唤醒；结果、失败、裁决及计划报告触发处理。

**模型工具不能关闭维护器。** 目标、成员和提醒可以通过明确的生命周期工具更新、暂停或关闭；完成的目标、结束的一次性提醒和临时成员退出活动列表，历史仍可查询。回答临时问题不会改变维护或报告设置。兼容工具`supervisor_control`只能查询状态，`off/interval`会被拒绝。

任务completed表示成员回合收束并保存了交付，不等于产品验收通过。`mission_complete`/`goal_finish`要求无未完成任务、无未交付结果，以及每条验收条件的证据；证据质量仍需模型和用户复核。

## 分阶段目标与逐项验收

可以直接告诉模型：

> 把当前目标按需求与模块清单、模块实现、统一导出、分批功能验收拆成最多三级目标。先登记交付项、验收标准和阶段依赖，再按批次推进；每项完成登记证据。执行细节自行决定，报告已实现、已验收和剩余工作。

主目标算第一级。`goal_plan`批量登记主目标和子目标，支持批内key引用；阶段顺序通过`dependsOn`明确声明并传递给下级，仅排列先后不等于依赖。`goal_focus`选择当前叶子目标，主对话写入/命令和派工必须绑定可执行叶子，成员任务可通过`team_send.goalId`分别绑定并行目标。临时排错记在原目标下，无需为每次修BUG增加层级。

目标完成使用`goal_accept`提交精确版本和逐条证据；插件检查全部验收项、必需子目标、阶段前置条件及相关执行状态。一项目标对应一份当前有效验收记录，可以引用多份文件、任务结果、主对话工具收据或子目标验收。`statement`明确标为模型陈述，不会冒充自动测试结果。默认一次登记即可，重复验收复用记录；修改定义或显式重开目标会撤销受影响的上级及依赖验收，并保留历史。已登记文件在上级验收时检查是否变化，不自动反复调用模型审查。插件不独立证明需求覆盖或测试结论真实充分。

SQLite是唯一正式账本，不要求模型维护MD或JSON文件。当前阶段、焦点、完成数、可执行下一项和未估算项自动进入上下文。详细定义、验收历史、工具收据和任务结果通过`goal_tree`分页读取；长验收标准用`section:"definition"`读取原文。

```text
/mission goals                         # 详细目标树；/mission 的目标页也能进入
/mission goals activate <主目标ID>     # 切换主目标，保留进度、证据和用量
/mission goals export <新文件.json>    # 按需导出全部目标、验收历史和产物引用
/mission goals depth 4                 # 用户授权提高深度；超过三级不建议
/mission goals skip <子目标ID> <原因>  # 用户明确排除范围，历史保留
/mission goals cancel <子目标ID> <原因>
```

详细看板支持↑↓或翻页选择、←→折叠展开、Enter查看证据、a激活主目标、f聚焦叶子，详情页r重新打开目标，Esc返回。主界面的二级/三级完成数只统计当前主目标已验收项；取消和跳过项在详情单列，不计为完成。可记录剩余预计投入区间，未估算项明确显示，不把目标数量比例当作交付日期。主目标完成后不会自动激活另一项；切换需先收束运行与未知进程、消费旧结果，并保留已有控制限制。

模型直接获得`goal_plan`、`goal_tree`、`goal_edit`、`goal_focus`、`goal_accept`、`goal_activate`、`goal_export`七个工具。旧的平面目标调用继续兼容；目标树完成需要精确revision，优先使用`goal_accept`。导出为一次SQLite一致性快照，产物内容保持文件引用；不是包含全部源码与日志的自包含备份。机制见[目标账本设计](docs/design/mission-control-v2/GOAL-TREE.md)。

## 主对话工具如何暴露

统一名单来自Pi的`getAllTools()`宿主注册表。各模块用`registerTool`注册名称、说明和参数schema；入口按本包来源收集工具，在会话启动及每次模型回合请求前更新`setActiveTools`。因此主模型直接收到完整工具定义，无需搜索或先调用发现工具；旧会话reload也会更新名称和参数。子智能体仍按成员入口及权限提供自己的工具。

`mission_capabilities`是可查询目录，列出51个插件工具的名称、说明、启用状态和命令对应关系，也返回待核对任务的epoch及目标revision。查看某个完整参数时传`toolName`和`includeSchemas=true`；不指定名称时，schema响应最多展示前5项，名称目录则默认全部展示。

如果模型只反复查询状态、仍声称必须由用户输入`/mission reconcile`，先看`mission_status.runtime`确认版本及恢复工具可见性。2.0.18起已可直接调用`mission_reconcile`和`mission_control`；重启不会自动证明unknown进程已停止。2.0.19在状态和系统引导最前面给出`recoveryPlan`，修正旧no_progress提示，长状态采用结构化摘录而不切断JSON。模型应先检查宿主进程与产物，再执行计划中的工具；工具实际失败时应报告工具名和原始错误，不能把一次状态查询称作恢复失败。

### 批准范围内自主执行

`business-only`是默认自主策略，意思是模型在已批准的范围内自行决定实现方式、普通重试、命令、文件组织、成员分工和格式，只在范围、验收、权限、预算、截止时间、发布或不可逆风险上请求用户。这是执行工作时的分工规则，不增加文件或系统权限，也不覆盖原有任务约束。升级后默认生效，不需要手动启用。

你可以直接告诉主模型：

> 保持 business-only；批准范围内的实现、重试和分工由你决定。调用 mission_policy 确认并应用，只有超出范围或涉及重大风险时再问我。

模型可直接调用`mission_policy({action:"apply",policy:"business-only"})`；同一调用可重复，保持已有裁决、暂停和预算。也保留用户命令：

```text
/mission policy status
/mission policy business-only
```

待裁决不要求必须回复A/B/C。“这个选择你在已批准范围内自行决定”也可以是有效答复。模型应引用这条新的用户原话并用精确`decisionId`调用`mission_decision(action=resolve)`，说明采取哪种方案；不能仅为取得一个选项字母再次询问。应用策略本身不回答旧裁决，也不自动解除未知或越权事项。

当前插件只提供 TUI 操作界面；此前未发布的浏览器/HTTP 操作原型已移除，不提供浏览器操作入口。

| 能力 | 主对话工具 |
| --- | --- |
| 核对中断执行 | `mission_reconcile`，批量提交精确任务epoch及进程已结束的检查证据 |
| 恢复无进展阻塞 | `mission_control(action=resume)`，核对目标身份及revision，保留预算用量 |
| 给成员发消息 | `team_message`，运行中steer，空闲时创建受跟踪回合 |
| 设置报告间隔 | `mission_report` |
| 压缩及摘要模型 | `mission_compact`、`compaction_model`，主/成员设置分开 |
| 重连设置 | `reconnect_config`，不续期共享故障恢复额度 |
| 公开历史及导出 | `mission_history`分页读取、`mission_export`流式写入新文件 |
| 完成已有工作区迁移登记 | `project_recover`，仅接受与当前会话和目录匹配的持久journal |

用户显式暂停/停止、预算续期以及新工作区授权仍有各自控制，模型工具保留这些边界。目录来源统一不代表任意用户命令都能被模型执行；交互面板、编辑器和复制仍使用Pi的UI入口。

## 用户控制

| 操作 | 行为 |
| --- | --- |
| `/mission` | 打开当前成员列表，每个成员一行；Enter进入公开对话，Tab切换目标/提醒 |
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
| `/mission archive 新目录` | 生成长任务联合归档：目标树、验收证据、成员/任务关联、完整公开正文分卷和离线HTML阅读器；不覆盖已有目录 |

Pi原生Esc继续停止当前主回合，不替换成全局停止；成员继续工作、结果保留，自动唤醒暂时抑制。发送新指令解除这次回合中断抑制；用户通过`/mission pause/stop`暂停时则必须明确resume。详情面板Esc只返回，不取消任务。

原生`/export`、复制、输入框、footer、模型选择和会话树保留。**既有约1GB旧日志仍可能触发Pi原生HTML整体字符串化限制**；v2不改写它，另提供流式公开导出。公开导出是有界可读记录，不是包含所有私有字段的无损备份。

## 实时查看成员

输入框正上方常驻任务看板。宽屏以“类别、名称/内容、状态、时间/进展”四列显示目标、定时任务和子智能体；进度汇报也是独立的定时行。窄屏按类别堆叠显示，仍保留成员状态。看板按终端高度限制为4–10行，超出的成员或提醒在`/mission`工作台查看。进入工作台时看板暂时隐藏，退出后恢复。

输入`/agents`或`/mission`后，用↑↓选择当前成员，Enter进入对应公开对话；每个成员只占一行，历史任务与退役成员不再分段混入列表。Tab切换目标/验收及定时提醒，t打开主会话时间线。更多成员可滚动选择，同一成员的历史会话仍可用对话页的`[`/`]`查看。

对话页使用和主 Pi 对话相同的 Markdown、代码块和工具结果层次，显示任务消息、公开回复、工具参数、返回和错误。成员文字流与工具已经上报的进度会实时显示；工具本身没有进度事件时，需要等它返回，不虚构中间输出。长内容默认折叠，Enter展开；↑↓选择消息、PgUp/PgDn滚动，Home加载更早记录，End回到最新，f暂停/恢复跟随，`[`/`]`切换该成员历史会话。`m`打开 Pi 原生编辑器给当前成员发消息：成员运行时发送 steer，成员空闲时创建新回合。`c`复制当前逻辑消息，不包含边框、分隔线或其他面板内容。Esc先回团队，再退出工作台。主会话正在运行时也可使用这些用户命令。

动作块使用Pi原生主题底色：执行中、成功、错误分别对应宿主工具面板样式，回复保持普通背景。命令直接显示命令文本，编辑显示增删行；`c`复制仍保留完整原始参数，包括未在预览中显示的超时等字段。看板和动作块均不添加竖向边框；工作台使用全屏路由，终端选择时没有邻列的分隔线。

查看器不发模型请求、不接管成员会话、不暂停任务、不确认交付；不提供隐式发送消息或修改权限。只展示公开内容，过滤思考、签名及私有系统正文。日志按LF分页读取，忽略尚未写完的尾记录；窗口、缓存和单条展示均有上限，超大记录会提示略过，不是无损备份或任意日志文件浏览器。

从2.0.x更新无需另开Pi会话。先等成员任务收束并结束当前主回合，再`/reload`，或正常退出后恢复该会话；运行中直接reload仍会将旧执行记为中断。v1状态不会因此自动迁移。若曾加载2.0.7原生时间补丁，撤回后需正常重启一次，清除进程内旧代码。

2.0.3的成员视图存在主题色适配崩溃，2.0.4已修复。若Pi已因此退出，本地路径安装加载更新后，在原工作目录运行`pi -r`选择原会话，再用`/agents`查看；不用删除日志或重建已保存的成员。崩溃前尚未完成的执行仍按中断恢复规则处理。

## 消息时间

成员对话和主会话插件时间线显示每条公开消息的本地时间，跨天补日期；命令显示运行时长/最终耗时，缺少旧时间时明确标注。c复制仍不包含显示时间。

`/mission time`打开带时间的主会话查看页，支持实时公开增量、LF历史分页、暂停跟随与复制，m返回Pi原生输入框。原生主对话保持Pi自己的显示。2.0.7补丁方案已撤回，本机六个文件已恢复；旧维护脚本仅保留status/restore，禁止apply。实现和旧版本清理见[时间机制](docs/design/mission-control-v2/TIMESTAMPS.md)。

## 成员与权限

主模型根据任务选择限制，不机械沿用角色模板。代码审查、实现和验证默认提供授权范围内完整开发工具；`scout/reviewer/planner`只是角色名称，不再自动设成只读。需要只读时显式设置 `workspace.access:"read-only"` 和 `execution:"files"` 或合适的 sandbox。默认成员另有 find、web_search、web_fetch 和只读 goal_context，后者分页读取当前任务的完整标准与范围，不允许修改或验收目标。

可选 `tools:["read","find"]` 明确收窄成员工具；省略时开放当前工作区策略及受信任 workerExtensions 所提供的可用工具，`team_configure(tools:null)`恢复此默认。协调通信与 goal_context 保留；全局目标切换、停止和其他成员管理不作为普通成员工具开放。配置的项目工具属于受信任扩展，其副作用由扩展自身实现；不能把宿主命令或第三方工具宣称为OS级路径隔离。

成员加载自己工作目录适用的项目指令和已配置技能；技能资源目录只额外授予读取，不扩大项目写权限。MCP和其他用户插件不会自动全部启动；需要的项目扩展仍由用户配置 workerExtensions，再按成员工具策略暴露。

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

上下文超限时停止重发原请求，待宿主空闲后尝试压缩。成功保存检查点后恢复原目标；临时网络、限流或服务错误导致的压缩失败保留历史与摘要缓存，按持久冷却时间自动再试。明确取消、密钥、权限或余额错误等待修复，不循环发送相同无效请求。临时连接故障由原生重试、扩展重连和消息重投共同管理，每轮只统计实际失败；健康响应立即清除故障，正常工具调用不消耗失败额度。连续失败触顶后按60秒起步、逐轮加倍、通常最多1小时的间隔重新探测；服务给出的更长Retry-After仍会遵守。重载保留累计用量和下次重试时间，无需再发“继续”。`mission_recover`只核对故障身份和当前恢复条件，不解除用户暂停或增加预算。修改`goal_update`也不会解除这些限制。

普通进度通知耗尽重试后标为已替代；循环提醒合并未处理的旧发生次。结果或失败仍未消费时保留身份和产物，必要时隔离等待明确收集。`observed`仍只在实际请求包含消息且收到成功回复后确认。旧版已知“自动唤醒失败”的attention可迁移恢复；用户暂停、预算限制、无法分类的旧attention和旧waiting_user保留，避免误解锁。

`mission_decision`用于具体业务问题，可用`taskIds`只阻塞指定任务后续启动和复核；已运行回合正常收束。用户答复后，模型用`action=resolve`、精确`decisionId`及用户原答复确认；进度询问和扩展注入不会自动解除裁决。`mission_wait_external`声明外部生产者和带时区的截止时间，返回等待id/token；保存它们后由`mission_signal`通知实际事件，或在截止时唤醒一次。等待期间不产生空继续和例行进度报告，其他提醒仍保留。

重启/reload不重跑旧running/waiting任务，保留interrupted记录并发恢复通知；需要新attempt。未正常收束的成员session退役，下一attempt使用新sessionId，旧日志保留，避免回放缺少toolResult的历史。未启动排队工作、消息箱和提醒意图持久保存。

如果进程结束无法确认，该成员不能直接再次派工。主模型可先检查产物与宿主残留进程，再通过`mission_reconcile`提交精确任务epoch及结束证据；用户也可用`/mission reconcile 任务ID`确认。接口记录调用方的检查，不自行扫描或终止未知外部进程。若目标同时处于`no_progress` attention，检查下一步后用`mission_control`恢复，再以`team_resume`明确创建新attempt；旧命令不会自动重放，已有用量不会清零。

**维护器依赖Pi进程存活。关闭Pi或系统休眠期间不会启动模型回合。** 恢复后扫描到期提醒，循环提醒只补最近一次。没有安装独立服务、Windows计划任务或cron。每轮失败重试有次数上限，之后进入冷却；用户暂停、停止与显式预算耗尽始终阻止自动推进。

默认4并行，任务与目标均没有默认硬截止。模型可以根据实际任务设置固定时限；已有用户配置的正值仍保留。用户配置`<Pi agent目录>/mission-control.json`：

```json
{
  "maxParallel": 4,
  "taskTimeoutMs": 0,
  "progressIntervalMs": 3600000,
  "maxMissionMs": 0,
  "maxAutonomousTurns": 0,
  "maxOutputTokens": 0,
  "recoveryMaxRequests": 11,
  "recoveryCooldownMs": 60000,
  "defaultExecution": "host",
  "workerExtensions": [],
  "inheritEnv": [],
  "searchProvider": "exa"
}
```

自定义provider由扩展注册时，将受信任扩展路径加入workerExtensions；模型不能指定加载任意扩展。Pi的models/auth正文不被插件复制。

`team_send`、`team_broadcast`、`subagent`（包括批量/链条的单项覆盖）和成员向下派工共用时限策略：`timeoutPolicy:"none"`不设执行截止；`"fixed"`配正数`timeoutMs`，不再限于一小时；`queueTimeoutMs`单独约束排队。固定时限累计该任务实际执行的回合，排队及等待下游不计入。单个API、RPC控制请求与命令仍有各自超时；不将心跳或没有输出当成业务进展，也不默认因安静而杀任务。取消、暂停新派工、重载中断及未知进程核对仍有效，原已登记任务保留其时限。

WSL固定回归会话位于 `/home/lishuo/pi-mission-control-test`，与实际开发会话分离；通过其 `open-test-session.sh`恢复。`scripts/test-task-policies-tui.py`在此专用会话中替换候选包，通过同进程/reload检查范围、验收、成员能力和上下文窗口；离线provider还会注入上游故障、非人工aborted、24次工具续接及用户暂停，验证自动恢复与停止边界。

活动计时仅累计主回合或成员实际执行区间，排除重连冷却、裁决/外部等待、暂停和离线时间；主会话连接失败但成员仍在执行时继续计时。旧版没有活动记录的区间不伪装成精确统计；若用户已显式设置时间上限，则保留旧耗时的保守估算。`/mission resume`显式续期本轮限额时仍保留累计活动耗时。旧默认预算阻塞可在重载后解除，已有回合和输出计数保留，真实暂停和显式耗尽的限额不会被自动解除。

`recoveryMaxRequests`为兼容保留原设置名，现限制每轮连续失败数；`maxWakeAttempts`默认3，限制一轮冷却恢复中的探测次数。任一上限触发后保存下次冷却重试时间，不永久等待人工续接。`requests`保留累计请求，`failures`保留累计失败，`burstFailures`单独记录本轮失败；健康响应后结束该故障。故障恢复不重置显式配置的目标预算；成员与摘要请求仍有各自的重试流程，不计作主会话费用上限。超额请求通过Pi上下文入口中止，提供方须遵守宿主AbortSignal；不会自动重放已执行命令或把重连视为业务验收。

## 独立压缩模型

```text
/compaction-model provider/model-id
/compaction-model lead provider/model-id
/compaction-model member provider/model-id
/compaction-model status
/compaction-model off
```

不带范围时，主对话设置当前会话的压缩模型；`lead`明确设置当前主会话，`member`设置当前主会话未来启动的子智能体默认模型。成员对话自己执行命令时，设置的是该成员自己的压缩模型。`off`可关闭对应范围的自定义摘要并恢复Pi默认压缩。

主会话配置保存在当前Mission Control session目录，成员默认配置保存在该session目录的`member-compaction-summary.json`；旧的`PI_COMPACTION_SUMMARY_MODEL`和`<Pi agent目录>/compaction-summary.json`仍作为兼容回退：

```json
{
  "model": "provider/summary-model",
  "maxTokens": 16384,
  "maxInputChars": 24000
}
```

摘要按输入预算分块，使用短中间摘要，再合并成最终摘要。默认`maxInputTokens=64000`、`intermediateOutputChars=3000`、`maxOutputChars=12000`；输入和输出同时受模型窗口、输出上限及显式`maxInputChars`限制。旧配置的24000字符上限仍然有效，升级不会覆盖。通过`compaction_model action=set`可分别调整这些参数和`reasoningEffort`，已有摘要模型时无需再次填写model。预算中的tokens是启发式估算，密集代码可能超过估算值；诊断和实测应以提供方返回的usage为准。

完成块按模型、提示词及内容哈希缓存。未显式填写`maxTokens`时，推理摘要模型默认16384，普通模型默认4096；正文长度目标还会限制为该预算的一半字符数，为思考输出留空间。若默认上限全部耗于思考且输出截断，允许一次提高上限、最高32768 token；显式`maxTokens`不会被提高。摘要截断时缩小该块后重新摘要/合并，正常结束但正文过长时对完整正文再浓缩，空正文有限重试，最多4层恢复；仍失败则取消压缩并保留原历史和成功块，**不裁剪摘要结尾，不接受截断摘要，也不静默回退发送同一个巨型请求**。未配置摘要模型时保留Pi默认压缩。

摘要提示要求逐字保留必要的标识、修订号和续点，并以较晚的明确纠正覆盖旧值。这仍是模型生成的工作记忆，不能保证语义无遗漏；完整原历史持续保留。

滚动压缩先只缩减本轮新历史，旧检查点不再混入大段源码分块。旧摘要和新摘要合计仍在输出长度预算内时，直接按时间追加并保留旧摘要原文；只有超过上限才将短检查点合并压缩。这样减少反复改写旧条目和额外API请求。新旧内容明确标注，较晚的显式纠正优先；修改旧检查点可复用没有变化的源码块缓存。

旧版同名命令、配置文件和环境变量继续有效。主会话中环境变量优先于旧兼容文件；显式的成员范围配置优先于环境变量，保证主对话可以给子智能体选择不同的摘要模型。空白环境值忽略；status会显示主会话和成员默认配置来源及生效预算。当前会话目录的`compaction-diagnostics.json`始终保留最近一次压缩的阶段、上限、结束原因和正文字符数；`PI_COMPACTION_DEBUG=1`另记录详细阶段日志。两者都不写入对话正文、摘要或私有块。

## 实验性笔记换窗

```text
/context status
/context mode notes
/context notes
/context rollover
/context budget 800000
/context budget auto
/context mode summary
```

默认模式为`summary`。`notes`模式由当前工作模型通过`context_note`维护笔记；换窗直接使用已保存的最新`index`和`handoff`，不发送大历史给摘要模型。两种模式在同一Pi会话中切换，模式和笔记在`/reload`后保留。主会话与成员按各自Pi session ID隔离。

`index`最多1500估算tokens，`handoff`最多4000，主题笔记最多8000；读取每页最多2000估算tokens。工具拒绝过长内容并提示整理，不截掉末尾；写入只返回简短回执。仅最新入口和交接笔记自动进入窗口，详细主题笔记按需读取。笔记应记录已知结论、尚未确认的事项、纠正后的精确标识和下一步，不代表验收通过。

换窗另保留最近最多三条真实用户消息的有界原文，总计最多1500估算tokens，以降低模型把纠正后的标识记回旧值的风险。长消息仅带有明确标记的首尾节选及原始消息ID，不冒充完整请求。原文在工作笔记之后按时间排列，较晚的用户明确纠正优先于模型笔记。需要查找更早的指令或纠正时，`context_history`支持`role=user`；模型生成的摘要和重复说法不会混进该筛选。

保存当前入口和交接后，模型可调用`context_rollover`；工具通过Pi回合边界接口保存压缩检查点并继续同一次运行，中途不发出任务结束的settled事件，避免成员被误判完成。取消和reload会使旧的待执行换窗失效。近期保留量读取Pi的`compaction.keepRecentTokens`，切点使用Pi原生算法以保留完整工具调用/返回；保存笔记本身产生的调用和回执不会使交接被误判为过时。用户在空闲时执行`/context rollover`仍走原生手动压缩入口。

笔记模式先从配置窗口扣除输出和安全余量，再在本地输入预算的75%开始准备交接。例如窗口1050000、最大输出128000时，默认本地输入预算889232、准备阈值666924 tokens；它是保守预算，不是线路实测上限。`/context budget 数字`或`context_mode inputLimitTokens`可以进一步降低当前会话、当前模型线路的输入预算，`auto`/0只移除手工覆盖，不删除已观察到的上下文拒绝记录。实际发生上下文超限时可以保守降低该线路的本地预算；429不会被当成上下文容量不足。模式、预算和拒绝记录在reload后保留，不修改Pi模型配置。

达到准备阈值时，扩展在当前工具批次完成后要求模型补齐`index`和`handoff`，暂缓新的项目工具，给换窗留下空间。原生阈值压缩发现缺少或过时笔记时，也只在仍有余量的情况下请求修复。最多两次补充提醒、八个准备回合，计数在reload后保留；取消、额度耗尽或已过满时保留原历史并显示原因，不会反复重发巨型请求、伪造笔记或自动切换摘要模型。明确的新用户回合可重新处理已暂停/耗尽的准备；正常任务不需要每读一个文件就重写笔记。

模型在准备期间反复执行项目工具或只说准备好了而不换窗时，允许有限修复；耗尽后通过Pi的消息错误接口明确报告本次运行失败，使RPC成员不会被登记为成功的空结果。

`context_history`支持当前分支公开历史的字面搜索和按消息ID分页读取，跨换窗保留原始证据；偏移按Unicode字符计数。存储位于`<agentDir>/context-memory/<Pi session ID>/memory.sqlite`，只索引当前会话正常可见的历史和本扩展自己的笔记，不读取目标、任务或其他插件的内部数据库。已保存笔记有版本记录；每次模型请求只带最新入口。

笔记模式仍需模型实际执行保存和换窗，不是零成本记忆，也不保证优于摘要模式。大窗口可用性、信息保留、写入及回查消耗需要针对实际模型线路验证。可复现实验脚本为`scripts/benchmark-context-modes.mjs`，仅手动运行，不属于离线测试套件。

2.5.0支持一次原子保存入口、交接与主题笔记：`context_note(action="write",notes=[{name:"index",text:"..."},{name:"handoff",text:"..."}])`，最多12项、合计16000估算tokens。任一版本冲突则全部不写；正文相同不增加版本，但记录这次显式确认的来源。新窗口注明已完整注入的index/handoff版本，优先直接续读；交接保存当前文件/行、已完成与未完成项、撤回结论和准确主题/历史引用，详细分析留在主题笔记。

`context_history(action="batch",requests=[{action:"search",query:"...",role:"user"},{action:"read",id:"...",offset:0}],budgetTokens=4000)`一次处理最多8项，合计输出预算256–6000估算tokens；`nextRequest`及`nextOffset`提供续读位置。单项旧调用继续有效。

用户配置`mission-control.json`可设置`"memberContext":{"mode":"notes","inputLimitTokens":300000}`，只为新成员会话提供默认值，主对话模式保持自己的设置。独立上下文扩展也可单独接受`PI_CONTEXT_DEFAULTS` JSON，不读取Mission Control数据库。已有会话显式模式、预算及更低的已学习安全上限仍优先；30万预算通常在22.5万准备交接。一批大读取跳过预留区也会进入有界交接，不能继续无声膨胀。修改已有成员预算可在该成员使用`context_mode`或`/context budget`。

动态笔记提示位于历史尾部附近，不插入最后一组工具调用与结果之间，避免在每次index更新或用量变化时破坏整个历史前缀。换窗本身仍会改变前缀，网关缓存路由和保留时间也不由插件控制。排查可用`scripts/audit-prompt-cache.mjs --state-dir <会话状态目录> --session-file <主日志> --since <带时区时间> --until <带时区时间> --output <新文件>`；只读已保存的usage，分成员计算token加权命中率，不导出正文、私有推理或密钥。具体案例见[长任务与缓存修复](docs/design/mission-control-v2/LONG-RUN-CACHE-2026-10-20.md)。

## 公共网页与本地加速器

`web_fetch`默认拒绝私网/本地目标，逐次检查重定向并固定已检查的DNS地址。Steam++等加速器可能将公共域名映射到127.0.0.1；可由用户在`mission-control.json`明确设置：

```json
{"webFetch":{"trustedLocalHosts":["github.com","raw.githubusercontent.com","api.github.com"],"useSystemCa":true}}
```

仅所列精确公共域名、HTTPS 443及回环地址适用该路由；不能因此访问localhost、私网IP、其他端口或重定向内网。`useSystemCa`只为该工具请求合并Node默认及系统信任证书，保持主机名和证书验证，不修改全局TLS、hosts或Node启动参数；因此原会话`/reload`即可加载。证书不可信、映射被拒和上游HTTP错误分别提示。该配置也传给成员。

长成员通过RPC工作时，`agent_end/turn_end`重复快照按流丢弃，不将整段累计历史拼进内存；逐条消息、工具事件、RPC响应和最终`agent_settled`收据继续处理。必要记录仍限长，残缺协议不能伪装为成功结束。

## 工作区切换与改名

```text
/project status
/project switch "D:/projects/another project"
/project rename new-name
/project resolve "D:/projects/old-name/evidence.txt"
```

**目录尚未改名时，直接在当前 Pi 会话执行 `/project rename "新目录名"`，由插件改名并迁移。不要先在资源管理器里手动改名再 `/project switch`；旧 cwd 已不存在时，先恢复原目录名。** `switch` 用于切换另一现有工作区。迁移后先 `/project status` 核对，再 `/mission resume`。

在同一个Pi窗口延续对话，重建新cwd的原生工具、资源和项目指令；保留原会话及备份，新延续会话使用新ID。关闭后可在新目录`pi -r`找到它；自定义会话存储也保留。switch不移动原目录，rename不覆盖既有目标、不能跨盘搬迁；本插件及Pi agent存储须位于被改名目录之外。

迁移先暂停维护唤醒、停止本会话管理的成员执行，再复制主历史、SQLite状态、成员日志、结果文件；2.5.3同时保留本会话独立笔记数据库、模式、预算、笔记版本和压缩模型配置/缓存，回滚不会删除原笔记。主/成员历史正文不全局替换路径。rename只映射原目录内的成员权限路径；switch到另一项目保留成员原授权，不自动授权新目录。迁移后的目标和提醒保持暂停，核对路径后`/mission resume`；已停止任务需明确创建新attempt，不能自动重放。未知进程状态需要先reconcile。

也可以直接用自然语言让AI完成，例如：`把当前工作区改名为“软件仓库开发-新”`，或`把当前会话的工作区切换到“D:\知识库开发\软件仓库”`。插件从当前用户输入生成精确的一次性授权，AI读取`project_status`后调用`project_apply`；不必先输入授权命令。包含空格或标点的名称/路径放在引号内；表述不清楚时AI会用自然语言补问。引用、代码块、旧对话及插件生成的文字不生成授权。

授权绑定当前会话、动作、目标，十分钟过期；新的用户输入、`/reload`及取消会撤销自然语言授权，可直接说`先别改名了`。原有`/project allow rename <名称>`、`/project allow switch <路径>`和`/project revoke`继续可用。TUI/RPC在当前回合保存后切换；排队回执不等于已完成，应以最终工作区提示和`project_status`为准。迁移后保持任务暂停，确认工作区后仍用原有`/mission resume`恢复任务。print/json一次性模式拒绝模型排队迁移，可先执行用户命令。

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
