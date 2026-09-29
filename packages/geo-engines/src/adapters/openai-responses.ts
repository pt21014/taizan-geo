/**
 * OpenAI **官方 Responses API** + `web_search` 工具（code 仍是 `openai`）。
 *
 * 凭据键名（`EngineAskContext.credentials`）：
 *   - `apiKey`         —— 放 `Authorization: Bearer {apiKey}`（必填）
 *   - `baseUrl`        —— 网关地址，可选；也可以走 `ctx.baseUrl`，两者都给时 `ctx.baseUrl` 优先
 *   - `model`          —— 模型名，可选；也可以走 `ctx.model`，两者都给时 `ctx.model` 优先
 *   - `searchContextSize` —— 可选，`low` / `medium` / `high`
 *   - `userCountry`    —— 可选，两位国家码，写进 `tools[0].user_location`
 * 与 `openai-compatible.ts` 一样不设默认 baseUrl / model：这类端点没有"默认地址"，
 * 猜一个只会把请求打到别人的网关上。
 *
 * 文档（核对日期 2026-09-13）：
 *   https://developers.openai.com/api/docs/guides/tools-web-search
 *   （`https://platform.openai.com/docs/guides/tools-web-search` 现在 301 到这里）
 *
 * 为什么单独开一个文件而不是塞进 `openai-compatible.ts`：**两者是两条协议**，
 * 差异大到不能靠"多读几个字段"兼容——
 *   - 路径：`/responses`，不是 `/chat/completions`。
 *   - 请求：`input` 取代 `messages`；联网是 `tools: [{ type: 'web_search' }]`，
 *     chat/completions 那边根本没有这个工具。
 *   - 响应：没有 `choices`；正文在 `output[] → message → content[] → text`，
 *     引用在同一层的 `annotations[]`，单条是
 *     `{ type: 'url_citation', start_index, end_index, url, title }`——
 *     **不是** chat/completions 的 `message.annotations[].url_citation` 再嵌一层。
 *   - usage：`input_tokens` / `output_tokens`，不是 `prompt_tokens` / `completion_tokens`。
 * 一个 parse 同时认两套会把"字段没取到"和"用错了协议"混成同一种失败。
 *
 * 怎么选：打 openai.com 官方、要联网引用 → 用这个；打 DeepSeek / Kimi / vLLM /
 * 自建网关这类只实现了 chat/completions 的端点 → 用 `openai-compatible.ts`。
 * 两个类的 `code` 都是 `'openai'`，`EngineRegistry` 里只能注册其中一个，
 * 由装配层按引擎配置决定 register 哪个。
 *
 * 待验证: `tools[0].filters.{allowed_domains,blocked_domains}` 本适配器没发——
 * GEO 监测要的是"引擎自己会引谁"，限定域名会把结论做没了。
 */
import { dedupeCitations, extractUrlsFromText } from '../citation'
import { EngineError } from '../errors'
import type { HttpRequest } from '../http-client'
import type {
  EngineAdapter,
  EngineAskContext,
  EngineAskInput,
  EngineAskOutput,
  EngineParseMeta,
} from '../types'
import {
  collectResponsesCitations,
  collectResponsesFinishReason,
  collectResponsesSearchCalls,
  collectResponsesText,
} from './responses-api'
import { asNumber, asRecord, asString, pick, requireCredential, runAdapter, trimBaseUrl } from './shared'

const PATH = '/responses'
const CONTEXT_SIZES = new Set(['low', 'medium', 'high'])

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

/** 构造 Responses API + web_search 请求。纯函数。 */
export function buildOpenAiResponsesRequest(
  input: EngineAskInput,
  ctx: EngineAskContext,
): HttpRequest {
  const apiKey = requireCredential(ctx.credentials, 'apiKey', 'openai')
  const { baseUrl, model } = resolveTarget(ctx)

  const tool: Record<string, unknown> = { type: 'web_search' }
  const size = ctx.credentials['searchContextSize']?.trim()
  if (size && CONTEXT_SIZES.has(size)) tool['search_context_size'] = size
  const country = ctx.credentials['userCountry']?.trim()
  if (country) tool['user_location'] = { type: 'approximate', country }

  const body: Record<string, unknown> = {
    model,
    stream: false,
    tools: [tool],
    input: [{ role: 'user', content: [{ type: 'input_text', text: input.prompt }] }],
  }
  if (input.systemPrompt) body['instructions'] = input.systemPrompt

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

/** 解析 Responses API 响应。纯函数，对缺字段/空回答/空引用健壮。 */
export function parseOpenAiResponsesResponse(
  body: unknown,
  meta: EngineParseMeta,
): EngineAskOutput {
  const text = collectResponsesText(body)
  const citations = collectResponsesCitations(body)
  // 引擎没给结构化引用时从正文兜底抽 URL，只能撑域名统计，没有标题
  const deduped = citations.length > 0 ? dedupeCitations(citations) : extractUrlsFromText(text)

  const usage = asRecord(pick(body, 'usage'))
  const finishReason = collectResponsesFinishReason(body)

  return {
    text,
    citations: deduped,
    usage: {
      inputTokens: asNumber(usage?.['input_tokens']) ?? 0,
      outputTokens: asNumber(usage?.['output_tokens']) ?? 0,
      searchCalls: collectResponsesSearchCalls(body) ?? (deduped.length > 0 ? 1 : 0),
    },
    model: asString(pick(body, 'model')) ?? meta.model ?? 'unknown',
    latencyMs: meta.latencyMs,
    raw: body,
    ...(finishReason ? { finishReason } : {}),
  }
}

/** OpenAI Responses API 适配器。与 `OpenAiCompatibleEngineAdapter` 二选一注册。 */
export class OpenAiResponsesEngineAdapter implements EngineAdapter {
  readonly code = 'openai' as const

  ask(input: EngineAskInput, ctx: EngineAskContext): Promise<EngineAskOutput> {
    return runAdapter(
      input,
      ctx,
      buildOpenAiResponsesRequest,
      parseOpenAiResponsesResponse,
      ctx.model ?? ctx.credentials['model'] ?? 'unknown',
    )
  }
}
