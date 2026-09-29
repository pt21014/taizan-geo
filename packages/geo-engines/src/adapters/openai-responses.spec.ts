import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/openai-responses.json'
import {
  buildOpenAiResponsesRequest,
  OpenAiResponsesEngineAdapter,
  parseOpenAiResponsesResponse,
} from './openai-responses'
import type { EngineAskContext } from '../types'

const ctx = (extra: Partial<EngineAskContext> = {}): EngineAskContext => ({
  credentials: { apiKey: 'sk-x' },
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  http: { request: async () => ({ status: 200, body: JSON.stringify(fixture) }) },
  ...extra,
})

describe('buildOpenAiResponsesRequest', () => {
  it('打 /responses（不是 /chat/completions），带 web_search 工具', () => {
    const req = buildOpenAiResponsesRequest({ prompt: 'q' }, ctx())
    expect(req.url).toBe('https://api.openai.com/v1/responses')
    expect(req.headers['Authorization']).toBe('Bearer sk-x')
    const body = JSON.parse(req.body!) as Record<string, unknown>
    expect(body).toEqual({
      model: 'gpt-4.1-mini',
      stream: false,
      tools: [{ type: 'web_search' }],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'q' }] }],
    })
  })

  it('systemPrompt 走 instructions', () => {
    const body = JSON.parse(
      buildOpenAiResponsesRequest({ prompt: 'q', systemPrompt: 's' }, ctx()).body!,
    ) as { instructions?: string }
    expect(body.instructions).toBe('s')
  })

  it('searchContextSize / userCountry 写进工具；非法的 size 被忽略', () => {
    const toolOf = (credentials: Record<string, string>): Record<string, unknown> =>
      (
        JSON.parse(buildOpenAiResponsesRequest({ prompt: 'q' }, ctx({ credentials })).body!) as {
          tools: Array<Record<string, unknown>>
        }
      ).tools[0]!
    expect(toolOf({ apiKey: 'k', searchContextSize: 'high', userCountry: 'CN' })).toEqual({
      type: 'web_search',
      search_context_size: 'high',
      user_location: { type: 'approximate', country: 'CN' },
    })
    expect(toolOf({ apiKey: 'k', searchContextSize: 'enormous' })).toEqual({ type: 'web_search' })
  })

  it('缺 baseUrl / model / apiKey 时按 AUTH 抛——不猜默认地址', () => {
    const base = { credentials: { apiKey: 'sk-x' }, http: ctx().http }
    expect(() => buildOpenAiResponsesRequest({ prompt: 'q' }, { ...base, model: 'm' })).toThrow(
      'baseUrl',
    )
    expect(() =>
      buildOpenAiResponsesRequest({ prompt: 'q' }, { ...base, baseUrl: 'https://a' }),
    ).toThrow('model')
    expect(() => buildOpenAiResponsesRequest({ prompt: 'q' }, ctx({ credentials: {} }))).toThrow(
      'apiKey',
    )
  })
})

describe('parseOpenAiResponsesResponse', () => {
  it('解析官方样例：output[].content[].annotations[] 的 url_citation', () => {
    const out = parseOpenAiResponsesResponse(fixture, { latencyMs: 70 })
    expect(out.text).toContain('Taizan GEO')
    expect(out.citations).toEqual([
      { url: 'https://www.example.org/geo', title: 'Taizan GEO', index: 1 },
      { url: 'https://geo.newrank.cn', title: 'Newrank Zhihui', index: 2 },
    ])
    // Responses 的 usage 是 input_tokens / output_tokens
    expect(out.usage).toEqual({ inputTokens: 328, outputTokens: 96, searchCalls: 1 })
    expect(out.model).toBe('gpt-4.1-mini-2025-04-14')
    expect(out.finishReason).toBe('completed')
  })

  it('status=incomplete 时 finishReason 取 incomplete_details.reason', () => {
    const out = parseOpenAiResponsesResponse(
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
      { latencyMs: 1 },
    )
    expect(out.finishReason).toBe('max_output_tokens')
  })

  it('模型没触发搜索时 citations 空、searchCalls 0——这是事实不是错误', () => {
    const out = parseOpenAiResponsesResponse(
      {
        output: [
          { type: 'message', content: [{ type: 'output_text', text: '一段没有链接的回答' }] },
        ],
      },
      { latencyMs: 1 },
    )
    expect(out.citations).toEqual([])
    expect(out.usage.searchCalls).toBe(0)
  })

  it('正文里带裸链接、又没有 annotations 时兜底抽出来', () => {
    const out = parseOpenAiResponsesResponse(
      { output: [{ type: 'message', content: [{ type: 'output_text', text: 'see https://a.com/p' }] }] },
      { latencyMs: 1 },
    )
    expect(out.citations[0]!.url).toBe('https://a.com/p')
  })

  it('annotations 里缺 url 的条目被丢弃', () => {
    const out = parseOpenAiResponsesResponse(
      {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'x',
                annotations: [{ type: 'url_citation', title: '只有标题' }, { type: 'file_citation', file_id: 'f' }],
              },
            ],
          },
        ],
      },
      { latencyMs: 1 },
    )
    expect(out.citations).toEqual([])
  })

  it('空响应不抛错；model 取不到时退成 unknown', () => {
    const out = parseOpenAiResponsesResponse({}, { latencyMs: 1 })
    expect(out.text).toBe('')
    expect(out.model).toBe('unknown')
    expect(parseOpenAiResponsesResponse(null, { latencyMs: 1 }).citations).toEqual([])
  })
})

describe('OpenAiResponsesEngineAdapter', () => {
  it('code 是 openai（与 OpenAiCompatibleEngineAdapter 二选一注册）', async () => {
    const adapter = new OpenAiResponsesEngineAdapter()
    expect(adapter.code).toBe('openai')
    const out = await adapter.ask({ prompt: 'q' }, ctx())
    expect(out.citations).toHaveLength(2)
  })

  it('上游 429 时抛可重试的 RATE_LIMIT', async () => {
    const adapter = new OpenAiResponsesEngineAdapter()
    await expect(
      adapter.ask(
        { prompt: 'q' },
        ctx({ http: { request: async () => ({ status: 429, body: 'slow down' }) } }),
      ),
    ).rejects.toMatchObject({ kind: 'RATE_LIMIT', retryable: true })
  })
})
