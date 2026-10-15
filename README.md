# Pi Mission Control

适用于 Pi 1.2.0 的本地功能包。支持 Windows 与 WSL/Linux，包含：

| 功能 | 用法 |
| --- | --- |
| 持久智能体团队 | `team_spawn`、`team_send`、`team_broadcast`、`team_disband` |
| 后台完成后唤醒 | 异步派活 `wait:false`；完成/失败自动送回主对话 |
| Goal 模式 | `/goal start`、`status`、`pause`、`resume`、`stop` |
| 紧凑 TUI 状态区 | 默认最多 3 行；`/agents on|off|status` |
| 成员工作区限制 | `workspace.root`、`access`、`extraReadRoots` |
| 普通子智能体 | `subagent` 的单次、并行和链式模式 |
| 压缩模型路由 | `/compaction-model` 查看/设置；默认使用配置中的 DeepSeek 模型 |

包内自带 `worker`、`planner`、`scout` 和 `reviewer` 预设。用户 `~/.pi/agent/agents` 中同名定义优先，项目定义仍需按原有方式显式启用。无需把包内 agents 复制到用户配置目录。

## 导入

解压 ZIP 后，进入包目录的上级目录运行：

```bash
pi install ./pi-mission-control
```

也可以使用绝对路径：

```bash
pi install /path/to/pi-mission-control
```

Windows 示例：

```powershell
pi install C:/tools/pi-mission-control
```

这是 **本地路径安装**：Pi 在个人 settings.json 中记录包目录并直接加载，不会把代码复制到另一个目录。因此安装后请保留该目录；可以先把它放到固定的 tools 目录再安装。

当前已打开的 Pi 输入 `/reload`；新会话会自动加载包里的工具、参数和关键使用规则。完整 README 不会自动全文加入模型上下文。

检查或移除：

```bash
pi list
pi remove /path/to/pi-mission-control
```

`.tgz` 是 npm 格式归档，可以先 `tar -xzf pi-mission-control-1.0.0.tgz`，再 `pi install ./package`。Pi 的本地路径安装按目录发现资源，这里不依赖直接导入压缩文件的行为。没有向 npm 或 Git 服务发布这个包。

## 已经安装散装扩展时

不要同时启用原来的散装目录和本包，否则相同的工具/命令可能重复注册。当前这台电脑的 Windows 与 Debian WSL 共用同一个 agent 配置目录（WSL 的 `~/.pi/agent` 是符号链接），在一边改个人配置会影响另一边。

本次导入验证使用独立的测试配置，未自动迁移或覆盖你正在用的散装扩展。迁移时先备份并移走旧的 `agent-monitor`、`compaction-model`、`goal`、`subagent`、`team`、`workspace` 六个扩展目录，再安装本包。

## 模型与默认设置

本包不包含 API 密钥、models.json、auth.json、settings.json、会话记录或测试输出。导入目标 Pi 应自行配置所需模型。

团队成员可以使用该 Pi 已配置的任何兼容聊天模型。现有真实模型测试使用：

- `provider/lead-model`
- `provider/member-model`
- `provider/provider/model-id`

压缩模型默认值是 `provider/provider/model-id`。没有该模型时会回退到 Pi 的正常压缩。也可以通过 `/compaction-model provider/model-id` 设置适合目标环境的模型。

重试设置由目标 Pi 自己管理，**安装包不会修改全局重试、模型或思考等级**。若需要此前使用的“最多重试 5 次”，手动合并以下设置到目标的 settings.json：

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 5,
    "baseDelayMs": 2000,
    "maxAgentDelayMs": 60000,
    "provider": { "maxRetries": 0 }
  }
}
```

## 快速使用

```text
/goal start 完成任务 | 验收条件一 | 验收条件二
/agents status
/team-wake status
/compaction-model
```

可以直接告诉模型：“创建一个 DeepSeek 成员，只读这个目录”。创建成员的工作区参数示例：

```json
{
  "workspace": {
    "root": "/home/me/project",
    "access": "read-only",
    "extraReadRoots": ["/home/me/shared-docs"]
  }
}
```

Windows 使用 `C:/projects/example` 这类原生路径；WSL 使用 `/home/...` 或 `/mnt/c/...`。配置是共享的也不代表文件路径能在两种系统中原样互用。

工作区限制是文件工具层限制，受限成员不能执行主机命令、MCP 或再派生智能体；它不是操作系统沙箱。当前没有实现可执行命令的沙箱后端，`execution:sandbox` 会报错而不降级为主机执行。

详见各功能说明：

- [Goal 与唤醒](extensions/goal/README.md)
- [TUI 状态区](extensions/agent-monitor/README.md)
- [工作区访问限制](extensions/workspace/README.md)

## 验证

需要目标机器已安装 Pi；无需安装本包的 peer dependencies，它们由 Pi 提供。

```bash
npm run check
npm test
```

`check` 验证六个扩展入口可加载；`test` 使用临时配置执行回归测试，不访问模型 API，也不修改用户全局设置。

有模型配置时可额外运行真实测试（会产生模型用量）：

```bash
node extensions/goal/tests/live-team.mjs
node extensions/agent-monitor/tests/live-monitor.mjs
node extensions/workspace/tests/live-workspace.mjs
```

真实测试使用 Pi 当前配置与上述模型名。测试会把报告放到系统临时目录，支持 `PI_GOAL_TEST_OUTPUT`、`PI_MONITOR_TEST_OUTPUT`、`PI_WORKSPACE_TEST_OUTPUT` 覆盖。

如果自动查找不到 Pi 安装目录，设置 `PI_TEST_PACKAGE_DIR`，例如：

```bash
PI_TEST_PACKAGE_DIR=/home/me/.local/lib/node_modules/@earendil-works/pi-coding-agent npm test
```

## 限制与兼容性

- 已针对 Pi 1.2.0 验证。依赖该版本的扩展 API、RPC 与生命周期行为；升级 Pi 后应重新运行测试。
- 等待时主模型不持续推理，但 Pi 进程必须保持运行。退出 Pi 后不会继续运行后台团队。
- 恢复未完成 Goal 时会暂停，需 `/goal resume` 并重新派发中断工作。
- 本包团队调用使用安全 RPC 等待封装，规避 Pi 1.2.0 的未处理超时拒绝缺陷；不会修改 Pi 安装包。
- 包使用 MIT 许可，部分基础实现改编自 Pi 的 MIT 示例，见 [NOTICE](NOTICE.md)。
