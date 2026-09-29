import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/ernie.json'
import { buildErnieRequest, ErnieEngineAdapter, parseErnieResponse } from './ernie'
import type { EngineAskContext } from '../types'

const ctx = (extra: Partial<EngineAskContext> = {}): EngineAskContext => ({
  credentials: { apiKey: 'bce-v2-key' },
  http: { request: async () => ({ status: 200, body: JSON.stringify(fixture) }) },
  ...extra,
})

describe('buildErnieRequest', () => {
  it('打千帆 v2 chat 端点，Bearer 带的是 apiKey', () => {
    const req = buildErnieRequest({ prompt: 'q' }, ctx())
    expect(req.url).toBe('https://qianfan.baidubce.com/v2/chat/completions')
    expect(req.headers['Authorization']).toBe('Bearer bce-v2-key')
  })

  it('web_search 三个开关都打开', () => {
    const body = JSON.parse(buildErnieRequest({ prompt: 'q' }, ctx()).body!) as Record<
      string,
      unknown
    >
    // 文档：web_search 在请求体顶层，不在 messages / extra 里
    expect(body).toMatchObject({
      model: 'ernie-4.5-turbo-128k',
      stream: false,
      web_search: {
        enable: true,
        enable_citation: true,
        enable_trace: true,
        enable_status: false,
      },
    })
  })

  it('缺 apiKey 时按 AUTH 抛', () => {
    expect(() => buildErnieRequest({ prompt: 'q' }, ctx({ credentials: {} }))).toThrow('apiKey')
  })
})

describe('parseErnieResponse', () => {
  it('解析官方样例形状：顶层 search_results + OpenAI 风格 usage', () => {
    const out = parseErnieResponse(fixture, { latencyMs: 50 })
    expect(out.text).toContain('泰赞GEO')
    expect(out.finishReason).toBe('normal')
    expect(out.model).toBe('ernie-4.5-turbo-128k')
    expect(out.usage).toEqual({ inputTokens: 96, outputTokens: 210, searchCalls: 1 })
    expect(out.citations).toHaveLength(2)
    // 文档里的单条只有 index / url / title 三个字段，没有站点名
    expect(out.citations[0]).toEqual({
      url: 'https://www.example.org/geo',
      title: '泰赞 GEO：生成式引擎优化监测',
      index: 1,
    })
  })

  it('web_search 的四个开关按文档发在请求体顶层（build 侧断言见上）——响应侧多出来的字段被忽略', () => {
    const out = parseErnieResponse(
      { search_results: [{ index: 1, url: 'https://a.com/p', title: 'A', 未知字段: 1 }] },
      { latencyMs: 1 },
    )
    expect(out.citations).toEqual([{ url: 'https://a.com/p', title: 'A', index: 1 }])
  })

  // 待验证: 文档没有站点名字段，下面两个别名纯属兜底
  it('响应里若真出现 site_name / web_anchor，会被读成 siteName', () => {
    expect(
      parseErnieResponse({ search_results: [{ url: 'https://a.com', site_name: 'S' }] }, {
        latencyMs: 1,
      }).citations[0]!.siteName,
    ).toBe('S')
    expect(
      parseErnieResponse({ search_results: [{ url: 'https://b.com', web_anchor: 'W' }] }, {
        latencyMs: 1,
      }).citations[0]!.siteName,
    ).toBe('W')
  })

  // 待验证: search_results 也可能挂在 message 下，两处都要读到
  it('search_results 挂在 choices[0].message 下时同样能读到', () => {
    const out = parseErnieResponse(
      {
        choices: [
          {
            message: {
              content: 'x',
              search_results: [{ index: 1, url: 'https://a.com/p', title: 'A' }],
            },
          },
        ],
      },
      { latencyMs: 1 },
    )
    expect(out.citations).toHaveLength(1)
    expect(out.citations[0]!.url).toBe('https://a.com/p')
  })

  it('两处同时有同一条引用时去重成一条', () => {
    const out = parseErnieResponse(
      {
        choices: [{ message: { content: 'x', search_results: [{ url: 'https://a.com/p/' }] } }],
        search_results: [{ url: 'https://a.com/p', title: 'A' }],
      },
      { latencyMs: 1 },
    )
    expect(out.citations).toHaveLength(1)
    expect(out.citations[0]!.title).toBe('A')
  })

  it('缺 search_results / 空回答 / 整个响应是空对象都不抛错', () => {
    expect(parseErnieResponse({}, { latencyMs: 1 }).citations).toEqual([])
    expect(parseErnieResponse({}, { latencyMs: 1 }).text).toBe('')
    expect(parseErnieResponse({ choices: [] }, { latencyMs: 1 }).usage.searchCalls).toBe(0)
    expect(parseErnieResponse(null, { latencyMs: 1 }).text).toBe('')
  })
})

describe('ErnieEngineAdapter', () => {
  it('code 是 ernie，ask 端到端可用', async () => {
    const adapter = new ErnieEngineAdapter()
    expect(adapter.code).toBe('ernie')
    const out = await adapter.ask({ prompt: 'q' }, ctx())
    expect(out.citations).toHaveLength(2)
  })

  it('千帆用 HTTP 200 + 中文内容审核文案返回时，走 parse 不报错（错误分类由上游状态码负责）', async () => {
    const adapter = new ErnieEngineAdapter()
    const out = await adapter.ask(
      { prompt: 'q' },
      ctx({ http: { request: async () => ({ status: 200, body: '{"choices":[]}' }) } }),
    )
    expect(out.text).toBe('')
  })
})
