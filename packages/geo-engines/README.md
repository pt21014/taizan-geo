# @taizan/geo-engines

GEO（生成式引擎优化）引擎适配器：统一的 `EngineAdapter` 契约 + `EngineRegistry`
+ 错误分类 + 引用 URL 归一化；通义 / 文心 / 混元 / 智谱 / 秘塔 / 豆包 /
OpenAI 七家 + mock（其中 `openai` 这一 code 有两个实现：chat/completions 与
Responses API，装配层二选一注册）。每家的**请求构造与响应解析都是纯函数**，
对着官方文档样例响应写 spec——字段逐条核对的结论见下面《文档核对结论》。
零框架依赖，不 import 任何 `@nestjs/*` 或 `@prisma/client`，HTTP 走调用方注入的
`HttpClient` 接口，不 import axios、不用全局 `fetch`。

## 接口

```ts
interface EngineAskInput {
  prompt: string
  locale?: string
  systemPrompt?: string
  timeoutMs?: number
}

interface EngineCitation {
  url: string // 已过 normalizeUrl
  title?: string
  siteName?: string
  index?: number // 去重后重排为 1..n
  snippet?: string
}

interface EngineAskOutput {
  text: string // 空回答是空串，不是 undefined
  citations: EngineCitation[] // 没有引用是空数组，不是 undefined
  usage: { inputTokens: number; outputTokens: number; searchCalls: number }
  model: string
  latencyMs: number
  raw: unknown // 引擎原始响应，排障用
  finishReason?: string
}

interface EngineAskContext {
  credentials: Record<string, string> // 解密后的整包凭据
  http: HttpClient
  signal?: AbortSignal
  timeoutMs?: number
  model?: string // 模型名 / 火山方舟的 endpoint id
  baseUrl?: string // 自定义网关
}

interface EngineAdapter {
  readonly code: EngineCode // 'qwen'|'ernie'|'hunyuan'|'zhipu'|'metaso'|'doubao'|'openai'|'mock'
  ask(input: EngineAskInput, ctx: EngineAskContext): Promise<EngineAskOutput>
}
```

用法：

```ts
import { EngineRegistry, QwenEngineAdapter, ZhipuEngineAdapter } from '@taizan/geo-engines'

const registry = new EngineRegistry()
  .register(new QwenEngineAdapter())
  .register(new ZhipuEngineAdapter())

const out = await registry.get('qwen').ask(
  { prompt: '国内做 GEO 监测的工具有哪些？' },
  { credentials: { apiKey: 'sk-xxx' }, http: httpClient, timeoutMs: 30_000 },
)
```

## 每个引擎的凭据键名与文档

凭据是 `GeoEngine.credentialEnc` 解密后 `JSON.parse` 出来的那个对象，键名如下
（每个适配器文件顶部也有同一份说明）：

