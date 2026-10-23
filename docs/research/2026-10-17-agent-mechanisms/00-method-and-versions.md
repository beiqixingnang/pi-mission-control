# 调查方法、版本与术语

> 历史研究，基准日期为 2026-10-17。当前开发已统一到 Pi1.4.0；本文保留原版本结论，旧源码链接固定到本仓库历史提交。当前源码见 `vendor/pi-1.4.0/`。

## 0.1 调查范围与顺序

用户要求按“看源码摸清机制 → 制定实现计划 → 编写 → 测试”的顺序推进。本轮只完成第一阶段。最初的 `.reference/DISCUSSION.md` 是需求和候选问题整理，**不是已经决定采用的架构**。

调查采用固定源码快照，追入口、核心数据、执行端和结果路径；同时阅读对应测试源码了解原作者预期，但不把“存在测试文件”写成“本次测试已通过”。用户授权并行调查，本轮使用 3 个 `gpt-6-luna`、reasoning effort=`max` 子智能体分别负责执行生命周期、隔离权限、上下文/provider；主会话负责 Goal、调度、会话观察与结果交叉核对。

没有替换当前插件、删除旧实现、修改用户全局配置、启动模型实验、安装参考依赖、启动外部服务或实际沙箱。新增的分析脚本只处理既有本地脱敏证据和文档。

## 0.2 证据等级

| 标识 | 依据 | 能支持的结论 |
| --- | --- | --- |
| 源码已确认 | 追到固定提交的真实调用链及条件 | 在这些代码条件下会怎样执行；不等于跨平台运行已验收 |
| 日志已观察 | 用户指定会话的公开文本、工具调用/返回、状态记录 | 这次历史会话中发生过什么；状态快照不自动等于模型看见 |
| 源码和日志相符 | 机制与对应身份/时间/返回一致 | 强支持某条解释；仍不能还原没有记录的进程内瞬间 |
| 注释或文档声明 | README、注释、工具描述 | 原作者意图或使用约定；必须与实际执行端交叉核对 |
| 未证实假设 | 表象、单次报错、未录制的请求 | 保留为未来实验问题，不能当作根因 |

典型例子：pi-subagents 的 parent-wake 注释描述某些旧宿主不会在 sendMessage idle wake 时运行 before_agent_start；本地 Pi 1.3.0 源码和安装后 JS 都能追到该 hook，因此不能仅凭注释认定当前宿主仍有该问题。

## 0.3 固定版本

| 项目 | 固定提交/版本 | 本地参考路径 |
| --- | --- | --- |
| 当前插件 | `c34e32fec02d43808c2e4d8b313017dba2347993` | 仓库 `extensions/`，另有 `.reference/local-baseline/` |
| Pi 本机基准 | 1.3.0 | `vendor/pi-1.3.0/`；本机安装 package.json 同为 1.3.0 |
| Pi 上游 | `8efd314fa3d3232ce197d8d7a6a5660530b9d83e` | `.reference/sources/pi/` |
| Codex | `e16b631d08cdf82773831f9bbfb793da687d5299` | `.reference/sources/codex/` |
| DeepSeek Harness | `1517a4dbca0a2789ff1d41ba439600f8547d23fa` | `.reference/sources/deepseek-harness/` |
| pi-subagents | `f8ada81303db6ee76ed22fee5605dc8a8d62a83a`；发布 0.78.0 | `.reference/sources/plugins/pi-subagents/` |
| pi-web-access | `b3f676d8448ede197d8cd22589beeb9e44f1cf44`；发布 0.41.0 | `.reference/sources/plugins/pi-web-access/` |
| billion-context | `269accde8bcdf994a0dcf7fdda58494736074b20`；发布 0.1.197 | `.reference/sources/plugins/billion-context/` |
| pi-mcp-adapter | `efe943e637e503e10af382d0ace1aec834989c69`；发布 5.3.1 | `.reference/sources/plugins/pi-mcp-adapter/` |
| pi-goal-x | `64c5ace87f3400c0b55ef87f2d2912167f53dbaa`；发布 0.32.3 | `.reference/sources/plugins/pi-goal-x/` |
| pi-background-tasks | `799182ff65d7040732aea23b2001ea860b688531`；发布 2.6.10 | `.reference/sources/plugins/pi-background-tasks/` |
| gotgenes 权限 monorepo | `085d8bb9d36ff57fe8c155f6da8ce8b86ad42087`；权限包 40.2.2 | `.reference/sources/plugins/gotgenes--pi-permission-system/` |
| pi-web-search | `6b69f3fbd562840308025a2e4bcb749ecaede768`；发布 1.7.0 | `.reference/sources/plugins/pi-web-search/` |
| agent-comms | `0faf73b095815bf68e6749fa5696b7e457a7484f`；发布 8.13.20 | `.reference/sources/plugins/agent-comms/` |
| pi-harness-runtime | `4f3dc3fd0d7ae0f4b1720ffb6300cf323d6401ed`；发布 1.1.318 | `.reference/sources/plugins/pi-harness-runtime/` |

