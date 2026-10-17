# Pi 联网搜索与 MCP 工具暴露路径

固定快照：pi-web-access 0.41.0、pi-web-search 1.7.0、pi-mcp-adapter 5.3.1。本文追踪实际注册、provider选择器、请求函数、鉴权来源及结果返回点。只读固定源码与发布包，未发送真实联网搜索/模型/MCP请求；未逐一验证每一家第三方provider。

行为分析来自固定source Git HEAD：pi-web-access b3f676d8448ede197d8cd22589beeb9e44f1cf44、pi-web-search 6b69f3fbd562840308025a2e4bcb749ecaede768、pi-mcp-adapter efe943e637e503e10af382d0ace1aec834989c69。0.41.0/1.7.0/5.3.1是相应published README/配置参考，不表示source HEAD的全部行为已与npm tarball逐行比对。

## 先分清三种工具

| 扩展 | 模型看到的入口 | 本地执行后的主要网络目标 | 是否调用另一个模型 |
|---|---|---|---|
| pi-web-access | web_search、source_check、fetch_content及结果检索工具；可eager或dynamic启用 | 默认auto在多家搜索provider间选择；fetch_content可能直取网页、走extract provider或按fetch mode解析 | 一般web_search直接调搜索API/MCP；workflow开启时另有summary model |
| pi-web-search | web_search和url_context | 当前Pi model或web-search.json内指定model决定provider wire protocol；部分provider有原生search tool，Ollama用独立REST | web_search内部另做provider API search请求，provider模型执行native search |
| pi-mcp-adapter | 默认只见一个mcp代理schema；配置directTools/search才让具体MCP schema成为普通Pi tool | 用户配置的MCP server；transport/runtime管理连接 | adapter不替用户选搜索provider，执行用户选择的MCP工具并回传MCP ToolResult |

## pi-web-access 0.41.0：实际执行路径

### 注册、激活和tool result

