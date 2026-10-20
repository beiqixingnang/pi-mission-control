# 2.5.0 核查修复索引（2.5.1）

核查基线为 `9de5a976f87de78111ace8900803ba03699544a3`。修复于 2026-10-20 开始，2026-10-21 完成验证；候选分支为 `codex/review-contract-fixes`。机器可读记录见同目录 `REVIEW-FIXES-2026-10-20.receipt.json`。

| 编号 | 修改及行为 | 正例、负例与证据 |
| --- | --- | --- |
| PLUGIN-01 | `runtime/kernel.ts`、`extensions/mission-control/index.ts`：root 验收携带请求的确切 ID，在同一事务内检查当前 mission ID、mission revision 和目标 revision；root/child 统一返回验收记录。 | `goals.test.mjs` 检查 A 选中时验收 B 被拒绝，六张持久表完全不变；正确 A 验收及同 revision 幂等；错误 revision、执行中、unknown、未交付结果、用户/工作区 hold、待决事项均被拒绝。`pi-integration.test.mjs` 通过真实 Pi 公开工具检查失败没有部分提交，重复返回原验收 ID。 |
| PLUGIN-02 | `runtime/kernel.ts`、`runtime/activity-clock.ts`：停止意图生效时先结清活动尾段、更新 root 时间，再等待取消和归档；结束时钟在 tick、close、reload 和下一目标中保持原样。 | `activity-clock.test.mjs` 验证 running 4000 ms 精确累计，paused/waiting/cooldown/offline 不增计，重复结算不双计。`kernel.test.mjs` 延迟取消 20 秒且返回 unknown，结束计时及 unknown 执行收据都保留。验收完成的 root 也覆盖 close/reload/new root。 |
| PLUGIN-03 | `runtime/context-memory.ts`、`extensions/mission-control/context-memory.ts`：先缩短 Unicode 摘录，保留命中 ID/role/position；用持久密钥签名的 keyset 游标续查。批查只跳过真正完成的请求，公开 schema 增加 `cursor`/`startRequest`。 | `context-memory.test.mjs` 覆盖 256-token 长中文/emoji、预算强制裁掉命中的跨页、混合 search/read 逐字续读、真零命中，以及 query/role/session/branch/篡改游标拒绝。追加历史和 reload 保持游标有效。`context-pi.test.mjs`、WSL TUI 验证公开工具和同进程 `/reload` 后分页。既有 role=user、codepoint 偏移和工具回显排除测试保留。 |
| PLUGIN-04 | `runtime/rpc-records.ts`、`runtime/rpc-worker.ts`、`runtime/types.ts`、`runtime/kernel.ts`：增加 `protocolDiagnostic`，含 code、白名单 eventType/unknown、实际 limitBytes、observedBytesLowerBound、1-based LF recordIndex，持久到失败任务。 | `rpc-records.test.mjs` 覆盖任意 chunk 的大重复快照、canonical message_end/response/agent_settled 超限、嵌套/未知 type、EOF 残缺、正文 secret 不进入错误。真正启动合成 RPC 子进程触发默认 8 MiB 限制，验证失败及重载后的诊断。真实 Pi 成员连续读取、多次 notes 换窗、SSE 重试、无重放及 settlement 既有测试全部保留。 |
| PLUGIN-05（可选） | 两个 notes compaction 入口在 details 保存 index/handoff 的 revision 和 source；仅在当前分支最新 checkpoint 的精确版本确已投影时省去尾部 index 正文。 | `context-memory.test.mjs` 验证版本、来源、投影 role/时间/完整 summary、缺元数据、分支和新版。`context-pi.test.mjs` 在实际离线 provider 收到的上下文中计数，覆盖首次注入、两个换窗入口、新版及 reload；旧 checkpoint 无元数据时仍保守注入。稳定前缀和完整工具对原回归保留。 |

历史分页的继续方式：更新 `requests[nextRequest]` 的 `cursor=nextCursor` 或 `offset=nextOffset`，把相同数组及 `startRequest=nextRequest` 交给下一次 `context_history(action="batch")`。游标属于本会话、query、role 和分支，正常追加新消息不会失效；切到不包含原来源的分支会明确拒绝。read 的 Unicode codepoint 语义保持不变。

| 实际环境 | 命令 | 最终结果 |
| --- | --- | --- |
| Windows，Node 24.16.0，Pi 1.3.0 | `node scripts/test-v2.mjs` | 287 项：283 通过、4 项容器测试跳过、0 失败；exit 0 |
| WSL Debian，隔离 Node 24.16.0，Pi 1.3.0 | `node scripts/test-v2.mjs` | 287 项：283 通过、4 项容器测试跳过、0 失败；exit 0 |
| Windows、WSL | `node scripts/typecheck-v2.mjs` | 各 38 个源码文件严格类型检查通过；exit 0 |
| Windows、WSL | `node scripts/check.mjs` | 两入口、55 个插件工具加载，无错误；exit 0 |
| WSL 专用测试会话 | `python3 scripts/test-task-policies-tui.py BASELINE CANDIDATE TEST_HOME` | 60 项检查通过；实际先加载 2.5.0，再在同一 Pi 进程多次执行字面 `/reload` 加载 2.5.1；exit 0 |

所有运行数据来自临时目录或既有 WSL 专用测试会话。测试包括实际 Pi 1.3.0 SDK、成员 RPC 进程和交互式 TUI，但模型 provider 是确定性离线夹具；没有向实际模型网关发送请求。四项容器用例需要显式镜像，默认全套中按设计跳过，本轮未执行容器验证。没有测试 macOS、真实网关性能或硬件源码语义。

测试期间修复了一处离线夹具问题：合并通知可能同时含旧提醒和新故障，原夹具总取首条 `V2_TEST`，会忽略本轮新故障。夹具改为在合并通知中选最新命令，成功后的普通维护不再重放故障；保留原失败日志，增加真实 Pi 回归，未放宽次数或恢复状态断言。该修改只作用于测试 provider。

按仓库安装规则，在 Windows/WSL 完整回归、严格类型检查、入口加载以及专用 TUI 同进程升级通过后更新安装目录。用户的生产硬件 Pi 会话、账本、源码与 Qoder 输出不作测试对象；安装后由用户选择时机在原会话执行 `/reload`。
