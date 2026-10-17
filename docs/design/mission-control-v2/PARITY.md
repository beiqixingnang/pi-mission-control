# 旧版能力对照与2.0.2恢复机制

日期：2026-10-17。用户要求补齐重写遗漏，特别是独立压缩模型、对话工作区切换和提供方连接失败恢复。本轮只修改插件与隔离测试，没有替用户重载真实Pi、修改其全局配置或迁移真实项目。

## 能力清单

| 旧能力 | v2状态与入口 |
| --- | --- |
| 独立压缩/分支摘要模型 | 已保留；`/compaction-model`、旧配置文件及环境变量；2.0.2补齐来源提示、预算验证、成员环境传递与阶段debug |
| 对话工作区改名/切换 | 2.0.2恢复`/project rename`、`switch`、`status` |
| 授权模型执行一次工作区操作 | 2.0.2恢复`allow`、`revoke`和`project_apply`，保留十分钟、会话与精确目标限制 |
| 稳定项目身份和旧证据路径 | 复用经核对的identity模块；`project_resolve`、`/project resolve`，补齐registerProject的跨进程锁 |
| 提供方错误兜底重试 | 2.0.2恢复；主/成员同用，默认10次和固定5秒，包含非标准网关错误 |
| 全局停止命令 | 2.0.2恢复显式`/stop`，原生Escape继续只中止主回合 |
| Goal/监督/提醒 | 已由Mission核心合并；结果唤醒不要求模型启用独立开关 |
| 成员状态与对话查看 | 2.0.1已通过`/mission`及`/mission view`提供 |
| 全屏团队工作台与主对话式成员查看 | 2.0.3；`/agents`、Markdown层次、成员输入和逻辑复制 |
| 常驻横向看板、动作底色 | 2.0.5；输入框正上方、目标/定时提醒/成员整行状态、Pi原生工具底色、命令与编辑预览 |
| workspace文件、host、Podman | v2执行工具已提供；不重新启用旧host文件入口映射 |
| 原生导出、复制、会话树 | 保留Pi原生；公开大日志流式导出另外提供，未制作完整复制选择界面 |

旧`/agents`、`/goal`、`/supervisor`等命令并非逐个同名注册，功能归并到`/mission`。不能为了命令名兼容再加载旧入口，否则会重新引入两套状态和唤醒。

## 模型连接失败恢复

`extensions/mission-control/reconnect.ts`分别安装到lead入口与member扩展。它不根据502/429白名单决定是否恢复；`agent_before_settle.outcome=error`会检查恢复配置、预算、取消信号和排队用户输入。上下文超限交回压缩，正常工具错误不触发网络恢复。

默认10次、固定5000ms，用户可通过`/reconnect`命令修改当前会话的SQLite meta配置，或在mission-control.json中设置reconnect。成员启动时由运行核心合并这份配置，通过允许的环境项传入；不复制认证文件。用户没有明确配置enabled时，读取Pi公开SettingsManager得到持久retry.enabled，保留显式禁用意图。

本机Pi1.3.0的原生回合重试在`agent-session.ts._handlePostAgentRun/_prepareRetry`执行，默认3次、2000ms起指数退避、上限60000ms。它先于扩展pre-settle运行。扩展观察每次assistant错误，计算已经使用的连续失败次数，在原生预算耗尽后继续；成功响应重置该失败段。由于扩展不能在原生批次内部强制截断，最后一个原生批次可能略超剩余预算，不把它宣称严格的全链路十次上限。

插件每次等待固定5秒，但不会自动改Pi原生参数。如果用户将原生retry设置为maxRetries=10/baseDelayMs=5000/maxAgentDelayMs=5000，原生部分也按5秒进行。`/reconnect off`关闭额外恢复，不更改原生设置；status明确显示两层。底层HTTP客户端可能另有重试，不能将一次assistant尝试当作一个网络包。

等待绑定ctx.signal和generation；会话关闭、分支变化、用户停止、工作区迁移会中止。等待结束还要再次检查generation、取消及新输入。重连追加有界custom_message并请求下一次提供方回合，不直接调用或重放旧命令；已执行副作用的语义判断仍需模型检查产物。Pi标准provider转换还会跳过errored/aborted assistant，避免将其未完成工具调用重新发送。

