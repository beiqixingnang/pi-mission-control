# 智能体状态界面

新会话自动加载；已打开的 Pi 在停止任务并保存写入后输入 `/reload`。

- 小窗口：输入框上方最多 3 行，显示状态、最后可见消息时间和输出片段。
- 全屏 TUI 宽屏（默认至少 140 列 × 24 行）：左侧主对话占约 2/3，右侧上半为 Goal/监督器，下半为成员列表。
- 布局兼容检查失败或 regular 模式时回退紧凑显示。
- 只有收到新的可见文本才更新“消息时间”；工具事件更新活动时间；重绘和图标动画不算消息。
- 超过 15 秒没有新事件时停止动画，显示无更新时长。

```text
/agents auto
/agents compact
/agents wide
/agents status
/agents off
/agents on
/agents view cpu-builder
```

`Alt+J` 循环选择成员，`Alt+O` 打开只读对话查看器。↑↓/PgUp/PgDn 滚动，End 跟随，Esc 返回主对话，不切换主 Pi 会话、不修改主输入草稿，也不发送模型请求。持久团队可读取其历史；普通子智能体可查看当前进程缓存的可见消息和工具结果。

当有任务运行时 **Esc 优先全局停止**；没有任务运行时查看器 Esc 只返回。`/stop` 也可全局停止。主 AI、成员、Goal、监督器及重试会协调停止，成员身份/历史保留；已经写入的文件不会回滚。普通 Enter 保留 Pi 的插话语义，Windows/WSL Ctrl+Q 显式排队追加。

完整行为、兼容性边界及真实渲染器预览见 [界面与全局停止说明](../../docs/ui-and-interruption-1.1.0.md)。

```bash
npm run check
npm test
node scripts/preview-ui.mjs
```

测试使用临时配置和离线 fixture，无模型用量；真实终端的视觉效果仍由用户现场验证。
