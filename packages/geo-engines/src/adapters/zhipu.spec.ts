import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/zhipu.json'
import { buildZhipuRequest, parseZhipuResponse, ZhipuEngineAdapter } from './zhipu'
import type { EngineAskContext } from '../types'

const ctx = (extra: Partial<EngineAskContext> = {}): EngineAskContext => ({
  credentials: { apiKey: 'zp-key' },
  http: { request: async () => ({ status: 200, body: JSON.stringify(fixture) }) },
  ...extra,
})

describe('buildZhipuRequest', () => {
  it('打 bigmodel v4 chat 端点', () => {
    const req = buildZhipuRequest({ prompt: 'q' }, ctx())
    expect(req.url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    expect(req.headers['Authorization']).toBe('Bearer zp-key')
  })

  it('联网是工具调用形态：tools 里有 web_search 且 search_result 打开', () => {
    const body = JSON.parse(buildZhipuRequest({ prompt: 'q' }, ctx()).body!) as {
      tools: Array<Record<string, unknown>>
    }
    expect(body.tools[0]).toMatchObject({
      type: 'web_search',
      web_search: { enable: true, search_engine: 'search_std', search_result: true },
    })
  })

  it('credentials.searchEngine 可以切到 pro / quark 档', () => {
    const body = JSON.parse(
      buildZhipuRequest(
        { prompt: 'q' },
        ctx({ credentials: { apiKey: 'k', searchEngine: 'search_pro_quark' } }),
      ).body!,
    ) as { tools: Array<{ web_search: { search_engine: string } }> }
    expect(body.tools[0]!.web_search.search_engine).toBe('search_pro_quark')
  })

  it('缺 apiKey 时按 AUTH 抛', () => {
    expect(() => buildZhipuRequest({ prompt: 'q' }, ctx({ credentials: {} }))).toThrow('apiKey')
  })
})

describe('parseZhipuResponse', () => {
  it('解析顶层 web_search[]：地址在 link 不在 url，refer 里的数字当角标', () => {
    const out = parseZhipuResponse(fixture, { latencyMs: 20 })
    expect(out.text).toContain('泰赞GEO')
    expect(out.citations).toHaveLength(2)
    expect(out.citations[0]).toMatchObject({
      url: 'https://www.example.org/geo',
      title: '泰赞 GEO 官网',
      siteName: '泰赞',
    })
    expect(out.citations[0]!.snippet).toContain('六个引擎')
    expect(out.usage).toEqual({ inputTokens: 101, outputTokens: 188, searchCalls: 1 })
    expect(out.model).toBe('glm-4-plus')
  })

  // 待验证: 也可能挂在 tool_calls[].search_result 下
  it('检索结果挂在 tool_calls[].search_result 下时同样能读到', () => {
    const out = parseZhipuResponse(
      {
        choices: [
          {
            message: {
              content: 'x',
              tool_calls: [
                { type: 'web_search', search_result: [{ link: 'https://a.com/p', title: 'A' }] },
              ],
            },
          },
        ],
      },
      { latencyMs: 1 },
    )
    expect(out.citations).toHaveLength(1)
    expect(out.citations[0]!.title).toBe('A')
  })

  it('单条里用 url 而不是 link 时也认', () => {
    const out = parseZhipuResponse({ web_search: [{ url: 'https://a.com' }] }, { latencyMs: 1 })
    expect(out.citations[0]!.url).toBe('https://a.com')
  })

  it('缺 web_search / 空回答 / null 都不抛错', () => {
    expect(parseZhipuResponse({}, { latencyMs: 1 }).citations).toEqual([])
    expect(parseZhipuResponse({ choices: [] }, { latencyMs: 1 }).text).toBe('')
    expect(parseZhipuResponse(null, { latencyMs: 1 }).usage.searchCalls).toBe(0)
  })

  it('snippet 超长时截到 500 字，不把整页正文塞进库', () => {
    const out = parseZhipuResponse(
      { web_search: [{ link: 'https://a.com', content: 'x'.repeat(2000) }] },
      { latencyMs: 1 },
    )
    expect(out.citations[0]!.snippet).toHaveLength(500)
  })
})

describe('ZhipuEngineAdapter', () => {
  it('code 是 zhipu，ask 端到端可用', async () => {
    const adapter = new ZhipuEngineAdapter()
    expect(adapter.code).toBe('zhipu')
    const out = await adapter.ask({ prompt: 'q' }, ctx())
    expect(out.citations).toHaveLength(2)
  })
})
