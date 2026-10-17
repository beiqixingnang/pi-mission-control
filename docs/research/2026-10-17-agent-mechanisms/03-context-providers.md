# 上下文、压缩与 provider 协议机制

固定源码快照静态审计：Pi 1.3.0 与仓库内 compaction-model 扩展、DeepSeek Harness (DSH) 的 session projection 与 compaction-basic、Codex Responses 压缩及 billion-context 0.1.197 请求代理/外部区间摘要。本文只说明源码路径和观察边界；未调用实际模型、未进行协议实验，也不提出重构方案。

## 固定快照与可比范围

| 项目 | 本次固定版本 / revision | 审计落点 |
|---|---|---|
| Pi runtime | vendor/pi-1.3.0，coding-agent package 1.3.0 | session projection、compaction、extension runner、pi-ai provider implementations |
| compaction-model | 仓库本地扩展源码，无独立发布包版本 | extensions/compaction-model/index.ts |
| Codex | source snapshot commit e16b631d08cdf82773831f9bbfb793da687d5299；Cargo workspace manifest version 0.0.0 | .reference/sources/codex/codex-rs/core/src/compact*.rs |
| DeepSeek Harness | source snapshot commit 1517a4dbca0a2789ff1d41ba439600f8547d23fa；root package 0.0.3；dsh-compaction-basic、dsh-llm-pi-ai、dsh-llm-deepseek 各 0.2.1-alpha.5 | .reference/sources/deepseek-harness/packages/... |
| billion-context | source commit 269accde8bcdf994a0dcf7fdda58494736074b20；发布包 0.1.197 | .reference/sources/plugins/billion-context 与 .reference/published/billion-context-0.1.197/package |
| pi-web-access | source commit b3f676d8448ede197d8cd22589beeb9e44f1cf44；发布包 0.41.0 | source 与 .reference/published/pi-web-access-0.41.0/package |
| pi-web-search | source commit 6b69f3fbd562840308025a2e4bcb749ecaede768；发布包 1.7.0 | source 与 .reference/published/pi-web-search-1.7.0/package |
| pi-mcp-adapter | source commit efe943e637e503e10af382d0ace1aec834989c69；发布包 5.3.1 | source 与 .reference/published/pi-mcp-adapter-5.3.1/package |

除明确标为published package/README/CONFIGURATION的内容外，行为判断来自表中固定Git HEAD；manifest版本相同或相邻并不证明该source commit与npm tarball逐字等价。本文未做npm包全量反编译/差分验证；published目录引用的文档结论仅对应所引用文件。

## 机制对照

| 机制 | 摘要输入实际形状 | 摘要模型如何选 | 失败时 | 后续主模型请求 |
|---|---|---|---|---|
| Pi 1.3 默认 compaction | 所选历史先转成普通对话文本，再包进一个 user prompt；默认摘要请求不回放原会话 system prompt/tool schema | 当前活动 model | retry wrapper仅重试符合retry policy的瞬时失败；error、length截断、工具调用令压缩失败 | 成功时以firstKeptEntryId为边界，用summary与保留尾部重建session projection |
| Pi compaction-model扩展 | 仅序列化选中/已投影历史区间，作为单个user message送摘要模型；不是history/tool replay | PI_COMPACTION_SUMMARY_MODEL > compaction-summary.json.model > 扩展内空默认（Pi default） | 无模型、空文本、捕获异常返回undefined，core接管Pi默认摘要器 | 成功时扩展返回compaction result；它不建立通用chat provider路由 |
| DSH compaction-basic | 摘要请求前缀 = surface head system + 选中range投影消息 + 最新request header的tool schemas + 新压缩指令 | 显式summarizationProvider/Model > 最新已路由header > AgentOptions route | 默认不换模型；失败fail-closed。自动路径warning后继续未压缩请求；已提交剪枝可独立成立 | 成功checkpoint替换所选surface range；下次请求从替换后的projection构造 |
| Codex ordinary compact | Responses历史、prompt base instructions、compaction user prompt与执行工具附加的历史输出 | 当前compaction turn的model/provider | context overflow且history仍多于一项时删最早item重试；其他可重试错误按provider retry count/backoff。不是任选summary model | 成功后以筛选user messages、summary、initial/world context重建历史 |
| Codex remote compaction-v2 | 带注释Responses history；预处理function-call history输出；补compaction trigger；若tool不在Responses-lite history则单独发tool schemas | 当前step model；特定previous-model失败后可能换continuing/current model | stream retries至多min(provider retries,2)；须有completed且恰好一个Compaction output item | retained inputs与compact output安装回session；background candidate可能被拒，前台补请求/跳过取决于CompactionFallback |
| billion-context | 代理在请求发往主模型前折叠conversation；可选external summary只对每个选中range发送原文与有限只读reference | compress.externalSummary target chain | 每target校验timeout/响应/summary；链耗尽、配置错、取消、revision改变均不提交对应结果；批次可部分成功 | 成功apply后代理重建未来上游请求；恢复内容可能使后续payload再增长 |

