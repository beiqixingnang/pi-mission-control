# v2 验证记录

日期：2026-10-17，Asia/Shanghai。环境：Windows、Node24.16.0、已安装Pi1.3.0。不是跨平台或真实provider兼容性认证。

## 已执行检查

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 两个v2入口加载无错误；25个lead工具、6个用户命令（含独立压缩命令）；测试provider不被默认加载 |
| `npm run typecheck` | 2.0.8通过Compiler API严格检查25个直接源码文件及其依赖，包括workspace policy/Podman后端；Windows与Debian通过 |
| `npm test` | 2.0.8本机完整96用例：92通过、0失败、4个需显式镜像的容器用例跳过；耗时约50.1秒 |
| GitHub Actions | 2.0.7代码提交7c59b10，运行39029356454成功；Ubuntu与Windows / Node24各91通过、4跳过、0失败，入口和25文件严格类型检查全部通过 |
| 网络MCP framing回归 | 已纳入上述完整96用例 |
| 显式本机镜像容器测试 | 2.0.2再次运行container.test.mjs，10用例全部通过、0跳过；其中4项真实Podman用例约59秒，6项为重复静态/本地检查；测试前后`podman ps`为空 |
| npm tarball | 实际生成、检查内容、解包后加载v2入口成功；不含.reference、vendor、用户会话/认证配置或默认加载测试provider |
| Git whitespace | `git diff --check`核对；历史文档已标v1，v2仅加载新清单 |

2.0.5执行了UI/主题验证，2.0.6修正类型契约与CI夹具并重新验证。加载检查为两个入口、25个lead工具、6个用户命令，errors为空。本轮未重复运行真实Podman；容器结果为同日2.0.2验证记录。测试通过不等于真实provider与长期运行验收通过，未验证范围见文末。

普通测试全部由scripts/test-v2.mjs建立临时Pi agent目录；不读取用户auth/models/settings正文，不调用真实模型。真实Pi生命周期使用确定性离线provider，并非仅用mock替代Pi事件系统。

## 真实Pi流程

tests/v2/pi-integration.test.mjs共19用例通过：

1. 模型未创建Goal、未开启监督器，只派工并结束主回合；成员实际调用read拿到标记，随后自动唤醒主回合，交付观察确认，原生HTML导出成功。
2. 模型off维护被拒绝，read-only+host配置被拒绝，原生export/copy/tree/model命令未被覆盖。
3. 监督员给执行员派下游任务、结束等待回合、同session启动复核；父任务在复核后才完成。
4. host成员的文件工具拒绝根外路径，原生Windows PowerShell实际执行Node命令。
5. 长命令创建孙进程后取消任务，确认受管命令及孙进程退出。
6. 连续75次较大的成员配置修改不增加Pi主日志字节，原生HTML和流式公开导出仍可用。
7. 一次性print模式等待成员并返回结果，不退出后遗留被截断的后台任务。
8. 自定义摘要provider失败后取消compact、保留原历史；不走静默默认回退。
9. 分块摘要经真实Pi compact hook安装checkpoint，压缩后仍可正常请求下一回合。
10. 子智能体chain执行顺序按依赖，使用不同持久session。
11. Pi reload保留成员身份和用户pause，旧运行任务标interrupted、不自动重放，并保留恢复通知。
12. 通过真实模型工具验证路径发送null、空容器配置等占位参数，成员按files只读启动并交付；空configure不重置原模型与权限。
13. 多个非空派工模式、空任务条目或后续成员模型无效时，在创建任何成员/任务前明确拒绝。
14. 通过真实Pi的`/mission view`与公开custom组件，在成员完成前看到RPC公开文字增量，完成后看到实际工具返回；两级Esc返回不abort主回合、不改变任务状态、不展示私有fixture块。
15. 主会话和成员自定义提供方错误重连，默认十次预算耗尽、原生502衔接、取消退避均通过；成员继承策略。
16. 工作区rename/switch保留主/成员记忆、任务和权限，重启延续、原生取消回滚、运行成员停止、授权撤销/过期及新会话首响应前切换均通过。
17. 独立摘要模型的命令/环境优先级、预算配置和metadata-only debug通过；未把提示或摘要正文写进debug。
18. `project_resolve`按稳定项目身份解析历史路径，迁移历史LF正文只改新header，SQLite/产物副本和暂停提醒状态通过。
19. 真实Pi在主回复期间打开纯插件主时间线，显示公开增量及工具返回、排除私有fixture；退出不abort或派工，Pi文件哈希和原生render引用/旧全局槽位保持不变。

