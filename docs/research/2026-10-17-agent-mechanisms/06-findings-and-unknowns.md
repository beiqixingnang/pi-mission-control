# 已确认问题、版本边界与未决问题

本章只登记调查发现，不是修复实现计划。机制详述见同目录各章；源码结论限于版本表中的固定提交。后续实验和实现验收应独立记录。

## 6.1 已有源码与日志共同支持的发现

| 编号 | 发现 | 可复核机制或证据 | 结论边界 |
| --- | --- | --- | --- |
| F01 | 监督器绕过设置间隔 | team:job-start 每次 schedule(0)，tick 无最短间隔；日志19次检查在peer下游任务running记录后30ms内出现 | 条件性触发，主会话busy/有输入时不会立即开回合；不是每次start必唤醒 |
| F02 | 状态持久化导致日志大幅膨胀 | 主日志1,810个roster快照约939.8 MB，981个Goal快照约61.0 MB | 98.2458%是磁盘状态；不能说模型收到同样体积 |
| F03 | 受限执行员早期只有文件能力 | restricted模式默认execution=disabled；历史team_spawn拒绝bash | 无法直接跑测试是能力边界；不能仅靠prompt要求它自己测试 |
| F04 | 历史host配置代码异常 | L2642/L2643返回consumeHost is not defined | 后续有修复提交与配置成功；不能登记为当前未修复bug |
| F05 | Goal控制与实际团队执行可分离 | paused/blocked仍可关联新任务；模型没有goal_resume，目标暂停时团队继续执行的日志存在 | 没有resume工具不等于宿主完全不能恢复；斜杠命令有独立权限语义 |
| F06 | member timeout不能证明底层进程已停 | 后期6个约600秒超时任务的processState=unknown | 应保留不确定结果，不能把它当测试失败或已取消完成 |
| F07 | 普通上报与自动唤醒语义不同 | 当前team-result/note使用triggerTurn:false；Goal/监督器另有triggerTurn:true | 消息可进入会话但idle父会话不一定马上开回合 |
| F08 | 原生HTML导出对巨型历史做整体字符串化 | Pi generateHtml整体JSON.stringify/Base64；用户日志报告Invalid string length | 尚无本轮栈级重现，属于高可信代码解释 |
| F09 | 早期细碎派工与主AI代跑确实存在 | 用户多次要求组内闭环；主AI公开响应和工具调用显示过度接手 | 插件命令能力不足解释其中一部分；不把晚于操作的禁止指令倒推到过去 |
| F10 | 自动推进停工还包含协调失误 | Goal持续paused但被描述为可整夜推进；批次后成员闲置直到用户询问 | 同时有插件恢复接口缺口，不能单边归因 |
| F11 | 擅自关闭监督器扩大了失联范围 | 用户问频繁触发，主AI关闭监督器，后来承认并恢复 | 关闭是协调决策；提前触发本身已有F01的插件原因 |
| F12 | 普通Team通知的实时ACK监听错层 | Pi triggerTurn:false追加调用_appendCustomMessage，只发public事件；Team注册的pi.on(message_end)属于扩展事件，未被这条路径调用 | ordinary delivery可能已在session但仍delivered=false；restoreRoster会从branch回推确认，不能用未ACK计数断言丢消息 |
| F13 | host模式不再强制workspace文件路径边界 | launch和permitted在host选择Pi原生read/write/edit/bash；受控工具仍注册为workspace_*且未被选择 | 只对实际启用的工具适用；read-only虽不选write/edit，但host bash仍可写。root/access仍在metadata中不等于有OS或wrapper强制 |

另外两项静态风险尚未做运行复现：compaction-model对非空摘要未像Pi默认摘要器一样检查stopReason=length，可能接受截断输出；普通subagent在POSIX取消时尝试负PID进程组信号，但启动参数未显式detached，完整后代清理需要实际验证。它们分别详见上下文章和隔离章，不能直接当作此次日志故障的已证实根因。

原始日志L行号和详细公开证据仅保存在本机 `.reference/analysis/`；这里不嵌入私有项目内容。新增监督器时间证据在 `.reference/investigation/2026-10-17/supervisor-*.json`，可由 `tools/analyze_supervisor_timing.py` 从既有脱敏 LF 派生数据复算。

## 6.2 必须保持的语义区别

| 表面上相似的说法 | 代码核对后的区别 |
| --- | --- |
| “有子智能体通知”与“子智能体能唤醒父会话” | 通知可只是queue-only；是否触发新回合由状态和trigger字段决定 |
| “父AI停下”与“父工具正在wait” | 可能是结束生成后idle、一个tool future未返回、等待同一树消息、Goal waiting等不同层 |
| “结果已送达”与“模型处理过结果” | 内存入队、会话追加、模型请求包含和业务确认是不同提交点 |
| “成员还在”与“任务还在” | session身份恢复、Agent对象、OS进程、实际任务执行不能互相推导 |
| “工作区只读”与“进程读写受限” | 文件工具wrapper只限制它管辖的工具入口；host命令、MCP或间接工具可能有独立权限 |
| “沙箱”与“worktree” | 前者强制执行权限，后者隔离Git工作目录；二者能组合但不能互相代替 |
| “持久定时器”与“关进程仍执行” | 任务意图可持久，实际定时扫描和模型执行仍需要Host存活 |
| “压缩成功”与“历史被删除” | 压缩主要改变后续上下文投影，磁盘旧记录及插件快照未必减少 |
| “流式输出”与“整个读取链常数内存” | DSH ZIP输出流式但单个日志可能仍整体串行化；Pi LF读取仍保留entries数组 |
| “推理档位max”与“模型按预期推理” | 取决于具体API字段、模型路由、网关支持和响应映射，需要可观察协议证据 |

