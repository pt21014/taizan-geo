import { describe, expect, it } from 'vitest'
import { classifyHttpError, EngineError, isEngineError } from './errors'

describe('EngineError', () => {
  it('每类错误有默认的可重试性', () => {
    expect(new EngineError('AUTH', 'x').retryable).toBe(false)
    expect(new EngineError('RATE_LIMIT', 'x').retryable).toBe(true)
    expect(new EngineError('TIMEOUT', 'x').retryable).toBe(true)
    expect(new EngineError('CONTENT_FILTER', 'x').retryable).toBe(false)
    expect(new EngineError('UPSTREAM', 'x').retryable).toBe(true)
    expect(new EngineError('PARSE', 'x').retryable).toBe(false)
  })

  it('retryable 可以被显式覆盖，upstreamStatus 与 cause 原样带上', () => {
    const cause = new Error('socket hang up')
    const e = new EngineError('UPSTREAM', 'x', { retryable: false, upstreamStatus: 400, cause })
    expect(e.retryable).toBe(false)
    expect(e.upstreamStatus).toBe(400)
    expect(e.cause).toBe(cause)
    expect(e.name).toBe('EngineError')
    expect(e).toBeInstanceOf(Error)
  })

  it('isEngineError 认 instanceof，也认 name（跨 bundle 时 instanceof 不可靠）', () => {
    expect(isEngineError(new EngineError('AUTH', 'x'))).toBe(true)
    const faux = new Error('x')
    faux.name = 'EngineError'
    expect(isEngineError(faux)).toBe(true)
    expect(isEngineError(new Error('x'))).toBe(false)
    expect(isEngineError('x')).toBe(false)
  })
})

describe('classifyHttpError', () => {
  it('401 / 403 → AUTH，不可重试', () => {
    for (const status of [401, 403]) {
      const e = classifyHttpError(status, '{"error":"bad key"}')
      expect(e.kind).toBe('AUTH')
      expect(e.retryable).toBe(false)
      expect(e.upstreamStatus).toBe(status)
    }
  })

  it('429 → RATE_LIMIT，可重试', () => {
    const e = classifyHttpError(429, '{"error":"slow down"}')
    expect(e.kind).toBe('RATE_LIMIT')
    expect(e.retryable).toBe(true)
  })

  it('body 里带限流特征串时，即使状态码是 200/400 也算 RATE_LIMIT', () => {
    expect(classifyHttpError(400, '{"Code":"RequestLimitExceeded"}').kind).toBe('RATE_LIMIT')
    expect(classifyHttpError(200, '{"message":"请求过于频繁，请稍后再试"}').kind).toBe('RATE_LIMIT')
  })

  it('5xx → UPSTREAM，可重试', () => {
    for (const status of [500, 502, 503]) {
      const e = classifyHttpError(status, 'Bad Gateway')
      expect(e.kind).toBe('UPSTREAM')
      expect(e.retryable).toBe(true)
    }
  })

  it('status 0（网络层失败）→ UPSTREAM，可重试', () => {
    const e = classifyHttpError(0, 'ECONNRESET')
    expect(e.kind).toBe('UPSTREAM')
    expect(e.retryable).toBe(true)
  })

  it('408 / 504 → TIMEOUT，可重试', () => {
    expect(classifyHttpError(408, '').kind).toBe('TIMEOUT')
    expect(classifyHttpError(504, '').kind).toBe('TIMEOUT')
    expect(classifyHttpError(504, '').retryable).toBe(true)
  })

  it('内容审核类 → CONTENT_FILTER，不可重试；且优先于状态码判定', () => {
    // 通义：HTTP 400 + DataInspectionFailed
    const qwen = classifyHttpError(400, '{"code":"DataInspectionFailed","message":"risk"}')
    expect(qwen.kind).toBe('CONTENT_FILTER')
    expect(qwen.retryable).toBe(false)
    // 千帆：HTTP 200 + 中文"内容审核"
    expect(classifyHttpError(200, '{"error_msg":"内容审核不通过"}').kind).toBe('CONTENT_FILTER')
    // OpenAI 一族
    expect(classifyHttpError(400, '{"error":{"code":"content_filter"}}').kind).toBe(
      'CONTENT_FILTER',
    )
    // 即便状态码是 429，内容审核也不该被当成限流去重试
    expect(classifyHttpError(429, '{"code":"SensitiveContent"}').kind).toBe('CONTENT_FILTER')
  })

  it('body 里带鉴权特征串但状态码不是 401/403 时也归 AUTH', () => {
    const e = classifyHttpError(400, '{"error":{"code":"invalid_api_key"}}')
    expect(e.kind).toBe('AUTH')
    expect(e.retryable).toBe(false)
  })

  it('其余 4xx（参数错、模型不存在）→ UPSTREAM 但不可重试', () => {
    const e = classifyHttpError(404, '{"error":"model not found"}')
    expect(e.kind).toBe('UPSTREAM')
    expect(e.retryable).toBe(false)
  })

  it('超长 body 只截前 500 字进 message，不把整个响应塞进日志', () => {
    const e = classifyHttpError(500, 'x'.repeat(5000))
    expect(e.message.length).toBeLessThan(600)
  })
})