## 2.0.3 UI验证

- 全屏团队工作台与成员Markdown对话快照已用实际Pi TUI组件生成到`docs/ui-preview-mission-panel.txt`；宽屏/窄屏均保持行宽限制。
- `/agents`、`/mission`、`/mission view`入口加载检查通过；成员消息路由和逻辑复制新增回归通过。

## 2.0.4主题崩溃回归

- 用户实际TUI报错`Unknown theme color: mdItalic`。2.0.3上述快照使用了宽松的简化主题，真实Pi命令测试也传空主题；这些检查验证了内容和流程，但没有验证真实Theme token，因此漏掉mdItalic/mdBullet。
- 2.0.4的`tests/v2/theme.test.mjs`使用安装Pi的真实dark/light/system主题，并断言对应主题确实加载。覆盖用户引用、斜体、粗体、删除线、列表、链接、表格、代码块及工具返回，在20/50/80/120/180列渲染；不允许靠错误页降级冒充成功。
- 主题异常注入后，渲染错误留在工作台内，Esc两级返回仍可用，运行核心快照不变；完成目标隐藏过期倒计时，完成成员对话标题保持完成状态。
- 真实Pi custom命令集成也改用实际主题；预览脚本移除假主题，改用实际Theme，渲染降级时脚本明确失败。重新生成了预览。
- 2.0.4没有进行Windows终端截图/人工全流程验收；本次新增证据是实际Theme、实际Markdown和真实Pi命令流程，不等同于终端视觉验收。

## 2.0.5横向看板和动作底色

- 针对主题、UI和真实Pi流程的28项专项测试通过；最终完整测试为86项中的82项通过、4项容器跳过、0失败。
- 真实dark/light/system主题覆盖看板的20/50/80/120列与12/24/30/40行；检查高度上限、中文可见宽度、目标/定时提醒、多余成员提示和不存在竖向分隔符。
- 使用真实Theme.bg记录验证userMessageBg、toolPendingBg、toolSuccessBg和toolErrorBg，确认回复正文不被动作底色覆盖；保留2.0.4主题崩溃与异常兜底回归。
- 命令和编辑预览回归验证实际命令、增删行、不输出多余围栏；c复制仍保留完整参数JSON（包括timeout），且无ANSI或边框字符。
- 真实Pi命令测试检查widget的aboveEditor位置、进入工作台隐藏、收到运行中更新后保持隐藏、退出后恢复；原有实时公开增量、任务继续运行、两级Esc与原生导出回归均通过。
- 预览脚本使用真实安装Pi的TuiAltScreen/VStack/ScrollView/Markdown和dark主题，生成宽屏120×30、窄屏70×24主界面、团队页、成员页及编辑展开页共五帧；经Pillow栅格化后查看宽屏、窄屏、成员与编辑PNG，根据预览改进了命令/编辑布局和符号字体。公开纯文本保存在docs/ui-preview-mission-panel.txt；ANSI和PNG位于忽略的.reference/artifacts/ui。
- 上述PNG是隔离夹具的真实组件渲染预览，输入区为固定草稿，不是用户桌面截图。没有热重载用户Pi，也未验收真实终端鼠标拖选；逻辑复制通过脚本键盘路径验证。

## 2.0.6推送与CI修正

