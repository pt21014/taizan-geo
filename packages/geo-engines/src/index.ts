/**
 * `@taizan/geo-engines`：GEO 引擎适配器契约 + registry + 错误分类 + 引用归一化。
 *
 * 零框架依赖，不 import 任何 `@nestjs/*` 或 `@prisma/client`；HTTP 一律走调用方
 * 注入的 {@link HttpClient}，本包不 import axios、也不直接用全局 `fetch`——这样
 * `buildXxxRequest` / `parseXxxResponse` 这些纯函数可以在裸 node 环境里对着官方
 * 文档的样例响应跑单测，不必真的花钱发一次请求。
 *
 * 最小用法：
 *
 * ```ts
 * import { EngineRegistry, QwenEngineAdapter, ZhipuEngineAdapter } from '@taizan/geo-engines'
 *
 * const registry = new EngineRegistry()
 *   .register(new QwenEngineAdapter())
 *   .register(new ZhipuEngineAdapter())
 *
 * const out = await registry.get('qwen').ask(
 *   { prompt: '国内做 GEO 监测的工具有哪些？' },
 *   { credentials: { apiKey: 'sk-xxx' }, http: httpClient, timeoutMs: 30_000 },
 * )
 * // out.citations 已按 normalizeUrl 归一并去重，out.usage 供计费用
 * ```
 *
 * @packageDocumentation
 */
export type { HttpClient, HttpRequest, HttpRequestOptions, HttpResponse } from './http-client'
export type {
  EngineAdapter,
  EngineAskContext,
  EngineAskInput,
  EngineAskOutput,
  EngineCitation,
  EngineCode,
  EngineParseMeta,
} from './types'
export {
  classifyHttpError,
  EngineError,
  isEngineError,
  type EngineErrorKind,
  type EngineErrorOptions,
} from './errors'
export { dedupeCitations, domainOf, extractUrlsFromText, normalizeUrl } from './citation'
export { EngineRegistry } from './registry'

export { buildQwenRequest, parseQwenResponse, QwenEngineAdapter } from './adapters/qwen'
export { buildErnieRequest, ErnieEngineAdapter, parseErnieResponse } from './adapters/ernie'
export {
  buildHunyuanRequest,
  HunyuanEngineAdapter,
  parseHunyuanResponse,
} from './adapters/hunyuan'
export { buildZhipuRequest, parseZhipuResponse, ZhipuEngineAdapter } from './adapters/zhipu'
export { buildMetasoRequest, MetasoEngineAdapter, parseMetasoResponse } from './adapters/metaso'
export { buildDoubaoRequest, DoubaoEngineAdapter, parseDoubaoResponse } from './adapters/doubao'
export {
  buildOpenAiRequest,
  OpenAiCompatibleEngineAdapter,
  parseOpenAiResponse,
} from './adapters/openai-compatible'
export {
  buildOpenAiResponsesRequest,
  OpenAiResponsesEngineAdapter,
  parseOpenAiResponsesResponse,
} from './adapters/openai-responses'
export {
  collectResponsesCitations,
  collectResponsesFinishReason,
  collectResponsesSearchCalls,
  collectResponsesText,
} from './adapters/responses-api'
export {
  assertMockNotInProd,
  buildMockAnswer,
  MOCK_SCENARIOS,
  MockEngineAdapter,
  type MockScenario,
  type MockSettings,
  type ProdCheckEnv,
} from './adapters/mock'
