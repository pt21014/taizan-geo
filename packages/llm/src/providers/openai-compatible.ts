/**
 * OpenAI 协议兼容 provider（DeepSeek / Kimi / 智谱 / vLLM / 自建网关 / openai.com）。
 *
 * 配置（`OpenAiCompatibleConfig`）：
 *   - `baseUrl` —— 形如 `https://api.deepseek.com/v1`（必填）
 *   - `apiKey`  —— 放 `Authorization: Bearer {apiKey}`（必填）
 *   - `model`   —— 默认模型名（必填；`ChatRequest.model` 可以逐次覆盖）
 *
 * `jsonSchema` 存在时打开 `response_format: { type: 'json_object' }`，并把
 * `buildJsonSchemaHint(schema)` 追加到 system message 末尾。
 *
 * 字段核对（2026-09-13，对着 https://developers.openai.com/api/docs/ 的
 * chat/completions）：`response_format: { type: 'json_object' }` 与
 * `{ type: 'json_schema', json_schema: { name, schema } }` 两种写法的字段名都对；
 * 响应正文在 `choices[0].message.content`、结束原因在 `choices[0].finish_reason`、
 * `usage` 是 `prompt_tokens` / `completion_tokens`。均与本文件实现一致。
 * 注意这里**没有也不需要** `tools: [{ type: 'web_search' }]`——那个工具只存在于
 * Responses API，本包不联网，联网那条路在 `@taizan/geo-engines` 里。
 *
 * 为什么不用 `{ type: 'json_schema', json_schema: {...} }`（更强的那个模式）：
 * 只有少数几家支持，其余家收到会直接 400。`json_object` 是这一族里**普遍支持**
 * 的最大公约数，schema 的约束靠提示词补——反正 `parseJsonLoose` 本来就要兜住
 * 模型不听话的情况。想用强模式的端点，在配置里加 `strictJsonSchema: true`。
 */
import { buildJsonSchemaHint, parseJsonLoose } from '../json-schema'
import type { HttpRequest } from '../http-client'
import type { ChatMessage, ChatRequest, ChatResponse, LlmChatContext, LlmProvider } from '../types'
import { asArray, asNumber, asRecord, asString, pick, trimBaseUrl } from './shared'

/** OpenAI 协议兼容端点的配置。 */
export interface OpenAiCompatibleConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 端点支持 `response_format: { type: 'json_schema' }` 时置 true，默认走 `json_object`。 */
  strictJsonSchema?: boolean
}

const PATH = '/chat/completions'

/** 把 schema 提示拼进 messages：有 system 就追加，没有就插一条。纯函数。 */
export function withSchemaHint(messages: ChatMessage[], req: ChatRequest): ChatMessage[] {
  if (!req.jsonSchema) return messages
  const hint = buildJsonSchemaHint(req.jsonSchema)
  const idx = messages.findIndex((m) => m.role === 'system')
  if (idx < 0) return [{ role: 'system', content: hint }, ...messages]
  return messages.map((m, i) =>
    i === idx ? { ...m, content: `${m.content}\n\n${hint}` } : m,
  )
}

/** 构造 OpenAI 协议 chat 请求。纯函数。 */
export function buildOpenAiChatRequest(
  req: ChatRequest,
  cfg: OpenAiCompatibleConfig,
): HttpRequest {
  if (!cfg?.baseUrl) throw new Error('[@taizan/llm] openai-compatible 配置缺少 baseUrl')
  if (!cfg?.apiKey) throw new Error('[@taizan/llm] openai-compatible 配置缺少 apiKey')
  const model = req.model ?? cfg.model
  if (!model) throw new Error('[@taizan/llm] openai-compatible 配置缺少 model')

  const body: Record<string, unknown> = {
    model,
    messages: withSchemaHint(req.messages, req),
    stream: false,
  }
  if (req.temperature !== undefined) body['temperature'] = req.temperature
  if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens
  if (req.jsonSchema) {
    body['response_format'] = cfg.strictJsonSchema
      ? { type: 'json_schema', json_schema: { name: 'result', schema: req.jsonSchema } }
      : { type: 'json_object' }
  }

  return {
    url: `${trimBaseUrl(cfg.baseUrl)}${PATH}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }
}

/** 解析 OpenAI 协议响应。纯函数，对缺字段健壮。 */
export function parseOpenAiChatResponse(
  body: unknown,
  req: ChatRequest,
  fallbackModel: string,
): ChatResponse {
  const choice = asRecord(asArray(pick(body, 'choices'))[0])
  const text = asString(pick(choice, 'message', 'content')) ?? ''
  const usage = asRecord(pick(body, 'usage'))
  const res: ChatResponse = {
    text,
    usage: {
      inputTokens: asNumber(usage?.['prompt_tokens']) ?? 0,
      outputTokens: asNumber(usage?.['completion_tokens']) ?? 0,
    },
    model: asString(pick(body, 'model')) ?? req.model ?? fallbackModel,
    finishReason: asString(choice?.['finish_reason']) ?? 'unknown',
  }
  if (req.jsonSchema) {
    const json = parseJsonLoose(text)
    // 解析不出来时刻意不写这个字段：调用方用 `'json' in res` 或 `res.json === undefined`
    // 都能判断，而不是拿到一个 null 分不清是"模型真返回了 null"还是"解析失败"
    if (json !== undefined) res.json = json
  }
  return res
}

/** OpenAI 协议兼容 provider。 */
export class OpenAiCompatibleLlmProvider implements LlmProvider<OpenAiCompatibleConfig> {
  readonly name = 'openai-compatible'

  async chat(
    req: ChatRequest,
    cfg: OpenAiCompatibleConfig,
    ctx: LlmChatContext,
  ): Promise<ChatResponse> {
    const httpReq = buildOpenAiChatRequest(req, cfg)
    const res = await ctx.http.request(httpReq, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
    })
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `[@taizan/llm] ${this.name} 返回 HTTP ${res.status}：${(res.body ?? '').slice(0, 300)}`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(res.body) as unknown
    } catch {
      throw new Error(
        `[@taizan/llm] ${this.name} 响应不是合法 JSON：${(res.body ?? '').slice(0, 300)}`,
      )
    }
    return parseOpenAiChatResponse(parsed, req, cfg.model)
  }
}
