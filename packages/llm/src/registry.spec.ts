import { describe, expect, it } from 'vitest'
import { LlmProviderRegistry } from './registry'
import type { ChatRequest, ChatResponse, LlmChatContext, LlmProvider } from './types'

const CTX: LlmChatContext = {
  http: { request: async () => ({ status: 200, body: '{}' }) },
}

const REQ: ChatRequest = { messages: [{ role: 'user', content: 'q' }] }

function okProvider(name: string): LlmProvider {
  return {
    name,
    chat: async (): Promise<ChatResponse> => ({
      text: `from-${name}`,
      usage: { inputTokens: 1, outputTokens: 2 },
      model: name,
      finishReason: 'stop',
    }),
  }
}

function failProvider(name: string, message: string): LlmProvider {
  return {
    name,
    chat: async () => {
      throw new Error(message)
    },
  }
}

describe('LlmProviderRegistry', () => {
  it('主 provider 成功时只尝试一次', async () => {
    const registry = new LlmProviderRegistry().register(okProvider('a')).register(okProvider('b'))
    const outcome = await registry.chatWithFallback(REQ, { a: {}, b: {} }, ['a', 'b'], CTX)
    expect(outcome.provider).toBe('a')
    expect(outcome.response.text).toBe('from-a')
    expect(outcome.attempts).toHaveLength(1)
    expect(outcome.attempts[0]).toMatchObject({ provider: 'a', ok: true })
  })

  it('主 provider 失败自动切备用，两次尝试都落记录', async () => {
    const registry = new LlmProviderRegistry()
      .register(failProvider('a', '限流了'))
      .register(okProvider('b'))
    const outcome = await registry.chatWithFallback(REQ, { a: {}, b: {} }, ['a', 'b'], CTX)
    expect(outcome.provider).toBe('b')
    expect(outcome.attempts).toHaveLength(2)
    expect(outcome.attempts[0]).toMatchObject({ provider: 'a', ok: false, error: '限流了' })
    expect(outcome.attempts[1]!.ok).toBe(true)
    expect(outcome.attempts[0]!.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('全部失败时抛错，message 里能看到每一次的失败原因', async () => {
    const registry = new LlmProviderRegistry()
      .register(failProvider('a', 'a 挂了'))
      .register(failProvider('b', 'b 也挂了'))
    await expect(
      registry.chatWithFallback(REQ, { a: {}, b: {} }, ['a', 'b'], CTX),
    ).rejects.toThrow(/a 挂了.*b 也挂了/)
  })

  it('order 里出现未登记的 provider 名时抛错', async () => {
    const registry = new LlmProviderRegistry().register(okProvider('a'))
    await expect(
      registry.chatWithFallback(REQ, { a: {} }, ['not-registered'], CTX),
    ).rejects.toThrow('未登记的 LLM provider')
  })

  it('provider 缺配置时抛错', async () => {
    const registry = new LlmProviderRegistry().register(okProvider('a'))
    await expect(registry.chatWithFallback(REQ, {}, ['a'], CTX)).rejects.toThrow('缺少配置')
  })

  it('order 为空时抛错', async () => {
    const registry = new LlmProviderRegistry().register(okProvider('a'))
    await expect(registry.chatWithFallback(REQ, { a: {} }, [], CTX)).rejects.toThrow(
      '至少需要一个 provider',
    )
  })

  it('names() 列出已登记的 provider；get() 取不到时抛', () => {
    const registry = new LlmProviderRegistry().register(okProvider('a')).register(okProvider('b'))
    expect(registry.names().sort()).toEqual(['a', 'b'])
    expect(() => registry.get('c')).toThrow('未登记')
  })
})
