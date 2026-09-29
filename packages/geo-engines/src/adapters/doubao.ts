/**
 * 豆包 / 火山方舟（Ark）。
 *
 * 凭据键名（`EngineAskContext.credentials`）：
 *   - `apiKey`  —— 方舟 API Key，放 `Authorization: Bearer {apiKey}`（必填）
 *   - `useBots` —— 可选，`'true'` 时改走旧的 `/bots/chat/completions`（见下）
 *   - `sources` —— 可选，逗号分隔的附加内容源，如 `douyin,moji,toutiao`
 * `ctx.model` 默认走 Responses API 时填的是**模型名或推理接入点 ID**；
 * `useBots='true'` 时填的是**应用 ID（bot-xxxx）**。
 * 网关走 `ctx.baseUrl`（默认 `https://ark.cn-beijing.volces.com/api/v3`）。
 *
 * 文档（核对日期 2026-09-13）：
 *   - Web Search（联网内容插件）：https://www.volcengine.com/docs/82379/1756990
 *   - 应用(bot) API：https://www.volcengine.com/docs/82379/1526787
 *   - 联网插件数据结构 SearchDocument：https://www.volcengine.com/docs/82379/1285209
 *
 * 已核对（文档明确）：
 *   - 联网搜索走 **`POST /api/v3/responses`**（Responses API，兼容 OpenAI Responses
 *     协议），工具声明是 `tools: [{ "type": "web_search" }]`。文档原文：
 *     「联网内容插件仅支持 Responses API」。**上一版实现默认打的
 *     `/bots/chat/completions` 是旧的应用(bot)通道**，需要先在控制台建应用、
 *     给应用挂插件，`ctx.model` 还得换成 bot ID——不是文档推荐的联网方式。
 *   - `tools` 的子字段：`sources`（`["doubao"]` 是豆包搜索 Custom 版；联网内容插件
 *     可加 `"douyin"`/`"moji"`/`"toutiao"`，默认走 `search_engine` 搜全网）、
 *     `limit`（1~50，默认 10）、`max_keyword`（1~50）、`user_location`。
 *     顶层还有 `max_tool_calls`（1~10，默认 3）。
 *   - 引用在 **`output[] → type:'message' → content[] → annotations[]`**，
 *     单条是 `{ type: 'url_citation', title, url, site_name, publish_time, summary }`。
 *     不是 `references[]`——`references[]` 是旧 bots 通道的字段。
 *   - `usage` 是 `input_tokens` / `output_tokens` / `total_tokens`，外加
 *     `tool_usage.web_search`（搜索次数）与 `tool_usage_details`。
 *   - 旧 bots 通道的 `references[]` 单条是 SearchDocument：
 *     `site_name` / `summary` / `publish_time` / `title` / `url` / `logo_url` /
 *     `mobile_url` / `cover_image` / `extra`，token 账在 `bot_usage.model_usage[]`。
 *
 * 待验证: `caching` 与 `tools` 不能同时传（文档说会 400），本适配器不发 caching，
 * 但如果调用方通过网关注入了缓存参数会踩到，未实测。
 * 待验证: 联网插件的按次单价（调研报告标为待验证，文档只给了计费页链接）。
 * 本包不管计费，`searchCalls` 按 `usage.tool_usage.web_search` 或
 * `output[]` 里 `web_search_call` 的条数报给上层，成本由
 * `GeoEngine.pricePerQueryCents` 算。
 */
import { dedupeCitations, extractUrlsFromText, normalizeUrl } from '../citation'
import type { HttpRequest } from '../http-client'
import type {
  EngineAdapter,
  EngineAskContext,
  EngineAskInput,
  EngineAskOutput,
  EngineCitation,
  EngineParseMeta,
} from '../types'
import {
  collectResponsesCitations,
  collectResponsesFinishReason,
  collectResponsesSearchCalls,
  collectResponsesText,
} from './responses-api'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  buildChatMessages,
  pick,
  requireCredential,
  runAdapter,
  trimBaseUrl,
} from './shared'

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_MODEL = 'doubao-seed-1-6'
const RESPONSES_PATH = '/responses'
const BOTS_PATH = '/bots/chat/completions'

/** `credentials.useBots === 'true'` 时走旧的应用(bot)通道。 */
function usesBots(ctx: EngineAskContext): boolean {
  return ctx.credentials['useBots'] === 'true'
}

