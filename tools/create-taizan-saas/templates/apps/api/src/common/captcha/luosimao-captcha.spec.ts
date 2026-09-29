import { describe, expect, it, vi } from 'vitest'
import { verifyLuosimaoCaptcha } from './luosimao-captcha.service'

function fakeFetch(response: unknown, ok = true): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () => response,
  }) as unknown as typeof globalThis.fetch
}

describe('verifyLuosimaoCaptcha', () => {
  it('error === 0 且 res === "success" 才算通过', async () => {
    const fetchImpl = fakeFetch({ error: 0, res: 'success' })
    await expect(verifyLuosimaoCaptcha('key', 'token', fetchImpl)).resolves.toBe(true)
  })

  it('res 是 failed 时不通过', async () => {
    const fetchImpl = fakeFetch({ error: 0, res: 'failed' })
    await expect(verifyLuosimaoCaptcha('key', 'token', fetchImpl)).resolves.toBe(false)
  })

  it('error 非 0 时不通过', async () => {
    const fetchImpl = fakeFetch({ error: -1, res: 'failed', msg: 'invalid response' })
    await expect(verifyLuosimaoCaptcha('key', 'token', fetchImpl)).resolves.toBe(false)
  })

  it('HTTP 非 2xx 时不通过', async () => {
    const fetchImpl = fakeFetch({ error: 0, res: 'success' }, false)
    await expect(verifyLuosimaoCaptcha('key', 'token', fetchImpl)).resolves.toBe(false)
  })

  it('token 为空字符串直接判不通过，不发请求', async () => {
    const fetchImpl = vi.fn()
    await expect(
      verifyLuosimaoCaptcha('key', '', fetchImpl as unknown as typeof globalThis.fetch),
    ).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('请求体带 api_key 与 response 两个字段', async () => {
    let seenBody = ''
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      seenBody = String(init.body)
      return { ok: true, json: async () => ({ error: 0, res: 'success' }) }
    }) as unknown as typeof globalThis.fetch
    await verifyLuosimaoCaptcha('my-key', 'my-token', fetchImpl)
    expect(seenBody).toContain('api_key=my-key')
    expect(seenBody).toContain('response=my-token')
  })
})
