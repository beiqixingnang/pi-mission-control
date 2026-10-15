# 成员工作区限制

团队成员与普通子智能体现在都可选择独立的受限工作区。新启动的 Pi 自动加载；当前会话输入 `/reload` 后工具参数更新。

## 两种目录用法

- 只设置 `cwd`：保留 Pi 原有行为，改变启动目录和相对路径起点，不限制访问其他目录。
- 设置 `workspace`：授权主目录及额外只读目录，通过受控文件工具执行任务，禁止主机命令和再次派生智能体。

未指定 `workspace` 的主对话和成员行为保持原样。当前主 Pi 没有额外的逐次确认扩展，仍使用启动它的 Windows 用户权限；本功能不会添加全局执行确认弹窗。

可以直接对主模型说：

```text
派一个 DeepSeek 成员，只读 D:/projects/backend，另外可以读取 D:/projects/shared-docs，不允许访问其他目录。
```

创建团队成员对应的参数：

```json
{
  "name": "reviewer",
  "role": "后端只读审阅",
  "model": "provider/provider/model-id",
  "workspace": {
    "root": "D:/projects/backend",
    "access": "read-only",
    "extraReadRoots": ["D:/projects/shared-docs"],
    "execution": "disabled"
  }
}
```

工作目录默认就是 `root`。如需从内部子目录开始，可同时指定 `cwd`，但必须位于 `root` 内。

普通子智能体：

```json
{
  "agent": "worker",
  "task": "检查并修复这个目录里的类型声明，不运行命令。",
  "workspace": {
    "root": "D:/projects/backend",
    "access": "read-write"
  }
}
```

普通子智能体支持单次、并行和链式模式。可以在顶层设置所有任务共用的工作区，也可以在每个 `tasks[]` 或 `chain[]` 中单独指定。优先级：单项任务 > 调用顶层 > agent 文件预设。这里的覆盖由不受限的主模型负责；受限成员没有再派生智能体或扩大授权范围的工具。

## 参数

| 字段 | 含义 |
| --- | --- |
| `root` | 必填；已存在的主目录，相对路径以主模型的 cwd 为起点 |
| `access` | `read-only` 或 `read-write`，默认 `read-write` |
| `extraReadRoots` | 最多 20 个额外只读目录；不能与主目录互相包含 |
| `execution` | 默认 `disabled`；主机 Bash、PowerShell、脚本执行及外部工具不可用 |

受限成员可以使用读取、目录列表、文件查找和文本搜索；可写成员还可创建和编辑文件。工具在子进程中名为 `workspace_read`、`workspace_write` 等，确保限制扩展加载失败时不会自动获得普通同名工具。正常调用时主模型只需要指定 `workspace`。

如果额外设置 `tools` 白名单，请使用 `read`、`ls`、`find`、`grep`、`write`、`edit` 这些名字，启动器会映射到受控工具。请求 `bash` 等不支持的工具会在启动前报错；只读成员请求 `write`/`edit` 也会报错。受限模式下 `tools: []` 表示不提供工具。agent 预设中显式包含 `bash` 的也需要移除该项。

`execution: "sandbox"` 已预留，但本机没有配置沙箱后端，会明确拒绝启动，**不会降级成主机执行**。本次没有安装 Docker 或其他系统组件。

## agent 文件预设

```yaml
---
name: backend-reviewer
description: 后端只读审阅
model: provider/provider/model-id
workspace:
  root: D:/projects/backend
  access: read-only
  extraReadRoots:
    - D:/projects/shared-docs
---
实际读取代码后报告问题，不修改文件。
```

存在但写错的 `workspace` 配置会报错，不能悄悄变成不受限成员。相对目录预设以调用方主模型的 cwd 为起点，建议持久预设使用绝对路径。

## 路径和运行行为

- 每次实际文件访问都会检查路径范围；`../` 和绝对路径不能绕过授权。
- 不遍历符号链接、Windows junction 和硬链接文件，避免通过链接接触目录外内容。
- Windows 的 UNC、设备命名空间、ADS、驱动器相对路径、8.3 短路径和尾随点/空格别名不接受。
- 写入 `.pi`、`.agents`、`.git`，以及 Pi 自身配置/安装目录会被拒绝。
- 受限子进程只加载工作区限制扩展，关闭项目扩展、MCP、上下文文件、skills 和提示词模板，减少额外代码/上下文的自动加载。
- `find`/`grep` 使用有限的本地遍历，不调用外部程序；跳过 `.git`、`.pi`、`.agents`、`node_modules`，最多访问 10000 项和 64 层。`grep` 在受限模式只支持字面文本搜索，单文件不超过 2 MiB，总读取预算 20 MiB；不读取外部 ignore 配置。`read` 单文件限制 20 MiB。
- TUI 小面板显示简短目录名及“只读/可写”，`/agents status` 和 `team_list` 可查看完整范围。

这是 **Pi 文件工具层的访问限制**，并非操作系统沙箱。Pi 本身仍需读取运行配置、模型凭据与启动提示来发起模型请求；这些运行数据不因此从主机隔离。限制针对模型能调用的工具，不承诺抵御另一个本地进程同时替换目录造成的文件系统竞争，也不限制不受限主模型。若要运行任意命令并保证主机文件隔离，需要另行配置容器/系统沙箱。

## 验证

```bash
node --unhandled-rejections=strict --test ~/.pi/agent/extensions/workspace/tests/workspace.test.mjs
node --unhandled-rejections=strict ~/.pi/agent/extensions/workspace/tests/live-workspace.mjs
```

真实模型测试创建临时工作区，让 Luna 团队成员执行成功/拒绝的读取，让 DeepSeek 普通子智能体执行成功/拒绝的写入，检查工具事件和外部文件是否变化。测试消耗模型用量。可用 `PI_WORKSPACE_TEST_OUTPUT` 指定报告目录；测试工作区始终放在系统临时目录，避免测试写入 Pi 配置目录。