插件按web-search.json配置注册Pi tools。web_search schema包含query或queries、结果数量、recency/domain filters、provider、workflow、proxy；执行器先以runWithProxy建立当前call网络route，再调用web-tool-core.webSearch。见 [index.ts](../../../.reference/sources/plugins/pi-web-access/index.ts#L1405-L1435)、L1475-L1519、L1678-L1693；核心函数在 [web-tool-core.ts](../../../.reference/sources/plugins/pi-web-access/web-tool-core.ts#L752-L849)。

toolActivation=eager时工具立即是active tools；auto/dynamic时只注册web_enable，它通过Pi setActiveTools启用已配置工具，更新对后续model request生效。宿主不支持相应Pi动态工具API则降级为eager。见 [tool-activation.ts](../../../.reference/sources/plugins/pi-web-access/tool-activation.ts#L19-L48)、L63-L95与 [index.ts](../../../.reference/sources/plugins/pi-web-access/index.ts#L2262-L2267)。这是schema exposure/activation控制，不是联网授权本身。

web-tool-core将queries逐一交给gemini-search.ts的search函数，传入provider、ExtensionContext、filters、signal；结果保留provider/answer/URLs与errors，写入本地结果store并产生responseId。可选网页内容通常由fetch_content/get_search_content另取或另行后台fetch，避免无限扩展search结果消息。见 [web-tool-core.ts](../../../.reference/sources/plugins/pi-web-access/web-tool-core.ts#L616-L715)、L752-L849。Pi之后把该搜索工具结果作为正常toolResult送回模型；这是调用结果证据，不证明provider一定有结果或信息正确。

### provider precedence与auto fallback确实是什么

本次tool参数provider（若不是auto）优先于配置里的searchProvider/provider，否则缺省auto。search()把明确单provider直接dispatch；provider数组/all走指定并行集合；只有auto才走configured searchRouting或代码内的fallback chain。见 [web-tool-core.ts](../../../.reference/sources/plugins/pi-web-access/web-tool-core.ts#L179-L199)与 [gemini-search.ts](../../../.reference/sources/plugins/pi-web-access/gemini-search.ts#L648-L683)。

固定版本默认auto链（未配置searchRouting）顺序为：searxng；若环境/session适合则先OpenAI/Codex subscription search；Exa；OpenAI search；Brave、Parallel、TinyFish、Search1API、Searchinfinity、Querit、Tavily、Firecrawl、Jina、SERPdive、Kagi、Bocha、Ollama、Perplexity；最后Gemini。只有命中结果或answer的响应才立即结束；empty response临时保存，待链耗尽再返回。大多数provider异常会记入fallbackErrors然后继续，abort会传播。见 [gemini-search.ts](../../../.reference/sources/plugins/pi-web-access/gemini-search.ts#L648-L736)。

代码明确把Parallel MCP、degoog、DuckDuckGo、Kimi、AnySearch、XCrawl、xAI、Mistral、Bright Data、SerpBase、SerpAPI、Serper、Serply、You、Valyu、Baizhi、Z.ai、Keenable、Ceramic列为explicit-only：设置key不会使它们进入auto/all；需明确provider、array或configured routing。all也只是ALL_SEARCH_PROVIDERS名单，不等于所有已接入provider。见 [gemini-search.ts](../../../.reference/sources/plugins/pi-web-access/gemini-search.ts#L53-L77)、L116-L121、L673-L736。显式provider失败不会悄悄走auto fallback；这是用户要求的选择。

### no-key route、Pi auth和credential sources

- **Exa**是确切的zero-key网络route。auto认为Exa总可用；无exaApiKey时searchWithExa转到https://mcp.exa.ai/mcp，以MCP JSON-RPC tools/call调用Exa搜索工具；有key则POST Exa Search REST。MCP 429报rate-limit并建议配置key。见 [gemini-search.ts](../../../.reference/sources/plugins/pi-web-access/gemini-search.ts#L695-L703)、[exa.ts](../../../.reference/sources/plugins/pi-web-access/exa.ts#L206-L238)、L440-L465。zero-config不是本地/offline搜索。
- **OpenAI/Codex**可通过model registry读取Pi当前provider auth；代码为特定官方OpenAI/Codex endpoint解析Responses URL，不会默认把Pi凭证发送到任意自定义baseURL。无可用Pi auth时才查插件配置credential或OPENAI_API_KEY；useProviderBaseUrl需要所选provider auth和baseURL显式匹配。见 [openai-search.ts](../../../.reference/sources/plugins/pi-web-access/openai-search.ts#L281-L328)、L333-L380。源README称Pi Codex login能作为无单独key的search credentials，与这个auth route一致。
- **其它搜索API**多数由web-search.json的provider key/baseUrl或各自环境变量供auth。credential-source支持config value、显式env reference、trusted command credential source；env reference缺值报错，不是隐式匿名登录。见 [credential-source.ts](../../../.reference/sources/plugins/pi-web-access/credential-source.ts#L121-L137)、L230-L242。未逐家审计所有provider字段名或payload。
- per-call/global proxy经runWithProxy传给请求层；源码提示Node fetch不会自行route HTTP(S)_PROXY，需provider call的proxy配置。fetch redirects、SSRf/private host拒绝另有policy，不能由provider available推断最终网络可达。

### search output的证明边界

Pi tool schema允许返回responseId、query/provider/answer/results及fetchId；它会保留provider来源，full page可之后分页/检索，而不是每次都不受限内联。核心store/format逻辑见 [web-tool-core.ts](../../../.reference/sources/plugins/pi-web-access/web-tool-core.ts#L616-L715)、L658-L714。结果toolResult会进入正常模型turn；只凭session摘要/工具名字无法还原请求究竟用了哪家provider，需result的provider字段、工具details或脱敏出站记录。

## pi-web-search 1.7.0：由当前model/API选择native provider route

### 选model和注册的tools

扩展注册web_search与url_context两项Pi工具。无独立配置时用当前model；若PI_WEB_SEARCH_CONFIG或Pi agent目录下web-search.json配置provider/model，registry取对应model。配置无效/模型缺失/协议不支持会给明确tool error；不自动切换到另一个摘要模型以避免意外花费。见 [utils.ts](../../../.reference/sources/plugins/pi-web-search/src/utils.ts#L8-L19)、L26-L79、L89-L107与 [index.ts](../../../.reference/sources/plugins/pi-web-search/src/index.ts#L66-L107)。

web_search执行resolveWebSearchModel -> getConfig(model) -> callApiStream。callApiStream再按model provider-kind dispatch Google、Ollama、OpenAI/xAI、Anthropic/DeepSeek；未知kind报Unsupported provider。见 [web_search.ts](../../../.reference/sources/plugins/pi-web-search/src/web_search.ts#L17-L67)、[api.ts](../../../.reference/sources/plugins/pi-web-search/src/api.ts#L14-L46)。

### 实际provider请求及response/tool result

- **Google/Gemini**：请求中设置google_search；附URL可加url_context。response groundingMetadata内的webSearchQueries、groundingChunks、groundingSupports映成sources/citations。见 [web_search.ts](../../../.reference/sources/plugins/pi-web-search/src/web_search.ts#L45-L65)、[providers/google.ts](../../../.reference/sources/plugins/pi-web-search/src/providers/google.ts#L53-L87)、L89-L125。
- **OpenAI/Azure/Codex Responses或xAI**：独立Responses POST带tools:[{type:web_search}]与stream=true；按provider dialect请求sources/citations；解析SSE的web_search_call状态/queries/results与url citations。Codex route特定地加tool_choice=required、parallel_tool_calls、low verbosity。见 [providers/openai.ts](../../../.reference/sources/plugins/pi-web-search/src/providers/openai.ts#L140-L183)、L189-L215、L260-L305。
- **Anthropic/DeepSeek**：独立Messages POST带web_search_20260209 server tool，流中server_tool_use.id与web_search_tool_result.tool_use_id相关联；DeepSeek类型的web search error会fail当前web_search tool result。见 [providers/anthropic.ts](../../../.reference/sources/plugins/pi-web-search/src/providers/anthropic.ts#L33-L105)、L126-L175。
- **Ollama Cloud**：不是模型调用tool，而是独立POST /api/web_search与/api/web_fetch，需要Ollama API key；本地Ollama服务不等同云端路由。见 [providers/ollama.ts](../../../.reference/sources/plugins/pi-web-search/src/providers/ollama.ts#L7-L15)、L113-L163。

url_context单独注册；源码把它限制在Gemini URL Context或Ollama fetch实现。其它provider得到unsupported_provider结果，不会自动代理到跨provider网页搜索，见 [url_context.ts](../../../.reference/sources/plugins/pi-web-search/src/url_context.ts#L25-L48)。

### 认证、reasoning与失败

插件用直接fetch，不走Pi的普通LLM stream pipeline。因此providers/auth.ts先调用modelRegistry.getApiKeyAndHeaders，再补Pi-AI只在streamSimple内会执行的provider env key fallback；OpenCode Zen/Go还需传其会话ID headers。见 [providers/auth.ts](../../../.reference/sources/plugins/pi-web-search/src/providers/auth.ts#L14-L37)、L39-L61。DeepSeek无key会报/login或DEEPSEEK_API_KEY指引；Codex API还需Codex credential/account id，见 [providers/anthropic.ts](../../../.reference/sources/plugins/pi-web-search/src/providers/anthropic.ts#L43-L75)、[providers/openai.ts](../../../.reference/sources/plugins/pi-web-search/src/providers/openai.ts#L125-L138)。

OpenAI/xAI实现仅在model支持reasoning且当前thinkingLevel不是off时传reasoning effort；xAI复用Responses transport，但不沿用OpenAI effort语义。见 [providers/openai.ts](../../../.reference/sources/plugins/pi-web-search/src/providers/openai.ts#L160-L175)。route/auth/API failure变成web_search结果文本和details.error，不在该函数里自动替换provider；model选择错误和诊断见 [utils.ts](../../../.reference/sources/plugins/pi-web-search/src/utils.ts#L81-L107)、L112-L165、L197-L199。

## pi-mcp-adapter 5.3.1：proxy schema、direct schemas和server call

### 默认proxy不是所有MCP schemas

默认注册一个mcp gateway schema，其中参数包含tool/args、connect/search/describe、server/auth/install等操作；具体server tools不全部塞进首个prompt，因此避免大量闲置工具定义。见 [index.ts](../../../.reference/sources/plugins/pi-mcp-adapter/index.ts#L2091-L2121)、L2123-L2303与 [direct-tool-surface.ts](../../../.reference/sources/plugins/pi-mcp-adapter/direct-tool-surface.ts#L203-L230)。

配置directTools后，adapter从validated metadata cache选中MCP definitions，把inputSchema转为Pi parameters再registerTool；directTools:"search"会创建真实schema-backed但默认inactive的direct tools，成功mcp({search})匹配或成功mcp({tool})可激活命中项，下一次model request才看到对应schema。includeTools/excludeTools、prefix、server disabled与name collision会筛选schema。见 [direct-tool-surface.ts](../../../.reference/sources/plugins/pi-mcp-adapter/direct-tool-surface.ts#L72-L125)、L182-L193与 [index.ts](../../../.reference/sources/plugins/pi-mcp-adapter/index.ts#L439-L519)、L524-L667、L2252-L2296。

所以模型端存在两个请求路径：未promote时发一条Pi tool_call给mcp代理，由代理按名字调用上游MCP tool；direct tool已active后，模型直接调用Pi注册的对应tool schema。两种路径最后都返回Pi工具结果，但上游MCP tool本身不是OpenAI Responses web_search_call或Anthropic server search。

### executeCall鉴权/审批/结果链

proxyModes.executeCall解析tool/server，lazy connect或对needs-auth session恢复，之后在实际MCP call前执行approveTools策略。批准后通过MCP client callTool或task session呼叫工具；返回content过output guard，再由proxy/direct tool包装成Pi AgentToolResult。审批拒绝或headless时approval-required会变成带error details的失败结果。见 [proxy-modes.ts](../../../.reference/sources/plugins/pi-mcp-adapter/proxy-modes.ts#L1588-L1644)、L1646-L1717。

server OAuth secrets默认存OS credential store；显式encrypted-file模式需用户另配key。没有通用MCP联网免认证方式：连接endpoint、认证provider与server权限由该server配置决定。adapter的autoAuth最多按配置做OAuth尝试/重连，不会创造endpoint permission。配置模型可看fixed release [README.md](../../../.reference/published/pi-mcp-adapter-5.3.1/package/README.md#L20-L46)、L102-L131；实际dispatch以source为准。

## 联网覆盖范围与不能推出的结论

| 子系统 | 本轮已由代码确认 | 本轮未逐一确认 |
|---|---|---|
| pi-web-access | tool registration、dynamic activation、provider precedence/auto chain、Exa no-key MCP与REST切换、OpenAI Pi auth/API-key选择、查询dispatch与responseId结果归档 | 每一provider完整request JSON/密钥优先级、所有fetch mode和每种HTTP error、真实网络可达性 |
| pi-web-search | 当前或独立model选择；Google、OpenAI Responses、Anthropic/DeepSeek、Ollama四类真实dispatch；credential fallback；citation/tool result归一化 | 每一API variant及provider实时兼容性、摘要质量、真实key有效性 |
| pi-mcp-adapter | proxy/direct tool schema exposure、direct search activation、executeCall、approval/auth recovery和MCP result回程 | 每个MCP server的扩展协议与工具自身权限含义、上游服务实际可用性 |

上述未覆盖项没有写成已验证支持。本轮只读source/published artifacts，没有读取用户auth/models/settings文件，也没有进行真实网络调用。