- 首次推送be990a4触发GitHub Actions运行39026044161：Ubuntu离线套件86项中82通过、4项容器跳过、0失败；随后严格类型检查失败。Windows有3项容器策略静态测试在临时目录规范化之前失败，其余用例正常。这些失败未被当作验收成功。
- 类型错误包含ToolDefinition<any>丢失具体schema后使Static<any>成为unknown、工具结果缺少声明要求的details、prepared数组隐式any，以及SQLite异常清理引用尚未赋值的字段。修正泛型包装、结果结构、数组类型和已打开连接的局部引用；没有关闭strict或扩大any来压过错误。
- 原类型检查脚本在本机返回0，却没有发现上述错误；Debian及GitHub暴露了缺口。现直接调用TypeScript Compiler API，明确核对kernel、lead/member入口、viewer和compaction被选中，并报告23个直接源码文件。Windows Node24和Debian Node22.23.3的静态检查均通过；Debian这里只执行类型检查，不用Node22运行v2。
- 临时在runtime中注入不存在的ExtensionAPI方法和number赋给string，确认检查返回1且报告两种错误，随后删除探针；防止空检查或宿主API退化成any被误算通过。
- Windows runner的os.tmpdir可能含8.3短路径别名。测试夹具先对mkdtemp结果取realpath，再传给沙箱策略；运行时继续拒绝模糊别名，没有放宽权限规则。容器专项6项静态检查通过、4项实机检查按默认跳过。
- 核心修正后本机完整离线套件再次82通过、0失败、4跳过（约43.3秒）；入口加载通过。代码提交8257d07的GitHub Actions运行39026681452随后成功：Ubuntu job117378930267约21.4秒、Windows job117378930383约42.0秒，均86项中82通过、4跳过、0失败，并通过入口加载及23文件严格类型检查。此次结果是对应代码提交的证据，不替代后续提交的检查。

## 2.0.2恢复验证

- 自定义重连错误不依赖HTTP状态码；固定5秒在单元测试中可取消，实际Pi使用0秒夹具验证次数与取消，默认配置断言为10/5000。
- 原生Pi1.3.0默认重试3次/2秒指数退避/60秒上限；插件没有修改全局设置。
- `/project`迁移使用临时真实Pi运行时，覆盖rename、switch、重启、回滚、精确授权和运行成员停止；用户真实1GB日志未热迁移。

## 2.0.7消息时间验证（历史，2.0.8已撤回原生补丁）

- 新增9项时间与原生组件回归；当前完整95项中91通过、4容器跳过、0失败，类型检查25个直接文件及依赖通过，入口仍为25工具/6命令。
- dark/light/system实际主题覆盖重复正文的不同时间、保存时间/日期格式、缺失时间、稳定流式时间、真实工具耗时和UI异常回退；成员复制排除时间/耗时，原生HTML导出回归继续通过。
- Windows全局Pi1.3.0已显式适配6个运行时文件，备份保留；实际restore→零适配状态→重新apply通过。实际独立模块与CLI bundle的用户消息构造入口均保留重复正文的不同timestamp，CLI版本入口和chunk导入成功。
- 重新生成五个真实Pi组件隔离预览，检查了原生主对话和成员对话的时间/耗时PNG，未操作用户终端；生效需要重启Pi，/reload不足以更新核心模块。
- 代码提交7c59b10的GitHub运行39029356454最终成功：Windows job117386517804与Ubuntu job117386517938均91通过、4容器跳过、0失败，入口与25文件严格类型检查通过。CI使用未适配的原装Pi，原生组件测试在隔离副本中检验适配，没有给runner全局安装写补丁。
- 完整实现和恢复方式见[TIMESTAMPS](TIMESTAMPS.md)。没有给本机Linux安装写适配；Debian这里只执行静态类型检查。真实终端人工完整交互、付费provider与整夜负载仍未由CI覆盖。

## 2.0.8纯插件时间线

- 用户要求不修改Pi。已恢复Windows的六个Pi文件并与原始备份逐一核对SHA256，status报告patchedFiles=0、installerAvailable=false；没有强制重载用户会话。
- 删除原生显示装饰器、Symbol桥、补丁生成模块及旧原生修改测试；保留时间解析、公开元数据、流式稳定时间、重复正文等通用回归，并增加纯插件主历史/临时预览与已撤回apply的拒绝测试。
- 主时间线真实Pi集成已通过：公开文字在工具完成前可见，随后读到实际工具返回，私有思考/签名fixture不可见；原生组件/interactive-mode/CLI chunks前后哈希及UserMessageComponent.render引用保持一致，旧全局显示槽位未改变。
- 主查看器覆盖40条LF分页、暂停跟随/新消息/End、历史加载、5/20/50/80/120/180列、重复时间与c复制；m仅返回原生输入，q退出，不创建成员或任务。
- 本机完整96项中92通过、4容器跳过、0失败，约50.1秒；Windows与Debian25文件严格类型检查通过，25工具/6命令入口加载通过。跨平台动态结果以对应提交的Actions为准。
- 六帧预览在恢复原样的Pi上重新生成，并检查原生主界面、成员页与主时间线PNG；它们是隔离组件预览，不是桌面截图。本轮未调用付费模型或重跑实际Podman。

