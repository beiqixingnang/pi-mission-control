# 隔离与权限链调查

核对日期：2026-10-17（Asia/Shanghai）。本报告只追踪隔离与权限执行链，未改业务源码，未安装、构建或运行参考软件，未变更系统权限或沙箱，也未读取会话原始日志。代码行号对应当前本地检出；上游参考版本按固定 SHA 标识。文档声明仅用作背景，结论以代码调用路径为准。

## 版本与结论边界

| 对象 | 核对版本 |
|---|---|
| 本地 Pi | vendor 中 @earendil-works/pi-coding-agent 与 pi-agent-core 1.3.0；不是操作系统沙箱 |
| 当前插件 | pi-mission-control package.json 1.4.0；权限章节依据当前 extensions/workspace、extensions/team、extensions/subagent 工作树。对照的已记录 baseline 为 c34e32fec02d43808c2e4d8b313017dba2347993；此版本字段不证明当前工作树是该独立发布包内容 |
| DeepSeek Harness | 0.2.1-alpha.5，检出 SHA 1517a4dbca0a2789ff1d41ba439600f8547d23fa |
| Codex | 公开源码检出 SHA e16b631d08cdf82773831f9bbfb793da687d5299 |
| @gotgenes/pi-permission-system | npm 发布版 40.2.2；源码提交 085d8bb9d36ff57fe8c155f6da8ce8b86ad42087 |

绝对路径基准（后文引用的相对文件后缀与行号均从对应根目录拼接）：当前仓库 PI_ROOT=<repo>/；本地 Pi 源码为 PI_ROOT/vendor/pi-1.3.0/；DSH_ROOT=PI_ROOT/.reference/sources/deepseek-harness/；CODEX_ROOT=PI_ROOT/.reference/sources/codex/；GOTGENES_ROOT=PI_ROOT/.reference/sources/plugins/gotgenes--pi-permission-system/。例如后文 Codex 的 core/src/... 路径完整形式为 CODEX_ROOT/codex-rs/core/src/...。

DSH 源码另受根 AGENTS.md、packages/AGENTS.md、packages/experimental/AGENTS.md 约束；native/system/AGENTS.md 已读。调查目录之外的上游源码未改。报告没有据文档推断 Codex 桌面闭源部分、真实 Windows/macOS/Linux 主机状态或其他进程的行为。

## Pi 1.3.0 的能力入口

常规 Pi 会话把 read、bash、edit、write 定为初始活动内建工具；内建工具定义从 createAllToolDefinitions 建立，默认执行路径是本机文件操作和本机 shell。具体入口为 vendor/pi-1.3.0/packages/coding-agent/src/core/agent-session.ts:3636-3687、vendor/pi-1.3.0/packages/coding-agent/src/core/tools/index.ts:182-223、vendor/pi-1.3.0/packages/coding-agent/src/core/tools/bash.ts:96-165。bash 会在当前 OS 用户下启动 shell；POSIX 启用 detached process group，超时或 abort 通过 killProcessTree 发信号；Windows 走 taskkill /T。shell 环境由 process.env 派生，见 vendor/pi-1.3.0/packages/coding-agent/src/utils/shell.ts:138-149、185-215。这些行为提供执行与取消能力，不提供访问控制。

extension 可以在同一 Pi 进程中注册任意 JavaScript tool、监听 tool_call、覆盖工具或调用 ctx.executeTool；Pi SDK 也接受调用方提供的 customTools。注册由 vendor/pi-1.3.0/packages/coding-agent/src/core/extensions/loader.ts:240-303 执行。tool_call 事件在实际工具 execute 前通过 AgentSession 的工具流水线运行；从 extension 调用 ctx.executeTool 的嵌套工具也走同一套 hooks，见 vendor/pi-1.3.0/packages/coding-agent/src/core/agent-session.ts:653-682、728-764。这个事件是可信扩展提供的应用层门禁；不限制 extension 自己执行的 Node.js 文件、网络、子进程或 OS API。

CLI 的 --tools 选择活动工具，--no-extensions 关闭发现和内建扩展，但显式 --extension 仍然加载；--no-mcp、--no-skills、--no-prompt-templates、--no-context-files 关闭相应发现入口。见 vendor/pi-1.3.0/packages/coding-agent/src/cli/args.ts:147-217、327-336，以及 vendor/pi-1.3.0/packages/coding-agent/src/main.ts:540-551。SDK 文档和创建路径还允许 consumer 组合自定义工具与 resourceLoader，见 vendor/pi-1.3.0/packages/coding-agent/src/core/sdk.ts:183-191、280-295、460-472。因此“工具列表被收窄”只约束该 AgentSession 暴露/调用的 Pi 工具；它不能约束宿主进程或绕开 Pi 工具系统的扩展代码。

