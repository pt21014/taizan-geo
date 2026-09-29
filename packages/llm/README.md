# @taizan/llm

LLM Provider 接口 + registry（主 provider 失败自动切备用）+ JSON Schema 提示词
与脏输出解析 + mock 兜底；OpenAI 协议兼容与通义 DashScope 原生两套实现。
零框架依赖，不 import 任何 `@nestjs/*` 或 `@prisma/client`，HTTP 走调用方注入的
`HttpClient` 接口，不 import axios、不用全局 `fetch`。

这个包服务 GEO 里的两件事：把引擎的回答**结构化**（谁被提到了、第几位、什么
情感），以及**生成 Prompt**。两件事都要求模型吐 JSON。

## 接口

```ts
interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatRequest {
  messages: ChatMessage[]
  model?: string
  jsonSchema?: JsonSchema // 给了它就表示"这次要结构化输出"
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

interface ChatResponse {
  text: string
  json?: unknown // 解析失败时是 undefined，不是抛错
  usage: { inputTokens: number; outputTokens: number }
  model: string
  finishReason: string
}

interface LlmProvider<TConfig> {
  readonly name: string
  chat(req: ChatRequest, cfg: TConfig, ctx: { http: HttpClient; signal?: AbortSignal }): Promise<ChatResponse>
}
```

用法：

```ts
import { LlmProviderRegistry, MockLlmProvider, OpenAiCompatibleLlmProvider } from '@taizan/llm'

const registry = new LlmProviderRegistry()
  .register(new OpenAiCompatibleLlmProvider())
  .register(new MockLlmProvider())

const { response, provider, attempts } = await registry.chatWithFallback(
  { messages: [{ role: 'user', content: answerText }], jsonSchema: MENTION_SCHEMA },
  { 'openai-compatible': { baseUrl, apiKey, model }, mock: {} },
  ['openai-compatible', 'mock'],
  { http: httpClient },
)
// attempts 里每一次尝试都有记录（provider / ok / error / elapsedMs），排障要用
```

## 三个 provider

| name | 配置 | 说明 |
|---|---|---|
| `openai-compatible` | `baseUrl`、`apiKey`、`model`、`strictJsonSchema?` | DeepSeek / Kimi / 智谱 / vLLM / 自建网关 / openai.com 通吃。`jsonSchema` 存在时打开 `response_format: { type: 'json_object' }`；端点支持强模式时配 `strictJsonSchema: true` 改用 `{ type: 'json_schema' }` |
| `dashscope` | `apiKey`、`model`、`baseUrl?` | 通义原生 `/api/v1/services/aigc/text-generation/generation`，`result_format: 'message'`。原生协议上 `response_format` 支持不稳定，**只靠提示词**约束 JSON，解析交给 `parseJsonLoose` |
| `mock` | `scenario?`、`brandName?`、`competitorNames?` | 不发请求，按 scenario + messages 里出现的品牌词做**确定性字符串匹配** |

`mock` 的 7 个 scenario：`mention`（默认）/ `no-mention` / `competitor` /
`cited` / `negative` / `prompt-gen`（返回固定 5 条 Prompt）/ `fail`（直接抛错，
用来测 registry 的主备切换）。

**只有 messages 里真的出现了品牌词，mock 才产出该品牌的 mention**——这条规则是
刻意的：`analysis` 模块的单测拿 mock 当上游，如果不管输入是什么都返回一条"提及"，
那测的就不是分析逻辑，而是 mock 自己编的数据。

装配时务必调 `assertMockNotInProd(env, enabledProviderNames)`。

## 文档核对结论（核对日期 2026-09-13）

两个真实 provider 的请求/响应字段对着官方文档逐条核对过，**没有发现字段错误**：

| provider | 核对的文档 URL | 结论 |
|---|---|---|
| `dashscope` | https://help.aliyun.com/zh/model-studio/web-search（同一套 DashScope 原生协议） | 正确。`result_format` 与 `incremental_output` 在**请求体的 `parameters` 下**；`result_format:'message'` 时正文在 `output.choices[0].message.content`、结束原因在 `output.choices[0].finish_reason`（parse 还兜了老 `text` 格式的 `output.text`）；`usage` 是 `input_tokens` / `output_tokens` / `total_tokens`——与实现一致 |
| `openai-compatible` | https://developers.openai.com/api/docs/ | 正确。`response_format: { type: 'json_object' }` 与 `{ type: 'json_schema', json_schema: {...} }` 两种模式的字段名都对；`usage` 是 `prompt_tokens` / `completion_tokens`——与实现一致 |

