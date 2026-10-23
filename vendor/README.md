# Pi 源码快照

`pi-1.4.0/` 保存官方 Pi v1.4.0 标签的源码，供扩展 API、生命周期及底层机制核对。当前开发和 CI 统一以 Pi1.4.0 为基线；不再维护 Pi1.3 兼容测试。宿主仍独立安装，源码不会被插件加载。

| 项目 | 内容 |
| --- | --- |
| 标签 | `v1.4.0` |
| 提交 | `4a080252f06caf63a525d7873c5d94d3c23887e0` |
| 归档 SHA-256 | `677a2912de35585d17193d7facc5f1b4e106f6b2d22a13d101b237aa324726e8` |
| 归档大小 | 8,163,121 字节 |
| 文件数量 | 1,987 |
| 文件总大小 | 25,495,803 字节 |
| 上游项目 | https://github.com/earendil-works/pi |
| 许可证 | [MIT](pi-1.4.0/LICENSE)，Copyright (c) 2025 Mario Zechner |

元数据和文件树校验值保存在 [pi-source.json](pi-source.json)。归档按固定提交下载，逐文件提取并核对版本；没有应用本插件补丁、安装依赖或执行上游脚本。校验标识归档身份，不声明校验官方发布签名。跨平台文件树检查仅规范化文本 CRLF/LF，允许 Git 按上游属性检出 Windows 脚本。

## 使用

- [源码入口说明](pi-1.4.0/README.md)
- [Pi coding-agent 源码](pi-1.4.0/packages/coding-agent/src)
- [Pi 扩展文档](pi-1.4.0/packages/coding-agent/docs/extensions.md)
- [Pi 上游开发规则](pi-1.4.0/AGENTS.md)

源码内的 `.pi`、`.github`、锁文件、测试样本、生成数据和二进制测试资源均属于原始归档，保留以便完整查阅。没有加入用户的个人 Pi 配置、API 密钥或聊天会话。

此目录不是子模块或嵌套 Git 仓库，不会被插件清单加载，也不包含在 `pi-mission-control` 的 npm 打包白名单中。包运行时仍使用目标环境独立安装的 Pi；根目录的 `npm run check` 检查插件入口，不会构建此源码树。

旧研究报告保留当时的版本事实；原 Pi1.3 源码链接固定到本仓库历史提交，避免用新行号冒充旧证据。旧源码可经 Git 历史取回，当前树只保留 1.4.0 快照。
