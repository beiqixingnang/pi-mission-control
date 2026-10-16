# 团队任务树、执行收据与恢复

## 受信通知

团队完成通知默认立即显示在主窗口，不排队触发新的模型回合。Goal 仍可在任务链收束后根据当前 session 和 generation 触发新鲜唤醒；过期、取消、重载或旧会话的通知会丢弃。若要让主模型处理结果，使用 `goal_wait` 或下一次用户指令；不要依赖一条长期排队的 follow-up。


`/project status` 和 `project_status` 显示稳定的项目 UUID。`/project rename` 保留 ID，更新当前路径并保留历史别名；`switch` 到另一个目录使用目标项目自己的 ID，不根据 Git 远端把不同 clone 误合并。索引保存在 Pi agent 目录的 `projects/registry.json`，使用跨进程锁和原子替换，多个 Pi 会话不会互相覆盖索引。

旧会话、证据和任务输入保持原文。需要定位旧证据时使用：

```text
/project resolve D:/projects/Unifier/logs/result.txt
```

AI 可调用 `project_resolve({path:"D:/projects/Unifier/logs/result.txt"})`，得到当前目录中的对应路径。路径前缀按目录边界匹配，`Unifier-other` 不会被改成 `Open-other`。Windows 与 WSL 的原生路径记录可以共存，但不会自动推断跨系统目录身份。

## 受限命令执行

文件工具限制和操作系统隔离是不同的能力。默认 `execution:"disabled"` 继续只有文件和组内通信工具；显式配置本地 Podman 镜像后，成员获得 `workspace_exec`，**不会获得宿主机 bash/PowerShell**。

```json
{
  "name": "executor",
  "role": "运行测试并交付收据",
  "workspace": {
    "root": "D:/projects/example",
    "access": "read-write",
    "execution": "sandbox",
    "sandbox": {
      "engine": "podman",
      "image": "your-local-hardware-image:tag",
      "cpus": 2,
      "memoryMb": 2048,
      "maxSeconds": 1800
    }
  },
  "communication": { "allow": ["supervisor"] }
}
```

镜像必须已经存在于本地 Podman 引擎；插件在授权时解析为不可变镜像 ID，不拉取镜像、不安装工具链、不自动启动虚拟机，不在后端不可用时回退宿主执行。Python、Yosys、Verilator 等需要安装在该镜像中。WSL 中安装的命令不等于容器已经包含这些命令。