这些是实现差异，不是“GPT 在 DSH 不思考”或“DeepSeek 在 Codex 工具调用失败”的根因判定。没有请求/响应协议实验。DSH provider profile、Codex Responses API和DeepSeek Messages API是不同适配面；需要最终脱敏的模型可见request/response形状才能归因。

## Pi 1.3.0：session projection与compaction

### 正常请求历史是投影，不是原始JSONL拼接

Pi从当前branch生成context。buildContextEntries只保留最新compaction summary、firstKeptEntryId之后保留的旧条目及compaction之后新条目；buildSessionProjection再应用最新context_edit：replacement为null会移除目标内容，非空replacement会替换可编辑message。见 [session-manager.ts](../../../vendor/pi-1.3.0/packages/coding-agent/src/core/session-manager.ts#L439-L572)，重点L476-L539、L543-L570。

因此prepareCompaction从buildSessionProjection(pathEntries)取上下文，而不是摘要原始文件全文。已有最新checkpoint后，准备阶段只处理checkpoint后的新压缩范围；按projected token estimate和keepRecentTokens选cut point，近期尾部原样保留；切在turn中间时再为turn prefix单独生成summary。默认reserveTokens=16,384、keepRecentTokens=20,000，见 [compaction.ts](../../../vendor/pi-1.3.0/packages/coding-agent/src/core/compaction/compaction.ts#L872-L935)与L120-L130。

自动阈值/overflow与手工压缩会发session_before_compact；扩展可取消或提供compaction；无扩展结果时core生成默认摘要。失败发session_compact_failed。见 [agent-session.ts](../../../vendor/pi-1.3.0/packages/coding-agent/src/core/agent-session.ts#L2780-L2940)与 [extensions/types.ts](../../../vendor/pi-1.3.0/packages/coding-agent/src/core/extensions/types.ts#L784-L823)。

### 默认摘要：取样、序列化、token cap、重试

generateSummaryWithUsage先convertToLlm，再serializeConversation。serializer省略thinking/reasoning；保留可见assistant text、tool-call名称与参数、user text、tool-result文本；每个tool result摘要文本最多2,000字符，超出加截断标记。这是摘要用的人类可读transcript，不是provider tool-call wire replay，也不是完整provider request。见 [utils.ts](../../../vendor/pi-1.3.0/packages/coding-agent/src/core/compaction/utils.ts#L90-L155)、[messages.ts](../../../vendor/pi-1.3.0/packages/coding-agent/src/core/messages.ts#L140-L178)。图片不会被该serializer转成可读摘要文字。

serializer文本包进conversation标签、summary instruction/custom focus与previous summary；buildSummarizationContext只创建一条user message并用Pi summarization system prompt。maxTokens=min(floor(0.8*reserveTokens), model.maxTokens)。摘要请求设置cacheRetention:none、已有sessionId沿用否则UUID；streamFn或completeSimple经retryAssistantCall。stopReason error/length会报失败；内容中若有toolCall也报错；成功返回text与usage。见 [compaction.ts](../../../vendor/pi-1.3.0/packages/coding-agent/src/core/compaction/compaction.ts#L585-L638)、L681-L765。

turn split时，history与turn prefix分别请求并合成一条checkpoint，因此一次压缩可能有两个摘要调用，见同文件L994-L1055。文件读写路径从投影消息/tool call与上一压缩details提取，作为summary附加信息。

### compaction-model扩展具体做什么

扩展监听session_before_compact/session_before_tree。context compaction只取准备好的messagesToSummarize与turnPrefixMessages，convertToLlm后由serializeConversation序列化；prompt再带previousSummary、customInstructions、读取/修改文件路径。它调用ctx.modelRegistry.complete(model,{messages:[user(prompt)]},{maxTokens,signal,cacheRetention:none,sessionId:uuidv7()})。见 [extensions/compaction-model/index.ts](../../../extensions/compaction-model/index.ts#L90-L147)、L174-L216。

模型选择顺序：PI_COMPACTION_SUMMARY_MODEL > <agentDir>/compaction-summary.json.model > 空字符串（即Pi default）。maxTokens只读文件中的正数maxTokens，否则8192；/compaction-model provider/model-id验registry后保存设置。branch summary另外prepareBranchEntries(...,16384)。见同文件L9-L79、L150-L172、L218-L265。

无模型、model未注册、无输入、空摘要或捕获请求异常会return undefined，于是Pi core默认compaction接管；静态源码只能说明路径，不代表摘要API已实测。扩展只提取非空text blocks，没有像core默认summary generator那样检查stopReason=length。若provider complete返回非空但不完整的长度截断消息，该扩展代码可能认为它是摘要；需按具体adapter实验验证。这里fallback是Pi compaction选择回退，不是通用agent request model routing。

扩展的摘要请求不走extension context hook链：它直接调用modelRegistry.complete。普通agent request的transformContext在SDK绑定到ExtensionRunner.emitContext，见 [sdk.ts](../../../vendor/pi-1.3.0/packages/coding-agent/src/core/sdk.ts#L430-L445)。runner先运行普通context handlers（只给conversation；Pi恢复prompt/tools），再运行context_with_system（全量消息，handler输出由其负责），见 [runner.ts](../../../vendor/pi-1.3.0/packages/coding-agent/src/core/extensions/runner.ts#L1300-L1366)。context_edit是session持久投影，不等同这两类请求时hook。

### Pi 1.3.0 实际启动顺序

本版本_startRun调用_prepareRun；_prepareRun先检查pre-prompt compaction，然后emitBeforeAgentStart，合并最终prompt/tool loadout，再开始agent.prompt。见 [agent-session.ts](../../../vendor/pi-1.3.0/packages/coding-agent/src/core/agent-session.ts#L1831-L1940)。不得用旧注释/旧版本parent-wake流程覆盖当前1.3.0源码。

## DSH：projection、compaction-basic与LLM adapters

### 普通agent request和工具schema

preStep先assemble system prompt/context sections，调用agent/pre-step waterfall，把当前动态runtime context投影成user message；step再次刷新context与system prompt，将首个system message与更新写进session surface。见 [agent.ts](../../../.reference/sources/deepseek-harness/packages/core/agent-loop/src/agent.ts#L267-L288)、L406-L442。

buildRequest记录route/config、adapter defaults、tool schemas至request/header，并导出session.deriveMessages()、session.toolHistory()和header.tools为冻结GenerateOptions。见 [agent.ts](../../../.reference/sources/deepseek-harness/packages/core/agent-loop/src/agent.ts#L615-L703)。正常模型返回assistant tool-call blocks后，agent执行tool-call并把结果作为surface消息带入下一步，见同文件L529-L555。工具registry只投影name/description/parameters/deferLoading；execute/output等实现字段不出现在模型schema，见 [tools/src/index.ts](../../../.reference/sources/deepseek-harness/packages/core/tools/src/index.ts#L224-L271)、L1263-L1297及 [system-prompt/src/index.ts](../../../.reference/sources/deepseek-harness/packages/core/system-prompt/src/index.ts#L625-L650)。

### compaction-basic触发、范围、摘要target与失败

默认threshold ratio 0.8、retain ratio 0.16、headroom 65,536、maxTokens默认跟随headroom、compactionRetries=1、maxOverflowRetries=1、auto=true。可按provider/model精确覆盖；summary provider与model成对配置。解析同时考虑context window、request output reservation和headroom，见 [config.ts](../../../.reference/sources/deepseek-harness/packages/compaction/compaction-basic/src/config.ts#L19-L109)、L112-L157、L303-L327。

自动pre-step依最新持久route计量；如装tool-result pruner，先做无模型剪枝再重测，然后摘要balanced oldest range并保留近期尾。特定CONTEXT_WINDOW_EXCEEDED error绕过正常threshold/retention走overflow recovery；只有surface replacement generation前进时才授权重试。摘要失败不等于drop历史：自动handler warning后继续未压缩请求；若model-free prune已先提交，该部分减量仍保留。见 [index.ts](../../../.reference/sources/deepseek-harness/packages/compaction/compaction-basic/src/index.ts#L143-L232)、L320-L345。

range必须当前surface contiguous且不会切开tool-call/result pair；自动路径检查whole surface稳定，手动路径只要求span稳定。buildSummarizationInput收集surface首节点system prompt与range derived messages，并加最后header里的tools。摘要只在framed summary route-priced tokens严格低于原range时提交checkpoint。见 [region.ts](../../../.reference/sources/deepseek-harness/packages/compaction/compaction-basic/src/region.ts#L336-L383)、L386-L455、L532-L563。

默认summarizeWithLlm target=configured pair ?? latest session request header route ?? AgentOptions route；没有provider/model时明确报错。消息为input prefix后加最终compaction instruction；options带session toolHistory、input.tools、maxTokens、sessionId、purpose=compaction与signal，通过ctx.llm.stream直接调用。见 [summarizer.ts](../../../.reference/sources/deepseek-harness/packages/compaction/compaction-basic/src/summarizer.ts#L109-L181)。它不走agent/request route waterfall。stream error/abort/max-tokens失败，image output失败；只有text blocks写入checkpoint，见同文件L196-L207与L183-L194。

region捕获摘要异常后触发compaction/summary-error waterfall；默认recover返回false即抛错。恢复listener可先持久化剪枝再请求重算；无listener时自动路径保留最新持久surface。见 [region.ts](../../../.reference/sources/deepseek-harness/packages/compaction/compaction-basic/src/region.ts#L386-L427)。

### DSH provider protocol与reasoning/tool pairing

llm-pi-ai手工route的api字段严格映射Pi-AI lazy API：openai-completions、openai-responses、anthropic-messages；没被adapter接管的api load时拒绝；已有catalog route默认沿用catalog provider自己的协议，不是任意compatible endpoint自动推断。见 [provider.ts](../../../.reference/sources/deepseek-harness/packages/llm/llm-pi-ai/src/provider.ts#L29-L51)、L162-L191。

每次请求从immutable snapshot解析provider/model并校验显式reasoningEffort；provider/model不支持时抛UNSUPPORTED_REASONING_EFFORT；图片及tool变更按对应provider capability处理。Pi-AI streaming转回Harness stream chunks，见 [adapter.ts](../../../.reference/sources/deepseek-harness/packages/llm/llm-pi-ai/src/adapter.ts#L344-L425)、L159-L214。

自有llm-deepseek adapter是另一条Anthropic Messages API路线：配置允许thinking enabled/disabled和reasoningEffort off/low/high/max；默认effort high，关闭thinking时只接受off。请求serializer将tools映射为name/description/input_schema；effort映成thinking enabled/disabled与output_config.effort。见 [config.ts](../../../.reference/sources/deepseek-harness/packages/llm/llm-deepseek/src/config.ts#L17-L55)、L90-L115、L214-L229及 [serialize.ts](../../../.reference/sources/deepseek-harness/packages/llm/llm-deepseek/src/serialize.ts#L41-L79)、L80-L168。

Messages serializer校验assistant tool_use ID唯一、每个tool_result匹配pending ID、call有紧邻结果且末尾无未决call；否则返回INVALID_REQUEST。这是“DSH Messages adapter会拒绝不配对历史”的代码证据，不证明Codex当时实际request缺了什么。Pi-AI tool-call args由JSON parse为对象再变为Harness block；stopReason toolUse映为tool-calls，context overflow统一映为CONTEXT_WINDOW_EXCEEDED，见 [llm-pi-ai/src/stream.ts](../../../.reference/sources/deepseek-harness/packages/llm/llm-pi-ai/src/stream.ts#L1-L17)、L70-L112与DeepSeek serialize.ts L131-L146。

### 子agent的schema与route

子agent composition以父上下文preset为基础，也可child preset覆盖；toolFilter在child context里调用childCtx.tools.restrict。父provider/model/显式effort/maxTokens默认继承；route切换但没指定effort时删掉父route-owned effort。见 [child-agent.ts](../../../.reference/sources/deepseek-harness/packages/subagent/subagent/src/child-agent.ts#L98-L118)、L186-L218及 [manager.ts](../../../.reference/sources/deepseek-harness/packages/subagent/subagent/src/manager.ts#L1365-L1380)。实际发给child模型的schema来自child composition完成后的registry，不应等同“parent可用的全部工具”。结构化输出工具是child-only register，可进child schema/system prompt，见 [structured.ts](../../../.reference/sources/deepseek-harness/packages/subagent/subagent/src/structured.ts#L75-L114)。

## Codex：三种compaction路径与fallback边界

### Token-budget fresh context window（无需摘要模型）

TokenBudget feature开启时，manual compact与automatic inline compact可走run_manual/inline_compact_task：运行pre/post compact hooks、start_new_context_window，不做local summarization或remote server summary。见 [tasks/compact.rs](../../../.reference/sources/codex/codex-rs/core/src/tasks/compact.rs#L48-L58)与 [compact_token_budget.rs](../../../.reference/sources/codex/codex-rs/core/src/compact_token_budget.rs#L16-L68)。

### Ordinary local Responses summary compact

run_compact_task_inner_impl clone Responses history；记录compaction prompt；按模型truncation policy投影历史和base instructions；把executed tool calls attach到compact prompt；用当前turn provider/client session调用drain_to_completed。见 [compact.rs](../../../.reference/sources/codex/codex-rs/core/src/compact.rs#L264-L338)。

context overflow且request input多于一项时从头remove_first_item并重试；只剩一项则记context full并失败。Interrupted/TurnAborted、SessionBudgetExceeded、ResponseIncomplete不尝试删历史；其余错误按当前provider stream_max_retries/backoff retry。见同文件L338-L387。成功从compaction response/history取assistant summary，只保留符合compact policy的user inputs，组装replacement history并调用replace_compacted_history，见L391-L438、L604-L639。

compact_prompt/experimental_compact_prompt_file改变summary指令但不设置另一个摘要model。配置合并在 [config/mod.rs](../../../.reference/sources/codex/codex-rs/core/src/config/mod.rs#L4112-L4218)，prompt选择在 [compact.rs](../../../.reference/sources/codex/codex-rs/core/src/compact.rs#L118-L151)。

### Responses compaction-v2 remote

attempt从Responses history读取带注释条目，先trim过大function-call outputs，再按Responses-lite能力决定tools是在history或独立schemas；append CompactionTrigger后送remote v2。见 [compact_remote_v2_attempt.rs](../../../.reference/sources/codex/codex-rs/core/src/compact_remote_v2_attempt.rs#L67-L185)、L187-L220。请求还带当前route的compaction reasoning effort、reasoning summary和service tier；stream retry受provider max与常数2双重限制，见 [compact_remote_v2.rs](../../../.reference/sources/codex/codex-rs/core/src/compact_remote_v2.rs#L286-L373)。

remote response必须收到response.completed且恰好一个ResponseItem::Compaction，否则失败。foreground incomplete响应usage先记账；成功后只把符合保留feature/rules且不超过预算的输入留下，再append compaction output。见同文件L375-L504、L529-L577。

### model fallback不是通用alternate summarizer

V2 foreground attempt失败时，previous-turn model可在特定边界用continuing/current model重试：错误不能是abort/session budget/ResponseIncomplete；route slug要不同；current provider必须OpenAI且cached auth为Codex backend或API-key auth。fallback再失败时返回第一次error。见 [compact_model_fallback.rs](../../../.reference/sources/codex/codex-rs/core/src/compact_model_fallback.rs#L9-L33)与 [compact_remote_v2_installation.rs](../../../.reference/sources/codex/codex-rs/core/src/compact_remote_v2_installation.rs#L126-L172)。源码不证明这是“默认换便宜摘要模型”、对任意第三方OpenAI-compatible provider启用，或普通tool execution失败时重路由。Background candidate若model slug/hash与当前model不一致会拒收；拒收后是否前台补求取决于CompactionFallback，见installation.rs L17-L70、L83-L90。

## billion-context 0.1.197：外部摘要、cache、恢复与上行体边界

### 请求折叠不是额外保存一份摘要

billion-context在agent与上游API间做代理，按OpenAI Chat/Responses、Anthropic、Google shape rewrite历史并注入compress/decompress/search_context/acp_status等工具与指导。context管理与压缩状态留在kernel/session layer；selected range成功折叠后才重建后续请求。protocol request projection在 [prepare-openai.ts](../../../.reference/sources/plugins/billion-context/src/server/prepare-openai.ts#L250-L335)、[prepare-responses.ts](../../../.reference/sources/plugins/billion-context/src/server/prepare-responses.ts#L326-L432)、[prepare-anthropic.ts](../../../.reference/sources/plugins/billion-context/src/server/prepare-anthropic.ts#L370-L431)。

### external-summary的实走链路和预算

applyConfiguredCompression从本request Config rail读取externalSummary；没有启用plan时，直接applyRanges处理模型给出的range summary。启用时对每range构造probe并过kernel admission/protection；收集span原文和有限reference（未覆盖的user/最近消息、其它active summaries）；组成SummaryWork，按配置target chain调用plan.summarize；检查signal与session revision；只把成功range送进applyRanges。见 [external-summary-compress.ts](../../../.reference/sources/plugins/billion-context/src/external-summary-compress.ts#L35-L110)。

runtime逐个解析resolved target credential。HTTP candidate使用独立protocol、URL、model和headers；请求只带instructions及JSON(content,reference)，不照抄入站auth/model；POST返回通过大小和非空检查，见 [external-summary-runtime.ts](../../../.reference/sources/plugins/billion-context/src/external-summary-runtime.ts#L19-L73)、[external-summary-http.ts](../../../.reference/sources/plugins/billion-context/src/external-summary-http.ts#L127-L180)。配置dialect为anthropic、openai、responses、google；budget默认total 50s、per-target 25s、maxSummaryBytes 65,536；共享executor concurrency默认4、最大32，见 [external-summary-settings.ts](../../../.reference/sources/plugins/billion-context/src/external-summary-settings.ts#L25-L65)、L250-L295与 [external-summary.ts](../../../.reference/sources/plugins/billion-context/src/external-summary.ts#L101-L153)、L156-L226。

它确实能缩短成功折叠后的未来主模型输入，但有边界：

1. externalSummary默认关；没有有效配置目标不会暗中选择另一个摘要模型。
2. client到bili的首次原始上传已经发生；主要减少bili到main upstream的rewrite后request与后续历史负担。autoFold可以在代理preflight处理增长，但须配置开启且找到可压缩范围。
3. system prompt、tool schemas、不可分call/result unit、近期/受保护内容、一个超大不可切分result仍可能主导request大小。
4. CCR lossless内容cache用短head+pointer和acp_retrieve避免之后每轮带全文；恢复时可再次增加上下文。配置默认代理模式开启，阈值约4,000 tokens、head excerpt 96 chars；不是摘要cache或context-window扩容，见 published [CONFIGURATION.md](../../../.reference/published/billion-context-0.1.197/package/CONFIGURATION.md#L238-L260)。
5. stream/chunk处理负责协议转换，不代表request不解析、完整历史不上行或cache必命中。

## 静态证据与仍待测的用户观察

| 观察 | 已确认的代码事实 | 不能仅凭源码决定 |
|---|---|---|
| DSH内选GPT“没有思考” | DSH pi-ai route支持openai-completions/responses/anthropic-messages；effort取agent config/profile/route defaults与模型能力；adapter按provider映射wire field；unsupported explicit effort报错 | 当前model/provider/profile、最终effort wire field、API/gateway是否支持或删参、response是否有可见reasoning block |
| Codex切DeepSeek“工具调用失败” | Codex实现围绕Responses item/tool schemas；DSH自有DeepSeek用Anthropic Messages body并严格配对tool_use/result | 实际client/代理/adapter、HTTP endpoint/status、request tool IDs/results、具体标准化error code；无实验不可直接归因provider协议 |
| 自动fallback“用了备用model” | Pi扩展错误/空结果回Pi core；DSH默认维持latest route；Codex只在特定V2 previous-turn -> current边界fallback；bili external summary按用户配置target chain走 | 当前真实设置/凭证、API响应和上游retry记录；本轮未读取密钥、models/settings正文，也没发request |

## 脱敏审计脚本证据边界

project_context.py docstring声明这是metadata-only Pi 1.3 projection、不是outbound request；它用SQLite offsets按LF line回读active branch，只写角色/字符数/toolCall计数、compaction/context_edit元信息，并port buildContextEntries/buildSessionProjection。脚本结果有not_provider_payload:true和limitations。见 [.reference/tools/project_context.py](../../../.reference/tools/project_context.py#L1-L5)、L15-L76。

stream_sessions.py在binary文件上逐LF行读并记录offset/size，过滤system/developer与thinking/reasoning/signature/key等字段，生成public/state derived files及tool call/result pairing计数。见 [.reference/tools/stream_sessions.py](../../../.reference/tools/stream_sessions.py#L1-L5)、L15-L19、L66-L123、L127-L180、L236-L252。

main.summary中的custom snapshot bytes约占98.2458%是durable JSONL文件大小构成，不代表model context tokens、outbound body、provider billing input或cache miss百分比。Projection不会重建：

- Pi request-time context/context_with_system hooks与queued/injected context；
- 当前provider/API-specific message normalization、tool schema/tool change encoding、image attachment serialization；
- reasoning/replay opaque metadata、request headers、实际stream/outbound body；
- 每次route/turn独立的token估算、subagent request projection。

本轮只读脱敏派生脚本及生成metadata projection范围，没有打开原始session JSONL，也没有输出system正文、thinking、signature或密钥。
