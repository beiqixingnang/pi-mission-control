# Pi 源码快照

`pi-1.3.0/` 保存用户提供的 Pi 1.3.0 源码归档内容，用于查阅扩展 API、生命周期和底层实现。源码逐文件从归档提取，没有应用本项目的插件修改，也没有安装依赖或执行上游构建/安装脚本。

| 项目 | 内容 |
| --- | --- |
| 原始归档 | `pi-1.3.0.tar.gz` |
| 归档 SHA-256 | `8cafd09a80062335ed6511d56567188264160478d78653ecb5ae7d6afb49d53e` |
| 归档大小 | 7,992,876 字节 |
| 文件数量 | 1,925 |
| 文件总大小 | 24,815,371 字节 |
| 上游项目 | https://github.com/earendil-works/pi |
| 许可证 | [MIT](pi-1.3.0/LICENSE)，Copyright (c) 2025 Mario Zechner |

版本信息来自用户提供的归档名；归档不含 Git 提交历史，本项目没有据此推断或指定上游提交 SHA。以上校验值标识本次导入的文件，不代表已校验官方发布签名。

## 使用

- [源码入口说明](pi-1.3.0/README.md)
- [Pi coding-agent 源码](pi-1.3.0/packages/coding-agent/src)
- [Pi 扩展文档](pi-1.3.0/packages/coding-agent/docs/extensions.md)
- [Pi 上游开发规则](pi-1.3.0/AGENTS.md)

源码内的 `.pi`、`.github`、锁文件、测试样本、生成数据和二进制测试资源均属于原始归档，保留以便完整查阅。没有加入用户的个人 Pi 配置、API 密钥或聊天会话。

此目录不是子模块或嵌套 Git 仓库，不会被插件清单加载，也不包含在 `pi-mission-control` 的 npm 打包白名单中。包运行时仍使用目标环境独立安装的 Pi；根目录的 `npm run check` 检查插件入口，不会构建此源码树。
