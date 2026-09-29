/**
 * 通义 DashScope 原生协议 provider。
 *
 * 配置（`DashScopeConfig`）：
 *   - `apiKey`  —— 百炼 API-KEY，放 `Authorization: Bearer {apiKey}`（必填）
 *   - `model`   —— 默认模型名，如 `qwen-plus`（必填；`ChatRequest.model` 可逐次覆盖）
 *   - `baseUrl` —— 可选，默认 `https://dashscope.aliyuncs.com`
 *
 * 端点：`/api/v1/services/aigc/text-generation/generation`，
 * `parameters.result_format = 'message'`。
 *
 * 字段核对（2026-09-13，对着 https://help.aliyun.com/zh/model-studio/web-search
 * 的 DashScope 原生协议小节）：`result_format` / `incremental_output` /
 * `temperature` / `max_tokens` 都在**请求体的 `parameters` 下**（不是顶层）；
 * `result_format:'message'` 时正文在 `output.choices[0].message.content`、
 * 结束原因在 `output.choices[0].finish_reason`；`usage` 是
 * `input_tokens` / `output_tokens` / `total_tokens`。均与本文件实现一致。
 *
 * 为什么单独做一个原生 provider 而不是复用 OpenAI 兼容端点：DashScope 原生协议
 * 的请求/响应是 `input` + `parameters` / `output` 两段式，与 OpenAI 完全不同形；
 * 而 `@taizan/geo-engines` 的通义适配器走的也是原生协议——两个包的通义部分形状
 * 一致，排障时不用在脑子里切换两套字段名。
 *
 * JSON 输出：DashScope 原生这条路上 `response_format` 的支持不稳定，这里**只靠
 * 提示词**约束（`buildJsonSchemaHint`），解析交给 `parseJsonLoose` 兜底。
 */
import { parseJsonLoose } from '../json-schema'
import type { HttpRequest } from '../http-client'
import type { ChatRequest, ChatResponse, LlmChatContext, LlmProvider } from '../types'
import { asArray, asNumber, asRecord, asString, pick, trimBaseUrl } from './shared'
import { withSchemaHint } from './openai-compatible'

/** DashScope 原生协议的配置。 */
export interface DashScopeConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com'
const PATH = '/api/v1/services/aigc/text-generation/generation'

/** 构造 DashScope 原生请求。纯函数。 */
export function buildDashScopeRequest(req: ChatRequest, cfg: DashScopeConfig): HttpRequest {
  if (!cfg?.apiKey) throw new Error('[@taizan/llm] dashscope 配置缺少 apiKey')
  const model = req.model ?? cfg.model
  if (!model) throw new Error('[@taizan/llm] dashscope 配置缺少 model')

  const parameters: Record<string, unknown> = {
    result_format: 'message',
    incremental_output: false,
  }
  if (req.temperature !== undefined) parameters['temperature'] = req.temperature
  if (req.maxTokens !== undefined) parameters['max_tokens'] = req.maxTokens

  const body = {
    model,
    input: { messages: withSchemaHint(req.messages, req) },
    parameters,
  }

  return {
    url: `${trimBaseUrl(cfg.baseUrl ?? DEFAULT_BASE_URL)}${PATH}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }
}

/** 解析 DashScope 原生响应。纯函数，对缺字段健壮。 */
export function parseDashScopeResponse(
  body: unknown,
  req: ChatRequest,
  fallbackModel: string,
): ChatResponse {
  const output = asRecord(pick(body, 'output'))
  const choice = asRecord(asArray(output?.['choices'])[0])
  // result_format=message 走 choices；老的 text 格式直接在 output.text 上
  const text = asString(pick(choice, 'message', 'content')) ?? asString(output?.['text']) ?? ''
  const usage = asRecord(pick(body, 'usage'))

  const res: ChatResponse = {
    text,
    usage: {
      inputTokens: asNumber(usage?.['input_tokens']) ?? 0,
      outputTokens: asNumber(usage?.['output_tokens']) ?? 0,
    },
    model: asString(pick(body, 'model')) ?? req.model ?? fallbackModel,
    finishReason:
      asString(choice?.['finish_reason']) ?? asString(output?.['finish_reason']) ?? 'unknown',
  }
  if (req.jsonSchema) {
    const json = parseJsonLoose(text)
    if (json !== undefined) res.json = json
  }
  return res
}

/** 通义 DashScope 原生 provider。 */
export class DashScopeLlmProvider implements LlmProvider<DashScopeConfig> {
  readonly name = 'dashscope'

  async chat(req: ChatRequest, cfg: DashScopeConfig, ctx: LlmChatContext): Promise<ChatResponse> {
    const httpReq = buildDashScopeRequest(req, cfg)
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
    return parseDashScopeResponse(parsed, req, cfg.model)
  }
}