| code | 凭据键 | 默认 baseUrl | 默认 model | 联网/引用开关 | 文档 |
|---|---|---|---|---|---|
| `qwen` | `apiKey`、`searchStrategy`(可选) | `https://dashscope.aliyuncs.com` | `qwen-plus` | `parameters.enable_search` + `parameters.search_options.{enable_source,enable_citation,citation_format,forced_search}` → `output.search_info.search_results[]` | https://help.aliyun.com/zh/model-studio/web-search |
| `ernie` | `apiKey`（千帆 v2 Bearer） | `https://qianfan.baidubce.com` | `ernie-4.5-turbo-128k` | `web_search.{enable,enable_citation,enable_trace}` → `search_results[]` | https://cloud.baidu.com/doc/qianfan-docs/s/Wm8r4sw29 |
| `hunyuan` | `apiKey` | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-turbos-latest` | `enable_enhancement` + `citation` + `search_info` → `search_info.search_results[]`，**无引用时从正文兜底** | https://cloud.tencent.com/document/product/1729/111007 |
| `zhipu` | `apiKey`、`searchEngine`(可选) | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` | `tools: [{ type: 'web_search', web_search: { search_result: true } }]` → `web_search[]`（url 在 `link`） | https://docs.bigmodel.cn/cn/guide/tools/web-search |
| `metaso` | `apiKey` | `https://metaso.cn/api/v1` | scope，默认 `webpage`（六选一） | Search API 本身就是联网的 → `webpages[]`（url 在 `link`） | https://metaso.cn/search-api/playground |
| `doubao` | `apiKey`、`sources`(可选)、`useBots`(可选) | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6`（`ctx.model` 可填模型名/接入点 ID） | **Responses API** `/responses` + `tools:[{type:'web_search'}]` → `output[].content[].annotations[]` | https://www.volcengine.com/docs/82379/1756990 |
| `openai`（chat） | `apiKey`、`baseUrl`、`model` | 无默认（必填） | 无默认（必填） | `/chat/completions`；`annotations[].url_citation` / 顶层 `citations` / `search_results[]`，都没有时正文兜底 | 各家网关自定义 |
| `openai`（responses） | `apiKey`、`baseUrl`、`model`、`searchContextSize`(可选)、`userCountry`(可选) | 无默认（必填） | 无默认（必填） | `/responses` + `tools:[{type:'web_search'}]` → `output[].content[].annotations[]` | https://developers.openai.com/api/docs/guides/tools-web-search |
| `mock` | `scenario`、`brandName`、`brandDomain`、`competitorNames` | — | — | 见下 | — |

`mock` 的 8 个 scenario（《GEO-P0技术设计.md》§2.1）：`mention`（默认）/
`no-mention` / `competitor` / `cited` / `negative` / `timeout` / `rate-limit` /
`auth-fail`。输出**确定性**（`latencyMs` 固定 12、`usage` 固定），因为
`analysis` 的单测与 e2e 都拿它当输入——回答只要有一点随机，e2e 就会偶发红。
装配时务必调 `assertMockNotInProd(env, enabledEngineCodes)`：mock 在生产跑起来
会往 `GeoVisibilityDaily` 灌一整套编好的"提及率 100%"，而且不报错。

## 怎么加一个引擎

1. 在 `src/types.ts` 的 `EngineCode` 里加上新 code。
2. 在 `src/adapters/` 下新建 `<code>.ts`，**文件顶部用注释写清凭据键名与文档
   链接**，然后导出三样东西：

   ```ts
   export function buildXxxRequest(input: EngineAskInput, ctx: EngineAskContext): HttpRequest
   export function parseXxxResponse(body: unknown, meta: EngineParseMeta): EngineAskOutput
   export class XxxEngineAdapter implements EngineAdapter {
     readonly code = 'xxx' as const
     ask(input, ctx) {
       return runAdapter(input, ctx, buildXxxRequest, parseXxxResponse, DEFAULT_MODEL)
     }
   }
   ```

   `build` 与 `parse` 必须是纯函数——不发请求、不看时钟、不读环境变量。耗时与
   兜底模型名从 `meta` 进来，就是为了让 `parse` 保持纯。
   `parse` 一律用 `shared.ts` 里的 `asRecord/asArray/asString/asNumber/pick` 取值：
   引擎的响应不是我们的契约，少一个 `usage` 字段不该让整次查询失败。
3. 放一份官方文档样例形状的 fixture 到 `src/adapters/__fixtures__/<code>.json`，
   写同名 `<code>.spec.ts`：`build` 断言 URL / headers / body 关键字段，`parse`
   断言正文、引用、usage，并且**必须有"缺字段 / 空回答 / 引用为空"三条用例**。
4. 在 `src/index.ts` 里导出这三样，装配处 `registry.register(new XxxEngineAdapter())`。

## 关键约定

- **HTTP 客户端由调用方注入**：`ctx.http`。本包不 import axios、不用全局 `fetch`，
  这样纯函数能在裸 node 环境跑单测，不必真的花钱发一次引擎请求。
- **错误一律归一成 `EngineError`**，`kind` 六选一、`retryable` 决定队列要不要退避。
  `classifyHttpError(status, body)` 的判定顺序是"先看 body 特征串、再看状态码"：
  内容审核被拒在千帆是 HTTP 200 + 业务错误码、在别家是 400，只看状态码会把
  不可重试的错误当成可重试的白烧 6 次。网络层失败传 `status = 0`。
- **引用 URL 一律过 `normalizeUrl`**：去 `utm_*` 等跟踪参数、去 fragment、去末尾
  斜杠、host 转小写；**协议不动**（`http` 不升级成 `https`）。`domainOf` 去
  `www.` 与端口，中文域名保留原字面不转 punycode。
- **`parse` 对缺字段健壮**：引擎改字段名、返回空回答、不给引用，都只应该让这一条
  结果变"没有引用"，不该让整个批量任务炸掉。
- **mock 生产环境启用直接拒启**。

## 文档核对结论（核对日期 2026-09-13）

对着各厂商**官方文档页**逐字核对了请求字段、响应字段与引用字段。结论如下；
每个适配器的文件头有同一份说明的详细版（含逐条字段清单）。

| 引擎 | 核对的文档 URL | 结论 |
|---|---|---|
| `qwen` | https://help.aliyun.com/zh/model-studio/web-search ＋ https://www.alibabacloud.com/help/zh/model-studio/web-search | **改了一处**。`enable_search` / `search_options` 在 `parameters` 下、`result_format:'message'` 正文在 `output.choices[0].message.content`、`search_results[]` 单条是 `site_name`/`icon`/`index`/`title`/`url`、`usage` 是 `input_tokens`/`output_tokens`——**原实现全对**。但原来发的 `search_strategy: 'standard'` 是**非法值**：中文站列的合法值是 `turbo`(默认)/`max`/`agent`/`agent_max`，国际站说"目前仅支持 agent"。两份文档打架，改成**默认不发这个字段**，需要时由 `credentials.searchStrategy` 指定。`citation_format:'[ref_<number>]'` 与 `forced_search` 是文档里的合法字段，保留 |
| `ernie` | https://cloud.baidu.com/doc/qianfan-docs/s/Wm8r4sw29 | **原实现正确**，只改了注释与 fixture。文档确认 `web_search.{enable,enable_citation,enable_trace,enable_status}` 在**请求体顶层**（另有 `search_mode`/`search_number`/`reference_number` 未用），响应 `search_results[]` 在**顶层**、单条只有 `index`/`url`/`title`。fixture 里编的 `web_anchor` 字段文档里没有，已从 fixture 移掉、降级为 parse 的兜底并单独写了用例 |
| `hunyuan` | https://cloud.tencent.com/document/product/1729/111007 ＋ https://cloud.tencent.com/document/product/1729/105701 | **原实现正确**，只改了注释。兼容端点**明确支持**混元自定义参数 `enable_enhancement`(默认 false)、`citation`(默认 false)、`search_info`(默认 false，"值为 true 且命中搜索时，接口会返回 search_info")，另有 `force_search_enhancement` / `enable_multimedia` / `enable_recommended_questions` / `enable_speed_search` 未用。所以"兼容端点拿不到引用"的担心可以排除。**但 `search_info` 的内部形状两份文档都没列**，`search_info.search_results[].{index,title,url}` 仍是推断——正文兜底路径保留 |
| `zhipu` | https://docs.bigmodel.cn/cn/guide/tools/web-search ＋ https://docs.bigmodel.cn/api-reference/模型-api/对话补全 | **原实现正确**，只改了注释与 fixture。`tools:[{type:'web_search',web_search:{enable,search_engine,search_result,...}}]` 与 `search_engine` 的四个合法值都对；接口参考确认检索结果在**顶层 `web_search[]`**，单条是 `icon`/`title`/`link`/`media`/`publish_date`/`content`/`refer`（url 在 `link`）。fixture 补上了 `publish_date` |
| `metaso` | https://metaso.cn/search-api/playground（`/search-api/docs` **是 404**，秘塔没有对外静态文档） | **请求侧核对上了，响应侧没有一手文档**。从官方调试台生成请求代码的前端 chunk 里读到：端点 `POST /api/v1/search`、字段 `q`/`scope`/`size`(或 `page`)/`includeSummary`/`includeRawContent`(仅 webpage)/`conciseSnippet`、`scope` 六选一（`webpage`/`document`/`scholar`/`image`/`video`/`podcast`）。据此给 build 加了 scope 白名单（非法值退回 `webpage`）与 `conciseSnippet`。响应形状按第三方集成一致描述的顶层 `{credits,total,webpages:[{title,link,snippet,score,date}]}` 重写了 fixture，**未实测**，多路兜底全部保留 |
| `doubao` | https://www.volcengine.com/docs/82379/1756990 ＋ /1526787 ＋ /1285209 | **改了实现**。文档原文「联网内容插件仅支持 Responses API」——联网搜索要打 **`POST /api/v3/responses`** 配 `tools:[{type:'web_search'}]`，引用在 `output[]→message→content[]→annotations[]`，单条 `{type:'url_citation',title,url,site_name,publish_time,summary}`，usage 是 `input_tokens`/`output_tokens` + `tool_usage.web_search`。原实现默认打的 `/bots/chat/completions` 是**旧的应用(bot)通道**（要先在控制台建应用挂插件、`model` 得填 bot ID），已改为默认 Responses、`credentials.useBots='true'` 才走旧通道。旧通道的 `references[]` 也核对了：是 `SearchDocument`，字段 `site_name`/`summary`/`publish_time`/`title`/`url`/`logo_url`/`mobile_url`/`cover_image`/`extra`（不是原来猜的 `link`/`source_name`/`content`），token 账在 `bot_usage.model_usage[]` |
| `openai` | https://developers.openai.com/api/docs/guides/tools-web-search（`platform.openai.com/...` 301 到这里） | **新增了一个适配器**。官方 `web_search` 工具**只存在于 Responses API**：`tools:[{type:'web_search',search_context_size,filters,user_location}]`，响应 `output[]` 里有 `web_search_call` 与 `message`，引用在 `message.content[].annotations[]`，单条 `{type:'url_citation',start_index,end_index,url,title}`，usage 是 `input_tokens`/`output_tokens`。与 chat/completions 差异太大，新开 `openai-responses.ts`（含 spec 与 fixture）。原 `openai-compatible.ts` 保留给只实现 chat/completions 的端点（DeepSeek/Kimi/vLLM/自建网关），并在文件头写清它读的三种引用位置**都不是** OpenAI 官方字段、均未实测 |

`@taizan/llm` 的两个 provider 同日核对，**没有发现字段错误**：DashScope 原生的
`parameters.result_format='message'` 与 `usage.input_tokens`/`output_tokens` 对；
OpenAI 兼容的 `response_format:{type:'json_object'}` 与
`usage.prompt_tokens`/`completion_tokens` 对。

## 仍然待验证的清单

上面核对完之后还剩下这些——代码里用 `// 待验证:` 标注，且每一处都做了多路兜底 +
缺失兜底，实测后回来收敛即可：