注意 `openai-compatible` 走的是 **`/chat/completions`**，这是对的：这个包只要
"给一段文本、拿一段 JSON"，不需要联网工具。OpenAI 的 `web_search` 工具只存在于
Responses API，那条路在 `@taizan/geo-engines` 的 `openai-responses.ts` 里，
与本包无关。

## JSON 输出为什么要单独一层

即便打开了各家的"JSON 模式"，模型仍然会时不时把 JSON 包进 ` ```json ` 围栏里、
在前面加一句"好的，以下是结果："、或者在 `maxTokens` 截断时吐出半个对象。
`JSON.parse` 在这几种情况下全会抛，而 GEO 的分析任务是批量跑的——一条脏输出让
整批炸掉是不可接受的。

- `buildJsonSchemaHint(schema)`：把 JSON Schema 转成缩进的字段清单（标必填/可选、
  枚举取值、description）追加到 system message。做成自然语言而不是直接贴 schema
  JSON：模型对前者的遵循度更高，而且 `$schema`/`additionalProperties` 这类关键字
  白占 token。
- `parseJsonLoose(text)`：依次尝试 ① 直接 parse ② 剥围栏 ③ 取第一个 `{` 到最后一个
  `}`（或 `[`…`]`）④ 截尾修复（补未闭合的引号与括号、丢掉悬空的 key 与逗号）。
  **全失败时返回 `undefined`，绝不抛**——上层拿到 `undefined` 才能决定是重试一次、
  降级到关键词规则、还是把这条结果标成 FAILED。

截尾修复是给 `maxTokens` 截断准备的：一次分析被截断多半只丢了最后一两个 mention，
前面几条仍然是有用的数据，扔掉整条结果太浪费。

## 怎么加一个 provider

1. 在 `src/providers/` 下新建一个文件，导出三样：`buildXxxRequest(req, cfg)`、
   `parseXxxResponse(body, req, fallbackModel)` 两个**纯函数**，以及实现
   `LlmProvider<TConfig>` 的类。
2. `parse` 一律用 `providers/shared.ts` 的 `asRecord/asArray/asString/asNumber/pick`
   取值——模型服务商的响应不是我们的契约，少一个 `usage` 字段不该让整批分析炸掉。
3. `chat()` 失败**抛异常**（不像 `@taizan/sms` 用返回值表达失败）：registry 的
   fallback 是 try/catch 驱动的，非 2xx 与非 JSON 响应都要抛。
4. `req.jsonSchema` 存在时：能打开原生 JSON 模式就打开，然后一律把正文过
   `parseJsonLoose` 写进 `res.json`；解析不出来时**不要写这个字段**。
5. 在 `src/index.ts` 里导出，写同名 `.spec.ts`。

## 导出的 schema：`MENTION_SCHEMA`

`src/schemas.ts` 里放着分析流水线真正用的那份 JSON Schema（品牌/竞品提及抽取），
由本包 `export`：

```ts
import { MENTION_SCHEMA } from '@taizan/llm'

await llm.chat({ messages, jsonSchema: MENTION_SCHEMA, temperature: 0 })
```

它住在本包而不是调用它的 Nest handler 里，是因为它**是 provider 侧的契约**：
`buildJsonSchemaHint()` 要把它渲染成提示词，`MockLlmProvider` 的 `mention` 场景
要按它的形状编 JSON，两件事都发生在包内。schema 留在应用侧的话，包的单测只能
对着一份手抄的简化版跑，而手抄版哪天与真版不一致了没有任何信号。
`schemas.spec.ts` 就是在钉这两处耦合。

字段含义（与 `apps/api` 的 `mergeLlmMentions` 逐个对齐，改一边要改另一边）：
`entityName` / `position`（1 起）/ `isCited` / `sentiment`（POSITIVE|NEUTRAL|NEGATIVE）
/ `sentimentScore`（−100..100 整数，**它本身就是"情感值 ×100"**）/ `snippet`（非必填）。

## 关键约定

- **HTTP 客户端由调用方注入**（`ctx.http`），本包不 import axios、不用全局 `fetch`。
- **`response.json` 解析失败是 `undefined`，不是抛错**。
- **registry 记 `attempts[]`**：一次分析切换过 provider 时，两次尝试都要能看到，
  只留最后一次等于把"主模型一直在超时"藏起来。
- **mock 生产环境启用直接拒启**。
