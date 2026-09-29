/**
 * 智谱 GLM（`https://open.bigmodel.cn/api/paas/v4/chat/completions`）。
 *
 * 凭据键名（`EngineAskContext.credentials`）：
 *   - `apiKey`       —— 智谱开放平台 API Key，放 `Authorization: Bearer {apiKey}`（必填）
 *   - `searchEngine` —— 可选，检索引擎名，默认 `search_std`
 * 模型走 `ctx.model`（默认 `glm-4-plus`），网关走 `ctx.baseUrl`。
 *
 * 文档（核对日期 2026-09-13）：
 *   - https://docs.bigmodel.cn/cn/guide/tools/web-search
 *   - 对话补全接口参考：https://docs.bigmodel.cn/api-reference/模型-api/对话补全
 *
 * 已核对（文档明确）：
 *   - 端点 `POST https://open.bigmodel.cn/api/paas/v4/chat/completions`，Bearer 鉴权。
 *   - 联网是工具形态：`tools: [{ type: 'web_search', web_search: { enable, search_engine,
 *     search_result, search_prompt, count(1-50, 默认 10), search_domain_filter,
 *     search_recency_filter(默认 noLimit), content_size(默认 medium) } }]`。
 *   - 响应里检索结果在**顶层 `web_search[]`**（接口参考原文："返回与网页搜索相关的
 *     信息，使用 WebSearchToolSchema 时返回"），单条字段为
 *     `icon` / `title` / `link` / `media` / `publish_date` / `content` / `refer`——
 *     **地址在 `link` 不在 `url`**。
 *   - `usage` 是 `prompt_tokens` / `completion_tokens` / `total_tokens`。
 *
 * 智谱的联网是**工具调用**形态：在 `tools` 里塞一个 `{ type: 'web_search' }`，
 * 并打开 `search_result: true` 才会把检索结果一并回来。检索引擎可选
 * `search_std` / `search_pro` / `search_pro_sogou` / `search_pro_quark`，
 * 价格 ¥0.01 / 0.03 / 0.05 一次递增。P0 默认 `search_std`；
 * 想拿夸克的结果（调研报告里提到这是拿夸克结果的合法通道）就把
 * `credentials.searchEngine` 配成 `search_pro_quark`。
 *
 * 待验证: `refer` 的取值格式。文档只说类型是 string，没给样例；parse 里按
 * "形如 `ref_1`，抠出数字当角标"处理，抠不出数字就不写 `index`。
 * 待验证: parse 额外读的 `choices[0].message.tool_calls[].search_result` 属于
 * 防御性兜底，接口参考里**没有**这个位置，未实测存在。
 */
import { dedupeCitations, normalizeUrl } from '../citation'
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

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const DEFAULT_MODEL = 'glm-4-plus'
const DEFAULT_SEARCH_ENGINE = 'search_std'
const PATH = '/chat/completions'

/** 构造智谱 chat 请求（带 web_search 工具）。纯函数。 */
export function buildZhipuRequest(input: EngineAskInput, ctx: EngineAskContext): HttpRequest {
  const apiKey = requireCredential(ctx.credentials, 'apiKey', 'zhipu')
  const searchEngine = ctx.credentials['searchEngine'] ?? DEFAULT_SEARCH_ENGINE
  const body = {
    model: ctx.model ?? DEFAULT_MODEL,
    messages: buildChatMessages(input),
    stream: false,
    tools: [
      {
        type: 'web_search',
        web_search: {
          enable: true,
          search_engine: searchEngine,
          // 不打开这个就只有正文、没有检索结果列表，GEO 的引用统计就没了
          search_result: true,
        },
      },
    ],
  }
  return {
    url: `${trimBaseUrl(ctx.baseUrl ?? DEFAULT_BASE_URL)}${PATH}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }
}

/** 解析智谱响应。纯函数，对缺字段/空回答/空引用健壮。 */
export function parseZhipuResponse(body: unknown, meta: EngineParseMeta): EngineAskOutput {
  const choice = asRecord(asArray(pick(body, 'choices'))[0])
  const text = asString(pick(choice, 'message', 'content')) ?? ''
  const finishReason = asString(choice?.['finish_reason'])

  // 文档给的是顶层 web_search[]；tool_calls 那处是防御性兜底（未实测存在）
  const rawResults: unknown[] = [...asArray(pick(body, 'web_search'))]
  for (const call of asArray(pick(choice, 'message', 'tool_calls'))) {
    rawResults.push(...asArray(pick(call, 'search_result')))
  }

  const citations: EngineCitation[] = []
  for (const item of rawResults) {
    const rec = asRecord(item)
    if (!rec) continue
    // 智谱把地址放在 link，不是 url
    const url = asString(rec['link']) ?? asString(rec['url'])
    if (!url) continue
    const citation: EngineCitation = { url: normalizeUrl(url) }
    const title = asString(rec['title'])
    if (title) citation.title = title
    const siteName = asString(rec['media'])
    if (siteName) citation.siteName = siteName
    const snippet = asString(rec['content'])
    if (snippet) citation.snippet = snippet.slice(0, 500)
    // refer 形如 "ref_1"，从里面抠数字当角标
    const referNum = Number((asString(rec['refer']) ?? '').replace(/\D+/g, ''))
    if (Number.isFinite(referNum) && referNum > 0) citation.index = referNum
    citations.push(citation)
  }

  const usage = asRecord(pick(body, 'usage'))
  const deduped = dedupeCitations(citations)

  return {
    text,
    citations: deduped,
    usage: {
      inputTokens: asNumber(usage?.['prompt_tokens']) ?? 0,
      outputTokens: asNumber(usage?.['completion_tokens']) ?? 0,
      searchCalls: deduped.length > 0 ? 1 : 0,
    },
    model: asString(pick(body, 'model')) ?? meta.model ?? DEFAULT_MODEL,
    latencyMs: meta.latencyMs,
    raw: body,
    ...(finishReason ? { finishReason } : {}),
  }
}

/** 智谱 GLM 适配器。 */
export class ZhipuEngineAdapter implements EngineAdapter {
  readonly code = 'zhipu' as const

  ask(input: EngineAskInput, ctx: EngineAskContext): Promise<EngineAskOutput> {
    return runAdapter(input, ctx, buildZhipuRequest, parseZhipuResponse, DEFAULT_MODEL)
  }
}
