/**
 * 秘塔 metaso（2026-07 上线的 Search API）。
 *
 * 凭据键名（`EngineAskContext.credentials`）：
 *   - `apiKey` —— 秘塔控制台签发的 key，放 `Authorization: Bearer {apiKey}`（必填）
 * 网关走 `ctx.baseUrl`（默认 `https://metaso.cn/api/v1`），`ctx.model` 在这里被
 * 当作 scope/模式名透传（默认 `webpage`）。
 *
 * 文档（核对日期 2026-09-13）：
 *   - API Key 与产品页：https://metaso.cn/search-api/api-keys
 *   - 在线调试台（会按当前配置生成请求代码）：https://metaso.cn/search-api/playground
 *
 * `https://metaso.cn/search-api/docs` 这个路径**是 404**，秘塔没有对外的静态文档页；
 * 能核对的一手材料是调试台自己生成的请求代码（页面 chunk
 * `app/(pages)/(menu-attached)/search-api/playground/page-*.js`），以下按它核对：
 *
 * 已核对（来自官方调试台生成的请求）：
 *   - 三个端点：`POST /api/v1/search`（搜索）、`POST /api/v1/reader`（读网页）、
 *     `POST /api/v1/chat/completions`（问答）。本适配器用第一个。
 *   - 请求体字段：`q`、`scope`、`size` 与 `page` 二选一、`includeSummary`、
 *     `includeRawContent`（仅 `scope=webpage` 时发）、`conciseSnippet`。
 *   - `scope` 的合法取值是 `webpage` / `document` / `scholar` / `image` / `video` /
 *     `podcast` 六个（调试台的下拉项，见 `SCOPES`）。
 *   - 鉴权 `Authorization: Bearer {apiKey}`。
 *
 * 秘塔与其余六家不同：它本质是一个**带 AI 总结的搜索 API**，不是 chat API。
 * 我们要的恰好就是"一个问题 → 一段带引用的回答"，所以把 `q` 当 prompt 发、
 * 把 summary 当 `text`、把网页列表当 citations，对齐 `EngineAskOutput`。
 *
 * 待验证: **响应体没有一手文档**（响应形状只在调试台实际请求后渲染，抓不到静态样例）。
 * 第三方集成（官方 MCP server 的封装与多个开源客户端）一致地描述为顶层
 * `{ credits, total, webpages: [{ title, link, snippet, score, date, content }] }`，
 * fixture 按这个形状写，但**未实测**。parse 因此保留多路兜底：
 *   - 正文依次尝试 `summary` / `data.summary` / `answer` / `data.answer` / `markdown`；
 *   - 列表依次尝试 `webpages` / `data.webpages` / `references` / `data.references` /
 *     `results` / `data.results`，单条里 url 认 `link` 与 `url` 两种写法。
 * 都取不到时用 `extractUrlsFromText` 从正文兜底，整次查询不会因此失败。
 * 待验证: `includeSummary=true` 时总结放在响应的哪个 key 上，同样没有一手样例。
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
  pick,
  requireCredential,
  runAdapter,
  trimBaseUrl,
} from './shared'

const DEFAULT_BASE_URL = 'https://metaso.cn/api/v1'
const DEFAULT_SCOPE = 'webpage'
const PATH = '/search'

/** 调试台下拉里的六个合法 scope。传进来的值不在里面时退回 `webpage`。 */
const SCOPES = new Set(['webpage', 'document', 'scholar', 'image', 'video', 'podcast'])

/** 构造秘塔 Search API 请求。纯函数。 */
export function buildMetasoRequest(input: EngineAskInput, ctx: EngineAskContext): HttpRequest {
  const apiKey = requireCredential(ctx.credentials, 'apiKey', 'metaso')
  // 秘塔没有 system message 的概念，系统提示只能拼进问题里
  const q = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt
  // ctx.model 在秘塔这里当 scope 用；非法值直接退回 webpage，别把 400 留到线上
  const requested = ctx.model ?? DEFAULT_SCOPE
  const scope = SCOPES.has(requested) ? requested : DEFAULT_SCOPE
  const body: Record<string, unknown> = {
    q,
    scope,
    size: 10,
    includeSummary: true,
    conciseSnippet: false,
  }
  // 调试台只在 scope=webpage 时才发 includeRawContent，照抄
  if (scope === 'webpage') body['includeRawContent'] = false
  return {
    url: `${trimBaseUrl(ctx.baseUrl ?? DEFAULT_BASE_URL)}${PATH}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  }
}

/** 从一堆候选位置里挑第一个非空字符串。 */
function firstText(body: unknown): string {
  return (
    asString(pick(body, 'summary')) ??
    asString(pick(body, 'data', 'summary')) ??
    asString(pick(body, 'answer')) ??
    asString(pick(body, 'data', 'answer')) ??
    asString(pick(body, 'markdown')) ??
    ''
  )
}

/** 从一堆候选位置里挑第一个非空数组。 */
function firstResults(body: unknown): unknown[] {
  for (const path of [
    ['webpages'],
    ['data', 'webpages'],
    ['references'],
    ['data', 'references'],
    ['results'],
    ['data', 'results'],
  ]) {
    const arr = asArray(pick(body, ...path))
    if (arr.length > 0) return arr
  }
  return []
}

/** 解析秘塔响应。纯函数；字段位置全是待验证项，所以每一处都做了多路兜底。 */
export function parseMetasoResponse(body: unknown, meta: EngineParseMeta): EngineAskOutput {
  const text = firstText(body)

  const citations: EngineCitation[] = []
  firstResults(body).forEach((item, i) => {
    const rec = asRecord(item)
    if (!rec) return
    const url = asString(rec['link']) ?? asString(rec['url'])
    if (!url) return
    const citation: EngineCitation = { url: normalizeUrl(url) }
    const title = asString(rec['title'])
    if (title) citation.title = title
    const siteName = asString(rec['authors']) ?? asString(rec['source'])
    if (siteName) citation.siteName = siteName
    const snippet = asString(rec['snippet']) ?? asString(rec['content'])
    if (snippet) citation.snippet = snippet.slice(0, 500)
    citation.index = asNumber(rec['position']) ?? i + 1
    citations.push(citation)
  })

  const deduped = citations.length > 0 ? dedupeCitations(citations) : extractUrlsFromText(text)

  // 秘塔按次计费，没有 token 账；credits 只在部分响应里有，取不到就记 0
  const credits = asNumber(pick(body, 'credits')) ?? asNumber(pick(body, 'data', 'credits')) ?? 0
  return {
    text,
    citations: deduped,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      searchCalls: credits > 0 ? credits : 1,
    },
    model: meta.model ?? DEFAULT_SCOPE,
    latencyMs: meta.latencyMs,
    raw: body,
  }
}

/** 秘塔适配器。 */
export class MetasoEngineAdapter implements EngineAdapter {
  readonly code = 'metaso' as const

  ask(input: EngineAskInput, ctx: EngineAskContext): Promise<EngineAskOutput> {
    return runAdapter(input, ctx, buildMetasoRequest, parseMetasoResponse, DEFAULT_SCOPE)
  }
}
