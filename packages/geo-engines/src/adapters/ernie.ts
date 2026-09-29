/**
 * 文心一言 / 百度千帆 v2（OpenAI 风格的 `/v2/chat/completions`）。
 *
 * 凭据键名（`EngineAskContext.credentials`）：
 *   - `apiKey` —— 千帆 v2 的 API Key，放 `Authorization: Bearer {apiKey}`（必填）
 * 模型走 `ctx.model`（默认 `ernie-4.5-turbo-128k`），网关走 `ctx.baseUrl`
 * （默认 `https://qianfan.baidubce.com`）。
 *
 * 文档（核对日期 2026-09-13）：https://cloud.baidu.com/doc/qianfan-docs/s/Wm8r4sw29
 *
 * 已核对（文档明确）：
 *   - 鉴权是 `Authorization: Bearer {apiKey}`。
 *   - `web_search` 在**请求体顶层**，子字段 `enable`(默认 false) /
 *     `enable_citation`(默认 false) / `enable_trace`(默认 false) /
 *     `enable_status`(默认 false) / `search_mode`(默认 "auto") /
 *     `search_number`(默认 10) / `reference_number`(默认 10)。
 *   - 响应的 `search_results[]` 在**顶层**（与 `choices` 并列），
 *     单条字段是 `index` / `url` / `title`。
 *   - `usage` 是 OpenAI 风格的 `prompt_tokens` / `completion_tokens` / `total_tokens`。
 *
 * 千帆 v2 用的是 IAM Bearer Token 还是 API Key 直连，历史上换过几版（v1 是
 * `access_token` 挂 query）。这里按 **v2 的 `Bearer {apiKey}`** 实现，凭据只需要
 * 一个键；如果平台后台配的是老的 AK/SK，应该在装配层先换成 v2 API Key，
 * 而不是在这个包里塞一套 IAM 签名。
 *
 * 待验证: 文档只给了顶层 `search_results[]`，没说流式/非流式是否有差异；
 * parse 额外多读一处 `choices[0].message.search_results` 纯属防御，未实测存在。
 * 待验证: 文档列出的单条字段只有 `index`/`url`/`title`，没有站点名字段；
 * parse 里的 `site_name`/`web_anchor` 两个别名是兜底，未在文档里出现过。
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

const DEFAULT_BASE_URL = 'https://qianfan.baidubce.com'
const DEFAULT_MODEL = 'ernie-4.5-turbo-128k'
const PATH = '/v2/chat/completions'

/** 构造千帆 v2 chat 请求。纯函数。 */
export function buildErnieRequest(input: EngineAskInput, ctx: EngineAskContext): HttpRequest {
  const apiKey = requireCredential(ctx.credentials, 'apiKey', 'ernie')
  const body = {
    model: ctx.model ?? DEFAULT_MODEL,
    messages: buildChatMessages(input),
    stream: false,
    web_search: {
      enable: true,
      // enable_citation 打开才会回 search_results；enable_trace 会把检索链路一并带回
      enable_citation: true,
      enable_trace: true,
      enable_status: false,
    },
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

/** 解析千帆 v2 响应。纯函数，对缺字段/空回答/空引用健壮。 */
export function parseErnieResponse(body: unknown, meta: EngineParseMeta): EngineAskOutput {
  const choice = asRecord(asArray(pick(body, 'choices'))[0])
  const text = asString(pick(choice, 'message', 'content')) ?? ''
  const finishReason = asString(choice?.['finish_reason'])

  // 文档给的是顶层 search_results[]；message 内那处是防御性兜底（未实测存在）
  const rawResults = [
    ...asArray(pick(body, 'search_results')),
    ...asArray(pick(choice, 'message', 'search_results')),
  ]
  const citations: EngineCitation[] = []
  for (const item of rawResults) {
    const rec = asRecord(item)
    if (!rec) continue
    const url = asString(rec['url'])
    if (!url) continue
    const citation: EngineCitation = { url: normalizeUrl(url) }
    const title = asString(rec['title'])
    if (title) citation.title = title
    // 待验证: 文档里的单条只有 index/url/title，这两个站点名字段是兜底
    const siteName = asString(rec['site_name']) ?? asString(rec['web_anchor'])
    if (siteName) citation.siteName = siteName
    const index = asNumber(rec['index'])
    if (index !== undefined) citation.index = index
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

/** 文心一言适配器。 */
export class ErnieEngineAdapter implements EngineAdapter {
  readonly code = 'ernie' as const

  ask(input: EngineAskInput, ctx: EngineAskContext): Promise<EngineAskOutput> {
    return runAdapter(input, ctx, buildErnieRequest, parseErnieResponse, DEFAULT_MODEL)
  }
}