## 当前 workspace 插件：成员能力如何进入

workspace 不是默认作用于主会话或所有子会话的全局沙箱。它在 team_spawn、普通 subagent 单次参数、tasks[]、chain[]，或 agent 文件 frontmatter 的 workspace 字段显式配置时触发。普通子智能体只传 cwd 是改变起点，不构成路径限制；workspace 预设和单项/顶层参数的优先级见 extensions/subagent/agents.ts:67-112、extensions/subagent/index.ts:426-455、extensions/subagent/index.ts:670-704。team_spawn 将 workspace 配置交给同一个 prepareWorkspaceLaunch，见 extensions/team/index.ts:795-831。没有 workspace 的子会话保留 Pi 原始工具行为，见 extensions/workspace/launch.ts:17-23。

prepareWorkspaceLaunch 先检查成员不能从已有 PI_AGENT_WORKSPACE_POLICY 子进程再派生或扩大 workspace；解析并验证 root/cwd、tool allowlist、execution 后，追加显式 workspace guard 扩展及环境变量。受限启动参数关闭 extension discovery、MCP、skills、模板、themes、上下文文件，并通过 --tools 或 --no-tools 只启用其计算出的工具集。Team 创建时随后会显式追加 member-bridge 扩展；普通 subagent 不加这条团队桥。Podman 预检失败会在 child spawn 前报错，不回退到 host；见 extensions/workspace/launch.ts:17-40、extensions/team/index.ts:819-829、extensions/workspace/policy.ts:57-76。Team 和 subagent 两条创建链都先准备 launch plan，验证错误时不会创建 Pi 子进程，分别见 extensions/team/index.ts:795-824、extensions/subagent/index.ts:426-455、496-505。

受限子会话显式加载 workspace/index.ts 和 child-only member-bridge.ts；这是因为 Pi 允许 --no-extensions 与显式 --extension 并用。workspace/index.ts 读取策略环境，无法解析时让工具执行失败；注册 tool_call allowlist、session_start 活动工具过滤、user_bash 拦截，并把内建 read/write/edit 包装成 workspace_read/workspace_write/workspace_edit，见 extensions/workspace/index.ts:16-52、61-82。Pi 的 tool_call hook 执行失败会阻断原工具调用；extension 工具本身也通过 guard 在执行前 authorize 路径。

disabled 模式只给受控文件工具与团队桥接工具，不注册 shell/exec。sandbox 模式另外注册 workspace_exec 与 workspace_exec_status，且只允许 Podman。host 模式会显式启用基础 Pi bash；文案说明为 trusted host execution、不是 OS sandbox。模式枚举与 allowedTools 定义见 extensions/workspace/launch.ts:8-15、extensions/workspace/policy.ts:21-29。以下为从实际注册名和 allowlist 推导出的重要 host 路径：

* launch.ts 在 host 模式将 read/write/edit/bash 映射为 Pi 原名，见 extensions/workspace/launch.ts:30-38；workspace/index.ts 的 guard 包装工具却始终将文件工具重命名为 workspace_read/workspace_write/workspace_edit，见 extensions/workspace/index.ts:43-53、61-82。因而 host 模式的 --tools 选择会激活 Pi 基础 read/write/edit/bash，而非有路径检查的同名 workspace_* 包装器；tool_call 也把 read/write/edit/bash 视为 permitted。root/access 仍存在于 roster metadata 和提示词，但不限制基础文件工具路径。配置为 access=read-only 时 bash 仍被 host allowlist 明确允许，shell 可在宿主用户权限下写任意 OS 可访问位置。此结论由活动名称和注册代码静态对照得出，未运行实例确认。
* team_configure 可在已有 restricted、idle 成员上把 execution 改成 host，并重新启动成员；它剥除预设中的 bash/exec 后再按新模式添加，见 extensions/team/index.ts:959-975。该工具在 extension 中直接注册，本身没有额外操作系统确认；若部署的其他审批插件拦截此 tool call，则另当别论。

