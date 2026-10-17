# 联网实现与实测记录

核对日期：2026-10-17，Asia/Shanghai。实现版本2.0.6，Windows / Node24.16.0 / Pi1.3.0。本次检查没有修改运行代码、用户配置或正在运行的真实Pi会话。

## 已确认能用的范围

默认Exa搜索和公开网页抓取均已通过真实网络验证，并经实际Pi会话工具调用链确认结果进入后续模型上下文。模型驱动器为确定性离线provider；只有搜索和抓取访问真实公网，不调用GPT/DeepSeek等付费模型。这不能代替真实模型选择工具、构造参数的兼容性验收。

| 路径 | 真实输入与结果 | 观察耗时 |
| --- | --- | --- |
| 直接调用searchWeb | 搜索Pi扩展文档，返回Pi官方来源；默认Exa、无需用户提供密钥 | 约3.1秒 |
| 直接调用fetchPage | pi.dev主页成功，得到6,811字符 | 约0.8秒 |
| Pi模型调用web_search | 查询Pi扩展文档，返回含标题/来源/摘录的24,000字符，truncated=true | 约1.1秒 |
| Pi模型调用web_fetch | 读取Pi官方扩展文档，得到22,643字符，未截断 | 约1.2秒 |
| Pi模型调用web_fetch本机地址 | 在连接前拒绝127.0.0.1，错误进入后续模型上下文 | 约14毫秒 |

直接抓取example.com另遇一次ECONNRESET；这是一次未成功的连接，未把它记为通过，也不能据此推断所有公网抓取不可用。上表是当次观察，不是延迟或可用性承诺。

本机未配置mission-control.json的搜索覆盖项，BRAVE_API_KEY未设置，因此实际检查的是默认Exa。Brave、用户自建SearXNG没有进行真实服务验收。

## Pi和插件分别负责什么

核对的Pi1.3.0内建工具集合为read/bash/powershell/edit/write/grep/find/ls；搜索不是这组内建工具的一部分。Pi提供扩展注册、工具schema、模型调用和结果回程。插件在extensions/mission-control/index.ts注册web_search与web_fetch，并委托runtime/web.ts实现网络请求。

调用链：

```text
模型看见web_search/web_fetch工具schema
    → Pi验证参数并执行扩展工具
    → runtime/web.ts向搜索服务或目标网页请求
    → 返回来源、时间、文本、截断标记
    → lead工具包装器生成toolResult
    → Pi将toolResult送入下一次模型请求
```

网络由本机Node进程执行；不要求当前模型供应商提供内置联网接口。此次实际Pi验证覆盖工具调用和结果回程，模型驱动器也确认收到完整返回文本。

## web_search：远端搜索服务

配置来自Pi agent目录的mission-control.json；runtime/types.ts默认searchProvider为exa。配置在会话启动时读取。

| provider | 请求方式 | 用户需要提供的配置 |
| --- | --- | --- |
| exa（默认） | 向https://mcp.exa.ai/mcp发送JSON-RPC tools/call，调用web_search_exa | 默认不需要密钥 |
| brave | GET Brave Search API，X-Subscription-Token认证 | searchProvider=brave，进程环境BRAVE_API_KEY |
| searxng | 对searchUrl增加q和format=json | searchProvider=searxng及明确的searchUrl |

Exa当前请求参数为query、numResults=8、type=auto；这是固定工具调用的轻量MCP适配，不是驻留的通用MCP客户端。响应支持普通JSON及MCP event-stream封装，提取result.content中的文本。Brave与SearXNG提取各自的结果数组。

查询长度1–4,000字符，请求超时25秒，响应最多1MiB，输出最多24,000字符。Exa请求最多8条结果，但总体文本仍会被截断；后部来源可能不在模型看到的窗口中。输出包含provider、query、retrievedAt、content、truncated。

发送给服务的是查询参数，没有附加完整会话、系统提示或任务数据库。默认路径没有读取EXA_API_KEY；设置该变量本身不会改变当前Exa调用方式。Brave只读取BRAVE_API_KEY。

失败会显式返回工具错误。当前没有Exa→Brave→SearXNG自动切换，也没有独立的搜索重试预算。主模型提供方的/reconnect不接管工具HTTP失败。Exa公开服务的免密钥使用不等于无限额度，仍受其可用性与限流约束。

## web_fetch：本机直接读取公开页面

fetchPage先验证HTTP(S)协议且URL不含嵌入式认证，解析DNS并拒绝私有/本机目标。通过Node http/https发请求，连接使用已经验证的地址，保留URL主机名供HTTP Host与TLS验证；每次重定向重新验证目标。

最多跟随3次重定向，每跳HTTP请求20秒，原始响应最多1MiB。DNS查询在该跳HTTP请求之前；没有浏览器导航或页面脚本执行。结果包括最终url、retrievedAt、text和truncated，文本最多32,000字符。

HTML提取会移除script/style/noscript、标签并折叠空白，只处理部分常见HTML实体。这是一种基础文本提取：导航可能留下，某些实体仍保留。它不提供登录态、JavaScript渲染、PDF解析、下载管理或浏览器操作。

## 主会话和成员权限

这两个工具当前只在lead入口注册。member.ts使用独立能力名单，没有注册web_search/web_fetch，运行Hook也阻止名单之外的工具；不是派工后所有成员自动拥有同一套联网工具。

- files成员只有受控文件工具及团队通信工具。
- sandbox命令在Podman禁网环境执行，没有自动联网能力。
- host成员拥有可信宿主命令权限，可通过命令程序联网；但仍没有这两个专用搜索/抓取工具。host模式不代表网络隔离。

因此目前的专用联网调用由主会话完成。若希望研究员/执行员也直接使用同一套搜索工具，需要另行设计显式联网授权和成员调用入口，不能把host网络能力和统一联网工具权限混为一谈。本次未悄然扩大成员权限。

## 证据与复现边界

本次在.reference/artifacts/web保留了调用记录和隔离测试会话，目录被Git忽略；未读取用户认证文件、真实会话或私有项目正文。

直接调用记录为live-default.json。实际Pi回程记录为live-pi-session.json；smoke-pi.mjs使用离线provider主动生成工具调用，检查tool_execution_end、工具错误标记及下一轮模型收到的文本，并正常发出session_shutdown关闭运行核心。测试资料保留在该忽略目录，便于后续核对。

现有默认离线套件另外覆盖查询载荷不含会话正文、Exa普通/SSE响应、私网地址拒绝、重定向重查和基础HTML提取；它们不冒充真实网络可用性。本次未修改运行代码，所以没有重复运行整套跨平台测试。

## 源码入口与服务说明

- [lead工具注册](../../../extensions/mission-control/index.ts#L892)：web_search/web_fetch的schema、调用和错误回程。
- [网络实现](../../../runtime/web.ts)：searchWeb、fetchPage、响应上限、DNS检查及固定连接。
- [配置默认值](../../../runtime/types.ts#L125)：搜索provider与可选searchUrl。
- [成员工具入口](../../../extensions/mission-control/member.ts)：独立工具名单和执行门禁。
- [Exa官方MCP说明](https://exa.ai/docs/reference/exa-mcp)：公开HTTP端点、免密钥入口、web_search_exa及可选付费密钥配置。当前插件只实现表中固定调用方式，并未实现官方服务的全部工具。
