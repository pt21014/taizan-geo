import { describe, expect, it } from 'vitest'
import botsFixture from './__fixtures__/doubao-bots.json'
import fixture from './__fixtures__/doubao.json'
import { buildDoubaoRequest, DoubaoEngineAdapter, parseDoubaoResponse } from './doubao'
import type { EngineAskContext } from '../types'

const ctx = (extra: Partial<EngineAskContext> = {}): EngineAskContext => ({
  credentials: { apiKey: 'ark-key' },
  model: 'doubao-seed-2-1-pro-260628',
  http: { request: async () => ({ status: 200, body: JSON.stringify(fixture) }) },
  ...extra,
})

describe('buildDoubaoRequest', () => {
  // 文档：「联网内容插件仅支持 Responses API」，所以默认打 /responses
  it('默认打 Responses API，带 tools: [{ type: "web_search" }]', () => {
    const req = buildDoubaoRequest({ prompt: 'q' }, ctx())
    expect(req.url).toBe('https://ark.cn-beijing.volces.com/api/v3/responses')
    expect(req.headers['Authorization']).toBe('Bearer ark-key')
    const body = JSON.parse(req.body!) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'doubao-seed-2-1-pro-260628',
      stream: false,
      tools: [{ type: 'web_search' }],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'q' }] }],
    })
  })

  it('systemPrompt 走 Responses 的 instructions，不塞进 input', () => {
    const body = JSON.parse(buildDoubaoRequest({ prompt: 'q', systemPrompt: 's' }, ctx()).body!) as {
      instructions?: string
      input: unknown[]
    }
    expect(body.instructions).toBe('s')
    expect(body.input).toHaveLength(1)
  })

  it('credentials.sources 可以加附加内容源（douyin / moji / toutiao）', () => {
    const body = JSON.parse(
      buildDoubaoRequest(
        { prompt: 'q' },
        ctx({ credentials: { apiKey: 'k', sources: 'douyin, toutiao' } }),
      ).body!,
    ) as { tools: Array<Record<string, unknown>> }
    expect(body.tools[0]).toEqual({ type: 'web_search', sources: ['douyin', 'toutiao'] })
  })

  it('credentials.useBots = "true" 时切回旧的应用(bot)通道', () => {
    const req = buildDoubaoRequest(
      { prompt: 'q' },
      ctx({ credentials: { apiKey: 'k', useBots: 'true' }, model: 'bot-20250407225237-6xv7r' }),
    )
    expect(req.url).toBe('https://ark.cn-beijing.volces.com/api/v3/bots/chat/completions')
    const body = JSON.parse(req.body!) as { model: string; messages: unknown[] }
    expect(body.model).toBe('bot-20250407225237-6xv7r')
    expect(body.messages).toEqual([{ role: 'user', content: 'q' }])
  })

  it('缺 apiKey 时按 AUTH 抛', () => {
    expect(() => buildDoubaoRequest({ prompt: 'q' }, ctx({ credentials: {} }))).toThrow('apiKey')
  })
})

describe('parseDoubaoResponse', () => {
  it('解析官方样例：output[].content[].annotations[] 里的 url_citation', () => {
    const out = parseDoubaoResponse(fixture, { latencyMs: 60 })
    expect(out.text).toContain('泰赞GEO')
    expect(out.citations).toHaveLength(2)
    expect(out.citations[0]).toEqual({
      // utm 参数被归一掉
      url: 'https://www.example.org/geo',
      title: '泰赞 GEO',
      siteName: '泰赞',
      snippet: '支持六个国产引擎的可见度监测。',
      index: 1,
    })
    // Responses 的 usage 是 input_tokens / output_tokens；搜索次数取 tool_usage.web_search
    expect(out.usage).toEqual({ inputTokens: 3666, outputTokens: 1610, searchCalls: 1 })
    expect(out.model).toBe('doubao-seed-2-1-pro-260628')
    expect(out.finishReason).toBe('completed')
  })

  it('reasoning / web_search_call 这些非 message 条目不会被当成正文', () => {
    const out = parseDoubaoResponse(fixture, { latencyMs: 1 })
    expect(out.text).not.toContain('先搜一下')
  })

  it('没有 tool_usage 时按 output[] 里 web_search_call 的条数算搜索次数', () => {
    const out = parseDoubaoResponse(
      {
        output: [
          { type: 'web_search_call' },
          { type: 'web_search_call' },
          { type: 'message', content: [{ type: 'output_text', text: 'x' }] },
        ],
      },
      { latencyMs: 1 },
    )
    expect(out.usage.searchCalls).toBe(2)
  })

  it('多段 message 的正文会拼起来，不是只取第一段', () => {
    const out = parseDoubaoResponse(
      {
        output: [
          { type: 'message', content: [{ type: 'output_text', text: '前半段' }] },
          { type: 'message', content: [{ type: 'output_text', text: '后半段' }] },
        ],
      },
      { latencyMs: 1 },
    )
    expect(out.text).toBe('前半段\n后半段')
  })

  // 旧通道：references[] 是 SearchDocument
  it('旧 bots 通道的 references[] 与 bot_usage 也能解析', () => {
    const out = parseDoubaoResponse(botsFixture, { latencyMs: 1 })
    expect(out.text).toContain('泰赞GEO')
    expect(out.citations).toHaveLength(2)
    expect(out.citations[0]).toMatchObject({
      url: 'https://www.example.org/geo',
      title: '泰赞 GEO',
      siteName: '泰赞',
    })
    expect(out.usage).toEqual({ inputTokens: 1960, outputTokens: 99, searchCalls: 1 })
    expect(out.finishReason).toBe('stop')
  })

  it('SearchDocument 只有 mobile_url 没有 url 时用 mobile_url', () => {
    const out = parseDoubaoResponse(
      { references: [{ mobile_url: 'https://m.a.com/p', title: 'A' }] },
      { latencyMs: 1 },
    )
    expect(out.citations[0]!.url).toBe('https://m.a.com/p')
  })

  it('没有任何结构化引用时从正文兜底抽链接', () => {
    const out = parseDoubaoResponse(
      { output: [{ type: 'message', content: [{ type: 'output_text', text: '详见 https://a.com/p 。' }] }] },
      { latencyMs: 1 },
    )
    expect(out.citations[0]!.url).toBe('https://a.com/p')
  })

  it('空响应 / 空回答不抛错', () => {
    expect(parseDoubaoResponse({}, { latencyMs: 1 }).text).toBe('')
    expect(parseDoubaoResponse(null, { latencyMs: 1 }).citations).toEqual([])
    expect(parseDoubaoResponse({ output: [] }, { latencyMs: 1 }).usage.searchCalls).toBe(0)
    expect(parseDoubaoResponse({ choices: [{ message: {} }] }, { latencyMs: 1 }).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      searchCalls: 0,
    })
  })
})

describe('DoubaoEngineAdapter', () => {
  it('code 是 doubao，ask 端到端可用', async () => {
    const adapter = new DoubaoEngineAdapter()
    expect(adapter.code).toBe('doubao')
    const out = await adapter.ask({ prompt: 'q' }, ctx())
    expect(out.citations).toHaveLength(2)
  })
})