disabled 与 sandbox 模式的基础 Pi 原名由不匹配的 permitted set 拦截；受控文件工具逐次检查 WorkspaceAccess。authorize 规范化路径，只接受 primary root 和 readRoots 内路径，写入只接受 primary root，拒绝 .pi/.agents/.git 和运行/安装目录；逐组件 lstat、realpath 后拒绝符号链接/junction、nlink > 1 的硬链接文件、特殊对象和根外 canonical path。读取限制 20 MiB，写入采用打开现有 inode 或独占创建后再次检查 regular file/nlink。见 extensions/workspace/policy.ts:79-151。额外根最多 20 个、必须是目录，不能与 primary root 重叠；只加入 readRoots，不加入 write roots，见 extensions/workspace/policy.ts:70-76、89-99。列表/find/grep 也拒绝链接，限制遍历项目与文件/输出预算，见 extensions/workspace/index.ts:84-169。

这些是插件自己的 Node 文件 API 路径检查，不是 OS ACL、系统调用过滤或文件系统命名空间。命令、非 Pi API、其他进程、已加载的任意扩展以及授权目录之外的挂载/别名关系都不受内核级根限制。路径检查和后续文件系统 syscall 之间仍有竞争窗口；插件注释也明确不承诺抵御并发宿主进程替换目录。插件拒绝一般软链接/junction 与多链接文件降低常见逃逸面，但不能把逐次 Node 检查等同于 OS 强制。

## Podman 执行路径与边界

execution=sandbox 是插件中唯一提供 OS/容器级命令隔离的模式。resolveWorkspace 在 child 启动前 probe 本地 Podman 和已安装镜像，拒绝不可用/缺镜像，不 pull、不降级；镜像名解析为 immutable image ID。运行时在受控临时目录复制工作区快照，跳过 .git、.pi、.agents、node_modules、.mission-control、软链接、nlink>1 和特殊对象；primary read-only 与额外只读根分别作为容器文件树拷贝，额外根映射至 /reference/N。见 extensions/workspace/sandbox.ts:44-58、168-205、267-340、493-501、750-816。

容器通过 Podman create 固定为 --pull=never、--network none、--read-only、忽略镜像 volumes、--cap-drop ALL、no-new-privileges、限制 PID/内存/CPU、UID/GID 65534，以及私有 tmpfs。read-write 的 /workspace 是容器内 tmpfs；宿主目录不 bind mount。默认限制为 1 CPU、512 MiB、256 PIDs、5 分钟最大执行；配置上限为 64 CPU、64 GiB、32768 PIDs、3600 秒。命令通过 podman exec 在容器 /bin/sh -c 中运行，create 参数及 argv 调用见 extensions/workspace/sandbox.ts:533-557、808-825。网络关闭针对容器命令；Pi 主进程本身仍需要访问模型服务。该路径共享宿主内核，Podman daemon/machine 与其安装镜像是信任基础。

sandbox 模式即使 access=read-only 仍允许 workspace_exec：访问字段控制快照与 workspace 写回，不关闭命令工具。只读工作区和 extraReadRoots 在镜像层不可写；read-write 的容器改动只从 /workspace 导出。导出路径重新授权，忽略链接/硬链接/特殊对象，比较原始文件哈希并在宿主并发改动时拒绝覆盖；见 extensions/workspace/sandbox.ts:836-843、650-738。后台审计是显式例外：执行开始前无论 read-only 都会写 primary root 下 .mission-control/runs/<id>/receipt.json 与 output.log，见 extensions/workspace/sandbox.ts:764-775。超时/取消后移除本次随机命名容器；移除失败记 containerStopped=unknown，且结果不报告 ok，见 extensions/workspace/sandbox.ts:817-871。Podman CLI 子进程继承的不是完整父环境，而是受限的 Podman 控制变量清单；容器命令本身没有 --env 传递，创建时仅显式设置 HOME=/tmp，见 extensions/workspace/sandbox.ts:403-409、533-556。

## 成员通信与权限继承

workspace 模式为受限成员额外加载 team bridge；bridge 自身只提供消息、wait/status/cancel，不接受路径或启动进程。请求由父进程按成员 roster 检查通信关系，见 extensions/team/member-bridge.ts:1-7、78-110 与 extensions/team/index.ts:733-750。成员之间的 mayCommunicate 判定是 sender.communication.allow 包含对方 **或** recipient.communication.allow 包含发送方，见 extensions/team/messaging.ts:52-63；因此只要任一方 allow pair 即可通信，不是双向双方均同意。普通 subagent workspace 被配置后不提供嵌套 subagent 工具；已有受限成员也无法通过 launch.ts 再派生扩大授权。但队友消息是提示内容，不会把接收方的工具权限复制给发送者；接收方仍按自己的工具执行。

