import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../config/env'
import { createNotifyChannels } from './channels'

function env(overrides: Partial<AppEnv>): AppEnv {
  return { NODE_ENV: 'test', SMS_PROVIDER: 'mock', ...overrides } as AppEnv
}

describe('createNotifyChannels', () => {
  it('SMS_PROVIDER=mock（默认）在非生产环境正常装配', () => {
    expect(() => createNotifyChannels(env({}))).not.toThrow()
  })

  it('SMS_PROVIDER=mock 在生产环境拒启（assertMockNotInProd）', () => {
    expect(() => createNotifyChannels(env({ NODE_ENV: 'production' }))).toThrow('拒绝启动')
  })

  it('SMS_PROVIDER=luosimao 但缺 LUOSIMAO_API_KEY 时装配期就抛，不等到发送才发现', () => {
    expect(() => createNotifyChannels(env({ SMS_PROVIDER: 'luosimao' }))).toThrow(
      'LUOSIMAO_API_KEY',
    )
  })

  it('SMS_PROVIDER=luosimao 且配好 LUOSIMAO_API_KEY 时正常装配（生产环境也不抛）', () => {
    expect(() =>
      createNotifyChannels(
        env({ SMS_PROVIDER: 'luosimao', LUOSIMAO_API_KEY: 'key', NODE_ENV: 'production' }),
      ),
    ).not.toThrow()
  })

  it('装出两个通道：INBOX 与 SMS', () => {
    const channels = createNotifyChannels(env({}))
    expect(channels.map((c) => c.kind).sort()).toEqual(['INBOX', 'SMS'])
  })
})