源码 HEAD 与发布版本可能不同。采集时同时保存指定 npm `.tgz`、元数据并核对 SHA-512 integrity 和 SHA-1 shasum。校验表示下载内容与 registry 元数据一致，不表示安全审计。pi-goal-x 的 goal-scheduler、goal-runtime、goal-events、goal-state 已按文本归一化比较，HEAD 与 0.32.3 发布文件一致；CRLF/LF 的字节差异不能当作逻辑差异。

热门程度依据是 2026-10-17 `pi.dev/packages` 首页默认 Most downloads 显示的月下载量，选择相关包作为参考；不是全站完整排名，更不是代码正确性证明。

## 0.4 核心术语

| 术语 | 本文含义 | 容易混淆的另一概念 |
| --- | --- | --- |
| session | 可持久化对话身份及其记录 | 正在运行的 OS 进程 |
| Agent 实例 | 本次进程中的活动会话执行对象 | 同 ID 的旧实例或磁盘记录 |
| 成员名称 | 用户/模型可读的团队名字 | sessionId、taskId、processId |
| 激活代次/epoch/generation | 区分重建、取消、恢复前后的执行资格 | 任务业务内容是否相同 |
| task/job | 一次有范围和身份的工作 | 成员整个生命周期 |
| attempt | 同一工作的一次执行尝试 | 新工作或旧交付重放 |
| delivery | 一次消息或结果投递身份 | 对应任务一定完成并通过验收 |
| queued | 已放入某一层队列 | 已持久化、已被模型读取 |
| claimed/admitted | 已领取/已允许进入当前模型步骤 | 模型已经成功处理结果 |
| acknowledged | 按特定实现标记已确认 | 业务完成、 exactly-once |
| idle | 特定宿主的运行资格为空闲 | Goal 完成、没有子进程、没有未来计划 |
| wait | 可能是工具等待、结束回合、inbox等待或逻辑目标状态 | OS 线程阻塞或不断轮询 |
| sandbox | 操作系统/容器等强制执行约束 | 提示词、工具名单或 cwd |
| worktree | Git 的独立工作目录/状态管理 | 进程与安全隔离 |
| compaction | 重新构建后续模型上下文的摘要/裁剪 | 删除整个历史磁盘记录 |
| transcript | 为人或分析工具生成的可见文本投影 | 原始事件日志或出站请求 |

## 0.5 日志与隐私处理

用户指定的主日志按二进制 LF 流式解析，每次 JSON.parse 一条记录；没有把约 1 GB 文件整体读成一个字符串。通过所有历史成员索引关联 6 个持久成员会话。原始日志不复制、不修改、不上传。

内部推理块、签名、私有 system/developer 正文、成员私有 systemPrompt 和凭据字段不进入报告。工具结果中的嵌套会话数据也做结构过滤。长期文档只保留脱敏的聚合计数、错误类型、源码位置和少量公开行为证据；可定位的完整派生材料保留在 `.reference/analysis/`。

这次主日志覆盖插件多次更新和一次 Pi 升级。因此某个历史报错只证明对应时点发生过故障，不能自动认定当前 HEAD 仍然同样报错。主 AI 的自述可以证明它说过什么，不能单独证明它对系统的解释是对的。

## 0.6 本文没有覆盖的证明

- 没有为任何 provider 做真实推理/工具协议兼容性认证，没有验证用户网关的请求转发。
- 没有在各操作系统实际启动并攻击/验证沙箱，没有测试硬件工具链在沙箱下可用性。
- 没有启动 Codex/DSH/Pi 的参考测试套件，测试源码仅作预期行为证据。
- 没有取得 Codex 桌面应用全部内部源码，不能从公开仓库缺少某个调度文件推断产品完全没有该能力。
- 没有因其他项目有完备状态设计就直接决定照搬；实现方案在后续阶段另定。

## 0.7 复核与更新方式

源码引用优先给具体函数和行号，行号只对本章固定提交有意义。长期复核时可以按上述提交重新取得仓库；本插件和 Pi 1.3.0 代码已在本仓库内。`.reference/catalog/` 保存采集元数据，`.reference/SOURCE_MAP.md` 保存更多本地阅读入口。

可移植的来源清单另保存在本目录 [source-lock.json](source-lock.json)，不包含用户日志或密钥。专题中的 `<repo>/` 表示本仓库根目录；指向 `.reference/` 的链接仅在参考源码仍存在于本机时可直接打开。参考目录未随 Git 提交时，可按清单中的仓库和提交重新取得源码。

正式更新本调查时，应记录：上游新提交、受影响函数、旧结论是否仍成立、是否运行过实验，以及新增不确定项。不要只替换版本表而保留未经重新核对的行为描述。
