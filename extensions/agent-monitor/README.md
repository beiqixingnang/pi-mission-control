# 紧凑智能体状态区

在 Pi TUI 输入框上方显示智能体的活动。新会话自动加载；已打开的 Pi 输入 `/reload` 生效。

默认最多 **3 行**：一行总览，两行成员状态和最近一段可见文本。没有成员时自动收起。超过两项时，每 5 秒轮换显示其余成员。窄窗口自动截断，支持中文宽字符和 emoji。

```text
智能体 3 · 运行 2 · 空闲 1 · 1/2
⠹ 团队 reviewer · 执行中 18s · 工具 read │ 正在检查相关文件…
⠹ 子任务 worker · 执行中 12s · 输出中 │ 已找到需要修改的位置…
```

- 同时支持 `team_spawn` 的持久成员，以及 `subagent` 的单次、并行和链式任务。
- 显示启动、执行、思考活动、工具调用、可见文本输出、空闲、失败和停止。
- 不显示 thinking 正文；“思考中”只来自事件类型。
- 最近 15 秒没有新事件时，转动图标停止，显示“无更新多久”。等待并不自动表示任务失败。
- 普通子任务完成、停止或进程失败后，结果保留约 10 秒再收起。仍在运行的空闲团队成员保留，直到解散。
- 团队任务失败但成员进程仍然存活时，会保留失败状态，供你判断是否重新派活。
- 当前 Pi 1.2.0 的团队客户端子进程退出事件也会被被动监听：意外退出会显示异常，并结束正在等待的任务。这里没有 RPC 轮询，也没有额外模型调用。

## 控制

```text
/agents status
/agents off
/agents on
```

`status` 查看所有成员和完整模型名称，`off` 隐藏小面板，`on` 恢复显示。开关只影响当前会话，重载后默认开启。隐藏显示不会暂停或取消任务。

更新在本地合并绘制，文本事件最多约每 120ms 请求一次重绘；计时约每秒刷新。RPC、JSON 和 print 模式不会安装 TUI 小面板。重载、切换会话或分支时会清理界面状态和定时器。

## 验证

```bash
node --unhandled-rejections=strict --test ~/.pi/agent/extensions/agent-monitor/tests/monitor.test.mjs
node --unhandled-rejections=strict ~/.pi/agent/extensions/agent-monitor/tests/live-monitor.mjs
```

第二条使用真实的 Luna 团队成员和 DeepSeek 普通子智能体，会消耗两次任务的模型用量，并记录本地状态事件及三行界面的逐帧文本。测试报告默认写入临时目录，也可通过 `PI_MONITOR_TEST_OUTPUT` 指定目录；Pi 安装目录可通过 `PI_TEST_PACKAGE_DIR` 覆盖。
