# Pi 1.3.0 升级评估与 WSL 验证

## 结论

建议升级到 Pi 1.3.0：本次升级实际完成于 Debian WSL，插件 1.1.0 的九个入口加载正常，91/91 项测试通过。没有发现需要为本次版本变化修改插件实现的兼容问题。Windows 的全局 Pi 保持 1.2.0，没有自动升级。

不是必须立即停工升级的安全通告，但 1.3.0 对本项目的中转站、持久会话、成员查看器有直接的可靠性收益。生产终端的字体、输入法、鼠标，以及真实中转站长时间稳定性不在自动测试结论中。

## 官方变更与本项目的关系

来源为 npm 官方发布包的 `CHANGELOG.md`，1.3.0 发布日期 2026-10-15。

- [官方 1.3.0 更新记录](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md)
- [官方 1.2.0 → 1.3.0 比较](https://github.com/earendil-works/pi/compare/v1.2.0...v1.3.0)
- [npm 1.3.0](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/1.3.0)

| 1.3.0 变更 | 对我们使用的影响 |
| --- | --- |
| 所有内部 Pi 依赖固定到同一发布版本 | 减少新安装时 coding-agent/ai/tui/agent 混装不兼容版本 |
| 修复 `Unable to forward upstream stream`、`The service is temporarily unavailable` 不自动重试 | 对使用中转站有用；随机其他上游错误仍需 retry-any |
| 恢复会话时保留运行中启用的工具，正确叠加 `--tools +name/-name` | 对持久成员/恢复工作流有益；我们受限成员显式工具白名单继续通过测试 |
| 修复 `ctx.ui.custom` 的 done 误关闭最上层其他弹窗 | 对成员对话查看器和其他弹窗同时出现时有益 |
| 修复代理同一流块同时返回 reasoning/content 的显示顺序 | 对 OpenAI 兼容中转站有用 |
| 切换模型时丢弃其他模型的 thinking 块，不再作为正文发给新模型 | 减少模型把旧思考内容当作回复继续输出的问题 |
| GPT-6 API key 调整思考等级保留 prompt cache | 官方 OpenAI API 场景有收益；不能由此保证当前自定义中转站的缓存命中或计费 |
| Kimi Code 改为 Chat Completions，baseUrl 必须包含 `/v1` | 当前自定义 provider/provider 配置不属于该提供商；若以后使用需调整 |
| 官方 `openai-codex/gpt-6.1-sol` 上下文窗口更新到 500K | 不等于修改自定义 `provider` provider 的配置 |
| codemode 取消/超时与残留 worker 修复 | 使用 codemode 时有益，不代替我们的团队/普通子智能体全局取消 |

## 静态对比

对比 Windows 当前安装的 Pi 1.2.0 与 npm 1.3.0 发布包：

- `core/extensions/types.d.ts` 完全一致；Goal 使用的生命周期事件契约未改变。
- `modes/rpc/rpc-client.js` 完全一致；安全等待封装仍有保留价值。
- `core/session-manager.js` 完全一致；持久 roster 和子会话读写格式未改变。
- `core/tools/read.js`、`write.js`、`edit.js` 完全一致。
- `core/agent-session.js` 的差异集中在恢复工具集与工具 modifiers 的处理。
- `modes/interactive/interactive-mode.js` 包含指定 overlay handle 关闭的修复和 share destination 设置。
- `modes/interactive/tui-renderer.js` 完全一致。布局仍依赖兼容性适配，已由实际 TUI renderer 测试覆盖。

## 实际升级

升级对象：Debian WSL 用户级全局 npm 安装，前缀 `/home/user/.local`。

```bash
npm install -g --prefix /home/user/.local --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.3.0
pi --version
```

升级后 `pi --version` 返回 `1.3.0`。实际安装的 `pi-agent-core`、`pi-ai`、`pi-codemode`、`pi-mcp`、`pi-tui` 全部为 1.3.0，与声明一致。升级没有执行依赖 lifecycle scripts。

WSL 的 `~/.pi/agent` 链接到 Windows 的配置目录。本次升级前后比对 `settings.json`、`models.json`、`auth.json` 的 SHA-256，三个文件均未改变；没有打开/修改 CPU/GPU 主会话或其持久成员。

## 测试

```bash
cd /path/to/Documents/pi-mission-control
PI_TEST_PACKAGE_DIR=/home/user/.local/lib/node_modules/@earendil-works/pi-coding-agent node scripts/check.mjs
PI_TEST_PACKAGE_DIR=/home/user/.local/lib/node_modules/@earendil-works/pi-coding-agent node scripts/test.mjs
```

环境：Debian WSL，Node v22.23.3，实际全局 Pi 1.3.0，插件 1.1.0。

结果：**九个入口加载无错误，91 个测试全部通过，失败 0**。覆盖成员双向 ACL 消息、受限文件访问、主进程重启后的成员历史恢复、随机 provider 错误与 502 重试、Goal/监督器恢复、主请求全局取消后新消息可处理、真实普通子进程退出、宽窄 TUI 布局与只读历史查看。

测试使用临时 agent 配置与离线确定性 provider，没有调用真实 GPT/DeepSeek，也没有声称验证 ccSwitch 的切换操作或真实中转站可用性。

## 后续使用

WSL 已可使用 1.3.0。恢复既有会话前先保存当前工作，并退出旧 Pi 进程后重新启动；仅 `/reload` 不会把旧进程内已加载的 Pi 核心替换成新版本。

Windows 目前仍为 1.2.0，可以继续工作；需要时再单独升级到固定的 1.3.0。保留本仓库中 Pi 1.2.0 源码参考快照，不因本次验证替换它。