当前 Pi team 的子进程环境明确由 RpcClient 用 { ...process.env, ...options.env } 构造，见 vendor/pi-1.3.0/packages/coding-agent/src/modes/rpc/rpc-client.ts:94-99；team 传入的 workspace env 只是追加策略、成员名和 bridge 配置，见 extensions/team/index.ts:839-844。普通 subagent 的 node spawn 同样使用 { ...process.env, ...plan.env }，见 extensions/subagent/index.ts:496-505。因而所有 host ambient env（含凭据变量，如果父进程中存在）进入 Pi child 进程；workspace 文件权限不会剥除该环境。disabled child 没有任意 shell/读取环境的工具入口，sandbox command 不拿到 Pi 父进程 env；host child 的 bash 继承 Pi shell environment，能直接查看进程环境。这是代码路径可确认的进程环境继承，不等同于说所有凭据都可通过 disabled 文件工具读出。

普通 subagent 在 Windows 取消时启动 taskkill /T，POSIX 则调用 process.kill(-pid, SIGTERM) 后再对子 Pi 根 PID 发 TERM/KILL；其 spawn options 没有 detached=true，见 extensions/subagent/index.ts:499-504、614-632。POSIX 负 PID 调用只有在目标确实独立建立 process group 时才会覆盖整组；当前 Node spawn 没有建立新 group 的选项。未执行进程实验，故把“POSIX 后代可能未随子 Pi 一并退出”记为代码层风险而非实测结果。Pi 内建 bash 自身则显式 detached POSIX 并按 pid group 杀进程，见 vendor/pi-1.3.0/packages/coding-agent/src/core/tools/bash.ts:112-128、vendor/pi-1.3.0/packages/coding-agent/src/utils/shell.ts:185-215。team RPC stop 会对 member Pi 根进程 TERM，1 秒后 KILL，见 vendor/pi-1.3.0/packages/coding-agent/src/modes/rpc/rpc-client.ts:145-166；之后由该 Pi runtime 负责其 shell children。

## @gotgenes 权限与 worktree 对照

40.2.2 的 @gotgenes/pi-permission-system 在 Pi tool_call 边界执行权限规则、询问/拒绝与审计：index.ts 注册 createFailClosedToolCall，PermissionGateHandler 把 tool 名、输入、cwd 送入 policy pipeline，实际决定翻译为 Pi 的 block 结果。见 .reference/sources/plugins/gotgenes--pi-permission-system/packages/pi-permission-system/src/index.ts:385-403、handlers/permission-gate-handler.ts:48-77、handlers/tool-call-boundary.ts:20-60。它比只隐藏工具更接近执行点，能按 Bash command、路径工具或 MCP intent 评估，但本身仍是同一 Pi 进程里的应用级 hook，不改变 OS 令牌、目录 ACL、namespace、网络栈或扩展 JS 权限。其规则是否覆盖某个 surface 取决于 permission-system 与相应 tool access extractor / policy composition 是否加载；不能仅凭安装该 npm 包宣称系统沙箱。

该发布版还通过 pi-subagents child 生命周期识别 in-process 子会话并维护父节点/权限请求转发；父子是共享 process/globalThis 的 extension sessions，而独立进程 child 通过 environment/session-path heuristics 识别，见 .reference/sources/plugins/gotgenes--pi-permission-system/packages/pi-permission-system/src/authority/subagent-context.ts:25-80、authority/subagent-lifecycle-events.ts:77-105。权限请求可由 child 交给父会话处理，不意味着继承 OS 文件/网络强制。worktree provider 只有 agent 类型列在全局/项目 worktreeAgents 才创建临时 git worktree，否则返回 undefined 继续父 cwd；配置文件缺失或无该 agent 默认不隔离，见 .reference/sources/plugins/gotgenes--pi-permission-system/packages/pi-subagents-worktrees/src/config.ts:2-49、workspace-provider.ts:70-91。它只将 git checkout/cwd/branch 与父工作树分开：仍使用同一用户和 kernel，可通过绝对路径、shell、进程环境、其他文件/网络能力访问该用户能访问的资源。清理器会把所有工作树改动 stage/commit 到新分支，不是删除权限或访问隔离，见 .reference/sources/plugins/gotgenes--pi-permission-system/packages/pi-subagents-worktrees/src/worktree.ts:94-125。

## DeepSeek Harness 的实际 compose 与执行链

