/**
 * OpenAI **Responses API** 形状的取值助手（`output[]` / `annotations[]`）。
 *
 * 为什么单独抽一个文件：火山方舟的联网搜索工具与 OpenAI 官方的 `web_search` 工具
 * 用的是**同一套 Responses 协议**（方舟文档原文：「兼容 OpenAI Responses 接口
 * 协议」），响应里 `output[] → message → content[] → annotations[]` 的层级、
 * `url_citation` 的 type 值都一模一样。两家各抄一遍这段遍历，就意味着以后
 * 「annotations 多一个字段」要改两个地方。
 *
 * 与 chat/completions 的区别（这也是为什么不能复用 `openai-compatible.ts`）：
 *   - 请求：`input` 取代 `messages`；工具在 `tools: [{ type: 'web_search' }]`。
 *   - 响应：没有 `choices`，正文在 `output[].content[].text`，引用在
 *     `content[].annotations[]`（**不是** chat/completions 那种
 *     `message.annotations[].url_citation` 的再嵌套一层）。
 *   - usage：`input_tokens` / `output_tokens`（chat 那边是
 *     `prompt_tokens` / `completion_tokens`）。
 *
 * 文档（核对日期 2026-09-13）：
 *   - OpenAI：https://developers.openai.com/api/docs/guides/tools-web-search
 *   - 火山方舟：https://www.volcengine.com/docs/82379/1756990
 *
 * 全是纯函数。
 */
import { normalizeUrl } from '../citation'
import type { EngineCitation } from '../types'
import { asArray, asNumber, asRecord, asString, pick } from './shared'

/** `output[]` 里 `type === 'message'` 的那些条目的 `content[]` 拍平。 */
function messageContents(body: unknown): unknown[] {
  const out: unknown[] = []
  for (const item of asArray(pick(body, 'output'))) {
    const rec = asRecord(item)
    if (!rec || asString(rec['type']) !== 'message') continue
    out.push(...asArray(rec['content']))
  }
  return out
}

/**
 * 正文：把 `output[]` 里所有 message 的 `output_text` 拼起来。
 *
 * 拼而不是取第一条：一次响应里可以有多个 message（模型先答一段、搜完再补一段），
 * 只取第一条会把后半截答案丢掉，而 GEO 统计的正是"整段回答里提没提到品牌"。
 * 顶层 `output_text`（部分 SDK 会补这个便利字段）优先用。
 */
export function collectResponsesText(body: unknown): string {
  const convenience = asString(pick(body, 'output_text'))
  if (convenience) return convenience
  const parts: string[] = []
  for (const c of messageContents(body)) {
    const rec = asRecord(c)
    if (!rec) continue
    const type = asString(rec['type'])
    // output_text 是文档里的类型名；type 缺失时只要有 text 就当正文用
    if (type !== undefined && type !== 'output_text') continue
    const text = asString(rec['text'])
    if (text) parts.push(text)
  }
  return parts.join('\n')
}

/**
 * 引用：`output[].content[].annotations[]` 里 `type === 'url_citation'` 的条目。
 *
 * 字段取值按两家文档的并集：`url` / `title` 两家都有；`site_name`、`publish_time`、
 * `summary` 只有火山方舟给（OpenAI 那边是 `start_index` / `end_index`），多出来的
 * 字段取不到就不写，不影响解析。
 */
export function collectResponsesCitations(body: unknown): EngineCitation[] {
  const citations: EngineCitation[] = []
  for (const c of messageContents(body)) {
    for (const ann of asArray(asRecord(c)?.['annotations'])) {
      const rec = asRecord(ann)
      if (!rec) continue
      const type = asString(rec['type'])
      if (type !== undefined && type !== 'url_citation') continue
      // OpenAI 的 chat/completions 会把内容再套一层 url_citation，Responses 不会；
      // 两种都认，免得调用方把两条协议的响应喂错了就丢引用
      const inner = asRecord(rec['url_citation']) ?? rec
      const url = asString(inner['url'])
      if (!url) continue
      const citation: EngineCitation = { url: normalizeUrl(url) }
      const title = asString(inner['title'])
      if (title) citation.title = title
      const siteName = asString(inner['site_name'])
      if (siteName) citation.siteName = siteName
      const snippet = asString(inner['summary'])
      if (snippet) citation.snippet = snippet.slice(0, 500)
      citations.push(citation)
    }
  }
  return citations
}

/**
 * 联网搜索次数。
 *
 * 优先用方舟的 `usage.tool_usage.web_search`（文档明确："显示 Responses API 中
 * 工具的总调用次数"），没有就数 `output[]` 里 `web_search_call` 条目的个数——
 * OpenAI 不报 tool_usage，但两家都会把每次搜索作为一个 `web_search_call` 落在
 * `output[]` 里。
 */
export function collectResponsesSearchCalls(body: unknown): number | undefined {
  const reported = asNumber(pick(body, 'usage', 'tool_usage', 'web_search'))
  if (reported !== undefined) return reported
  let n = 0
  for (const item of asArray(pick(body, 'output'))) {
    if (asString(asRecord(item)?.['type']) === 'web_search_call') n += 1
  }
  return n > 0 ? n : undefined
}

/**
 * 结束原因。Responses 没有 `finish_reason`，顶层 `status` 是
 * `completed` / `incomplete` / `failed`；`incomplete` 时真正的原因在
 * `incomplete_details.reason`。
 */
export function collectResponsesFinishReason(body: unknown): string | undefined {
  return asString(pick(body, 'incomplete_details', 'reason')) ?? asString(pick(body, 'status'))
}
