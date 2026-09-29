import { describe, expect, it } from 'vitest'
import { assertMockNotInProd, MOCK_SCENARIOS, MockEngineAdapter } from './mock'
import type { EngineAskContext } from '../types'

const CREDS = {
  brandName: '泰赞GEO',
  brandDomain: 'example.org',
  competitorNames: '新榜智汇,豆智',
}

const ctx = (scenario?: string, extra: Partial<EngineAskContext> = {}): EngineAskContext => ({
  credentials: { ...CREDS, ...(scenario ? { scenario } : {}) },
  // mock 不发请求，给一个会炸的 http 客户端正好能证明这一点
  http: {
    request: async () => {
      throw new Error('mock 引擎不应该发任何 HTTP 请求')
    },
  },
  ...extra,
})

const adapter = new MockEngineAdapter()

describe('MockEngineAdapter 的 8 个 scenario', () => {
  it('MOCK_SCENARIOS 就是技术设计 §2.1 的 8 个', () => {
    expect(MOCK_SCENARIOS).toEqual([
      'mention',
      'no-mention',
      'competitor',
      'cited',
      'negative',
      'timeout',
      'rate-limit',
      'auth-fail',
    ])
  })

  it('code 是 mock', () => {
    expect(adapter.code).toBe('mock')
  })

  it('mention（默认）：回答含品牌名、位次 1、2 条引用且其一是品牌官网', async () => {
    const out = await adapter.ask({ prompt: '国内 GEO 工具' }, ctx('mention'))
    expect(out.text).toContain('泰赞GEO')
    // "位次 1"：品牌名出现在竞品之前
    expect(out.text.indexOf('泰赞GEO')).toBeLessThan(out.text.indexOf('新榜智汇'))
    expect(out.citations).toHaveLength(2)
    expect(out.citations[0]!.url).toBe('https://example.org/product')
    expect(out.usage.searchCalls).toBe(1)
  })

  it('不传 scenario 时等同于 mention；非法 scenario 也退到 mention', async () => {
    const a = await adapter.ask({ prompt: 'q' }, ctx())
    const b = await adapter.ask({ prompt: 'q' }, ctx('mention'))
    const c = await adapter.ask({ prompt: 'q' }, ctx('不存在的场景'))
    expect(a.text).toBe(b.text)
    expect(c.text).toBe(b.text)
  })

  it('no-mention：不含品牌词，citations 空，searchCalls 退成 0', async () => {
    const out = await adapter.ask({ prompt: 'q' }, ctx('no-mention'))
    expect(out.text).not.toContain('泰赞GEO')
    expect(out.citations).toEqual([])
    expect(out.usage.searchCalls).toBe(0)
  })

  it('competitor：只提竞品，不提本品牌', async () => {
    const out = await adapter.ask({ prompt: 'q' }, ctx('competitor'))
    expect(out.text).not.toContain('泰赞GEO')
    expect(out.text).toContain('新榜智汇')
    expect(out.text).toContain('豆智')
    expect(out.citations).toHaveLength(2)
  })

  it('cited：提及 + 唯一一条引用指向品牌官网', async () => {
    const out = await adapter.ask({ prompt: 'q' }, ctx('cited'))
    expect(out.text).toContain('泰赞GEO')
    expect(out.citations).toHaveLength(1)
    expect(out.citations[0]!.url).toBe('https://example.org/docs/intro')
  })

  it('negative：提及但语气负面', async () => {
    const out = await adapter.ask({ prompt: 'q' }, ctx('negative'))
    expect(out.text).toContain('泰赞GEO')
    expect(out.text).toContain('投诉')
    expect(out.text).toContain('不太推荐')
    expect(out.citations).toHaveLength(1)
  })

  it('timeout：等 ctx.timeoutMs 之后抛可重试的 TIMEOUT', async () => {
    const startedAt = Date.now()
    await expect(
      adapter.ask({ prompt: 'q' }, ctx('timeout', { timeoutMs: 20 })),
    ).rejects.toMatchObject({ kind: 'TIMEOUT', retryable: true })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15)
  })

  it('timeout：不传 timeoutMs 时用默认的 50ms', async () => {
    await expect(adapter.ask({ prompt: 'q' }, ctx('timeout'))).rejects.toMatchObject({
      kind: 'TIMEOUT',
    })
  })

  it('rate-limit：立即抛可重试的 RATE_LIMIT', async () => {
    await expect(adapter.ask({ prompt: 'q' }, ctx('rate-limit'))).rejects.toMatchObject({
      kind: 'RATE_LIMIT',
      retryable: true,
    })
  })

  it('auth-fail：抛不可重试的 AUTH', async () => {
    await expect(adapter.ask({ prompt: 'q' }, ctx('auth-fail'))).rejects.toMatchObject({
      kind: 'AUTH',
      retryable: false,
    })
  })
})

describe('MockEngineAdapter 的确定性', () => {
  it('同样的入参跑两次，输出逐字段相同（含 latencyMs 与 usage）', async () => {
    const a = await adapter.ask({ prompt: 'q' }, ctx('mention'))
    const b = await adapter.ask({ prompt: 'q' }, ctx('mention'))
    expect(a).toEqual(b)
    expect(a.latencyMs).toBe(12)
    expect(a.usage).toEqual({ inputTokens: 42, outputTokens: 128, searchCalls: 1 })
  })

  it('prompt 会被带进回答里，便于 analysis 的 spec 断言', async () => {
    const out = await adapter.ask({ prompt: '买什么扫地机器人' }, ctx('mention'))
    expect(out.text).toContain('买什么扫地机器人')
    expect(out.raw).toMatchObject({ mock: true, scenario: 'mention' })
  })

  it('缺 credentials 时用内置默认品牌名，不抛错', async () => {
    const out = await adapter.ask(
      { prompt: 'q' },
      { credentials: {}, http: ctx().http },
    )
    expect(out.text).toContain('示例品牌')
  })
})

describe('assertMockNotInProd', () => {
  it('生产环境启用 mock 直接拒启', () => {
    expect(() => assertMockNotInProd({ NODE_ENV: 'production' }, ['qwen', 'mock'])).toThrow(
      '拒绝启动',
    )
    // 不传第二个参数 = "调用方正要用 mock"
    expect(() => assertMockNotInProd({ NODE_ENV: 'production' })).toThrow('拒绝启动')
  })

  it('生产环境未启用 mock 不抛', () => {
    expect(() => assertMockNotInProd({ NODE_ENV: 'production' }, ['qwen', 'zhipu'])).not.toThrow()
  })

  it('非生产环境启用 mock 不抛（本地/CI 的正常用法）', () => {
    expect(() => assertMockNotInProd({ NODE_ENV: 'test' }, ['mock'])).not.toThrow()
    expect(() => assertMockNotInProd({}, ['mock'])).not.toThrow()
  })
})