| 引擎 | 还没核实的点 |
|---|---|
| `qwen` | `search_strategy` 的合法取值（中文站说 `turbo`/`max`/`agent`/`agent_max`，国际站说只支持 `agent`，两份官方文档互相打架，所以默认不发）；`usage.search_count` 没在文档里出现过，parse 是"有就用" |
| `ernie` | 文档只给了顶层 `search_results[]`，parse 多读的 `choices[0].message.search_results` 是防御性兜底，未实测存在；文档列的单条字段没有站点名，`site_name`/`web_anchor` 两个别名同样是兜底 |
| `hunyuan` | **`search_info` 的内部形状**：兼容接口文档只写"会返回 search_info"，云 API 文档也只写"搜索结果信息"，两边都没列子字段。按"云 API 的 `SearchInfo.SearchResults` 在兼容端点转成 `search_info.search_results[].{index,title,url}`"处理，是推断不是实测；正文兜底路径保留并有专门用例 |
| `zhipu` | `refer` 的取值格式（文档只写类型 string，parse 按 `ref_1` 抠数字当角标）；parse 多读的 `choices[0].message.tool_calls[].search_result` 接口参考里没有，未实测存在 |
| `metaso` | **响应体没有一手文档**：正文放哪个 key（`summary` 还是 `data.summary`）、`webpages[]` 是否真在顶层、`credits`/`total` 是否每次都回，全部未实测，多路兜底保留 |
| `doubao` | `caching` 与 `tools` 不能同时传（文档说会 400），本包不发 caching 但网关注入时会踩到，未实测；联网插件的按次单价文档只给了计费页链接 |
| `openai` | `openai-compatible.ts` 里读的三种引用位置都是各家网关的扩展，不是官方字段，均未实测；`openai-responses.ts` 没发 `filters.allowed_domains`——GEO 要的是"引擎自己会引谁"，限定域名会把结论做没 |