## 6.3 消息排队问题不能只用重复ID查完

本会话有32条team-member-message，新交付协议阶段13条带显式delivery ID，未见同一ID被重复记录为两条这种通知。这只排除了这一种显式重复样本：

- 早期通知缺少delivery身份。
- 同一文本可以换ID重复，或者不同文本都因等待太久而语义过时。
- Pi原生steer/followUp/pendingCustom、插件notifications、Goal.results、成员bridge outbox不是同一队列。
- 取消成员并不自动删除已追加的会话消息；历史消息存在也不等于系统又执行了一次任务。
- delivered标记的实现可能在模型实际处理之前发生；它不能独立证明消费成功。

进一步交叉复核确认：当前Team的普通triggerTurn:false通知走Pi的API直接追加路径，未调用扩展级message_end，所以对应实时ACK监听实际上覆盖不到它；下次restore才可能根据branch中的details确认。Goal自己的team:delivery-ack则是在consumeResults中主动提前发出。两种情况必须分别解释，不能统一写成“message_end代表模型收到”。

用户提到的另一轮插件测试中“成员关闭后仍排队上报”不全包含于本次主日志，未取得那轮完整运行证据。不能把这份日志里没有同ID重复，当作该现象不存在的证明。

`goal_wait` 返回“没有活动后台任务”也不能单独认定模型误用：短任务可能在异步派发返回与wait执行之间完成，或者下游任务在当时版本没有被登记进Goal pending。只有结合实际任务身份、时序、上一条工具返回和当时的目标状态，才能判断是合理竞态、协议表达缺口，还是模型在已知无任务后反复调用。初步统计的10次此类错误是现象计数，不等于10次已经定责的协调错误。

## 6.4 不能从本轮静态调查定因的观察

| 观察/问题 | 目前可确认 | 仍缺的证据 |
| --- | --- | --- |
| GPT接DSH时看起来不思考 | 已追provider参数和响应映射；UI是否展示reasoning与是否请求reasoning要区分 | 精确模型/API/配置、可脱敏出站字段、响应事件和推理计量 |
| DeepSeek接Codex不能触发子智能体 | 工具调用受模型能力、schema暴露与harness feature配置影响 | 最小任务、当次活跃工具schema、模型返回工具名/参数/ID、网关响应 |
| 1M上下文压缩上传失败 | 巨型单次摘要请求可能遇到输入窗口、字节、速率或网络限制 | 请求字节数、provider窗口/限额、HTTP状态、失败时点和可重试边界 |
| 所有子进程在取消后退出 | 静态链能看出Abort/kill请求和部分进程管理 | 各平台实际进程树、命令孙进程、容器生命周期和强杀实验 |
| Windows沙箱可用且足够硬件开发 | Codex/DSH有原生后端；不同backend声明full/partial且有能力限制 | 在本机工具链、WSL、文件链接、网络、凭据情况下的实际约束检查 |
| 所有插件在Pi1.3可直接共存 | 已核对部分宿主API与发布版；源码有兼容处理 | 联合装载、事件顺序、reload、工具同名和UI冲突的运行实验 |
| 崩溃后自动恢复不会重复副作用 | DSH与插件有持久身份、claim和恢复路径 | 各落盘窗口的故障注入、命令幂等边界、未知进程状态恢复 |
| Codex桌面所有定时机制都能从公开仓库找到 | 已定位公开Goal/多智能体/沙箱机制 | 桌面自动化服务的完整公开实现并未取得 |

这些是调查结论的边界，不表示需求被取消。下一阶段可以据此决定需要哪些设计约束和实验，但本章不预先替用户选择方案。

## 6.5 对最初分析的修正

最初材料收集阶段的FINDINGS只对监督器提前触发保持“待历史重放”判断。深入源码后，已发现当前HEAD的schedule(0)路径，且日志出现任务运行与检查几毫秒级相邻，因此更新为F01的已确认机制。

最初“Codex存在通知”的描述需要同时说明其trigger_turn=false；这不能用于否定用户观察到的“父会话得一直等”的使用体验。相反，源码支持“通知存在”与“idle自动新回合”是不同能力。

第三方项目的README或注释不作为实现最终依据。例如parent-wake的旧宿主hook注释与本地Pi1.3实际链不同；session-tools的格式化很好用也不意味着其readFileSync适合1GB输入；DSH流式ZIP也不代表单会话流式读取。后续计划应使用这些修正后的机制说明。