## 对话工作区延续

`project.ts`负责用户命令、授权、宿主替换；`runtime/relocation.ts`负责路径验证、备份、LF复制、数据库与文件迁移、journal及回滚。

1. 重新校验source/target、目录包含关系、目标占用、插件安装位置和agent存储。模型授权必须来自本会话且未过期、未消费，不能替换动作或目标。
2. 关闭自动派工和唤醒入口，暂停Mission；取消受管任务树并等进程收束。unknown进程要求人工检查/reconcile，不能盲目移动仍可能被写入的目录。主回合abort并等待idle，排队输入存在时拒绝迁移。
3. 保留原主日志并另存opaque备份。已持久化日志通过文件复制及按LF处理，不join整份历史；新建但尚未写出第一条助手回复的持久会话逐条写快照。--no-session不能迁移。
4. 用SQLite VACUUM INTO建立一致状态副本，复制artifacts和sessions。更换sidecar引用路径，保留成员/任务/交付身份、预算、验收证据及提醒。执行任务已停止，不自动重放。
5. rename真实移动目录，只映射原目录内的成员workspace.root/extraReadRoots及副本日志header.cwd；switch不移动源目录，成员原授权保持不变。用户消息、工具历史、验收证据正文和命令字符串都不全局替换。
6. 创建新主session ID/header.cwd，保留全部历史记录和当前leaf，追加小型位置说明及迁移标记。Pi公开switchSession重建cwd相关工具、资源、上下文；仅process.chdir不足以完成这一步。
7. 宿主切换成功后提交稳定项目身份和会话关联。rename保持同一项目ID；switch进入目标项目ID。旧绝对证据路径可通过registry映射到最新root，路径前缀按段判断，不修改相似名称的兄弟目录。

迁移副本的relocationHold持久保存。普通提问与重启不解除它；目标及提醒需用户`/mission resume`。暂停时不推进到期提醒，恢复按最近周期只补一次，避免积压旧提醒。原生Escape语义不改变，显式`/stop`可停止主回合及成员树。

## 失败与恢复

操作日志在agent目录project-migrations/UUID/migration.json，含动作、路径、备份和新会话位置，不含对话正文。original.jsonl是完整私有备份。

准备失败和原生session_before_switch取消时，撤销本操作创建的延续会话/状态副本，并将改名目录移回。删除范围校验为本操作UUID状态目录；已被另一个运行核心取得owner lock时不删除。原目标或原源被外部操作占用时不覆盖，保留journal。

宿主已开始替换后失败，不能假定旧运行时仍合法；保留新目录、状态副本和备份，输出恢复会话路径。重新打开后可用`/project recover`完成项目身份登记。显式授权会在会话切换后失效，不能靠重放旧授权消息恢复。

TUI/RPC支持模型工具的post-settlement替换。print/json一次性模型调用拒绝排队迁移，避免宿主退出导致静默丢失操作；可直接使用用户`/project`命令。

## 压缩兼容

旧compaction-summary.json的model/maxTokens继续使用，新版maxInputChars控制分块。PI_COMPACTION_SUMMARY_MODEL优先，空白值忽略；命令保存配置时若仍被环境覆盖会说明，不静默声称切换成功。成员环境允许此项及PI_COMPACTION_DEBUG。debug只写阶段/模型，不写提示、总结或内部块。

压缩和branch summary仍通过Pi公开hook接入独立模型；成功块缓存、分层合并、截断拒绝与失败保留原历史不变。错误不会静默回退到同一份巨大默认请求。

## 验证与限制

测试使用隔离agent目录、临时项目和确定性provider，包含真实Pi运行时与子进程。测试次数/延迟可缩短以验证状态机；默认10/5000另有配置断言。完整结果见VALIDATION。

未在用户真实GPT/DeepSeek网关、旧1GB会话或真实硬件仓库上执行迁移；日志复制流式不代表Pi原生载入历史也已变为流式。原生会话加载、外部扩展绝对路径、文件系统句柄、跨盘rename及用户自定义provider行为仍受宿主和操作系统限制。没有增加独立daemon、OS scheduler、日历cron或系统用户级host沙箱。