DSH 的核心类型是每次 capability call 携带的 SandboxExecutionPolicy（mode + workspaceRoot + sessionId）以及独立的 enforcement 事实。dsh-sandbox 定义模式：read-only、workspace-write、danger-full-access，并明确网络和进程可见性不属于其模式词汇，见 .reference/sources/deepseek-harness/packages/sandbox/sandbox/src/index.ts:24-36。sandbox-policy 以 session header.cwd 作为 workspace-write 根，effective mode 顺序是 approved per-call mode > session 最后一次 sandbox/mode event > deployment default；sandbox/mode 只写 session event，见 packages/sandbox/sandbox-policy/src/index.ts:104-179、packages/sandbox/sandbox-policy/src/session-mode.ts:41-54。

不应假设该 capability 在任何 DSH composition 中自动存在。当前检出的 base bundle 显式加载 sandbox-local、sandbox-policy、平台对应的 bash/pwsh-sandbox 与 fs-sandbox；base 把 mode 设为 DSH_PERMISSION_MODE，缺省 workspace-write，approval policy 缺省 ask；见 packages/bundle/base/cordis.patch.yml:237-263、511-512。sdk-minimal 也列出 sandbox 服务，但其他 profile/自定义 composition 是否启用 shell 或 filesystem enforcing provider 需逐一看其 cordis patch。仅加载 sandbox-policy 不会拦截某个未接入它的 consumer。

shell 调用链为 tool/bare caller → dsh-bash-sandbox → LocalBashExecutor.resolve 把每次 mode/root 放入 spec → sandbox provider confine(exact argv, policy) → subprocess spawn。danger-full-access 明确直接调用父类本地执行器；其它 mode 先拿 runner argv，runner 构造失败为 SANDBOX_UNAVAILABLE，前台不会改走原始命令，见 packages/shell/bash-sandbox/src/index.ts:80-132。fs-sandbox 只覆盖 writeText/editText：read-only 一律拒写，workspace-write 对新 canonical target 做 containment 后再将 fresh target 交给本地 atomic write/edit；danger-full-access 原样委托。reads/list/stat/watch 不被这个 backend 限制，见 packages/fs/fs-sandbox/src/index.ts:1-24、55-144。故 DSH 的 mode 是受控 write effect 范围，而非“只允许读 workspace”：普通 child command 在可读权限上可看到调用用户可读的其他文件，除非另有 read-side provider。

本地 sandbox-local 针对同一主机 shell argv 包装平台 runner，选择链与 probe 在代码中明确：Linux [bwrap, landlock]，macOS [seatbelt]，Windows [windows-acl]。Linux 有多个候选时按序 functional-probe，全部 unusable 则 SandboxUnavailableError；单 runner 不做链路 probe，执行时拒绝会作为 runner failure。见 packages/sandbox/sandbox-local/src/index.ts:151-178、325-343、498-550。sandbox/bash consumer 将平台 fatal runner signature / spawn failure 与普通策略拒绝区别处理，不会静默返回原 argv，见 packages/shell/bash-sandbox/src/index.ts:115-131。自定义 runnerCommand 会跳过平台选择/probe，却把供应者配置当作 full enforcement 声明；外部操作者配置错误时此声明不构成独立证明，见 sandbox-local/src/index.ts:45-60、325-343。

DSH runner 实际约束范围如下。每行“full/partial”只指 DSH file-effect 目标，不能推出 network、read 或全面隔离。

| 平台 / 执行证据 | 文件系统与其他约束 | 明确未约束或限制 |
|---|---|---|
| Linux bwrap | bwrapProfileArgs 默认把 / ro-bind，workspace-write 时把实时 workspace 子目录 bind 可写；创建 PID namespace，见 sandbox-local/src/profiles.ts:16-23。 | 该调用未 unshare-net；不做 DSH network policy。代码未筛 hardlink，workspace 内 hardlink 可别名同 inode，这个写路径属性没有通过代码检查消除；属于从 live bind 机制作出的风险推断，未实测。 |
| Linux Landlock | 对 / 只读授权，workspace/tmp/dev-null 做 RW allow-list；具体平台可用 ABI 由 native launcher functional probe 回报 full/partial，见 profiles.ts:26-36、sandbox-local/src/index.ts:523-539。无兼容 runner 时 fail closed。 | 这是文件访问规则；不提供网络或 PID namespace。旧 ABI 可能只能部分覆盖访问类型，消费者应看 enforcement。 |
| macOS Seatbelt | sandbox-exec profile 为 allow default + deny file-write*，再按统一 writableRoots 开放 workspace/temp roots，见 profiles.ts:38-57。 | 没有 deny network、文件读取围栏或独立进程 namespace；遵循文件写入策略而已。 |
| Windows ACL restricted token | CreateRestrictedToken WRITE_RESTRICTED 与低完整性 token；workspace/temp 的 capability SID ACE 允许限定写/删，base filesystem 子目录同时受删除保护，见 sandbox-windows-acl/src/token.ts:182-241、sandbox-windows-acl/src/index.ts:224-304、349-430。native API 出错不以原用户 token spawn。runner 的 Job 用于结束 child range。 | enforcement 明报 partial：NTFS hard link 是同一对象，能让 workspace 获权影响外部别名；读、网络、进程可见性不受此 token 限制，其他 AppContainer 写过 ACL 的文件可能对低完整性 child 不可读。见 sandbox-windows-acl/README.md:102-110、125-133。 |

