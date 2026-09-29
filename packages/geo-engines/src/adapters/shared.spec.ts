import { describe, expect, it, vi } from 'vitest'
import { EngineError } from '../errors'
import type { HttpClient, HttpRequest, HttpResponse } from '../http-client'
import type { EngineAskContext, EngineAskInput, EngineAskOutput } from '../types'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  buildChatMessages,
  parseJsonBody,
  pick,
  requireCredential,
  runAdapter,
  trimBaseUrl,
} from './shared'

/** 固定响应的假 HttpClient，顺便记下收到的请求。 */
function stubHttp(res: HttpResponse | (() => Promise<HttpResponse>)): HttpClient & {
  calls: HttpRequest[]
} {
  const calls: HttpRequest[] = []
  return {
    calls,
    request: async (req) => {
      calls.push(req)
      return typeof res === 'function' ? res() : res
    },
  }
}

const BUILD = (input: EngineAskInput, ctx: EngineAskContext): HttpRequest => ({
  url: `${ctx.baseUrl ?? 'https://x.com'}/chat`,
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: input.prompt }),
})

const PARSE = (body: unknown, meta: { latencyMs: number; model?: string }): EngineAskOutput => ({
  text: asString(pick(body, 'text')) ?? '',
  citations: [],
  usage: { inputTokens: 0, outputTokens: 0, searchCalls: 0 },
  model: meta.model ?? 'unknown',
  latencyMs: meta.latencyMs,
  raw: body,
})

describe('取值助手', () => {
  it('asRecord 只认普通对象，null 与数组都返回 undefined', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord(null)).toBeUndefined()
    expect(asRecord([1])).toBeUndefined()
    expect(asRecord('x')).toBeUndefined()
  })

  it('asArray 非数组一律返回空数组，调用方可以直接 for..of', () => {
    expect(asArray([1, 2])).toEqual([1, 2])
    expect(asArray(undefined)).toEqual([])
    expect(asArray({ length: 2 })).toEqual([])
  })

  it('asString 空串与非字符串都返回 undefined', () => {
    expect(asString('x')).toBe('x')
    expect(asString('')).toBeUndefined()
    expect(asString(1)).toBeUndefined()
  })

  it('asNumber 排除 NaN / Infinity / 字符串数字', () => {
    expect(asNumber(1)).toBe(1)
    expect(asNumber(0)).toBe(0)
    expect(asNumber(NaN)).toBeUndefined()
    expect(asNumber(Infinity)).toBeUndefined()
    expect(asNumber('1')).toBeUndefined()
  })

  it('pick 中途断链返回 undefined，不抛错', () => {
    expect(pick({ a: { b: { c: 1 } } }, 'a', 'b', 'c')).toBe(1)
    expect(pick({ a: null }, 'a', 'b')).toBeUndefined()
    expect(pick(undefined, 'a')).toBeUndefined()
  })

  it('trimBaseUrl 去掉末尾所有斜杠', () => {
    expect(trimBaseUrl('https://a.com/v1//')).toBe('https://a.com/v1')
    expect(trimBaseUrl('https://a.com/v1')).toBe('https://a.com/v1')
  })
})

describe('requireCredential', () => {
  it('取到就返回（顺便 trim）', () => {
    expect(requireCredential({ apiKey: ' sk-1 ' }, 'apiKey', 'qwen')).toBe('sk-1')
  })

  it('缺失或空串时按 AUTH 抛，不可重试', () => {
    for (const creds of [{}, { apiKey: '' }, { apiKey: '   ' }]) {
      try {
        requireCredential(creds as Record<string, string>, 'apiKey', 'qwen')
        expect.unreachable('应该抛错')
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError)
        expect((e as EngineError).kind).toBe('AUTH')
        expect((e as EngineError).retryable).toBe(false)
      }
    }
  })
})

