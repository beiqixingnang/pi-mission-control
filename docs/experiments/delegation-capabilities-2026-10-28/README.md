# 成员能力与协作验证（2026-10-28）

本轮承接“插件开发”对话中已经批准的优化，基线为 `3d6e47f` / 2.7.1，候选为 `codex/delegation-capabilities` / 2.8.0。开发和回归在隔离工作树完成；用户的硬件开发 Pi 对话不参与测试、重载或控制。

## 实际行为

- 文件能力按解析后的授权目录决定。主根目录的 `access`、只读根和 `extraWriteRoots` 分别声明；`.agents`、`.pi`、`.git` 不再形成目录名黑名单。Pi 实际 agent、安装与当前任务状态目录继续保护。宿主命令仍是显式信任的执行能力，文件工具的根目录不构成操作系统沙盒。
- `team_capabilities`区分期望配置与当前任务实际使用的能力版本，并返回实际工具、模型、读写根和待生效状态。运行中 `team_configure` 登记新版本；已开始的工具操作完整结束，随后保存检查点，在同一任务与成员会话中切换。已完成命令不重放；立即撤销仍通过取消任务完成。
- `team_review` 对明确文件批次建立暂停。执行者到安全工具边界后停止后续操作，保存文件哈希快照，再启动所选审查员；审查完成后保存前后收据并恢复同一执行任务。失败或取消的审查保持暂停，主模型检查后可明确释放。审查角色与模型分别配置，不固定模型名，不自动附加沙盒。
- 模型的 `team_message` 默认 `note`，普通讨论不创建任务；明确 `assign` 才派正式工作。成员查看器中用户直接发指令保留运行中转向、空闲时开始工作的原有行为。成员之间按通信许可直接交流，普通进度不单独唤醒 lead。
- 主模型与成员指导补齐真实能力匹配、连续完成授权批次、只暂停需要明确授权的操作、继续独立已授权工作、复用有效证据，以及内部检查与用户汇报节奏分别处理。普通状态查询只展示能力版本；完整快照保留在账本，避免重复传回成员提示词。
- 迁移继续保存任务历史、能力配置和审查暂停；写根、审查文件与收据指针按实际路径映射。旧会话通过字面 `/reload` 加载新工具与参数。

## 回归证据

| 环境 | 结果 |
|---|---|
| Windows Node 24.16.0 / Pi 1.4.0 | 353 项：349 通过、4 跳过、0 失败；类型检查与两个入口加载通过 |
| WSL Debian Node 22.23.3 / Pi 1.4.0 | 353 项：348 通过、5 跳过、0 失败；类型检查与两个入口加载通过 |
| 独立 workspace 守卫 | Windows、WSL 各 15 项通过 |
| 最终状态输出与核心行为定向检查 | Windows 10 项、WSL 14 项通过 |
| 专用已有 WSL TUI 对话 | 170 项通过；同一进程内字面 `/reload`、原有目标/证据/暂停保留、权限版本切换、审查暂停恢复、迁移恢复与导入通过 |

四项共同跳过的检查需要显式启用本地 Podman / 硬件镜像测试；WSL 另跳过 Windows 专用 cwd 锁诊断。跳过项不计为通过。

真实 Pi/RPC/TUI 测试使用隔离的确定性离线 provider；有限命令切换测试实际运行 Windows PowerShell 或 WSL bash 下的 Node 子进程。已验证命令开始后变更权限不会将其提前杀死，新权限能拒绝下一次写入；审查员工作时执行者不能继续写，审查后使用原任务与成员会话继续。它们验证运行时行为，不替代真实模型对提示词的理解与遵循评估。

专用测试家目录继续使用 `/home/lishuo/pi-mission-control-test`。附带的 `tui-report.json` 保存完整检查名称、会话恢复信息与 `sameProcess:true`；后续迁移测试保留源对话，恢复身份由现有测试器记录。

运行方式：

```text
node scripts/typecheck-v2.mjs
node scripts/check.mjs
node scripts/test-v2.mjs
node --experimental-strip-types --test extensions/workspace/tests/workspace.test.mjs
python3 scripts/test-task-policies-tui.py BASELINE CANDIDATE /home/lishuo/pi-mission-control-test
```

测试通过后更新生产安装磁盘内容，由用户在正在使用的 Pi 对话中执行 `/reload`。Windows 与 WSL 的已配置插件链接均指向 `C:/Users/lishuo/Documents/pi-mission-control`，无需改写用户设置。
