/**
 * 引擎错误的统一分类。
 *
 * 为什么要分类而不是直接把厂商的错误往上抛：`run` 模块要靠 `retryable` 决定
 * 这条 job 是重试还是直接落 FAILED。把"密钥错了"当成可重试，会在每条 Prompt
 * 上白烧 6 次退避；把"限流"当成不可重试，会让一次批量跑出一堆假失败。
 */

/** 错误类别。 */
export type EngineErrorKind =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'CONTENT_FILTER'
  | 'UPSTREAM'
  | 'PARSE'

/** 构造 {@link EngineError} 的可选项。 */
export interface EngineErrorOptions {
  retryable?: boolean
  /** 上游 HTTP 状态码；网络层失败没有状态码时不填。 */
  upstreamStatus?: number
  cause?: unknown
}

/** 每类错误默认是否可重试。`classifyHttpError` 与构造函数共用这一份。 */
const DEFAULT_RETRYABLE: Record<EngineErrorKind, boolean> = {
  AUTH: false,
  RATE_LIMIT: true,
  TIMEOUT: true,
  CONTENT_FILTER: false,
  UPSTREAM: true,
  PARSE: false,
}

/** 引擎调用失败。适配器只抛这一种错误，不把厂商 SDK 的异常漏上去。 */
export class EngineError extends Error {
  readonly kind: EngineErrorKind
  readonly retryable: boolean
  readonly upstreamStatus?: number
  /** 覆盖 ES2022 的 `Error.cause`，显式声明以便在 d.ts 里可见。 */
  readonly cause?: unknown

  constructor(kind: EngineErrorKind, message: string, options: EngineErrorOptions = {}) {
    super(message)
    this.name = 'EngineError'
    this.kind = kind
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[kind]
    if (options.upstreamStatus !== undefined) this.upstreamStatus = options.upstreamStatus
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** 判断一个未知异常是不是 `EngineError`（跨 bundle 时 instanceof 不一定可靠，兼看 name）。 */
export function isEngineError(e: unknown): e is EngineError {
  return e instanceof EngineError || (e instanceof Error && e.name === 'EngineError')
}

/**
 * 内容审核类错误的特征串。
 *
 * 各家的表达完全不统一：通义是 `DataInspectionFailed`，千帆文心的错误码在
 * 336xxx 段且 message 里带"内容审核"，混元是 `SensitiveContent`，OpenAI 协议
 * 一族是 `content_filter`。这里按**响应体里出现的特征串**判定，比按状态码判定
 * 靠谱——内容审核在各家的状态码从 200 到 400 到 451 都有。
 */
const CONTENT_FILTER_MARKERS = [
  'datainspectionfailed',
  'data_inspection_failed',
  'content_filter',
  'contentfilter',
  'sensitivecontent',
  'sensitive_content',
  'content_policy',
  'risk_control',
  '内容审核',
  '敏感',
  '违规',
]

/** 限流类错误的特征串（用于状态码撒谎成 200/400 的引擎）。 */
const RATE_LIMIT_MARKERS = [
  'throttling',
  'rate_limit',
  'ratelimit',
  'rate limit',
  'requestlimitexceeded',
  'too many requests',
  'qps',
  '限流',
  '请求过于频繁',
]

/** 鉴权类错误的特征串。 */
const AUTH_MARKERS = [
  'invalidapikey',
  'invalid_api_key',
  'invalid api key',
  'authenticationerror',
  'unauthorized',
  'authfailure',
  'accessdenied',
  'permission',
  '鉴权',
  '密钥',
]

function hit(haystack: string, markers: string[]): boolean {
  return markers.some((m) => haystack.includes(m))
}

/**
 * 把一次失败的 HTTP 响应归类成 {@link EngineError}。纯函数，不发请求、不看时钟。
 *
 * 判定顺序刻意是"先看 body 特征串，再看状态码"：内容审核被拒是不可重试的，
 * 但它在千帆会以 HTTP 200 + 业务错误码返回、在别家会以 400 返回——只看状态码
 * 会把它误判成"参数错了"（不可重试，碰巧对）或"服务端抖动"（可重试，会白烧 6 次）。
 *
 * @param status - HTTP 状态码；网络层失败（连不上/超时前的 reset）传 0
 * @param body - 响应体原文（不要求是合法 JSON，串匹配即可）
 */
export function classifyHttpError(status: number, body: string): EngineError {
  const lower = (body ?? '').toLowerCase()
  const snippet = (body ?? '').slice(0, 500)

  if (hit(lower, CONTENT_FILTER_MARKERS)) {
    return new EngineError('CONTENT_FILTER', `引擎内容审核拒绝（HTTP ${status}）：${snippet}`, {
      upstreamStatus: status,
    })
  }
  if (status === 429 || hit(lower, RATE_LIMIT_MARKERS)) {
    return new EngineError('RATE_LIMIT', `引擎限流（HTTP ${status}）：${snippet}`, {
      upstreamStatus: status,
    })
  }
  if (status === 401 || status === 403) {
    return new EngineError('AUTH', `引擎鉴权失败（HTTP ${status}）：${snippet}`, {
      upstreamStatus: status,
    })
  }
  if (status === 408 || status === 504) {
    return new EngineError('TIMEOUT', `引擎超时（HTTP ${status}）：${snippet}`, {
      upstreamStatus: status,
    })
  }
  if (hit(lower, AUTH_MARKERS)) {
    return new EngineError('AUTH', `引擎鉴权失败（HTTP ${status}）：${snippet}`, {
      upstreamStatus: status,
    })
  }
  if (status === 0 || status >= 500) {
    // status 0 = 网络层失败（DNS/连接重置），与 5xx 同样按上游故障处理，可重试。
    return new EngineError('UPSTREAM', `引擎上游故障（HTTP ${status}）：${snippet}`, {
      upstreamStatus: status,
    })
  }
  // 其余 4xx：参数错、模型不存在、余额不足……重试解决不了，归 UPSTREAM 但标不可重试。
  return new EngineError('UPSTREAM', `引擎请求被拒绝（HTTP ${status}）：${snippet}`, {
    retryable: false,
    upstreamStatus: status,
  })
}
