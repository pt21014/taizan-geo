/**
 * 适配器共用的取值助手与执行骨架。
 *
 * 抽出来的理由：七家适配器的 `ask()` 方法体一模一样（计时 → build → 发请求 →
 * 非 2xx 归类 → JSON.parse → parse），差别全在两个纯函数里。七份复制粘贴的
 * `ask()` 意味着"给所有引擎加一条超时处理"要改七个地方。
 *
 * 取值助手（`asRecord` / `asArray` / `asString` / `asNumber`）的存在是为了让
 * `parseXxxResponse` 能对着**可能缺任何字段**的响应体写：引擎的响应不是我们的
 * 契约，少一个 `usage` 字段不该让整次查询失败。
 */
import { classifyHttpError, EngineError, isEngineError } from '../errors'
import type { HttpRequest } from '../http-client'
import type { EngineAskContext, EngineAskInput, EngineAskOutput, EngineParseMeta } from '../types'

/** 未知值 → 普通对象；不是对象（含 null、数组）时返回 undefined。 */
export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** 未知值 → 数组；不是数组时返回空数组（调用方可以直接 for..of）。 */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** 未知值 → 非空字符串；不是字符串或是空串时返回 undefined。 */
export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** 未知值 → 有限数字；`NaN`/`Infinity`/非数字返回 undefined。 */
export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 顺着一串 key 往下取，中途断了就返回 undefined。 */
export function pick(root: unknown, ...path: string[]): unknown {
  let cur: unknown = root
  for (const key of path) {
    const rec = asRecord(cur)
    if (!rec) return undefined
    cur = rec[key]
  }
  return cur
}

/** 去掉 baseUrl 末尾的斜杠，避免拼出 `https://x.com//v1/chat`。 */
export function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/** 从 `credentials` 里取必填键，缺了直接按 AUTH 抛——比发出去被 401 再回来快。 */
export function requireCredential(
  credentials: Record<string, string>,
  key: string,
  engine: string,
): string {
  const v = credentials?.[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new EngineError('AUTH', `[${engine}] 凭据缺少 "${key}"，请在平台后台补齐引擎凭据`)
  }
  return v.trim()
}

/** OpenAI 协议一族共用的 messages 构造。 */
export function buildChatMessages(
  input: EngineAskInput,
): Array<{ role: 'system' | 'user'; content: string }> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = []
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt })
  messages.push({ role: 'user', content: input.prompt })
  return messages
}

/** JSON.parse 一个响应体；失败按 PARSE 抛（不可重试——同样的响应重试一百次还是这个）。 */
export function parseJsonBody(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch (cause) {
    throw new EngineError('PARSE', `引擎响应不是合法 JSON：${(raw ?? '').slice(0, 300)}`, { cause })
  }
}

/**
 * 七家适配器 `ask()` 的共同骨架。
 *
 * 超时的语义：`input.timeoutMs` 优先于 `ctx.timeoutMs`，两者都没有就交给
 * `HttpClient` 实现自己的默认值——本包不自己起定时器，因为真正要被取消的是
 * 底层那个 socket，只有 HttpClient 实现拿得到它。
 */
export async function runAdapter(
  input: EngineAskInput,
  ctx: EngineAskContext,
  build: (input: EngineAskInput, ctx: EngineAskContext) => HttpRequest,
  parse: (body: unknown, meta: EngineParseMeta) => EngineAskOutput,
  fallbackModel: string,
): Promise<EngineAskOutput> {
  const req = build(input, ctx)
  const timeoutMs = input.timeoutMs ?? ctx.timeoutMs
  const startedAt = Date.now()
  let res
  try {
    res = await ctx.http.request(req, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
  } catch (cause) {
    if (isEngineError(cause)) throw cause
    const message = cause instanceof Error ? cause.message : String(cause)
    // AbortError / 超时在各家 HTTP 实现里的名字不统一，按 name 与 message 一起认
    const isAbort =
      (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError')) ||
      /timeout|timed out|aborted/i.test(message)
    throw new EngineError(isAbort ? 'TIMEOUT' : 'UPSTREAM', `引擎请求失败：${message}`, { cause })
  }
  if (res.status < 200 || res.status >= 300) {
    throw classifyHttpError(res.status, res.body)
  }
  const body = parseJsonBody(res.body)
  return parse(body, {
    latencyMs: Date.now() - startedAt,
    model: ctx.model ?? fallbackModel,
  })
}
