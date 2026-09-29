import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/openai-compatible.json'
import {
  buildOpenAiRequest,
  OpenAiCompatibleEngineAdapter,
  parseOpenAiResponse,
} from './openai-compatible'
import type { EngineAskContext } from '../types'

const ctx = (extra: Partial<EngineAskContext> = {}): EngineAskContext => ({
  credentials: { apiKey: 'sk-x' },
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  http: { request: async () => ({ status: 200, body: JSON.stringify(fixture) }) },
  ...extra,
})

describe('buildOpenAiRequest', () => {
  it('baseUrl + /chat/completions，Bearer 头', () => {
    const req = buildOpenAiRequest({ prompt: 'q' }, ctx())
    expect(req.url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(req.headers['Authorization']).toBe('Bearer sk-x')
    expect((JSON.parse(req.body!) as { model: string }).model).toBe('deepseek-chat')
  })

  it('baseUrl / model 也可以从 credentials 里来，ctx 优先', () => {
    const req = buildOpenAiRequest(
      { prompt: 'q' },
      {
        credentials: { apiKey: 'sk-x', baseUrl: 'https://gw.internal/v1/', model: 'kimi-k2' },
        http: { request: async () => ({ status: 200, body: '{}' }) },
      },
    )
    expect(req.url).toBe('https://gw.internal/v1/chat/completions')
    expect((JSON.parse(req.body!) as { model: string }).model).toBe('kimi-k2')
  })

  it('缺 baseUrl 或 model 时按 AUTH 抛——不猜默认地址', () => {
    const base = { credentials: { apiKey: 'sk-x' }, http: ctx().http }
    expect(() => buildOpenAiRequest({ prompt: 'q' }, { ...base, model: 'm' })).toThrow('baseUrl')
    expect(() => buildOpenAiRequest({ prompt: 'q' }, { ...base, baseUrl: 'https://a' })).toThrow(
      'model',
    )
  })

  it('缺 apiKey 时按 AUTH 抛', () => {
    expect(() => buildOpenAiRequest({ prompt: 'q' }, ctx({ credentials: {} }))).toThrow('apiKey')
  })
})

describe('parseOpenAiResponse', () => {
  it('解析 annotations[].url_citation（openai.com 的 web_search 工具形状）', () => {
    const out = parseOpenAiResponse(fixture, { latencyMs: 70 })
    expect(out.text).toContain('Taizan GEO')
    expect(out.citations).toHaveLength(2)
    expect(out.citations[0]).toMatchObject({
      url: 'https://www.example.org/geo',
      title: 'Taizan GEO',
    })
    expect(out.usage).toEqual({ inputTokens: 64, outputTokens: 120, searchCalls: 1 })
    expect(out.model).toBe('gpt-4.1-mini')
    expect(out.finishReason).toBe('stop')
  })

  it('顶层 citations: string[]（Perplexity 一族）也能解析', () => {
    const out = parseOpenAiResponse(
      { choices: [{ message: { content: 'x' } }], citations: ['https://a.com/p?utm_source=x'] },
      { latencyMs: 1 },
    )
    expect(out.citations).toEqual([{ url: 'https://a.com/p', index: 1 }])
  })

  it('顶层 search_results[]（自建网关）也能解析', () => {
    const out = parseOpenAiResponse(
      { search_results: [{ url: 'https://a.com', title: 'A' }] },
      { latencyMs: 1 },
    )
    expect(out.citations[0]!.title).toBe('A')
  })

  it('不联网的端点（DeepSeek 这类）没有引用是正常的，不是错误', () => {
    const out = parseOpenAiResponse(
      { choices: [{ message: { content: '一段没有链接的回答' } }] },
      { latencyMs: 1 },
    )
    expect(out.citations).toEqual([])
    expect(out.usage.searchCalls).toBe(0)
  })

  it('正文里带裸链接时兜底抽出来', () => {
    const out = parseOpenAiResponse(
      { choices: [{ message: { content: 'see https://a.com/p' } }] },
      { latencyMs: 1 },
    )
    expect(out.citations[0]!.url).toBe('https://a.com/p')
  })

  it('空响应不抛错；model 取不到时退成 unknown', () => {
    const out = parseOpenAiResponse({}, { latencyMs: 1 })
    expect(out.text).toBe('')
    expect(out.model).toBe('unknown')
    expect(parseOpenAiResponse(null, { latencyMs: 1 }).citations).toEqual([])
  })
})

describe('OpenAiCompatibleEngineAdapter', () => {
  it('code 是 openai，ask 端到端可用', async () => {
    const adapter = new OpenAiCompatibleEngineAdapter()
    expect(adapter.code).toBe('openai')
    const out = await adapter.ask({ prompt: 'q' }, ctx())
    expect(out.citations).toHaveLength(2)
  })

  it('上游 429 时抛可重试的 RATE_LIMIT', async () => {
    const adapter = new OpenAiCompatibleEngineAdapter()
    await expect(
      adapter.ask(
        { prompt: 'q' },
        ctx({ http: { request: async () => ({ status: 429, body: 'slow down' }) } }),
      ),
    ).rejects.toMatchObject({ kind: 'RATE_LIMIT', retryable: true })
  })
})
