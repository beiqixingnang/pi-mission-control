# Goal 模式与团队自动唤醒

适用于当前安装的 Pi 1.3.0。扩展位于 `~/.pi/agent/extensions/goal` 与 `~/.pi/agent/extensions/team`，启动新会话会自动加载。已打开的 Pi 输入 `/reload` 后生效。

## 开始一个目标

```text
/goal start 修复登录失败的问题 | 原复现步骤通过 | 相关测试通过
```

第一段是目标，后面的每一段是验收条件。不提供 `|` 时，目标本身作为一个验收条件。也可以自然语言要求使用 Goal 模式，主模型可调用 `goal_start` 设置目标和验收条件。

```text
/goal status
/goal pause
/goal resume
/goal stop
```

- `status` 显示进度、验收条件、预算和后台任务。
- `pause` 暂停主模型自动推进；成员可以继续执行，结果保留，暂停期间不唤醒主模型。
- `resume` 继续未完成的目标，并重新授予一份预算；如果成员尚未完成，继续等结果。
- `stop` 结束目标，取消该目标的后台任务，阻止尚未开始的排队任务执行。已经发生的文件修改不会撤销。
- 按 Escape 中断主模型，也会暂停目标，避免自动续跑抵消你的中断。

默认每次预算为 **20 次自动续跑、60 分钟、100000 个主模型输出 token**。后台成员的 token 不计入此项预算；它们仍有各自的任务超时。达到上限会暂停，使用 `/goal resume` 明确继续。预算在模型调用/轮次边界检查，单次响应可能超过 token 上限。

需要可执行验收检查时，`start` 可接受 JSON：

```text
/goal start {"objective":"修复项目的类型错误","criteria":["类型检查通过"],"verificationCommands":["npm run typecheck"],"maxContinuations":15,"maxMinutes":45,"maxOutputTokens":80000}
```

主模型通过 `goal_finish` 提交每个验收条件的证据。它也可以在目标仍未完成时调用 `goal_update` 修改目标、验收条件、验证命令或预算；修改后旧的证据和成员结果会清除。调用 `goal_stop` 会保留历史并取消该目标的后台任务，适合清理遗留目标。`goal_update` 和 `goal_stop` 都需要当前 `goalId`，可先调用 `goal_status` 获取。

配置过的 `verificationCommands` 会在完成前通过当前会话的 `bash` 工具执行，每条最多 30 秒；任一检查失败都不会标记完成。会话必须启用 `bash`。没有配置命令的条件，由主模型提交的证据记录完成情况，不构成独立的程序验证。

## Supervisor 控制

监督器默认关闭且只在当前会话有效。用户可以使用 `/supervisor on|off|status|interval <seconds>`，主模型也可以调用 `supervisor_control`，动作是 `on`、`off`、`status` 或 `interval`；周期限制为 1 到 3600 秒。它只在活动 Goal 或后台任务存在时唤醒主模型，不会创建系统级后台任务。


普通团队任务也可以使用，无需开启 Goal：

```json
{"to":"worker","message":"完成分配的任务并报告结果","wait":false}
```

`team_send` 和 `team_broadcast` 的异步调用返回任务编号。主模型可以结束当前回合；结果通过扩展消息自动触发下一轮，不需要循环查询。

异步调用可选 `notify`：

| 值 | 普通团队行为 |
| --- | --- |
| `batch`（默认） | 等待当前需要通知的普通后台任务完成后合并唤醒 |
| `immediate` | 每项任务完成后送达 |
| `off` | 保存结果，不自动通知 |

Goal 任务统一由 Goal 控制器处理：等待该目标的全部后台任务完成后唤醒；暂停或停止的目标不会被结果唤醒。`notify` 和 `/team-wake` 控制的是普通团队通知，不覆盖 Goal 的状态。

```text
/team-wake status
/team-wake off
/team-wake on
```

关闭普通团队通知时，已有通知会保留；重新打开后送达。`notify:off` 的单项任务不会在打开开关后补发。最近 100 项已完成任务可通过 `team_collect({jobIds:["任务编号"]})` 查询，避免同一成员后续回复覆盖旧结果。原有按成员 `names` 收集最新回复的方式继续支持。

在 Goal 中，模型应先完成异步派发，再**单独**调用 `goal_wait` 结束主回合。不要把 `goal_wait` 与其他工具放在同一批调用中。完成、失败和超时结果都会返回；失败后由主模型决定修复、重新派发或报告阻塞。

## 会话恢复与运行范围

Goal 状态和证据保存在当前 Pi 会话的 `goal-state` 条目中，并跟随会话分支。退出、重载、切换会话或浏览另一分支会关闭原有团队，避免旧结果进入新上下文。恢复的未完成 Goal 会暂停，使用 `/goal resume` 后重新派发中断的工作。

等待时主模型不持续推理，但 **Pi 进程需要保持运行**。本实现不提供退出 Pi 或重启电脑后继续执行的独立后台服务。测试使用 `--no-session` 的会话不会保存恢复状态。

团队扩展通过 `team/rpc.ts` 避开 Pi 1.2.0 `RpcClient.promptAndWait` 的未处理超时拒绝缺陷。此修复覆盖本团队扩展的调用，没有修改 npm 包；其他自行调用原方法的扩展仍需自行处理。

## 测试

```bash
node --unhandled-rejections=strict --test ~/.pi/agent/extensions/goal/tests/goal-team.test.mjs ~/.pi/agent/extensions/goal/tests/team-wake.test.mjs
node --unhandled-rejections=strict ~/.pi/agent/extensions/goal/tests/live-team.mjs
```

Windows 默认从 `%APPDATA%/npm/node_modules/@earendil-works/pi-coding-agent` 加载 Pi；其他位置可设置 `PI_TEST_PACKAGE_DIR`。

真实集成测试会消耗模型用量：Sol 作为主模型，Luna 与 DeepSeek 为成员，分别写入临时文件。测试强制主模型先结束回合，检查完成后自动唤醒，再刻意结束一次未完成目标的回合，检查 Goal 自动续跑，最后执行文件内容检查并验收。只记录生命周期、工具结果和最终答案，不导出 thinking 正文。
