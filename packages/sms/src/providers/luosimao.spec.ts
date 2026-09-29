import { describe, expect, it } from 'vitest'
import { LuosimaoSmsProvider, withLuosimaoSign } from './luosimao'
import type { HttpClient, HttpResponse } from '../http-client'

function fakeHttp(
  handler: (url: string, body: string, headers: Record<string, string>) => HttpResponse,
): HttpClient {
  return {
    post: async (url, body, headers) => handler(url, body, headers),
  }
}

describe('withLuosimaoSign', () => {
  it('没有签名时原样返回', () => {
    expect(withLuosimaoSign('您的验证码是 1234')).toBe('您的验证码是 1234')
  })

  it('正文里还没有签名时在末尾补一次（官方要求签名在末尾）', () => {
    expect(withLuosimaoSign('您的验证码是 1234', '泰赞')).toBe('您的验证码是 1234【泰赞】')
  })

  it('正文已经带了这个签名（哪怕不在末尾）就不重复拼接', () => {
    expect(withLuosimaoSign('【泰赞】您的验证码是 1234', '泰赞')).toBe('【泰赞】您的验证码是 1234')
    expect(withLuosimaoSign('您的验证码是 1234。【泰赞】如非本人操作请忽略', '泰赞')).toBe(
      '您的验证码是 1234。【泰赞】如非本人操作请忽略',
    )
  })
})

describe('LuosimaoSmsProvider', () => {
  const cfg = { apiKey: 'key123', signName: '泰赞' }

  it('成功响应（error === 0）算发送成功，vendorRef 取 batch_id', async () => {
    let seenAuth = ''
    let seenBody = ''
    const http = fakeHttp((_url, body, headers) => {
      seenAuth = headers['Authorization'] ?? ''
      seenBody = body
      return { status: 200, body: JSON.stringify({ error: 0, msg: 'ok', batch_id: 'b-1' }) }
    })
    const provider = new LuosimaoSmsProvider(http)
    const result = await provider.send(
      { phone: '13800000000', templateKey: 'ignored', params: {}, content: '您的验证码是 1234' },
      cfg,
    )
    expect(result.ok).toBe(true)
    expect(result.vendorRef).toBe('b-1')
    // Basic Auth：用户名固定 api，密码是 apiKey。
    expect(seenAuth).toBe(`Basic ${Buffer.from('api:key123').toString('base64')}`)
    expect(seenBody).toContain('mobile=13800000000')
    expect(new URLSearchParams(seenBody).get('message')).toBe('您的验证码是 1234【泰赞】')
  })

  it('error 非 0 算失败，error 里带 msg', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      body: JSON.stringify({ error: -1, msg: '余额不足' }),
    }))
    const provider = new LuosimaoSmsProvider(http)
    const result = await provider.send(
      { phone: '13800000000', templateKey: 'ignored', params: {}, content: '正文' },
      cfg,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('余额不足')
  })

  it('缺少已渲染正文时直接失败，不发请求', async () => {
    let called = false
    const http = fakeHttp(() => {
      called = true
      return { status: 200, body: '{}' }
    })
    const provider = new LuosimaoSmsProvider(http)
    const result = await provider.send(
      { phone: '13800000000', templateKey: 'ignored', params: {} },
      cfg,
    )
    expect(result.ok).toBe(false)
    expect(called).toBe(false)
  })

  it('网络异常归一成失败返回值，不抛出去', async () => {
    const provider = new LuosimaoSmsProvider({
      post: async () => {
        throw new Error('ECONNRESET')
      },
    })
    const result = await provider.send(
      { phone: '13800000000', templateKey: 'ignored', params: {}, content: '正文' },
      cfg,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ECONNRESET')
  })
})
