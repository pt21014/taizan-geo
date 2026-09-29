/**
 * 通知通道的装配（蓝图 §4.13）。
 *
 * ## 本阶段只装两条通道，为什么是这两条
 *
 * - **INBOX（站内信）**：没有外部依赖，永远送得到。它是「通知这件事真的接上了」的
 *   最小证据——`NotifyService` 会为每个通道写一行 `NotifyRecord`，站内信的「发送」
 *   本身就是那次写库。
 * - **SMS**：短信是唯一一条会真的花钱、也真的会在生产上出事的通道。本地/CI 用
 *   `MockSmsProvider` 记账不发送；生产环境按 `SMS_PROVIDER` 换成真厂商
 *   （目前接了螺丝帽 `luosimao`）。`createSmsChannel` 在装配时会调
 *   `assertMockNotInProd`——`NODE_ENV=production` 还挂着 mock 直接拒启，
 *   `config/env.ts` 的 `SMS_PROVIDER` 字段级 `superRefine` 是更早的第一道防线。
 *
 * `MP_TEMPLATE` / `APP_PUSH` 现在**一个都不装**，而不是装成 noop：装了 noop 的后果是
 * 业务代码可以照常 `channels: ['APP_PUSH']` 并拿到 `ok: true`，
 * 于是「推送没到」变成一个看不出来的状态。不装的话 `NotifyService` 会直接抛
 * 「通道没有登记驱动」——这才是那时候该发生的事。
 *
 * @packageDocumentation
 */

import { createInboxChannel, createSmsChannel, type NotifyChannelDriver } from '@taizan/nest-notify'
import {
  LuosimaoSmsProvider,
  MockSmsProvider,
  SmsProviderRegistry,
  type ProdCheckEnv,
} from '@taizan/sms'

import type { AppEnv } from '../config/env'
import { createSmsHttpClient } from './sms-http-client'

/**
 * mock provider 没有真厂商时兜底用的签名。真实项目里应当来自 env——
 * `SMS_PROVIDER=luosimao` 时用 `LUOSIMAO_SIGN`，这里保留是为了换真厂商前
 * 「这个位置需要一个值」能一眼看到。
 */
const MOCK_SIGN_NAME = 'taizan-saas'

function requireEnv(value: string | undefined, key: string): string {
  const v = value?.trim() ?? ''
  if (v === '') {
    throw new Error(
      `[@taizan/api] SMS_PROVIDER=luosimao 需要 ${key}，但它是空的。` +
        '缺配置在启动时就该炸——留到第一次发通知才发现的话，验证码/提醒已经该到用户手上了。',
    )
  }
  return v
}

/**
 * 建通知通道列表。
 *
 * @param env - 已校验的应用 env（`ENV = bootEnv()`），同时满足 `ProdCheckEnv`
 * @throws 生产环境仍然挂着 mock 短信 provider 时抛（`assertMockNotInProd`）
 */
export function createNotifyChannels(env: AppEnv & ProdCheckEnv): NotifyChannelDriver[] {
  const registry = new SmsProviderRegistry().register(new MockSmsProvider())
  const cfgByProvider: Record<string, unknown> = { mock: {} }
  let primary = 'mock'
  let signName = MOCK_SIGN_NAME

  if (env.SMS_PROVIDER === 'luosimao') {
    registry.register(new LuosimaoSmsProvider(createSmsHttpClient()))
    cfgByProvider.luosimao = {
      apiKey: requireEnv(env.LUOSIMAO_API_KEY, 'LUOSIMAO_API_KEY'),
      signName: env.LUOSIMAO_SIGN,
    }
    primary = 'luosimao'
    signName = env.LUOSIMAO_SIGN ?? MOCK_SIGN_NAME
  }

  return [
    createInboxChannel(),
    createSmsChannel(
      {
        registry,
        cfgByProvider,
        // 没有 fallbacks：只有一家真厂商，写一个假的备用只会让「切换真的发生过没有」
        // 变得不可验证。再接第二家真厂商时这里才有第二项。
        order: { primary },
        signName,
      },
      env,
    ),
  ]
}
