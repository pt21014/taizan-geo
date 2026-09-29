/**
 * 腾讯混元（OpenAI 兼容端点 `https://api.hunyuan.cloud.tencent.com/v1`）。
 *
 * 凭据键名（`EngineAskContext.credentials`）：
 *   - `apiKey` —— 混元控制台签发的 API Key，放 `Authorization: Bearer {apiKey}`（必填）
 * 模型走 `ctx.model`（默认 `hunyuan-turbos-latest`），网关走 `ctx.baseUrl`。
 *
 * 文档（核对日期 2026-09-13）：
 *   - OpenAI 兼容接口：https://cloud.tencent.com/document/product/1729/111007
 *   - 云 API ChatCompletions：https://cloud.tencent.com/document/product/1729/105701
 *
 * 已核对（文档明确）：兼容端点 `https://api.hunyuan.cloud.tencent.com/v1/chat/completions`
 * 在标准 OpenAI 参数之外，**明确支持一组"混元自定义参数"**，其中与联网相关的是：
 *   - `enable_enhancement`（boolean，默认 false）功能增强（如搜索）开关。
 *     文档原文："2025年04月20日 00:00:00 起，由默认开启状态转为默认关闭状态"——
 *     也就是说不显式打开就**不会联网**。
 *   - `citation`（boolean，默认 false）搜索引文角标开关，文档原文
 *     "配合 enable_enhancement 和 search_info 参数使用……对应 search_info 列表中的链接"。
 *   - `search_info`（boolean，默认 false）"在值为 true 且命中搜索时，接口会返回 search_info"。
 *   - 另有 `force_search_enhancement`（强制走 AI 搜索）、`enable_multimedia`、
 *     `enable_recommended_questions`、`enable_speed_search`，本适配器不发。
 * 所以"兼容端点拿不到引用"这个担心可以排除：**文档明确说会返回 `search_info`**。
 *
 * 为什么不走腾讯云 TC3 签名的 `ChatCompletions` 云 API：
 * TC3 那条路要 `secretId`/`secretKey` 两个凭据 + 一整套 CanonicalRequest 签名
 * （`packages/sms/src/providers/tencent-tc3.ts` 里有现成的纯函数可以抄），
 * 但它的请求/响应是**大驼峰的云 API 风格**（`Messages`/`Choices`/`SearchInfo`），
 * 与本包其余六家完全不同形。P0 先走官方同时提供的 OpenAI 兼容端点：一个 apiKey
 * 就能跑，形状和别家一致。如果后面实测发现兼容端点拿不到引用（见下条待验证），
 * 再补一个 `hunyuan-tc3.ts`，把 `EnableEnhancement` + `SearchInfo` 完整接回来。
 *
 * 待验证: `search_info` **内部的形状**。兼容接口文档只写"会返回 search_info"，
 * 没有列它的子字段；云 API 文档那边 `SearchInfo` 也只写了"搜索结果信息"，同样没有
 * 逐条列出 `SearchResults` 的字段名。本包按"云 API 的大驼峰 `SearchInfo.SearchResults`
 * 在兼容端点上转成小写蛇形 `search_info.search_results[]`，单条为 `index`/`title`/`url`"
 * 处理——**这是推断，未实测**。parse 依次尝试顶层 `search_info.search_results`、
 * `choices[0].message.search_info.search_results`、顶层 `search_results`，
 * 大驼峰与小写蛇形两套 key 都认；**都没有时用 `extractUrlsFromText` 从正文兜底**，
 * 这条兜底路径在 `hunyuan.spec.ts` 里有专门的用例。
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

const DEFAULT_BASE_URL = 'https://api.hunyuan.cloud.tencent.com/v1'
const DEFAULT_MODEL = 'hunyuan-turbos-latest'
const PATH = '/chat/completions'

/** 构造混元兼容端点请求。纯函数。 */
export function buildHunyuanRequest(input: EngineAskInput, ctx: EngineAskContext): HttpRequest {
  const apiKey = requireCredential(ctx.credentials, 'apiKey', 'hunyuan')
  const body = {
    model: ctx.model ?? DEFAULT_MODEL,
    messages: buildChatMessages(input),
    stream: false,
    // 下面三个是文档列明的"混元自定义参数"，缺一就拿不到 search_info：
    // enable_enhancement 开搜索，citation 开角标，search_info 要求把搜索结果回传
    enable_enhancement: true,
    citation: true,
    search_info: true,
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

/** 解析混元兼容端点响应。纯函数，无结构化引用时从正文兜底抽 URL。 */
export function parseHunyuanResponse(body: unknown, meta: EngineParseMeta): EngineAskOutput {
  const choice = asRecord(asArray(pick(body, 'choices'))[0])
  const text = asString(pick(choice, 'message', 'content')) ?? ''
  const finishReason = asString(choice?.['finish_reason'])

  const rawResults = [
    ...asArray(pick(body, 'search_info', 'search_results')),
    ...asArray(pick(choice, 'message', 'search_info', 'search_results')),
    ...asArray(pick(body, 'search_results')),
  ]
  const citations: EngineCitation[] = []
  for (const item of rawResults) {
    const rec = asRecord(item)
    if (!rec) continue
    // 云 API 的 SearchInfo 是大驼峰，兼容端点是小写，两种都认
    const url = asString(rec['url']) ?? asString(rec['Url'])
    if (!url) continue
    const citation: EngineCitation = { url: normalizeUrl(url) }
    const title = asString(rec['title']) ?? asString(rec['Title'])
    if (title) citation.title = title
    const siteName = asString(rec['site_name']) ?? asString(rec['SiteName'])
    if (siteName) citation.siteName = siteName
    const index = asNumber(rec['index']) ?? asNumber(rec['Index'])
    if (index !== undefined) citation.index = index
    citations.push(citation)
  }

  // 兜底：兼容端点没给引用字段时，从正文里正则抽链接（只能撑域名统计，没有标题）
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
    model: asString(pick(body, 'model')) ?? meta.model ?? DEFAULT_MODEL,
    latencyMs: meta.latencyMs,
    raw: body,
    ...(finishReason ? { finishReason } : {}),
  }
}

/** 混元适配器。 */
export class HunyuanEngineAdapter implements EngineAdapter {
  readonly code = 'hunyuan' as const

  ask(input: EngineAskInput, ctx: EngineAskContext): Promise<EngineAskOutput> {
    return runAdapter(input, ctx, buildHunyuanRequest, parseHunyuanResponse, DEFAULT_MODEL)
  }
}
