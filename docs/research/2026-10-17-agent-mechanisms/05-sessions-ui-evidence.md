# 会话存储、公开证据、复制与 TUI 观察机制

日期：2026-10-17。本章解释本轮证据怎样产生，以及复制/导出为什么不能与模型上下文或会话 fork 混用。只读源码和已脱敏日志派生材料，没有读取内部推理正文或私有 system 正文，没有执行导出、剪贴板写入或真实软件测试。

## S1：先区分五种不同视图

| 视图 | 包含什么 | 不足以证明什么 |
| --- | --- | --- |
| 磁盘会话 JSONL | 消息、压缩、状态快照、上下文编辑、分支关系等 | 文件体积不等于模型输入体积 |
| 当前分支 | 从 leaf 沿 parentId 回到根的记录 | 当前分支全部记录仍不等于当前模型上下文 |
| 压缩/编辑后的宿主投影 | 最近摘要、保留尾部及 context_edit 的替换/移除 | 尚未反映所有扩展 context hook 与 provider 序列化 |
| 模型出站请求 | system、messages、工具 schema、provider 特定字段和转换 | 模型输入也不代表模型一定按其正确协调 |
| 用户界面/公开 transcript | 用户和助手公开文本、工具调用与返回、可见通知 | 不能凭界面状态证明进程仍在运行、消息已消费或证据已验证 |

