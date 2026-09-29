/**
 * 通义千问 / 阿里云百炼（DashScope 原生协议）。
 *
 * 凭据键名（`EngineAskContext.credentials`）：
 *   - `apiKey`         —— 百炼的 API-KEY，放 `Authorization: Bearer {apiKey}`（必填）
 *   - `searchStrategy` —— 可选，`search_options.search_strategy` 的值；不配就不发这个字段
 * 其余可调项走 `ctx.model`（默认 `qwen-plus`）与 `ctx.baseUrl`
 * （默认 `https://dashscope.aliyuncs.com`）。
 *
 * 文档（核对日期 2026-09-13）：
 *   - https://help.aliyun.com/zh/model-studio/web-search
 *   - https://www.alibabacloud.com/help/zh/model-studio/web-search
 *
 * 已核对（文档明确）：
 *   - `enable_search` 与 `search_options` 都在**请求体的 `parameters` 下**，不是顶层。
 *   - `search_options` 的子字段：`enable_source` / `enable_citation` /
 *     `citation_format`（合法值 `[<number>]`、`[ref_<number>]`，默认 `[<number>]`）/
 *     `forced_search` / `search_strategy` / `enable_search_extension` / `freshness` /
 *     `assigned_site_list` / `prepend_search_result`。
 *   - `result_format: 'message'` 时正文在 `output.choices[0].message.content`，
 *     `finish_reason` 在 `output.choices[0].finish_reason`。
 *   - 响应 `output.search_info.search_results[]` 单条字段为
 *     `site_name` / `icon` / `index` / `title` / `url`。
 *   - `usage` 是 `input_tokens` / `output_tokens` / `total_tokens`。
 *
 * 待验证: `search_strategy` 的合法取值两份官方文档互相打架——中文站
 * （help.aliyun.com）列的是 `turbo`(默认) / `max` / `agent` / `agent_max`，
 * 国际站（alibabacloud.com）写的是"目前仅支持 agent 策略"。**默认不发这个字段**
 * （让服务端用它自己的默认值），需要时由 `credentials.searchStrategy` 显式指定，
 * 未实测哪一份是准的。
 * 待验证: `usage.search_count` 没在文档里出现，parse 里只是"有就用"，取不到时
 * 按"有引用即 1 次"估。
 *
 * 注意这里走的是 **DashScope 原生协议**（`/api/v1/services/aigc/...`，
 * 请求体是 `input` + `parameters` 两段），不是它同时提供的 OpenAI 兼容端点——
 * 兼容端点上 `search_options` 这组开关的支持情况不一致，而引用字段正是我们要的。
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
import { asArray, asNumber, asRecord, asString, pick, requireCredential, runAdapter, trimBaseUrl } from './shared'

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com'
const DEFAULT_MODEL = 'qwen-plus'
const PATH = '/api/v1/services/aigc/text-generation/generation'

/** 构造 DashScope 原生文本生成请求。纯函数。 */
export function buildQwenRequest(input: EngineAskInput, ctx: EngineAskContext): HttpRequest {
  const apiKey = requireCredential(ctx.credentials, 'apiKey', 'qwen')
  const messages: Array<{ role: string; content: string }> = []
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt })
  messages.push({ role: 'user', content: input.prompt })

  // search_strategy 的合法取值两份官方文档不一致（见文件头待验证），默认不发
  const searchStrategy = ctx.credentials['searchStrategy']?.trim()
  const searchOptions: Record<string, unknown> = {
    // enable_source + enable_citation 是拿到 search_results 的开关，缺一不可
    enable_source: true,
    enable_citation: true,
    // 文档给的两个合法值之一；角标形如 [ref_1]，与正文里的引用一一对应
    citation_format: '[ref_<number>]',
    forced_search: true,
  }
  if (searchStrategy) searchOptions['search_strategy'] = searchStrategy

  const body = {
    model: ctx.model ?? DEFAULT_MODEL,
    input: { messages },
    parameters: {
      // 必须是 message：text 格式下没有 finish_reason，也拿不到稳定的 choices 结构
      result_format: 'message',
      incremental_output: false,
      enable_search: true,
      search_options: searchOptions,
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

/** 解析 DashScope 原生响应。纯函数，对缺字段/空回答/空引用健壮。 */
export function parseQwenResponse(body: unknown, meta: EngineParseMeta): EngineAskOutput {
  const output = asRecord(pick(body, 'output'))
  const choice = asRecord(asArray(output?.['choices'])[0])
  // result_format=message 走 choices；老的 text 格式直接在 output.text 上，一并兜住
  const text =
    asString(pick(choice, 'message', 'content')) ?? asString(output?.['text']) ?? ''
  const finishReason =
    asString(choice?.['finish_reason']) ?? asString(output?.['finish_reason']) ?? undefined

  const rawResults = asArray(pick(output, 'search_info', 'search_results'))
  const citations: EngineCitation[] = []
  for (const item of rawResults) {
    const rec = asRecord(item)
    if (!rec) continue
    const url = asString(rec['url'])
    if (!url) continue
    const citation: EngineCitation = { url: normalizeUrl(url) }
    const title = asString(rec['title'])
    if (title) citation.title = title
    const siteName = asString(rec['site_name'])
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
      inputTokens: asNumber(usage?.['input_tokens']) ?? 0,
      outputTokens: asNumber(usage?.['output_tokens']) ?? 0,
      searchCalls: asNumber(usage?.['search_count']) ?? (deduped.length > 0 ? 1 : 0),
    },
    model: asString(pick(body, 'model')) ?? meta.model ?? DEFAULT_MODEL,
    latencyMs: meta.latencyMs,
    raw: body,
    ...(finishReason ? { finishReason } : {}),
  }
}

/** 通义千问适配器。 */
export class QwenEngineAdapter implements EngineAdapter {
  readonly code = 'qwen' as const

  ask(input: EngineAskInput, ctx: EngineAskContext): Promise<EngineAskOutput> {
    return runAdapter(input, ctx, buildQwenRequest, parseQwenResponse, DEFAULT_MODEL)
  }
}