`execution: "host"` 是可选的可信宿主机模式。主对话可以直接通过 `team_spawn` 或 `team_configure` 为指定成员启用它；host 模式可以使用普通 `bash` 和文件工具，适合你完全信任的仓库执行员；它不提供目录、网络、凭据或进程级隔离。成员仍受任务超时、输出上限、进程树取消和收据记录约束。
已经存在的空闲受限成员可以用 `team_configure` 更新后端，保留成员身份、上下文、原有目录和读写权限。
  "sandbox": { "engine": "podman", "image": "your-local-hardware-image:tag", "maxSeconds": 1800 }
}
```

该工具不修改工作区范围，不配置正在执行任务的成员。禁用使用 `execution:"disabled"`。

容器内路径是 `/workspace` 和 `/reference/0`、`/reference/1` 等额外只读目录。运行一个测试：

```json
{
  "command": "python3 tests/test_example.py",
  "timeoutSeconds": 600
}
```

返回运行 ID、退出码、超时/取消状态、日志、收据和回写产物路径。目录使用私有副本，不把真实工作区、宿主凭据、容器 socket 或其他主机目录挂入容器。根文件系统只读、网络关闭、删除额外 capabilities、禁止提权并限制进程/CPU/内存。文件写回检查原文件摘要；其他进程改动过的文件会产生冲突，避免覆盖别人的更新。

详见 [执行后端说明](../extensions/workspace/SANDBOX.md)。只读执行不回写命令产生的源文件变化，但会在 `.mission-control/runs/` 写入受控日志和收据。收据是可审查记录，不是不可伪造的远程证明。

## 组内派工与休眠

主对话使用 `team_send(wait:false)` 派给监督员。监督员通过 `team_message` 或受限环境中的 `workspace_team_message` 派给执行员：

```json
{
  "to": "executor",
  "message": "在容器中运行验证，交付收据、日志和结果路径。",
  "wait": false,
  "timeoutMs": 2200000
}
```

监督员随后**单独**调用 `team_wait({})`。执行员完成后，插件直接把交付发送给监督员，监督员读取收据、审查结果并回复；主对话不需要转发或代跑测试。主 Goal 会同时计入祖先和下游任务，直到负责人审查完毕才认为这条任务链完成。

约定半小时检查进度可用 `team_wait({reportAfterMs:1800000})`；这会唤醒该任务负责人，不会重跑执行员任务。遇到阻塞时，成员可 `team_wait({blockedReason:"缺少测试依赖"})`，任务保持阻塞、负责人得到通知，对应 Goal 暂停。处理后通过明确的新尝试恢复。

不要向正在等待自己的祖先派回一个新任务，这会形成循环。向祖先报告信息使用 `team_message({to:"supervisor",message:"进度说明",operation:"note",wait:false})`。组内 ACL 继续由父进程验证，消息不会扩大接收方的目录或执行权限。

## 身份、顺序与去重

`team_tree({})` 查看持久化任务树；可通过 `taskId` 只看一个子树。记录包括：

- 任务、父任务、根任务、批次和稳定项目 ID；
- 分配对象、负责人、排队/运行/等待/阻塞状态；
- 输入摘要、SHA-256、产物和收据路径；
- 独立交付编号和单调递增序号；
- 超时层、取消状态和可确认的进程状态。

成员读取同步回复后不会再收到同一条异步交付。异步结果按交付序号合并，持久化送达状态；重载时结合已保存的交付消息去重。旧任务、旧批次和历史结果不会仅因迟到或压缩而自动触发重跑。任务树保留有界历史，消息桥也有请求/日志容量限制。

## 超时与取消

各层含义分开：

| 层 | 控制 | 超时后的含义 |
| --- | --- | --- |
| 排队 | 主 `team_send.queueTimeoutMs` | 尚未开始成员回合，不声称已启动测试 |
| 消息传输 | 组内消息请求期限 | 等待回复失败；成员会话保留，需查任务/收据确认进程状态 |
| 成员回复 | `team_send.timeoutMs` 或组内消息的 `timeoutMs` | 中止该成员请求及其下游；保留成员会话 |
| 测试进程 | `workspace_exec.timeoutSeconds`，不超过 profile 的 `maxSeconds` | 停止此运行的容器和后代进程，保存日志和收据 |

长测试的成员回复窗口应大于测试进程上限，并预留准备/收集时间。执行结束、任务取消、成员会话退出是不同事件。没有证据时状态为 `unknown`，不会把“发出取消请求”描述为“所有外部进程均已停止”。使用 `workspace_exec_status({runId:"运行编号"})` 检查相应收据和容器状态。

主对话 `team_cancel({jobId:"任务编号"})` 或按成员名取消会级联到下游，等待已知请求收束，保留成员身份和对话。受限成员可用 `team_task_cancel` 取消自己任务的下游，不能取消其他组。全局停止与 `goal_stop` 也会取消对应子树。

## 重载、迁移与恢复

会话重载或工作区迁移后，任务树、未完成任务输入、交付状态、任务板和成员定义继续保留。运行中的进程不能跨重启接续，未完成任务标为中断；不会自动执行保存的队列。

确认环境与证据后，用 `team_resume({taskId:"旧任务编号"})` 显式创建一个新尝试。新尝试有新的任务 ID，并关联旧任务，同时获得历史路径映射。旧失败证据保持不变。阻塞的 Goal 需要在条件解决后明确 `/goal resume`，监督器也需重新开启。

以上只管理当前 Pi 会话及其派生任务，不会接管或取消其他对话的硬件工作。
