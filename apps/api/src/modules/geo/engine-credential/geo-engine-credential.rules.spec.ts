import { describe, expect, it } from 'vitest'
import { shouldUseTenantCredential } from './geo-engine-credential.rules'

describe('shouldUseTenantCredential', () => {
  it('没配过（null）时用平台', () => {
    expect(shouldUseTenantCredential(null)).toBe(false)
  })

  it('配了但停用时用平台', () => {
    expect(
      shouldUseTenantCredential({ enabled: false, credentials: { apiKey: 'sk-xxx' } }),
    ).toBe(false)
  })

  it('配了且启用时用商家自己的', () => {
    expect(
      shouldUseTenantCredential({ enabled: true, credentials: { apiKey: 'sk-xxx' } }),
    ).toBe(true)
  })

  it('启用但凭据包是空对象（商家配了行但没填任何键）仍然算「用商家的」——空包会在适配器层报 AUTH 失败，不应该被这里悄悄 fallback 掉，否则商家会以为在用自己的号却实际上一直在扣平台的钱', () => {
    expect(shouldUseTenantCredential({ enabled: true, credentials: {} })).toBe(true)
  })
})