Linux profile 的安全语义不是文件树快照：bwrap 使用同一主机 kernel 与 live bind workspace；macOS Seatbelt 同样是同一主机文件系统上的 write policy；Windows ACL 修改相应对象 DACL/labels。DSH 的权限失败结果来自文件系统拒绝标记或 runner denial；runner 启动/配置失败时 foreground 会抛不可用错误，不能解释成一般 policy deny。Landlock 的部分 ABI 由结果事实传播，而不是隐藏掉 partial。

Landlock 的 native 执行入口也已沿调用链读到。sandbox-local 的 Landlock argv 使用 profiles.ts:26-36 生成，launcherPath/probe/grantArgs 来自 native/system/packages/entry/src/index.ts:22-41、45-98、102-144；probe 实际 spawn 同一 launcher 的 --probe 并从返回行区分 full/partial，缺失文件、超时或不强制时为 unusable。C launcher 在 native/system/packages/entry/src/main.c:221-258 查询内核 ABI、构造 allow-list、设置 PR_SET_NO_NEW_PRIVS 并调用 landlock_restrict_self；ENOSYS/EOPNOTSUPP 等拒绝在 exec 前退出。较旧 ABI 输出 partial diagnostic 后仍 exec，但只受该 ABI 能表达的 filesystem access 类约束，见 main.c:281-295、native/system/docs/cli-contract.md:23-30。规则限制文件访问，不配置 network 或 PID namespace；launcher 自身在施加规则后 exec，子进程继承同一 Landlock domain。native/system/AGENTS.md 另明确缺少二进制/不支持 kernel 是 unusable，不在安装时编译或退回无约束执行。

子会话的 in-process DSH subagent manager 在新建前抓取 parent 明确 sandbox/mode override，并在子 session log 中追加 source=delegation；子 session header.cwd 作为该 child workspaceRoot。审批策略在存在 approval service 时 pin 为 never；只带父 session 显式模式覆写，不把 deployment default/one-shot 扩权 grant 当成 child seed，见 packages/subagent/subagent/src/child-agent.ts:135-153、220-279、packages/subagent/subagent/src/manager.ts:402-447、877-895。之后每个 child call 由同一个 child composition 的 shell/fs consumer 重新 resolve policy。该结论针对此本地 in-process provider path；外部 ACP、MCP、用户自装的 custom consumer、remote workspace 需各自确认，不把一个 subagent trace 推广到所有适配器。

DSH 的子进程环境与 Pi 插件不同：subprocess-local 从 scrubbedParentEnv 基础生成子进程 env，移除名字含 KEY/PASSWORD/SECRET/TOKEN 的环境变量以及 ambient DSH_*；PATH/HOME/locale/proxy 仍会保留，显式 spec.env 会在 scrub 后重新合并。见 packages/subprocess/subprocess/src/index.ts:40-79、packages/subprocess/subprocess-local/src/spawn.ts:36-53、448-473。这个名称启发式不覆盖任意秘密命名，也不阻止工作区中的密钥文件读取；bash-local README 记录 caller env 与 trusted dshEnv 在 scrub 后覆盖顺序，见 packages/shell/bash-local/src/index.ts:137-173。MCP/SDK transport 自己拥有 spawn 时不走本地 subprocess provider，相关 DSH adapter 另调用 scrubbedParentEnv 再合并 config；外部插件则不能由此推断。

subprocess-local 是执行所有性和取消资源的 owner，不等于 sandbox provider：Windows ordinary spawn 优先由 Job/runner 管理，Linux 选可用 user-systemd scope，否则 PGID fallback，macOS 使用较弱 fallback；README 明示脱离 process group/session 的后代不保证终止或计入 waitForExit，见 packages/subprocess/subprocess-local/src/index.ts:197-277、spawn.ts:448-480、subprocess-local/README.md:149。OS process range 决定取消与 quiescence，不改变子命令的文件/network policy。

