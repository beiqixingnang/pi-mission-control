# 第三方补充：跨成员通信与后台命令完成通知

本章补充 agent-comms 8.13.20（Git `0faf73b095815bf68e6749fa5696b7e457a7484f`）和 pi-background-tasks 2.6.10（Git `799182ff65d7040732aea23b2001ea860b688531`）的具体通知链。没有运行网络mesh、后台任务或插件测试；这里不是两个项目全部功能的审计。

## N1：agent-comms 将通信传输与 Pi 唤醒桥接

### 身份与入口

[Pi bridge](../../../.reference/sources/plugins/agent-comms/src/bridges/pi/extension.ts:44) 从 harness=pi、cwd 的 identity slot 创建 mesh store/tool，session_start 时 attachIdentity、store.init、注册 agent、加入项目房间（130–158）。注册工具为 `agent_comms`，支持 room send、dm、成员发现和房间成员管理（210 行起）。

这是一套跨 harness 通信桥。它不负责为接收成员创建隔离工作区、不自动限制接收者命令权限，也不是业务 task/attempt 生命周期的权威。通信权限通过房间成员及 token 检查，执行权限仍由接收 harness 决定。

### 发消息的真实链

[RoomMessaging.sendRoomMessage](../../../.reference/sources/plugins/agent-comms/src/core/room-messaging.ts:69) 解析 room 名称/ID，检查发送者属于成员集合并持有 room:member token。可选 durable=true 会先写发送者本地 room-send notice/oplog，再创建消息身份，把消息保存在房间历史，并用 token 对每个远端成员执行定向 room.send。

room send 的返回区分每个远端成员已接收还是暂存待重试；单个成员不能回答不要求阻塞整个 fan-out。DM 复用同样的 room.send 机制，跨设备第一次消息先走对方同意的 DM token 申请；self-DM 才是本地便笺路径（同文件 165 行起）。

注意这里的 durable 只是特定调用的持久补收语义，不代表所有 mesh 状态都自动拥有独立持久数据库。当前 deliveryQueues、agents、messages 等共享 Map 有自己的同步/重放逻辑；不能把房间发送持久化与全部业务任务持久化混成一个承诺。

### 接收和启动模型的真实链

```text
mesh状态/消息更新
 → DeliveryEngine 的本地接收回调
 → Pi extension store.onDelivery
 → 根据发送者 hint 或事件类型选 steer/followUp
 → actionable: pi.sendMessage(triggerTurn:true)
 → informational: 暂存，下一次工具调用时读取
```

[Pi onDelivery](../../../.reference/sources/plugins/agent-comms/src/bridges/pi/extension.ts:81) 的去重 key 是 `event.type + formatDeliveryEvent(event)`，recentDeliveries 内存集合上限 100，超过后删最老一半。发送方 hint=followUp 或 steer 时优先使用；没有 hint 时 actionable 事件默认 steer。得到 deliverAs 后使用 `triggerTurn:true`，因此能通过宿主 idle/new-run 或 busy/queue 路径唤醒。

它没有把每一条后台事件都当作需要模型回应：普通信息放 informationalBuffer，同时只更新 UI/通知。这个分层有助于减少无意义回合，但默认 actionable 分类和 sender hint 也会直接影响模型打断频率；本轮没有验证其在大团队负载下的表现。

### 队列、重放与“已读”含义

[DeliveryEngine.queueDelivery](../../../.reference/sources/plugins/agent-comms/src/core/delivery-engine.ts:89) 按接收agent排队，最大 100（mesh-store-shared.ts:62），超过则丢最老项。它不是无损无限日志。

同步回来的队列按 JSON 事件去重，重放主要针对 room_message、dm 和仍有效邀请；瞬时presence等信息不重复主动通知（delivery-engine.ts:259 行起）。本地又有50个key的去重集合。

[applyPatch 的 delivery 路径](../../../.reference/sources/plugins/agent-comms/src/core/delivery-engine.ts:325) 调用本地 onDelivery 后，通过零延迟 timer 自动 markRead。这个 read receipt 表示**通信桥接层已接收并通知**，不是“LLM 已在出站请求中看到且完成处理”。因此要把它拿来实现业务工作流时，不能用 readBy 或 delivered 就断言任务完成或无需恢复。队列同步、bridge去重和业务幂等是不同层。

