/**
 * `@taizan/llm`：LLM Provider 接口 + registry（主/备自动切换）+ JSON Schema
 * 提示词与脏输出解析 + mock 兜底。
 *
 * 零框架依赖，不 import 任何 `@nestjs/*` 或 `@prisma/client`；HTTP 一律走调用方
 * 注入的 {@link HttpClient}，本包不 import axios、也不直接用全局 `fetch`。
 *
 * 最小用法：
 *
 * ```ts
 * import { LlmProviderRegistry, MockLlmProvider, OpenAiCompatibleLlmProvider } from '@taizan/llm'
 *
 * const registry = new LlmProviderRegistry()
 *   .register(new OpenAiCompatibleLlmProvider())
 *   .register(new MockLlmProvider())
 *
 * const { response, attempts } = await registry.chatWithFallback(
 *   { messages: [{ role: 'user', content: '...' }], jsonSchema: MENTION_SCHEMA },
 *   { 'openai-compatible': { baseUrl, apiKey, model }, mock: {} },
 *   ['openai-compatible', 'mock'],
 *   { http: httpClient },
 * )
 * // response.json 解析失败时是 undefined，不抛——调用方决定重试还是降级
 * ```
 *
 * @packageDocumentation
 */
export type { HttpClient, HttpRequest, HttpRequestOptions, HttpResponse } from './http-client'
export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  JsonSchema,
  LlmChatContext,
  LlmProvider,
} from './types'
export {
  buildJsonSchemaHint,
  parseJsonLoose,
  repairTruncated,
  stripCodeFence,
} from './json-schema'
export { LlmProviderRegistry, type ChatAttempt, type ChatOutcome } from './registry'

/**
 * 分析任务的 JSON Schema 常量。它是 provider 侧的契约（渲染提示词 + 解析脏输出
 * 都在本包内），所以住在本包而不是调用它的 Nest handler 里——理由见 `schemas.ts`。
 */
export { MENTION_SCHEMA } from './schemas'

export {
  buildOpenAiChatRequest,
  OpenAiCompatibleLlmProvider,
  parseOpenAiChatResponse,
  withSchemaHint,
  type OpenAiCompatibleConfig,
} from './providers/openai-compatible'
export {
  buildDashScopeRequest,
  DashScopeLlmProvider,
  parseDashScopeResponse,
  type DashScopeConfig,
} from './providers/dashscope'
export {
  assertMockNotInProd,
  buildMockJson,
  buildMockPrompts,
  joinMessages,
  MOCK_LLM_SCENARIOS,
  MockLlmProvider,
  type MockGeneratedPrompt,
  type MockLlmConfig,
  type MockLlmScenario,
  type MockMention,
  type ProdCheckEnv,
} from './providers/mock'