## Codex 公开源码：系统 sandbox 的 command 调用链

Codex 公开实现中的实际执行链是 unified_exec handler 建立 request → CoreToolOrchestrator 从 TurnEnvironment 取得 filesystem/network policy、cwd 与 workspace roots 并选择 initial backend → SandboxAttempt.env_for 调 SandboxManager.transform → ExecRequest → UnifiedExecProcessManager/平台 runner spawn。入口见 codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:300-355、399-423，orchestrator.rs:143-164、327-384，tools/sandboxing.rs:490-520，SandboxManager transform 实现在 codex-rs/sandboxing/src/manager.rs:355-552。SandboxManager 根据 SandboxablePreference 与 PermissionProfile 决定初始 backend；Auto 在 restricted filesystem/network 或 managed-network requirements 时需要 platform sandbox；Forbid 返回 None，Require 表示请求隔离；但 platform selection 也会返回 None（例如明确禁用/没有对应平台后端），见 sandboxing/src/policy_transforms.rs:646-665、sandboxing/src/manager.rs:313-352。此 None 是选择结果，不能理解为内核确认隔离。选定 backend 的 transform/preparation 失败会返回 SandboxTransformError；Linux helper 缺失、Seatbelt profile 准备失败、Windows wrapper 不支持当前 policy 都会错误返回。

Codex 另有明确、审批驱动的无沙箱重试路径，不能概括成“永不降级”。只有 active filesystem policy 不含 deny-read restrictions 时，unsandboxed_execution_allowed 才允许这种 retry；sandbox deny 后还需满足 tool/approval-policy 条件，发起 approval 后再次构造 SandboxType::None 的 SandboxAttempt。若 deny-read 规则必须保留或审批不可用/被拒绝，则不这样放宽，路径返回错误。代码见 core/src/tools/sandboxing.rs:284-294、core/src/tools/orchestrator.rs:429-472、484-557。此处是显式命令级权限升级，不是 bwrap/Seatbelt/Windows runner 运行失败后自动回退。

Linux 默认 codex-linux-sandbox 使用 bwrap 构建文件和 namespace view，之后在 inner process 应用 no_new_privs+seccomp。可用系统 bwrap 时优先使用；缺失时用随 Codex CLI 捆绑的 bwrap。WSL1 因 user namespace 条件被拒，WSL2 按 Linux 路径。legacy Landlock 是显式旧路径，并非系统 bwrap 的一般缺失时静默替代；restricted filesystem 与 managed proxy 等场景要求 bwrap。文件默认 ro-bind /，Writable roots 覆盖 bind 可写，网络受限时隔离 network namespace 并 seccomp 屏蔽相关 socket；managed-proxy 是 unshare-net + 代理路由桥接；seccomp 还阻断 io_uring 与受限制的 socket family。源码入口为 sandboxing/src/manager.rs:477-527、sandboxing/src/landlock.rs:16-67、linux-sandbox/src/linux_run_main.rs:128-167、linux-sandbox/README.md:16-28、47-120。文件根权限和网络策略是分离 policy 维度。

macOS 通过 sandbox-exec 加动态 SBPL profile；文件允许/拒绝来自 filesystem policy，网络根据 NetworkSandboxPolicy、proxy endpoints、enforce_managed_network 构造独立允许/拒绝条目。若 managed-network 必须执行但 proxy/endpoints 准备失败，profile preparation 会返回错误而非开放直连；Seatbelt 不可用或 profile error 也在 transform 失败路径。见 sandboxing/src/manager.rs:436-473、sandboxing/src/seatbelt.rs:307-370、1032-1047。不要把 Unix 的同一“workspace-write”文本理解成同一 OS 机制。

Windows 两个实际后端需区别。WindowsRestrictedToken 通过 wrapper 的 spawn 路径，以 DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED 的 CreateRestrictedToken 构造 token，加入能力/额外 restricting SIDs、Logon 与 Everyone，设置 token default DACL；内核 access check 将普通用户 SID 权限与 restricting SID 权限相交，见 windows-sandbox-rs/src/token.rs:468-524。它不是 AppContainer token。非提升后端只可靠约束适配的 write root/carveout；split read、deny-read、不同 writable roots 等无法直接映射时，Windows filesystem overrides 明确返回“refusing to run unsandboxed”，见 sandboxing/src/windows.rs:33-70、74-132、133-212。Elevated level 使用独立 setup/provisioning 与 filesystem override；managed network 需要 elevated backend，否则 transform 明确错误，见 sandboxing/src/manager.rs:529-542、windows.rs:215-260。Windows selection 由 sandbox type/level 选择，不可只读 SandboxType::WindowsRestrictedToken 便断言走了哪一条。