describe('buildChatMessages', () => {
  it('不传 systemPrompt 时只有一条 user message', () => {
    expect(buildChatMessages({ prompt: 'q' })).toEqual([{ role: 'user', content: 'q' }])
  })

  it('传了 systemPrompt 时 system 在前', () => {
    expect(buildChatMessages({ prompt: 'q', systemPrompt: 's' })).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'q' },
    ])
  })
})

describe('parseJsonBody', () => {
  it('合法 JSON 直接返回', () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 })
  })

  it('非 JSON（比如网关返回的一段 HTML）按 PARSE 抛，不可重试', () => {
    try {
      parseJsonBody('<html>502 Bad Gateway</html>')
      expect.unreachable('应该抛错')
    } catch (e) {
      expect((e as EngineError).kind).toBe('PARSE')
      expect((e as EngineError).retryable).toBe(false)
    }
  })
})

describe('runAdapter', () => {
  const ctx = (http: HttpClient, extra: Partial<EngineAskContext> = {}): EngineAskContext => ({
    credentials: { apiKey: 'k' },
    http,
    ...extra,
  })

  it('2xx 时把 build 的请求发出去并交给 parse', async () => {
    const http = stubHttp({ status: 200, body: '{"text":"hi"}' })
    const out = await runAdapter({ prompt: 'q' }, ctx(http), BUILD, PARSE, 'fallback-model')
    expect(http.calls[0]!.url).toBe('https://x.com/chat')
    expect(out.text).toBe('hi')
    expect(out.model).toBe('fallback-model')
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('ctx.model 优先于 fallbackModel 传给 parse', async () => {
    const http = stubHttp({ status: 200, body: '{"text":"hi"}' })
    const out = await runAdapter(
      { prompt: 'q' },
      ctx(http, { model: 'qwen-max' }),
      BUILD,
      PARSE,
      'fallback-model',
    )
    expect(out.model).toBe('qwen-max')
  })

  it('input.timeoutMs 优先于 ctx.timeoutMs 传给 HttpClient', async () => {
    const request: HttpClient['request'] = vi.fn(async () => ({
      status: 200,
      body: '{"text":"hi"}',
    }))
    const calls = vi.mocked(request).mock.calls
    await runAdapter(
      { prompt: 'q', timeoutMs: 5000 },
      ctx({ request }, { timeoutMs: 30_000, signal: new AbortController().signal }),
      BUILD,
      PARSE,
      'm',
    )
    expect(calls[0]![1]).toMatchObject({ timeoutMs: 5000 })
    expect(calls[0]![1]).toHaveProperty('signal')
  })

  it('非 2xx 走 classifyHttpError', async () => {
    const http = stubHttp({ status: 429, body: 'slow down' })
    await expect(
      runAdapter({ prompt: 'q' }, ctx(http), BUILD, PARSE, 'm'),
    ).rejects.toMatchObject({ kind: 'RATE_LIMIT', retryable: true })
  })

  it('HttpClient 抛 AbortError 时归成 TIMEOUT', async () => {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    const http: HttpClient = {
      request: async () => {
        throw err
      },
    }
    await expect(runAdapter({ prompt: 'q' }, ctx(http), BUILD, PARSE, 'm')).rejects.toMatchObject({
      kind: 'TIMEOUT',
      retryable: true,
    })
  })

  it('HttpClient 抛普通网络错误时归成 UPSTREAM', async () => {
    const http: HttpClient = {
      request: async () => {
        throw new Error('ECONNRESET')
      },
    }
    await expect(runAdapter({ prompt: 'q' }, ctx(http), BUILD, PARSE, 'm')).rejects.toMatchObject({
      kind: 'UPSTREAM',
      retryable: true,
    })
  })

  it('build 阶段抛的 EngineError 原样往上抛（比如凭据缺失）', async () => {
    const http = stubHttp({ status: 200, body: '{}' })
    const build = (): HttpRequest => {
      throw new EngineError('AUTH', '缺凭据')
    }
    await expect(runAdapter({ prompt: 'q' }, ctx(http), build, PARSE, 'm')).rejects.toMatchObject({
      kind: 'AUTH',
    })
  })
})
