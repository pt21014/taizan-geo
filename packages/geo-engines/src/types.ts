/**
 * 引擎适配器的统一契约。见《GEO-产品定义与P0范围.md》§6。
 *
 * 每家引擎的联网开关、引用字段名完全不同（见 `adapters/*`），但对上层暴露的
 * 形状必须一样：`run` 模块才能不关心具体是哪家、按 `engineCodes` 循环发起查询。
 */
import type { HttpClient } from './http-client'

/**
 * P0 引擎池。
 *
 * `openai` 指的是"OpenAI 协议兼容"这一类端点（DeepSeek / Kimi / vLLM / 自建网关
 * 都走它），不是特指 openai.com——具体打到哪由 `EngineAskContext.baseUrl` 决定。
 */
export type EngineCode =
  | 'qwen'
  | 'ernie'
  | 'hunyuan'
  | 'zhipu'
  | 'metaso'
  | 'doubao'
  | 'openai'
  | 'mock'

/** 一次提问。 */
export interface EngineAskInput {
  /** Prompt 原文，直接作为 user message 发出去。 */
  prompt: string
  /** 语言/地区，形如 `zh-CN`；部分引擎会据此调搜索地域。 */
  locale?: string
  /** 系统提示词；不传则不发 system message（GEO 场景默认不加，要的是引擎的"原生回答"）。 */
  systemPrompt?: string
  /** 本次请求的超时，优先级高于 `EngineAskContext.timeoutMs`。 */
  timeoutMs?: number
}

/** 回答里带出来的一条引用（联网搜索结果）。 */
export interface EngineCitation {
  /** 引用地址；已过 `normalizeUrl` 归一。 */
  url: string
  title?: string
  /** 站点名（通义 `site_name`、豆包 `site_name` 等有这个字段）。 */
  siteName?: string
  /** 引擎给的角标序号，从 1 开始；引擎没给就是数组下标 + 1。 */
  index?: number
  /** 摘要片段。 */
  snippet?: string
}

/** 一次提问的归一化输出。 */
export interface EngineAskOutput {
  /** 回答正文；引擎返回空回答时是空字符串，不是 undefined。 */
  text: string
  /** 引用列表；引擎不返回引用时是空数组，不是 undefined。 */
  citations: EngineCitation[]
  usage: {
    inputTokens: number
    outputTokens: number
    /** 联网搜索次数；引擎不报就按"有引用即 1、无引用即 0"估。 */
    searchCalls: number
  }
  /** 实际生效的模型名。 */
  model: string
  /** 端到端耗时（毫秒），由适配器计时，不是引擎报的。 */
  latencyMs: number
  /** 引擎原始响应，落 `GeoQueryResult` 排障用，不要直接展示给用户。 */
  raw: unknown
  finishReason?: string
}

/**
 * 适配器执行上下文。
 *
 * `credentials` 是**解密后**的整包凭据（`GeoEngine.credentialEnc` 解出来再
 * `JSON.parse`），键名由每个适配器文件顶部的常量注释约定；适配器只读自己认识
 * 的那几个键，不认识的原样忽略。
 */
export interface EngineAskContext {
  credentials: Record<string, string>
  http: HttpClient
  signal?: AbortSignal
  timeoutMs?: number
  /** 模型名 / 火山方舟的 endpoint id；不传时用适配器内置默认值。 */
  model?: string
  /** 自定义网关地址；不传时用适配器内置默认值。末尾斜杠会被去掉。 */
  baseUrl?: string
}

/** `parseXxxResponse` 的第二个参数：解析纯函数自己算不出来的那部分。 */
export interface EngineParseMeta {
  /** 端到端耗时（毫秒）。 */
  latencyMs: number
  /** 请求时用的模型名，用于响应里没回显 model 的引擎（通义、秘塔）。 */
  model?: string
}

/** 引擎适配器。实现类不持有任何状态，HTTP 客户端从 `ctx` 进来。 */
export interface EngineAdapter {
  readonly code: EngineCode
  ask(input: EngineAskInput, ctx: EngineAskContext): Promise<EngineAskOutput>
}
