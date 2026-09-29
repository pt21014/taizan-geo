import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/hunyuan.json'
import noCitationFixture from './__fixtures__/hunyuan-no-citation.json'
import { buildHunyuanRequest, HunyuanEngineAdapter, parseHunyuanResponse } from './hunyuan'
import type { EngineAskContext } from '../types'

const ctx = (extra: Partial<EngineAskContext> = {}): EngineAskContext => ({
  credentials: { apiKey: 'sk-hunyuan' },
  http: { request: async () => ({ status: 200, body: JSON.stringify(fixture) }) },
  ...extra,
})

describe('buildHunyuanRequest', () => {
  it('打的是 OpenAI 兼容端点（不是 TC3 签名的云 API）', () => {
    const req = buildHunyuanRequest({ prompt: 'q' }, ctx())
    expect(req.url).toBe('https://api.hunyuan.cloud.tencent.com/v1/chat/completions')
    expect(req.headers['Authorization']).toBe('Bearer sk-hunyuan')
    // 凭据只要一个 apiKey，不需要 secretId/secretKey
    expect(Object.keys(ctx().credentials)).toEqual(['apiKey'])
  })

  it('联网增强开关随 body 一起发出去', () => {
    const body = JSON.parse(buildHunyuanRequest({ prompt: 'q' }, ctx()).body!) as Record<
      string,
      unknown
    >
    expect(body).toMatchObject({
      model: 'hunyuan-turbos-latest',
      enable_enhancement: true,
      citation: true,
      search_info: true,
    })
  })

  it('缺 apiKey 时按 AUTH 抛', () => {
    expect(() => buildHunyuanRequest({ prompt: 'q' }, ctx({ credentials: {} }))).toThrow('apiKey')
  })
})

describe('parseHunyuanResponse', () => {
  it('有 search_info.search_results 时按结构化引用解析', () => {
    const out = parseHunyuanResponse(fixture, { latencyMs: 30 })
    expect(out.text).toContain('泰赞GEO')
    expect(out.citations).toHaveLength(1)
    expect(out.citations[0]).toMatchObject({
      url: 'https://www.example.org/geo',
      title: '泰赞 GEO',
      siteName: '泰赞',
    })
    expect(out.usage).toEqual({ inputTokens: 88, outputTokens: 176, searchCalls: 1 })
  })

  // 待验证: 兼容端点是否真的回引用字段；不回时必须能从正文兜底
  it('兼容端点不回引用字段时，用 extractUrlsFromText 从正文兜底', () => {
    const out = parseHunyuanResponse(noCitationFixture, { latencyMs: 30 })
    expect(out.citations.map((c) => c.url)).toEqual([
      'https://www.example.org/geo',
      'https://geo.newrank.cn',
    ])
    // 兜底路径拿不到标题，这是固有代价
    expect(out.citations[0]!.title).toBeUndefined()
    expect(out.usage.searchCalls).toBe(1)
  })

  it('云 API 风格的大驼峰字段（Url/Title/SiteName）也能读', () => {
    const out = parseHunyuanResponse(
      {
        choices: [{ message: { content: 'x' } }],
        search_info: { search_results: [{ Index: 1, Url: 'https://a.com', Title: 'A', SiteName: 'S' }] },
      },
      { latencyMs: 1 },
    )
    expect(out.citations[0]).toMatchObject({ url: 'https://a.com', title: 'A', siteName: 'S' })
  })

  it('既没有引用字段、正文里也没有链接时 citations 为空、searchCalls 为 0', () => {
    const out = parseHunyuanResponse(
      { choices: [{ message: { content: '正文里没有任何链接' } }] },
      { latencyMs: 1 },
    )
    expect(out.citations).toEqual([])
    expect(out.usage.searchCalls).toBe(0)
  })

  it('空响应不抛错', () => {
    expect(parseHunyuanResponse({}, { latencyMs: 1 }).text).toBe('')
    expect(parseHunyuanResponse(null, { latencyMs: 1 }).citations).toEqual([])
  })
})

describe('HunyuanEngineAdapter', () => {
  it('code 是 hunyuan，ask 端到端可用', async () => {
    const adapter = new HunyuanEngineAdapter()
    expect(adapter.code).toBe('hunyuan')
    const out = await adapter.ask({ prompt: 'q' }, ctx())
    expect(out.citations).toHaveLength(1)
  })

  it('上游 500 时抛可重试的 UPSTREAM', async () => {
    const adapter = new HunyuanEngineAdapter()
    await expect(
      adapter.ask(
        { prompt: 'q' },
        ctx({ http: { request: async () => ({ status: 500, body: 'oops' }) } }),
      ),
    ).rejects.toMatchObject({ kind: 'UPSTREAM', retryable: true })
  })
})