Codex 的 MXC backend 是另一路 Windows 原生 Process Security Environment。source 明确说明它不调用 MXC AppContainer dispatcher，不编辑 host ACL，不请求 elevation，也排除 MXC 较旧 AppContainer fallback；可用性以实际 PSEC probe 为准，deny path capability 不足时在启动前报错。managed networking 允许 loopback/proxy listener 客户端与服务器，限制 direct non-loopback egress/general inbound，但 allow_local_binding=false 不受支持且会配置失败。见 codex-rs/mxc-sandbox/README.md:1-27、60-96、mxc-sandbox/src/lib.rs:64-105。故本次读到的 Codex 主路径不是“AppContainer 必定被启用”；旧/其他 AppContainer ACL 行为不能由名字推断并未作为回退路径证实。

Codex 下的 child agent 并非只继承父 profile 文件配置：prepare_agent_spawn_config 先由当前 TurnContext 重建 approval policy、cwd、permission profile snapshot，再把 role config 覆盖后的运行期 policy 重新套回 child，避免 role 覆写扩大；V1/V2 spawn 后将 prepared config 交给 AgentControl。见 core/src/agent/child_config.rs:52-100、132-164、175-201、core/src/tools/handlers/multi_agents/spawn.rs:98-139。源码有 spawn role 后重新加回运行时 sandbox 的行为测试，但本报告未执行它们。

Codex Windows restricted-token 命令的取消由 JobObject 结束整组；若 Job 终止失败再尝试直接终止根进程，见 windows-sandbox-rs/src/unified_exec/backends/legacy.rs:215-238、453-487。Unix PTY child 建立独立 process group，cancel/kill 向 group 发信号并同时尝试 child killer，见 utils/pty/src/pty.rs:73-105、211-216、296-302。它说明 sandbox process 的范围也被用作取消范围；仍属于宿主进程管理，不是 workspace 或 git branch 的属性。

上述 command OS sandbox 不等同于 Pi 主进程的环境隔离。本轮追踪了文件/网络权限向 command request 传递，但没有完整核对所有 Codex provider/executor 的环境过滤策略；MXC 源码明确 child 环境由 shared process path 传递，见 mxc-sandbox/README.md:42-46。不要仅从 filesystem/network sandbox 名称推出密钥环境变量已被剥离。

## 交叉比较与待确认项

| 层 | 实际拦截点 | 不自动提供 |
|---|---|---|
| Pi/permission-system tool_call | Pi AgentSession hook 在工具执行前 allow/ask/block | OS process token、kernel file/network enforcement；任意 extension 自身行为 |
| 当前 workspace 文件 guard | Node 文件工具逐次 authorize；子 session tool allowlist 与 event guard | workspace 之外的内核拒绝；host bash 的路径约束；恶意并发本地进程防护 |
| Git worktree | 子 agent 的 repo checkout/cwd/branch | 文件/网络/进程 capability 降权或同机用户隔离 |
| DSH sandbox mode + local runner | 消费相同 mode 的 Bash/Pwsh runner 对 write effects 的本地平台 enforcement；DSH fs provider fence API writes/edits | 一般读限制、网络限制；部分 Windows ABI/硬链接对象边界 |
| Codex PermissionProfile + sandbox backend | unified_exec child process 的 OS 文件/网络机制；backend-dependent | Pi 文本工具/extensions 的普遍隔离、所有 application services/远端工具的宿主级限制 |
| 当前 Podman sandbox | 隔离的容器进程网络/root/mount/capabilities 与受控导出 | 主机 kernel / Podman engine 信任；容器 image 内预烘焙秘密；与容器不相干的 Pi parent process |

本轮源码已确认，但尚未做真实平台动态实验的项目：Windows AppContainer/MXC/PSEC 的系统版本差异、NTFS hardlink/junction 与工具时序 race、Podman Desktop/Windows machine 与不同 OCI runtime 的实现差异、bwrap/Landlock 在具体宿主内核的功能探测值、Seatbelt 主机 profile 的真实系统拒绝结果、Codex 当前 desktop/remote executor 的封闭实现，以及仓库外 extensions/MCP/ACP/自定义 runner 是否旁路本地 provider。上游 repo 的测试源码存在不等同于本轮运行验证；没有将它们标成动态证明。