## N2：pi-background-tasks 把进程终态、产物和通知顺序明确分开

### 注册与启动选项

[extension.ts 的 bg_run](../../../.reference/sources/plugins/pi-background-tasks/src/extension.ts:968) 把任务交给 BackgroundTaskRegistry，工具层默认 notifyOnCompletion=true、triggerOnCompletion=true（1033 行）。Registry 的内部 start 默认 triggerOnCompletion=false（registry.ts:1489），因为其他调用者可能不希望自动触发模型。

所以核对默认行为必须追到**实际消费者**，不能只搜到 Registry 的默认false就说整个插件不会唤醒，也不能把工具默认true泛化到所有内部任务。

### 完成前的顺序

[finalizeTask](../../../.reference/sources/plugins/pi-background-tasks/src/core/registry.ts:3965) 有 finalized guard，清超时句柄后，等待 POSIX process group / Windows force cleanup 的结果；失败可把终态转为 failed。telemetryWrapped 输出还等短quiet window、冲刷末尾JSONL片段，再关闭/fsync输出流。

它在 [3991–4019](../../../.reference/sources/plugins/pi-background-tasks/src/core/registry.ts:3991) 保持 status=running，直到输出收束并尝试写最终metadata；这防止用户或模型看到 completed 时读到的还是前一个assistant回合快照。元数据写入失败会转failed、再尝试记录失败状态；第二次仍失败会记录错误，不能凭通知文本中的“durable”概括所有故障分支。

接下来先唤醒task waiters、发布terminal事件，再等待 [terminal publication gate](../../../.reference/sources/plugins/pi-background-tasks/src/core/registry.ts:4036)；被拒绝则记录错误，否则允许通知。事件发布与模型通知有独立生命周期，event-bus关闭不必等同于notification不可用，但session shutdown仍会抑制模型通知。

### 通知与失败处理

[notifyCompletion](../../../.reference/sources/plugins/pi-background-tasks/src/core/registry.ts:3919) 检查 notifyOnCompletion、notified、shuttingDown，生成包含taskId/status/output-file的短通知；传 `deliverAs:followUp`，triggerTurn由task.triggerOnCompletion决定。full logs保存在产物里，不把全部stdout塞进主模型。

notified 先置true；若 sendCompletionNotification 同步抛错就回滚false。实际注册的 [sendCompletionNotification](../../../.reference/sources/plugins/pi-background-tasks/src/extension.ts:268) 调用 `pi.sendMessage`，接口返回void，因此这条链并不提供“新模型回合已成功完成”的确认。不要把发消息函数返回当作业务消费ack。

terminal publication另有有限次数重试、重试timer和abandoned理由（registry.ts:3880–3916）。它与模型通知重试不能混为一谈；完整可靠性还取决于各消费者如何监听发布事件及恢复任务。本章只追查上述关键提交顺序，不宣称整个插件支持 exactly-once。

## N3：和当前插件、pi-subagents 的比较

| 问题 | 当前插件 | agent-comms | pi-background-tasks |
| --- | --- | --- | --- |
| 谁负责消息传输 | 父Pi的bridge文件、RPC和event bus | mesh/房间/DM及Pi桥 | 当前任务Registry和宿主通知桥 |
| 哪些事件开模型回合 | Goal结果、监督器检查；普通note不主动开 | actionable或明确hint，默认steer | 完成通知由triggerOnCompletion选择，bg_run工具默认true |
| 去重身份 | task/delivery ID、sequence、queuedDeliveries等，另有Goal消费状态 | bridge按类型+格式化文本和有限key集合；core另有message/token/queue | task.finalized、publication状态、task.notified，消费ack仍独立 |
| 接收确认 | Goal consume前ACK；普通API追加路径不触发扩展message_end，恢复时才可由branch回推ACK | bridge接收后可自动markRead | 通知API返回不表示模型处理完成 |
| 大输出 | reply等可能反复进入roster快照 | 主要是通信文本 | 保存output文件，通知只带摘要和路径 |
| 是否执行隔离后端 | workspace disabled/Podman/host分支 | 不是执行沙箱 | 负责进程任务生命周期，沙箱仍看shellPolicy和具体执行路径 |

pi-subagents 的父唤醒、监督请求、后台结果重放由子智能体生命周期章详述。以上比较揭示各项目分别拥有哪一层状态，不表示必须把它们直接拼装成新插件。