/** 构造方舟请求。纯函数。默认是 Responses API + web_search 工具。 */
export function buildDoubaoRequest(input: EngineAskInput, ctx: EngineAskContext): HttpRequest {
  const apiKey = requireCredential(ctx.credentials, 'apiKey', 'doubao')
  const base = trimBaseUrl(ctx.baseUrl ?? DEFAULT_BASE_URL)
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  if (usesBots(ctx)) {
    // 旧通道：model 填的是控制台建的应用 ID（bot-xxxx），联网插件在控制台挂
    const body = {
      model: ctx.model ?? DEFAULT_MODEL,
      messages: buildChatMessages(input),
      stream: false,
    }
    return { url: `${base}${BOTS_PATH}`, method: 'POST', headers, body: JSON.stringify(body) }
  }

  // Responses API：system prompt 走 `instructions`，问题走 input 的 input_text
  const tool: Record<string, unknown> = { type: 'web_search' }
  const sources = (ctx.credentials['sources'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (sources.length > 0) tool['sources'] = sources

  const body: Record<string, unknown> = {
    model: ctx.model ?? DEFAULT_MODEL,
    stream: false,
    tools: [tool],
    input: [{ role: 'user', content: [{ type: 'input_text', text: input.prompt }] }],
  }
  if (input.systemPrompt) body['instructions'] = input.systemPrompt

  return { url: `${base}${RESPONSES_PATH}`, method: 'POST', headers, body: JSON.stringify(body) }
}

/** 旧 bots 通道的 `references[]`（SearchDocument）。 */
function parseBotReferences(body: unknown, choice: Record<string, unknown> | undefined): EngineCitation[] {
  const raw = [
    ...asArray(pick(body, 'references')),
    ...asArray(pick(choice, 'message', 'references')),
  ]
  const citations: EngineCitation[] = []
  raw.forEach((item, i) => {
    const rec = asRecord(item)
    if (!rec) return
    // SearchDocument.url；mobile_url 是移动端别名，只在没有 url 时用
    const url = asString(rec['url']) ?? asString(rec['mobile_url'])
    if (!url) return
    const citation: EngineCitation = { url: normalizeUrl(url) }
    const title = asString(rec['title'])
    if (title) citation.title = title
    const siteName = asString(rec['site_name'])
    if (siteName) citation.siteName = siteName
    const snippet = asString(rec['summary'])
    if (snippet) citation.snippet = snippet.slice(0, 500)
    citation.index = i + 1
    citations.push(citation)
  })
  return citations
}

/**
 * 解析方舟响应。纯函数。
 *
 * 一个 parse 同时认两种形状，因为 `build` 会按 `useBots` 发两种请求：
 *   - Responses API：`output[]` + `annotations[]` + `usage.input_tokens`
 *   - 旧 bots 通道：`choices[]` + `references[]` + `bot_usage.model_usage[]`
 * 两边都没有结构化引用时，从正文兜底抽 URL。
 */
export function parseDoubaoResponse(body: unknown, meta: EngineParseMeta): EngineAskOutput {
  const choice = asRecord(asArray(pick(body, 'choices'))[0])
  const chatText = asString(pick(choice, 'message', 'content'))
  const text = chatText ?? collectResponsesText(body)

  const citations = [...collectResponsesCitations(body), ...parseBotReferences(body, choice)]
  const deduped = citations.length > 0 ? dedupeCitations(citations) : extractUrlsFromText(text)

  const usage = asRecord(pick(body, 'usage'))
  // bots 通道的 token 账在 bot_usage.model_usage[] 里，不在顶层 usage
  const botUsage = asRecord(asArray(pick(body, 'bot_usage', 'model_usage'))[0])
  const inputTokens =
    asNumber(usage?.['input_tokens']) ??
    asNumber(usage?.['prompt_tokens']) ??
    asNumber(botUsage?.['prompt_tokens']) ??
    0
  const outputTokens =
    asNumber(usage?.['output_tokens']) ??
    asNumber(usage?.['completion_tokens']) ??
    asNumber(botUsage?.['completion_tokens']) ??
    0

  const finishReason =
    asString(choice?.['finish_reason']) ?? collectResponsesFinishReason(body) ?? undefined

  return {
    text,
    citations: deduped,
    usage: {
      inputTokens,
      outputTokens,
      searchCalls: collectResponsesSearchCalls(body) ?? (deduped.length > 0 ? 1 : 0),
    },
    model: asString(pick(body, 'model')) ?? meta.model ?? DEFAULT_MODEL,
    latencyMs: meta.latencyMs,
    raw: body,
    ...(finishReason ? { finishReason } : {}),
  }
}

/** 豆包 / 火山方舟适配器。 */
export class DoubaoEngineAdapter implements EngineAdapter {
  readonly code = 'doubao' as const

  ask(input: EngineAskInput, ctx: EngineAskContext): Promise<EngineAskOutput> {
    return runAdapter(input, ctx, buildDoubaoRequest, parseDoubaoResponse, DEFAULT_MODEL)
  }
}
