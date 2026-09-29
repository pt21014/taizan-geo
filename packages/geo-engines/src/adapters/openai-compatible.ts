/**
 * OpenAI 协议兼容端点（code = `openai`）。
 *
 * 凭据键名（`EngineAskContext.credentials`）：
 *   - `apiKey`  —— 放 `Authorization: Bearer {apiKey}`（必填）
 *   - `baseUrl` —— 网关地址，可选；也可以走 `ctx.baseUrl`，两者都给时 `ctx.baseUrl` 优先
 *   - `model`   —— 模型名，可选；也可以走 `ctx.model`，两者都给时 `ctx.model` 优先
 * `baseUrl` 与 `model` **必须至少各有一个来源**，缺了直接按 AUTH 抛——这类端点
 * 没有"默认地址"可言，猜一个只会把请求打到别人的网关上。
 *
 * 这一个适配器覆盖 **只实现了 `/chat/completions` 的那一类端点**：DeepSeek /
 * Kimi / vLLM / 自建网关。注意其中**很多端点根本不联网**（DeepSeek 的 API 明确
 * 不带联网），那样回答里没有引用是正常的，`citations` 会是空数组——这本身就是
 * GEO 要记录的事实，不是错误。
 *
 * **要打 openai.com 官方的联网搜索，用 `openai-responses.ts`，不是这个文件。**
 * 核对日期 2026-09-13：官方 `web_search` 工具只存在于 Responses API
 * （https://developers.openai.com/api/docs/guides/tools-web-search，
 * `platform.openai.com/docs/guides/tools-web-search` 现在 301 到这里），
 * 请求体是 `input` + `tools: [{ type: 'web_search' }]`，响应是 `output[]` 而不是
 * `choices[]`，两条协议的形状差得太远，塞进同一个 parse 只会把"字段没取到"和
 * "用错了协议"混成同一种失败。两个适配器的 `code` 都是 `'openai'`，装配层二选一注册。
 *
 * 待验证: 各家把引用放哪儿没有统一，下面三种都不是 OpenAI 官方 chat/completions
 * 文档里的字段，而是各家网关自己加的扩展，均未实测：
 *   - `choices[0].message.annotations[].url_citation.{url,title}`
 *     （Azure / 部分网关把 Responses 的 url_citation 搬进了 chat 形状）
 *   - 顶层 `citations: string[]`（Perplexity 一族）
 *   - 顶层 `search_results[]`（一些自建网关）
 * parse 三种都读；都没有时用 `extractUrlsFromText` 从正文兜底。
 */
import { dedupeCitations, extractUrlsFromText, normalizeUrl } from '../citation'
import { EngineError } from '../errors'
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

const PATH = '/chat/completions'

/** 从 ctx / credentials 里解析出 baseUrl 与 model，缺一不可。 */
function resolveTarget(ctx: EngineAskContext): { baseUrl: string; model: string } {
  const baseUrl = ctx.baseUrl ?? ctx.credentials['baseUrl']
  const model = ctx.model ?? ctx.credentials['model']
  if (!baseUrl || baseUrl.trim() === '') {
    throw new EngineError('AUTH', '[openai] 缺少 baseUrl（ctx.baseUrl 或 credentials.baseUrl）')
  }
  if (!model || model.trim() === '') {
    throw new EngineError('AUTH', '[openai] 缺少 model（ctx.model 或 credentials.model）')
  }
  return { baseUrl: trimBaseUrl(baseUrl.trim()), model: model.trim() }
}

/** 构造 OpenAI 协议 chat 请求。纯函数。 */
export function buildOpenAiRequest(input: EngineAskInput, ctx: EngineAskContext): HttpRequest {
  const apiKey = requireCredential(ctx.credentials, 'apiKey', 'openai')
  const { baseUrl, model } = resolveTarget(ctx)
  const body = {
    model,
    messages: buildChatMessages(input),
    stream: false,
  }
  return {
    url: `${baseUrl}${PATH}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }
}

/** 解析 OpenAI 协议响应。纯函数，对缺字段/空回答/空引用健壮。 */
export function parseOpenAiResponse(body: unknown, meta: EngineParseMeta): EngineAskOutput {
  const choice = asRecord(asArray(pick(body, 'choices'))[0])
  const text = asString(pick(choice, 'message', 'content')) ?? ''
  const finishReason = asString(choice?.['finish_reason'])

  const citations: EngineCitation[] = []

  // ① annotations[].url_citation（把 Responses 的引用搬进 chat 形状的那些网关）
  for (const ann of asArray(pick(choice, 'message', 'annotations'))) {
    const rec = asRecord(ann)
    const cite = asRecord(rec?.['url_citation'])
    const url = asString(cite?.['url'])
    if (!url) continue
    const citation: EngineCitation = { url: normalizeUrl(url) }
    const title = asString(cite?.['title'])
    if (title) citation.title = title
    citations.push(citation)
  }

  // ② 顶层 citations: string[]（Perplexity 一族）
  for (const c of asArray(pick(body, 'citations'))) {
    const url = asString(c)
    if (url) citations.push({ url: normalizeUrl(url) })
  }

  // ③ 顶层 search_results[]（部分自建网关）
  for (const item of asArray(pick(body, 'search_results'))) {
    const rec = asRecord(item)
    const url = asString(rec?.['url']) ?? asString(rec?.['link'])
    if (!url) continue
    const citation: EngineCitation = { url: normalizeUrl(url) }
    const title = asString(rec?.['title'])
    if (title) citation.title = title
    citations.push(citation)
  }

  const deduped = citations.length > 0 ? dedupeCitations(citations) : extractUrlsFromText(text)
  const usage = asRecord(pick(body, 'usage'))

  return {
    text,
    citations: deduped,
    usage: {
      inputTokens: asNumber(usage?.['prompt_tokens']) ?? 0,
      outputTokens: asNumber(usage?.['completion_tokens']) ?? 0,
      searchCalls: deduped.length > 0 ? 1 : 0,
    },
    model: asString(pick(body, 'model')) ?? meta.model ?? 'unknown',
    latencyMs: meta.latencyMs,
    raw: body,
    ...(finishReason ? { finishReason } : {}),
  }
}

/** OpenAI 协议兼容适配器。 */
export class OpenAiCompatibleEngineAdapter implements EngineAdapter {
  readonly code = 'openai' as const

  ask(input: EngineAskInput, ctx: EngineAskContext): Promise<EngineAskOutput> {
    return runAdapter(
      input,
      ctx,
      buildOpenAiRequest,
      parseOpenAiResponse,
      ctx.model ?? ctx.credentials['model'] ?? 'unknown',
    )
  }
}
