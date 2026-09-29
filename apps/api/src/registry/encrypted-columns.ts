/**
 * **本应用自己的加密列注册表**（蓝图 §8 spec 11 / `docs/SECURITY-INVARIANTS.md` K4）。
 *
 * 框架那份在 `@taizan/prisma-base` 的 `ENCRYPTED_COLUMNS`（`TenantCredential.valueEnc` /
 * `PlatformSetting.valueEnc` / `PlatformAdmin.mfaSecretEnc`），它只管框架自己的三列，
 * 文件头明写「业务项目自己的加密列在项目侧另建一份注册表」——这里就是那一份。
 * 两份在 `test/arch/index.spec.ts` 的 spec 11 与 `test/arch/encrypted-columns.spec.ts`
 * 里合并后一起对账，所以**业务加了 `*Enc` 列却没登记这里，spec 会红**。
 *
 * ## 为什么漏登记必须在 CI 上红，而不是靠 code review
 *
 * 漏登记的那一列在平时完全正常：加密照常、解密照常、接口照常。它只在**密钥轮换**
 * 那一天暴露——轮换脚本按注册表挑列，没登记的列不会被重写，于是旧密钥退役之后
 * 那一列就再也解不开了。等到发现的时候，明文已经没有任何地方还留着。
 *
 * ## 加一条要同时做三件事（缺一件轮换时就漏）
 *
 * 1. schema 里加 `xxxEnc String? @db.Text` **和配对的 keyId 列**；
 * 2. 在下面的数组里登记（`keyIdColumn` 是真源，不靠命名约定猜）；
 * 3. 写入/读出一律走 `@taizan/crypto` 的 `CredentialVault`，明文永不落库、
 *    接口只回脱敏值。
 *
 * @packageDocumentation
 */

import type { EncryptedColumn } from '@taizan/prisma-base'

/**
 * 本应用业务表里的全部加密列。
 *
 * 只有 GEO 引擎凭据一条：租户级密钥统一走框架的 `TenantCredential`（provider + credKey
 * 是自由字符串，加一种供应商不用改表），所以业务侧不该再出现第二张"存密钥的表"。
 * `GeoEngine` 是例外，因为它是**平台域**的引擎接入配置——平台的商务合同密钥，
 * 一套服务全部租户，放进 `TenantCredential`（租户域）连读都读不出来。
 */
export const APP_ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  {
    model: 'GeoEngine',
    column: 'credentialEnc',
    keyIdColumn: 'credentialKeyId',
    description:
      '生成式引擎接入凭据的密文，存的是**整包 credentials 的 JSON**（apiKey / secret / ' +
      'region 之类，不同厂商字段不同，拆成列等于每接一个引擎改一次表）。' +
      '解密后 JSON.parse 喂 EngineAdapter.ask()；接口只回 credentialMasked。',
  },
  {
    model: 'GeoEngineCredential',
    column: 'credentialEnc',
    keyIdColumn: 'credentialKeyId',
    description:
      '商家自带引擎密钥的密文，格式与 GeoEngine.credentialEnc 完全一致（同一套 vault、' +
      '同一份 credentials JSON 形状），差别只是这张多了 tenantId。' +
      '解密后喂 EngineAdapter.ask()（GeoQueryExecuteHandler 优先用它，没有才 fallback 到平台密钥）；' +
      '接口只回 credentialMasked。',
  },
]
