import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/metaso.json'
import nestedFixture from './__fixtures__/metaso-nested.json'
import { buildMetasoRequest, MetasoEngineAdapter, parseMetasoResponse } from './metaso'
import type { EngineAskContext } from '../types'

const ctx = (extra: Partial<EngineAskContext> = {}): EngineAskContext => ({
  credentials: { apiKey: 'mt-key' },
  http: { request: async () => ({ status: 200, body: JSON.stringify(fixture) }) },
  ...extra,
})

describe('buildMetasoRequest', () => {
  // 路径与请求字段按官方调试台生成的请求核对（2026-09-13）
  it('打 Search API 的 /search，问题放在 q 里', () => {
    const req = buildMetasoRequest({ prompt: '国内 GEO 工具' }, ctx())
    expect(req.url).toBe('https://metaso.cn/api/v1/search')
    expect(req.headers['Authorization']).toBe('Bearer mt-key')
    const body = JSON.parse(req.body!) as Record<string, unknown>
    expect(body).toEqual({
      q: '国内 GEO 工具',
      scope: 'webpage',
      size: 10,
      includeSummary: true,
      conciseSnippet: false,
      includeRawContent: false,
    })
  })

  it('scope 取调试台下拉里的六个值；非法值退回 webpage', () => {
    const scopeOf = (model?: string): string =>
      (JSON.parse(buildMetasoRequest({ prompt: 'q' }, ctx({ ...(model ? { model } : {}) })).body!) as {
        scope: string
      }).scope
    for (const s of ['webpage', 'document', 'scholar', 'image', 'video', 'podcast']) {
      expect(scopeOf(s)).toBe(s)
    }
    expect(scopeOf('不存在的scope')).toBe('webpage')
  })

  it('includeRawContent 只在 scope=webpage 时发（照抄调试台的行为）', () => {
    const webpage = JSON.parse(buildMetasoRequest({ prompt: 'q' }, ctx()).body!) as Record<
      string,
      unknown
    >
    expect('includeRawContent' in webpage).toBe(true)
    const scholar = JSON.parse(
      buildMetasoRequest({ prompt: 'q' }, ctx({ model: 'scholar' })).body!,
    ) as Record<string, unknown>
    expect('includeRawContent' in scholar).toBe(false)
  })

  it('秘塔没有 system message，systemPrompt 被拼进 q', () => {
    const body = JSON.parse(
      buildMetasoRequest({ prompt: 'q', systemPrompt: 's' }, ctx()).body!,
    ) as { q: string }
    expect(body.q).toBe('s\n\nq')
  })

  it('缺 apiKey 时按 AUTH 抛', () => {
    expect(() => buildMetasoRequest({ prompt: 'q' }, ctx({ credentials: {} }))).toThrow('apiKey')
  })
})

describe('parseMetasoResponse', () => {
  it('顶层 summary 当正文，顶层 webpages 当引用（url 在 link）', () => {
    const out = parseMetasoResponse(fixture, { latencyMs: 80, model: 'webpage' })
    expect(out.text).toContain('泰赞GEO')
    expect(out.citations).toHaveLength(2)
    expect(out.citations[0]).toMatchObject({
      url: 'https://www.example.org/geo',
      title: '泰赞 GEO',
      snippet: '生成式引擎优化监测平台。',
      index: 1,
    })
    // 文档里的 webpages 单条没有站点名字段
    expect(out.citations[0]!.siteName).toBeUndefined()
    // 按次计费，没有 token 账；credits 当搜索次数
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0, searchCalls: 1 })
  })

  // 待验证: 响应容器名没有一手文档；下面几种形状都要能解析
  it('包在 data 里的那一种形状也能解析', () => {
    const out = parseMetasoResponse(nestedFixture, { latencyMs: 80, model: 'webpage' })
    expect(out.text).toContain('data')
    expect(out.citations).toHaveLength(1)
    expect(out.citations[0]).toMatchObject({ url: 'https://www.example.org/geo', siteName: '泰赞' })
    expect(out.usage.searchCalls).toBe(2)
  })

  it('单条里 url 写成 url 而不是 link 时也能解析', () => {
    const out = parseMetasoResponse(
      { summary: '答案', webpages: [{ url: 'https://a.com', title: 'A' }] },
      { latencyMs: 1 },
    )
    expect(out.text).toBe('答案')
    expect(out.citations[0]!.url).toBe('https://a.com')
  })

  it('answer / references 这套别名也能解析', () => {
    const out = parseMetasoResponse(
      { answer: '答案', references: [{ link: 'https://a.com' }] },
      { latencyMs: 1 },
    )
    expect(out.text).toBe('答案')
    expect(out.citations).toHaveLength(1)
  })

  it('结果列表缺失但正文里带链接时从正文兜底', () => {
    const out = parseMetasoResponse({ summary: '见 https://a.com/p 。' }, { latencyMs: 1 })
    expect(out.citations[0]!.url).toBe('https://a.com/p')
  })

  it('空响应不抛错，text 空串、citations 空数组', () => {
    expect(parseMetasoResponse({}, { latencyMs: 1 }).text).toBe('')
    expect(parseMetasoResponse(null, { latencyMs: 1 }).citations).toEqual([])
  })
})

describe('MetasoEngineAdapter', () => {
  it('code 是 metaso，ask 端到端可用', async () => {
    const adapter = new MetasoEngineAdapter()
    expect(adapter.code).toBe('metaso')
    const out = await adapter.ask({ prompt: 'q' }, ctx())
    expect(out.citations).toHaveLength(2)
  })
})
