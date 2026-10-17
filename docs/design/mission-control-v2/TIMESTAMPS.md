# 消息时间与原生Pi显示适配

版本2.0.7，2026-10-17。用户要求主对话、成员对话显示逐条时间，并授权自行选择实现方式、在任务开始前完成适配。

## 显示规则

- 使用电脑本地时区；当天显示HH:mm:ss，跨天补MM-DD，跨年补年份。
- 用户消息、助手回复、工具记录和扩展通知使用各自保存的时间，不按正文匹配，因此相同文字的两条消息可以有不同时间。
- 助手采用请求开始时间，流式增量不会把它变成最后一个token的时间。
- 工具运行中显示已运行时长，结束后优先使用Pi记录的durationMs。历史中有结束时间和耗时时，以二者恢复开始点；不把模型思考到工具返回的整个区间当作工具耗时。
- 无时间或耗时记录时明确显示时间未记录/省略耗时，不使用当前时间补历史。
- 成员视图把时间放在标题旁，并优先为它保留宽度；主对话利用原生组件顶部已有留白。极少数没有顶部留白的组件会增加一行元数据。

## 为什么主对话需要额外适配

Pi1.3.0公开的registerMarkdownTransformer只提供messageType、isStreaming和availableWidth，没有消息ID/时间。registerMessageRenderer只针对custom消息，不能替代原生user/assistant渲染。用正文查找时间无法区分重复输入；向正文写入时间又会影响模型上下文和复制。

因此成员查看器在插件中直接实现时间；原生主对话另提供一个显式、可恢复的Pi1.3.0显示适配。它是本项目维护的本地兼容桥，不是Pi已经公开支持的标准接口，也不是仅安装扩展就能在任意Pi版本启用的能力。

## 适配改动与边界

scripts/pi-timestamps.mjs只在明确执行apply时修改当前Pi安装，不运行安装生命周期脚本，也不改配置、认证、会话日志或模型请求。只审计并接受Pi1.3.0；其他版本或不匹配的代码形状明确拒绝，不盲目替换。

修改六个运行时文件：四个独立组件user-message、assistant-message、tool-execution、custom-message；interactive-mode中的两个用户消息构造入口；以及实际CLI使用的一个合并chunk。没有改动Git保留的原始vendor快照。

用户组件在创建时附带该条消息的timestamp Symbol元数据。助手/通知组件本身已有消息对象。组件完成原生render后，通过版本化Symbol桥调用插件的时间装饰函数；工具附带toolCallId和已有状态/耗时。正文、Markdown解析、命令/编辑渲染、图片和模型内容均由原生组件先处理。装饰器异常返回原始渲染，不能把Pi带崩。

插件使用pi-mission-control.timestamp-renderer.v1注册当前会话显示函数。session_shutdown移除当前实例的函数；不加载插件时适配桥返回原始界面。它不挂接私有layoutRoot，不重排消息，不追加时间提示词或时间消息。

每次安装先以TypeScript AST检查类和两个用户消息入口，全部计划生成后才写。原文件与SHA256清单保留在.reference/pi-timestamp-adapter/<安装ID>/，各Pi安装独立索引。替换采用相邻临时文件加rename；异常时恢复已替换文件。restore会核对安装位置、版本、目标清单和前后哈希，拒绝覆盖升级后或被另行修改的文件。备份、运行时副本均被Git忽略。

## 启用、检查与恢复

本机Windows安装已经执行apply，核对六个文件均完成适配；也实际执行过restore→status零文件→apply，并验证CLI版本入口及实际CLI chunk可以正常加载。没有强制退出用户终端。

```text
npm run pi:timestamps -- status
npm run pi:timestamps -- apply
npm run pi:timestamps -- restore
```

运行这些维护命令前，在插件仓库安装开发依赖：npm ci --ignore-scripts --legacy-peer-deps。适配脚本使用TypeScript做代码结构校验。其他独立Pi安装需要分别执行，不能把Windows备份用于WSL。

修改Pi运行时后需要正常退出Pi并恢复原会话（例如在原工作目录运行pi -r）；/reload只重载扩展，不会替换已经载入内存的核心组件。无需新建会话。恢复原文件后同样需要重启。

Pi重新安装或升级可能覆盖适配。成员时间仍可用，主对话恢复原生显示；/mission time会说明当前进程是否已加载适配。适配未加载时插件不会按文本猜时间，也不会自动修改全局Pi。

## 时间数据与复制/导出

runtime/time.ts提供统一的解析、本地格式与耗时格式。runtime/public.ts保留原entry.timestamp，另将公开message.timestamp/durationMs投影为messageTimestamp/durationMs；不重写原日志。过滤思考、签名及私有提示的规则保持原样。

viewer.ts按toolCallId匹配当前窗口内的调用与返回，保留时间和耗时元数据。未加载结果窗口时不假定工具已经成功。WorkerPublicStream保留助手的初始时间和每个工具第一次观察到的开始点，实时更新正文不会移动时间。

原生主对话的ToolTimes只索引call ID与时间/耗时，最多5,000项；不复制消息正文。重开时从当前分支已有元数据恢复工具时间，运行事件补充实时开始/结束。

时间不进入item.body。成员c复制仍使用原逻辑标题/正文，原生/copy继续读取原助手正文；终端鼠标拖选则照常复制用户实际选中的显示内容。原生HTML导出继续使用原日志，公开导出增加的是可选时间元数据，没有新增状态快照。

## 验证证据

- 新增9项测试，覆盖跨天/跨年/缺失时间、公开元数据、工具真实耗时、流式稳定时间、重复正文、原生Markdown/OSC区段/宽度、异常降级、原生命令渲染及通知。
- 使用安装Pi的实际dark/light/system主题和原生组件检查，正文渲染保持一致。成员复制回归增加时间/耗时后仍不复制显示元数据。
- 直接调用实际独立模块和CLI bundle的addMessageToChat，两条duplicate正文分别保留1000/2000的时间，验证真实构造入口，不只检查替换字符串。
- 使用实际Pi TUI和原生消息组件生成宽屏、窄屏、成员页预览，并查看PNG；它们是隔离夹具，不是用户桌面截图。
- 完整离线测试及跨平台结果见VALIDATION.md；本轮没有发送真实模型请求，没有热重载真实用户会话。
