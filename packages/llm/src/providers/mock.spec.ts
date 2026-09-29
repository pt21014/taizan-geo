import { describe, expect, it } from 'vitest'
import {
  assertMockNotInProd,
  buildMockJson,
  buildMockPrompts,
  MOCK_LLM_SCENARIOS,
  MockLlmProvider,
  type MockGeneratedPrompt,
  type MockLlmConfig,
  type MockMention,
} from './mock'
import type { ChatRequest, JsonSchema, LlmChatContext } from '../types'

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: { mentions: { type: 'array' } },
  required: ['mentions'],
}

const CFG: MockLlmConfig = { brandName: '泰赞GEO', competitorNames: ['新榜智汇', '豆智'] }

/** 带 schema 的分析请求；回答文本作为 user message 传进去。 */
const analyzeReq = (answer: string): ChatRequest => ({
  messages: [
    { role: 'system', content: '你是 GEO 分析助手' },
    { role: 'user', content: answer },
  ],
  jsonSchema: SCHEMA,
})

const CTX: LlmChatContext = {
  http: {
    request: async () => {
      throw new Error('mock provider 不应该发任何 HTTP 请求')
    },
  },
}

const provider = new MockLlmProvider()

describe('MockLlmProvider —— 无 jsonSchema', () => {
  it('回显固定文本，usage 固定', async () => {
    const res = await provider.chat({ messages: [{ role: 'user', content: 'q' }] }, {}, CTX)
    expect(res.text).toBe('这是 mock LLM 的固定回复，用于本地开发与 CI。')
    expect(res.json).toBeUndefined()
    expect(res.usage).toEqual({ inputTokens: 320, outputTokens: 180 })
    expect(res.finishReason).toBe('stop')
  })
})

describe('MockLlmProvider —— 按品牌词做确定性匹配', () => {
  it('messages 里出现品牌词时产出一条 position 1 的 mention', async () => {
    const res = await provider.chat(analyzeReq('比较推荐的是泰赞GEO'), CFG, CTX)
    const mentions = (res.json as { mentions: MockMention[] }).mentions
    expect(mentions).toHaveLength(1)
    expect(mentions[0]).toMatchObject({
      entityName: '泰赞GEO',
      position: 1,
      isCited: false,
      sentiment: 'POSITIVE',
      sentimentScore: 80,
    })
    // text 与 json 一致
    expect(JSON.parse(res.text)).toEqual(res.json)
  })

  it('messages 里没有品牌词时不编一条出来——否则测的就不是分析逻辑', async () => {
    const res = await provider.chat(analyzeReq('这段回答里谁都没提'), CFG, CTX)
    expect((res.json as { mentions: MockMention[] }).mentions).toEqual([])
  })

  it('品牌 + 竞品同时出现时，竞品排在品牌之后', async () => {
    const res = await provider.chat(analyzeReq('推荐泰赞GEO，其次新榜智汇'), CFG, CTX)
    const mentions = (res.json as { mentions: MockMention[] }).mentions
    expect(mentions.map((m) => [m.entityName, m.position])).toEqual([
      ['泰赞GEO', 1],
      ['新榜智汇', 2],
    ])
  })

  it('scenario=no-mention 一律返回空数组', async () => {
    const res = await provider.chat(analyzeReq('推荐泰赞GEO'), { ...CFG, scenario: 'no-mention' }, CTX)
    expect((res.json as { mentions: MockMention[] }).mentions).toEqual([])
  })

  it('scenario=cited 时 isCited 为 true', async () => {
    const res = await provider.chat(analyzeReq('推荐泰赞GEO'), { ...CFG, scenario: 'cited' }, CTX)
    expect((res.json as { mentions: MockMention[] }).mentions[0]!.isCited).toBe(true)
  })

  it('scenario=negative 时情感为负、分数为负', async () => {
    const res = await provider.chat(analyzeReq('泰赞GEO 有人投诉'), { ...CFG, scenario: 'negative' }, CTX)
    const m = (res.json as { mentions: MockMention[] }).mentions[0]!
    expect(m.sentiment).toBe('NEGATIVE')
    expect(m.sentimentScore).toBe(-60)
  })

  it('scenario=competitor 时只有竞品、没有本品牌', async () => {
    const res = await provider.chat(
      analyzeReq('推荐新榜智汇和豆智，泰赞GEO 也在列'),
      { ...CFG, scenario: 'competitor' },
      CTX,
    )
    const mentions = (res.json as { mentions: MockMention[] }).mentions
    expect(mentions.map((m) => m.entityName)).toEqual(['新榜智汇', '豆智'])
  })

  it('scenario=prompt-gen 返回固定 5 条 Prompt', async () => {
    const res = await provider.chat(
      { messages: [{ role: 'user', content: '给泰赞GEO 生成 Prompt' }], jsonSchema: SCHEMA },
      { ...CFG, scenario: 'prompt-gen' },
      CTX,
    )
    const prompts = (res.json as { prompts: MockGeneratedPrompt[] }).prompts
    expect(prompts).toHaveLength(5)
    expect(prompts.map((p) => p.funnelStage)).toEqual(['BOFU', 'BOFU', 'MOFU', 'TOFU', 'TOFU'])
    expect(prompts[0]!.text).toContain('泰赞GEO')
    expect(prompts.every((p) => p.topic.length > 0)).toBe(true)
  })

  it('scenario=fail 抛错，供 registry 的主备切换用例使用', async () => {
    await expect(
      provider.chat(analyzeReq('x'), { ...CFG, scenario: 'fail' }, CTX),
    ).rejects.toThrow('scenario=fail')
  })

  it('缺配置时用内置默认品牌名，不抛错', async () => {
    const res = await provider.chat(analyzeReq('推荐示例品牌'), {}, CTX)
    expect((res.json as { mentions: MockMention[] }).mentions[0]!.entityName).toBe('示例品牌')
  })

  it('MOCK_LLM_SCENARIOS 列全 7 个场景', () => {
    expect(MOCK_LLM_SCENARIOS).toEqual([
      'mention',
      'no-mention',
      'competitor',
      'cited',
      'negative',
      'prompt-gen',
      'fail',
    ])
  })
})

