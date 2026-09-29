/**
 * LLM Provider 的统一形状。
 *
 * 这个包服务的是 GEO 里的两件事：把引擎的回答**结构化**（谁被提到了、第几位、
 * 什么情感），以及**生成 Prompt**。两件事都要求模型吐 JSON，所以 `ChatRequest`
 * 带一个 `jsonSchema` 字段，各 provider 自己决定是用原生的 JSON 模式还是只能
 * 靠提示词约束（见 `json-schema.ts`）。
 */
import type { HttpClient } from './http-client'

/** 一条对话消息。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 一次对话请求。 */
export interface ChatRequest {
  messages: ChatMessage[]
  /** 模型名；不传时用 provider 配置里的默认值。 */
  model?: string
  /**
   * 期望的 JSON Schema。给了它就表示"这次要的是结构化输出"：
   * provider 会打开原生 JSON 模式（如果支持），并把 schema 摘要拼进提示词。
   */
  jsonSchema?: JsonSchema
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

/**
 * JSON Schema 的最小子集。
 *
 * 刻意不引 `json-schema` 的完整类型：本包只用得到 `type`/`properties`/`items`/
 * `required`/`enum`/`description` 这几个关键字，引一整套类型定义只会让
 * `buildJsonSchemaHint` 看起来比它实际做的事复杂。未知关键字原样忽略。
 */
export interface JsonSchema {
  type?: string
  description?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  required?: string[]
  enum?: Array<string | number | boolean | null>
  [k: string]: unknown
}

/** 一次对话结果。 */
export interface ChatResponse {
  /** 模型输出的原始文本。 */
  text: string
  /**
   * `jsonSchema` 存在时，`parseJsonLoose(text)` 的结果。
   *
   * **解析失败时是 `undefined`，不是抛错**——上层拿到 `undefined` 可以决定重试
   * 一次、降级到关键词规则、还是把这条结果标成 FAILED；抛错会让整批分析炸掉。
   */
  json?: unknown
  usage: { inputTokens: number; outputTokens: number }
  model: string
  finishReason: string
}

/** `chat()` 的执行上下文：HTTP 客户端注入式，不由本包决定。 */
export interface LlmChatContext {
  http: HttpClient
  signal?: AbortSignal
}

/**
 * LLM Provider。
 *
 * `TConfig` 是这家 provider 特有的配置形状（baseUrl/apiKey/model 等），刻意不
 * 统一成一个大而全的配置对象——那样每加一家都要给所有家的配置类型加一个永远
 * 用不到的可选字段。
 */
export interface LlmProvider<TConfig = unknown> {
  /** provider 名，registry 按它索引，也是 `ChatAttempt.provider` 的值。 */
  readonly name: string
  chat(req: ChatRequest, cfg: TConfig, ctx: LlmChatContext): Promise<ChatResponse>
}