## 核心和工具验证

2.0.6另做真实公网检查：实际Pi会话通过离线模型驱动调用Exa搜索、抓取Pi官方扩展文档、拒绝本机地址，三项结果均正确进入后续模型上下文；不调用付费模型、不修改用户配置。另有example.com单次ECONNRESET失败记录；Brave与SearXNG未实测。详见[联网实现与实测](NETWORK.md)。

- 自动mission登记、无Goal唤醒、busy主会话持久保留、发送租约与响应观察分离。
- 固定30分钟报告不因peer派工提前；普通progress合并、不单独唤醒。
- 有向通信ACL、祖先任务环拒绝、幂等request ID、旧epoch token拒绝。
- 组内等待释放成员进程、同任务review回合；运行中peer note通过steer接入。
- user stop保留身份、迟到成功不覆盖取消；普通提问不解除humanPaused。
- 有限唤醒失败退避、重启不重放副作用、owner lock、unknown进程禁止盲目重试。
- 提醒到期outbox/nextAt同事务，错过循环不补多条旧提醒。
- 摘要输入预算、缓存复用、部分失败恢复、长度截断拒绝。
- 约96MB合成日志LF流式导出，U+2028不拆记录，过滤系统/思考/签名及状态快照。
- Exa请求与结果归一化、MCP SSE framing、private/mapped目标和私网重定向拒绝、环境允许项。
- TUI renderer在20/50/80/120/180列、中文宽度、稳定排序下检查通过；无自动成员轮播。
- 2.0.1查看器覆盖5/20/50/80/120/180列；键盘选择/折叠任务树、Enter展开、Tab目标/提醒、翻页、暂停跟随和新消息提示、End回最新、历史session切换、两级Esc及不触发模型/改变任务。
- 有界反向LF日志分页、未完成尾记录、跨块与Unicode分隔符、超大记录分窗扫描、公开结构过滤；Pi1.3无累计message的RPC文字增量与thinking增量丢弃。
- 空tasks不遮住chain、空chain不改变并行语义、可选null/空workspace/sandbox占位、有效权限冲突仍拒绝；整批预检防止半支团队。

## 真实Podman

显式使用本机已有镜像：

```text
73f6c8647ffd48490e5c1953a9dab250781c75d2b985fc61d5a40fdbb4c7f30d
```

命令（PowerShell）：

```powershell
$env:PI_SANDBOX_TEST_IMAGE='73f6c8647ffd48490e5c1953a9dab250781c75d2b985fc61d5a40fdbb4c7f30d'
node scripts/test-v2.mjs tests/v2/container.test.mjs
```

4项实际执行：Python读取隔离输入与只读参考、受控产物写回；最小Yosys/Verilator模块；超时删除容器并保留部分日志/收据；取消仅停止本次容器并保留元数据。共约60秒，全部通过。未下载镜像、未修改真实硬件项目，结束时`podman ps`返回空列表。

## 本轮没有验证或提供的事项

- 没有对真实GPT/DeepSeek/其它provider网关发送请求；推理和tool协议仍需针对配置实测。
- Ubuntu GitHub已运行离线动态套件；未在macOS主机测试，也未验证Linux实际硬件项目、整夜负载或进程强杀的完整故障注入。
- TUI未做真实Windows终端截图与人工完整交互验收；已检查隔离夹具PNG，并通过公开组件渲染/宽度、脚本键盘事件及真实Pi命令接入验收。
- 未安装独立daemon、OS scheduler或原生Windows token沙箱；维护器仍需要Pi存活。
- 提醒提供ISO/after/fixed interval，暂不提供calendar cron/daily/weekly规则。
- 没有修改已存在1GB旧Pi日志或声称其原生HTML导出限制已修复；新会话回归已通过，旧记录可流式公开导出。
- 没有热重载用户当前真实Pi会话，也未修改其全局安装配置。package.json已指向v2，新打开的本地包会话使用新清单。