describe('MockLlmProvider 的确定性与调用记录', () => {
  it('同样的入参跑两次，输出逐字段相同', async () => {
    const a = await provider.chat(analyzeReq('推荐泰赞GEO'), CFG, CTX)
    const b = await provider.chat(analyzeReq('推荐泰赞GEO'), CFG, CTX)
    expect(a).toEqual(b)
  })

  it('calls 按顺序记下每次请求，reset 清空', async () => {
    const p = new MockLlmProvider()
    await p.chat(analyzeReq('推荐泰赞GEO'), CFG, CTX)
    expect(p.calls).toHaveLength(1)
    p.reset()
    expect(p.calls).toHaveLength(0)
  })

  it('buildMockJson / buildMockPrompts 是纯函数，可直接给别的包的 spec 用', () => {
    expect(buildMockJson(analyzeReq('推荐泰赞GEO'), CFG)).toEqual(
      buildMockJson(analyzeReq('推荐泰赞GEO'), CFG),
    )
    expect(buildMockPrompts('X')).toHaveLength(5)
  })
})

describe('assertMockNotInProd', () => {
  it('生产环境启用 mock 直接拒启', () => {
    expect(() => assertMockNotInProd({ NODE_ENV: 'production' }, ['dashscope', 'mock'])).toThrow(
      '拒绝启动',
    )
    expect(() => assertMockNotInProd({ NODE_ENV: 'production' })).toThrow('拒绝启动')
  })

  it('生产环境未启用 mock 不抛', () => {
    expect(() =>
      assertMockNotInProd({ NODE_ENV: 'production' }, ['dashscope', 'openai-compatible']),
    ).not.toThrow()
  })

  it('非生产环境启用 mock 不抛', () => {
    expect(() => assertMockNotInProd({ NODE_ENV: 'test' }, ['mock'])).not.toThrow()
    expect(() => assertMockNotInProd({}, ['mock'])).not.toThrow()
  })
})
