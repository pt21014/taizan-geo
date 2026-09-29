import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/qwen.json'
import { buildQwenRequest, parseQwenResponse, QwenEngineAdapter } from './qwen'
import type { EngineAskContext } from '../types'

const ctx = (extra: Partial<EngineAskContext> = {}): EngineAskContext => ({
  credentials: { apiKey: 'sk-qwen' },
  http: { request: async () => ({ status: 200, body: JSON.stringify(fixture) }) },
  ...extra,
})

describe('buildQwenRequest', () => {
  it('打 DashScope 原生文本生成端点，带 Bearer 头', () => {
    const req = buildQwenRequest({ prompt: '国内 GEO 工具有哪些' }, ctx())
    expect(req.url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
    )
    expect(req.method).toBe('POST')
    expect(req.headers['Authorization']).toBe('Bearer sk-qwen')
    expect(req.headers['Content-Type']).toBe('application/json')
  })

  it('body 里联网与引用开关都打开，result_format 是 message（字段位置按官方文档）', () => {
    const req = buildQwenRequest({ prompt: 'q' }, ctx())
    const body = JSON.parse(req.body!) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'qwen-plus',
      input: { messages: [{ role: 'user', content: 'q' }] },
      parameters: {
        result_format: 'message',
        enable_search: true,
        search_options: {
          enable_source: true,
          enable_citation: true,
          citation_format: '[ref_<number>]',
          forced_search: true,
        },
      },
    })
  })

  // 文档打架：中文站说 turbo/max/agent/agent_max，国际站说只支持 agent。
  // 默认不发，避免把一个非法值打过去换来 400。
  it('默认不发 search_strategy；credentials.searchStrategy 配了才发', () => {
    const withoutStrategy = JSON.parse(buildQwenRequest({ prompt: 'q' }, ctx()).body!) as {
      parameters: { search_options: Record<string, unknown> }
    }
    expect('search_strategy' in withoutStrategy.parameters.search_options).toBe(false)

    const withStrategy = JSON.parse(
      buildQwenRequest(
        { prompt: 'q' },
        ctx({ credentials: { apiKey: 'sk-qwen', searchStrategy: 'agent' } }),
      ).body!,
    ) as { parameters: { search_options: Record<string, unknown> } }
    expect(withStrategy.parameters.search_options['search_strategy']).toBe('agent')
  })

  it('systemPrompt 会作为第一条 message 发出去', () => {
    const req = buildQwenRequest({ prompt: 'q', systemPrompt: 's' }, ctx())
    const body = JSON.parse(req.body!) as { input: { messages: unknown[] } }
    expect(body.input.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'q' },
    ])
  })

  it('ctx.model / ctx.baseUrl 可以覆盖默认值，末尾斜杠被去掉', () => {
    const req = buildQwenRequest(
      { prompt: 'q' },
      ctx({ model: 'qwen-max', baseUrl: 'https://gw.internal/' }),
    )
    expect(req.url.startsWith('https://gw.internal/api/v1/')).toBe(true)
    expect((JSON.parse(req.body!) as { model: string }).model).toBe('qwen-max')
  })

  it('缺 apiKey 时按 AUTH 抛', () => {
    expect(() => buildQwenRequest({ prompt: 'q' }, ctx({ credentials: {} }))).toThrow('apiKey')
  })
})

describe('parseQwenResponse', () => {
  it('解析官方样例形状：正文 + search_results + usage', () => {
    const out = parseQwenResponse(fixture, { latencyMs: 100, model: 'qwen-plus' })
    expect(out.text).toContain('泰赞GEO')
    expect(out.finishReason).toBe('stop')
    expect(out.usage).toEqual({ inputTokens: 82, outputTokens: 240, searchCalls: 1 })
    expect(out.model).toBe('qwen-plus')
    expect(out.latencyMs).toBe(100)
    expect(out.raw).toBe(fixture)
  })

  it('引用被归一化：utm 参数与 fragment 都被去掉，index 重排', () => {
    const out = parseQwenResponse(fixture, { latencyMs: 1 })
    expect(out.citations).toHaveLength(2)
    expect(out.citations[0]).toMatchObject({
      url: 'https://www.example.org/geo',
      title: '泰赞 GEO 产品介绍',
      siteName: '泰赞',
      index: 1,
    })
    expect(out.citations[1]!.url).toBe('https://geo.newrank.cn')
  })

  it('缺 search_info 时 citations 是空数组，searchCalls 退成 0', () => {
    const out = parseQwenResponse(
      { output: { choices: [{ message: { content: 'x' } }] } },
      { latencyMs: 1, model: 'qwen-plus' },
    )
    expect(out.citations).toEqual([])
    expect(out.usage.searchCalls).toBe(0)
  })

  it('空回答 / 整个 output 缺失都不抛错，text 退成空串', () => {
    expect(parseQwenResponse({}, { latencyMs: 1 }).text).toBe('')
    expect(parseQwenResponse(null, { latencyMs: 1 }).text).toBe('')
    expect(parseQwenResponse({ output: { choices: [] } }, { latencyMs: 1 }).text).toBe('')
  })

  it('老的 text 格式（没有 choices）也能取到正文', () => {
    const out = parseQwenResponse({ output: { text: '老格式' } }, { latencyMs: 1 })
    expect(out.text).toBe('老格式')
  })

  // 官方 Java 示例里 siteName / icon 可能是 null，缺这两个不该影响解析
  it('search_results 只有文档里的 index/title/url 三个字段时照样解析', () => {
    const out = parseQwenResponse(
      {
        output: {
          choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
          search_info: {
            search_results: [{ index: 1, title: 'A', url: 'https://a.com/p', site_name: null, icon: null }],
          },
        },
      },
      { latencyMs: 1 },
    )
    expect(out.citations).toEqual([{ url: 'https://a.com/p', title: 'A', index: 1 }])
  })

  it('引用里缺 url 的条目被丢弃，不会产生空 url 的引用', () => {
    const out = parseQwenResponse(
      { output: { search_info: { search_results: [{ title: '只有标题' }, { url: 'https://a.com' }] } } },
      { latencyMs: 1 },
    )
    expect(out.citations).toHaveLength(1)
    expect(out.citations[0]!.url).toBe('https://a.com')
  })
})

describe('QwenEngineAdapter', () => {
  it('code 是 qwen，ask 端到端把 fixture 解析出来', async () => {
    const adapter = new QwenEngineAdapter()
    expect(adapter.code).toBe('qwen')
    const out = await adapter.ask({ prompt: 'q' }, ctx())
    expect(out.citations).toHaveLength(2)
    expect(out.usage.inputTokens).toBe(82)
  })

  it('上游 401 时抛 AUTH', async () => {
    const adapter = new QwenEngineAdapter()
    await expect(
      adapter.ask(
        { prompt: 'q' },
        ctx({ http: { request: async () => ({ status: 401, body: 'invalid key' }) } }),
      ),
    ).rejects.toMatchObject({ kind: 'AUTH', retryable: false })
  })
})