Pi 1.3.0 的 [sessionEntryToContextMessages](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/core/session-manager.ts#L439) 对普通 `custom` 返回空数组；`custom_message` 则转成 custom role 消息，经 [convertToLlm](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/core/messages.ts#L148) 变成 user role 的 content。它不会把 details 自动拼成正文。工具结果同样要区分 `content` 和扩展附加元数据。

[buildContextEntries](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/core/session-manager.ts#L476) 按当前叶子选分支，再以最近 compaction 的 firstKeptEntryId 留尾部。[buildSessionProjection](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/core/session-manager.ts#L543) 收集 context_edit，对目标 entry 应用 content replacement 或 omission。私有 system 和摘要、普通对话、状态快照在这个阶段的作用不同。

## S2：原始 1 GB 日志的体积和关联范围

本次按用户给定的主会话 ID 读取主日志，再遍历全部历史 team-roster 的成员 sessionId，关联旧式含精确主 ID 的成员文件名。共 7 个源文件：主日志和 6 个持久成员会话，合计 1,063,568,447 字节。GPU 有重建前后两个身份，所以 6 个成员会话不代表 6 个同时存在的角色。

主日志：1,018,692,336 字节，4,683 条 LF 记录，其中：

| 类别 | 字节数 | 条数 |
| --- | ---: | ---: |
| team-roster | 939,827,868 | 1,810 |
| goal-state | 60,994,102 | 981 |
| message | 17,401,654 | 1,784 |
| 其他 | 468,712 | 108 |

重复状态快照占 98.2458%。这与 [team.persist](../../../extensions/team/index.ts:264) 每次追加 members、jobs、taskTree、deliveries、board 的完整集合相符。其最大单条原始记录约 1.3 MB；LF 流式读取仍需为单条记录分配解析对象，但不需要分配整份文件的字符串。

Pi 1.3.0 本身的 [loadEntriesFromFile](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/core/session-manager.ts#L627) 也按缓冲块找 LF，避免读成单一字符串；**但它仍把全部解析 entries 保存在数组中**。所以“流式读文件”不等于“恢复全会话常数内存”。本轮分析程序只保留摘要、必要的当前状态、字节索引；完整原始记录不复制到新日志中。

审计产物分为：行号/偏移 SQLite 索引、按记录类型计数、公开文本有界摘录、状态变化、活动分支、元数据上下文投影。公开文本单段截断为 16,000 字符，嵌套列表也有界；因此它们不是原日志的无损替代。

## S3：不能根据快照里的大对象断言“模型收到了它”

`team-roster` 可能保存所有任务输入、旧 reply、权限等，并每次重复写入。如果只读 JSONL 全量长度，就会错误归因于模型上下文膨胀。相反，如果模型调用 `team_tree` 或 `goal_status`，工具返回的 content 包含其中一部分状态，它确实可以进入上下文；context hook 也可能附加目标提醒。

本轮的 metadata-only 投影按 Pi 1.3.0 规则得到 654 条贡献记录，不导出 system 正文和 reasoning。它表示“这份 session 在最后叶子可投影成什么”，不表示已还原过去每次真正出站请求。没有请求录制就无法从磁盘快照完整证明：当时实际启用了哪些 tools、provider 改写了什么字段、重试传了多少字节、限流由哪一层返回。

另外，记录中 assistant:error、toolResult.isError、任务 failed、RPC timeout、底层进程退出码属于不同层。本次 taskTree 中有 6 个约十分钟 member timeout 且 processState=unknown，不能推断它们的硬件测试进程已经退出；“调用超时”与“副作用已停止”需要独立证据。

## S4：现有 TUI 是事件投影，不是执行权威

[agent-monitor:update](../../../extensions/agent-monitor/index.ts:124) 把事件保存到本地 Map。状态枚举 starting/working/idle/done/error/stopped 是插件报告值；界面没有通过操作系统逐项探测任务进程。terminal 项目在 10 秒后被 prune，Map 超过 100 会优先清终态（同文件 34–37）。这适合轻量状态展示，不是完整审计日志。

成员对话查看器 [openViewer](../../../extensions/agent-monitor/index.ts:87) 发 `agent-monitor:history` 查询事件，由 team 同步挂上 RPC `getMessages()` 的 Promise，返回后调用 visibleHistory。它不是直接打开成员磁盘记录，也不是当前主模型的上下文。

[visibleHistory](../../../extensions/agent-monitor/history.ts:3) 只保留最近 200 条消息，限定 user/assistant/toolResult/custom；text 留正文，toolCall 只显示工具名，thinking/签名/图片被排除。每条可见内容截取后 12,000 字符。因此在 TUI 看不到某段较早交付，不等于它没有在磁盘中；工具参数的显示信息也不完整。

同文件 [linesForHistory](../../../extensions/agent-monitor/history.ts:28) 使用 `content.split("\\n")` 分隔字面反斜杠 n，而上游组合常用真实换行 `"\n"`。这是静态观察到的显示路径细节；是否表现为具体换行异常取决于 wrapTextWithAnsi 的处理，本轮未运行 TUI 验证，不能直接宣布视觉故障。

Pi还区分公开session事件与扩展handler事件。[`_appendCustomMessage`](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/core/agent-session.ts#L2361) 对API直接追加的消息先写session，再通过 `_emit` 发public message_start/end；[`_emit`](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/core/agent-session.ts#L1039) 只遍历公共订阅者。扩展的 `pi.on('message_end')` 由 `_handleAgentEvent → _emitExtensionEvent → emitMessageEnd` 派发，不是同一个事件出口。当前Team普通通知的triggerTurn:false路径只触发前者，所以Team的扩展级ACK监听不会在这一步执行。界面能看到消息而delivery仍false，在当前实现中可以同时成立。

Pi 的自定义 event bus [createEventBus](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/core/event-bus.ts#L12) 是 EventEmitter：emit 返回 void，handler 被包在 async safeHandler 中且异常只记录。同步监听器在第一个 await 前对 query 对象赋值，调用方马上读这个赋值可以工作；**emit 不会等待一个异步处理完成，也不会把监听器失败抛回业务调用方**。这对 team:scope、team:before-wake、history 查询和取消回收的调用顺序很关键，不能把事件广播当成可靠事务提交。

## S5：Pi 的“复制消息”“导出会话”“fork 会话”是三套机制

### 复制到剪贴板

[handleCopyCommand](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L6655) 优先复制全屏 TUI 的活动选择区（仅当调用参数 preferSelection 等条件满足），否则 `getLastAssistantText()` 只取最后助手的公开文本。会话树界面另有 [selector.onCopy](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5710) 复制所选消息。

[copyToClipboard](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/utils/clipboard.ts#L86) 尝试 native clipboard、平台命令、WSL/远程 OSC52。OSC52 编码长度上限为 100,000（同文件 9–26），它只是终端 escape 发送，不能保证远端剪贴板确实已写入。Windows/WSL 还涉及 Unicode 传输和本机/终端剪贴板目标。因此复制体验问题至少分选择范围、文本生成、平台传输、终端限制四层，不能都归结为 session 存储。

### 导出 HTML

[SessionData](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/core/export-html/index.ts#L130) 含整个 entries、leaf、可选 systemPrompt 和工具 schema。`generateHtml` 在 [160 行](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/core/export-html/index.ts#L160) 整体 JSON.stringify，再 Base64，然后替换进单个 HTML 字符串。

因此 JSONL 读取已经按 LF 分块，也不能防止这个导出阶段对全部 entries 做巨型单字符串化。原日志 L4648 的 Invalid string length 与这条路径匹配；本轮没有重现原生导出栈，归类为强源码支持的解释。该导出还可能包含私有或工具配置正文，不能不经筛选就当“公开对话”分享。

### fork / 复制会话身份

[SessionManager.forkFrom](https://github.com/beiqixingnang/pi-mission-control/blob/a796417cfd213d22e11852be273779bdceb78d15/vendor/pi-1.3.0/packages/coding-agent/src/core/session-manager.ts#L1815) 加载源全部 entries，创建新 sessionId/new header，并 parentSession 指向源文件，再逐条复制非 header entries。它复制的是**全部历史记录**，包含 custom 状态和其他分支，不是“只复制当前模型上下文”或“只复制公开文字”。它也不会自动把任务外部副作用撤销、重建团队权限或重新关联所有插件身份。这个机制仅作为复制语义的补充参考，不等于用户要求改善剪贴板功能的最终方案。

## S6：第三方 transcript 值得参考，但现成读取器不适合 1 GB

gotgenes monorepo 的 [session-tree.resolveBranches](../../../.reference/sources/plugins/gotgenes--pi-permission-system/packages/pi-session-tools/src/session-tree.ts:55) 用 parentId walk 标识 live/all 分支，避免将回退前的已弃分支误当当前对话。[format-transcript](../../../.reference/sources/plugins/gotgenes--pi-permission-system/packages/pi-session-tools/src/format-transcript.ts:35) 只抽 text/tool-call，略过 thinking，system 只显示结构计数，并标识 context_edit。

但 [readSessionFileEntries](../../../.reference/sources/plugins/gotgenes--pi-permission-system/packages/pi-session-tools/src/session-file.ts:28) 明确使用 `readFileSync(file, "utf-8")` 再 split LF。它适合参考 transcript 的内容选择与分支归属，**不能直接用于用户这份 1 GB 日志**。功能完整度或下载量不能替代大型输入的实现核对。

## S7：DSH 的公开文本提取与完整日志导出也是不同产品面

[extractSessionEventText](../../../.reference/sources/deepseek-harness/packages/session-query/session-query/src/extraction.ts:15) 对 user/assistant/tool-call/tool-result/todo 等明确事件抽取语义文本；reasoning、request header、结构事件和未知扩展事件默认不贡献搜索文本。这是为搜索定义的选择，不等于把原始会话物理日志删掉。

DSH 的 [session-log-export/archive.ts](../../../.reference/sources/deepseek-harness/packages/session-query/session-log-export/src/archive.ts:347) 可把根会话及 lineage 子会话放进 ZIP，图片/附件去重，导出前对活跃会话做 flush barrier。`streamSessionLogZip` 使用 fflate、WHATWG ReadableStream 和消费背压，响应队列高水位为 64 KiB，压缩输出可增量产生并取消。

**需要纠正常见误读**：ZIP 输出是流式，不代表单份 session-log 是 LF 常数内存。当前 [readSessionLogText](../../../.reference/sources/deepseek-harness/packages/session-query/session-log-export/src/archive.ts:148) 读取整个逻辑事件序列并 `serializeSessionLog`；后者把 JSON 字符串数组 join 成一份字符串（110–136）。`sessionLogZipEntries` 接受预先串行化的 rootContent，并一次持有一个子会话正文。因此它避免“全部 ZIP 一次缓冲”，但仍有**单会话大字符串**的限制，不能未经修改就宣称解决用户 1 GB 场景。

## S8：本轮证据可复核性与保留规则

本轮读取主会话与 6 成员时，源文件大小/修改时间未变化；清单保存读取前缀 SHA-256。私有块跳过统计可检查审计程序是否工作，但数量本身不暴露正文。任务状态变化记录保留原行号，后续可以按 offset 读取指定 LF 记录；默认只读取脱敏派生摘录。

公开摘录并非可以对外公开发布的数据。长期机制文档保存源码位置、版本、流程和脱敏事实；原始用户路径、完整对话、完整输入/交付和系统提示继续只在本机忽略目录中。后续重构与测试应引用这些事实，而不是重新用“1 GB = 1M 模型上下文”之类的假设替代它。
