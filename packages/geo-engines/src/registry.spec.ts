import { describe, expect, it } from 'vitest'
import { EngineRegistry } from './registry'
import type { EngineAdapter, EngineAskOutput, EngineCode } from './types'

function stubAdapter(code: EngineCode): EngineAdapter {
  return {
    code,
    ask: async (): Promise<EngineAskOutput> => ({
      text: `stub-${code}`,
      citations: [],
      usage: { inputTokens: 0, outputTokens: 0, searchCalls: 0 },
      model: 'stub',
      latencyMs: 0,
      raw: null,
    }),
  }
}

describe('EngineRegistry', () => {
  it('register / get / has / codes 的基本行为', async () => {
    const registry = new EngineRegistry()
      .register(stubAdapter('qwen'))
      .register(stubAdapter('zhipu'))

    expect(registry.has('qwen')).toBe(true)
    expect(registry.has('ernie')).toBe(false)
    expect(registry.codes()).toEqual(['qwen', 'zhipu'])
    const out = await registry.get('qwen').ask(
      { prompt: 'x' },
      { credentials: {}, http: { request: async () => ({ status: 200, body: '{}' }) } },
    )
    expect(out.text).toBe('stub-qwen')
  })

  it('重复登记同一个 code 直接抛错，不静默覆盖', () => {
    const registry = new EngineRegistry().register(stubAdapter('qwen'))
    expect(() => registry.register(stubAdapter('qwen'))).toThrow('重复登记')
  })

  it('取未登记的 code 抛错', () => {
    const registry = new EngineRegistry()
    expect(() => registry.get('metaso')).toThrow('未登记的引擎')
  })

  it('register 返回 this，可以链式登记', () => {
    const registry = new EngineRegistry()
    expect(registry.register(stubAdapter('mock'))).toBe(registry)
  })
})
