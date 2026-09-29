/**
 * 商家自带引擎密钥的数据访问层 + 密钥加解密。
 *
 * ## 与平台域 `GeoEngineService` 的关系
 *
 * 这张表是**租户域**（有 `tenantId` 列，登记在 `tenancy/tenant-models.ts` 里），
 * 全文走 `PrismaService.tenant`，没有一处 `RawPrismaService`——与 `GeoEngineService`
 * 全文没有一处 `prisma.tenant` 正好相反，两边分别是租户隔离扩展的两侧。
 *
 * 密钥加解密复用**同一套** `@taizan/crypto` vault（`CRYPTO_KEYS`/`CRYPTO_KEY_CURRENT`），
 * 不另起一套：轮换密钥时运维只用管一份 `CRYPTO_KEYS`，而不是「平台的密钥轮换了，
 * 商家自带的这批还在用旧密钥」这种要分别处理的情况。
 *
 * ## 明文在这个文件里只活两个方法
 *
 * `create`/`update` 收到明文立刻加密落库；`findRuntimeCandidate` 是**进程内专用**的
 * 明文出口，只给 `GeoQueryExecuteHandler` 用，任何控制器方法都不回明文
 * （`toView()` 不读 `credentialEnc`，与 `GeoEngineService.toView` 同一条底线）。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { ErrorCode, normalizePage, type PageResult } from '@taizan/contracts'
import { createVault, type CredentialVault } from '@taizan/crypto'
import { BizException, ConfigService } from '@taizan/nest-core'
import { PrismaService } from '@taizan/nest-prisma'

import { autoTenantData, type AppPrismaService } from '../../../common/prisma.types'
import type { AppEnv } from '../../../config/env'
import {
  maskCredentials,
  parseCredentialsJson,
} from '../engine/geo-engine.rules'
import { GeoEngineService } from '../engine/geo-engine.service'
import type { TenantCredentialCandidate } from './geo-engine-credential.rules'
import type {
  CreateGeoEngineCredentialDto,
  GeoEngineCredentialView,
  ListGeoEngineCredentialQueryDto,
  UpdateGeoEngineCredentialDto,
} from './dto/geo-engine-credential.dto'

type GeoEngineCredentialRow = NonNullable<
  Awaited<ReturnType<AppPrismaService['tenant']['geoEngineCredential']['findUnique']>>
>

function parseMasked(raw: string | null): Record<string, string> {
  if (raw === null || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

@Injectable()
export class GeoEngineCredentialService {
  private readonly vault: CredentialVault

  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(ConfigService) config: ConfigService<AppEnv>,
    @Inject(GeoEngineService) private readonly platformEngines: GeoEngineService,
  ) {
    this.vault = createVault({
      keys: config.get('CRYPTO_KEYS'),
      currentKeyId: config.get('CRYPTO_KEY_CURRENT'),
    })
  }

  /** 分页列表，附平台侧引擎展示名。 */
  async list(query: ListGeoEngineCredentialQueryDto): Promise<PageResult<GeoEngineCredentialView>> {
    const { page, pageSize } = normalizePage(query)
    const where: Prisma.GeoEngineCredentialWhereInput = { deletedAt: null }

    const [rows, total] = await Promise.all([
      this.prisma.tenant.geoEngineCredential.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tenant.geoEngineCredential.count({ where }),
    ])

    const nameByCode = await this.platformEngines.nameByCode()
    return { items: rows.map((row) => this.toView(row, nameByCode)), total, page, pageSize }
  }

  /**
   * 新建。
   *
   * @throws 1040000 凭据格式不对、engineCode 不是当前平台已启用的引擎，
   *   或本店已经为这个 engineCode 配过一条活跃记录
   */
  async create(dto: CreateGeoEngineCredentialDto): Promise<GeoEngineCredentialView> {
    const engineCode = dto.engineCode.trim().toLowerCase()
    await this.assertEngineCodeUsable(engineCode)
    await this.assertAvailable(engineCode)

    const parsed = parseCredentialsJson(JSON.stringify(dto.credentials ?? {}))
    if (!parsed.ok) throw new BizException(ErrorCode.BAD_REQUEST, parsed.message)
    if (Object.keys(parsed.credentials).length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, '凭据不能是空对象——新建这张表就是为了配一把密钥')
    }

    const { valueEnc, keyId } = this.vault.encrypt(JSON.stringify(parsed.credentials))

    const row = await this.prisma.tenant.geoEngineCredential.create({
      data: autoTenantData<Prisma.GeoEngineCredentialCreateInput>({
        engineCode,
        enabled: dto.enabled ?? true,
        credentialEnc: valueEnc,
        credentialKeyId: keyId,
        credentialMasked: JSON.stringify(maskCredentials(parsed.credentials)),
      }),
    })
    return this.toView(row, await this.platformEngines.nameByCode())
  }

  /** 整包替换凭据（不改 `engineCode`/`enabled`）。 */
  async update(id: string, dto: UpdateGeoEngineCredentialDto): Promise<GeoEngineCredentialView> {
    await this.requireRow(id)

    const parsed = parseCredentialsJson(JSON.stringify(dto.credentials ?? {}))
    if (!parsed.ok) throw new BizException(ErrorCode.BAD_REQUEST, parsed.message)
    if (Object.keys(parsed.credentials).length === 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        '凭据不能改成空对象——不想再用了就停用或删除这条记录',
      )
    }

    const { valueEnc, keyId } = this.vault.encrypt(JSON.stringify(parsed.credentials))
    const row = await this.prisma.tenant.geoEngineCredential.update({
      where: { id },
      data: {
        credentialEnc: valueEnc,
        credentialKeyId: keyId,
        credentialMasked: JSON.stringify(maskCredentials(parsed.credentials)),
      },
    })
    return this.toView(row, await this.platformEngines.nameByCode())
  }

  /** 启用 / 停用。 */
  async setEnabled(id: string, enabled: boolean): Promise<GeoEngineCredentialView> {
    await this.requireRow(id)
    const row = await this.prisma.tenant.geoEngineCredential.update({
      where: { id },
      data: { enabled },
    })
    return this.toView(row, await this.platformEngines.nameByCode())
  }

  /** 软删。 */
  async remove(id: string): Promise<{ id: string }> {
    await this.requireRow(id)
    await this.prisma.tenant.geoEngineCredential.update({
      where: { id },
      data: { deletedAt: new Date() },
    })
    return { id }
  }

  // ── 跑批专用：进程内解密出口 ────────────────────────────────────────────

  /**
   * 跑批 handler 要用的候选凭据（{@link TenantCredentialCandidate}）。
   *
   * 没配过这个 engineCode 时回 `null`；配了但停用时回 `{enabled:false, credentials:{}}`
   * ——**不解密**（停用状态下 `shouldUseTenantCredential` 一定回 `false`，解出来的
   * 明文永远用不上，解密只是白花一次 vault 调用）；启用中才真的解密。
   *
   * @param engineCode - 引擎 code
   */
  async findRuntimeCandidate(engineCode: string): Promise<TenantCredentialCandidate | null> {
    const row = await this.prisma.tenant.geoEngineCredential.findFirst({
      where: { engineCode, deletedAt: null },
    })
    if (!row) return null
    if (!row.enabled) return { enabled: false, credentials: {} }

    const plain = this.vault.decrypt(row.credentialEnc, row.credentialKeyId)
    const parsed = parseCredentialsJson(plain)
    if (!parsed.ok) {
      // 解不开的原因只有「密钥轮换时漏了这一列」，与 `GeoEngineService.decryptCredentials`
      // 同一条理由抛出去，让这条查询失败并可重试，而不是悄悄 fallback 到平台密钥——
      // 那样商家会以为自己的号在用，账单却算在平台头上。
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `本店为引擎「${engineCode}」配置的密钥解不开——多半是密钥轮换时漏了 GeoEngineCredential.credentialEnc 这一列`,
      )
    }
    return { enabled: true, credentials: parsed.credentials }
  }

  // ── 私有 ────────────────────────────────────────────────────────────────

  private async requireRow(id: string): Promise<GeoEngineCredentialRow> {
    const row = await this.prisma.tenant.geoEngineCredential.findFirst({
      where: { id, deletedAt: null },
    })
    if (!row) {
      throw new BizException(ErrorCode.CROSS_TENANT_FORBIDDEN, '这条密钥配置不存在，或不属于当前店铺')
    }
    return row
  }

  /** 同店同 engineCode 只能有一条活跃配置。见 schema 里的唯一索引注释。 */
  private async assertAvailable(engineCode: string): Promise<void> {
    const existing = await this.prisma.tenant.geoEngineCredential.findFirst({
      where: { engineCode, deletedAt: null },
      select: { id: true },
    })
    if (existing) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `本店已经为引擎「${engineCode}」配过密钥了；改那一条，或者先把它删掉`,
      )
    }
  }

  /** engineCode 必须是当前平台启用的引擎，与 `GeoBrand.engineCodes` 同一条校验路径。 */
  private async assertEngineCodeUsable(engineCode: string): Promise<void> {
    const enabled = await this.platformEngines.enabledCodes()
    if (!enabled.has(engineCode)) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `引擎「${engineCode}」不可用（没有这个引擎，或平台已把它停用）`,
      )
    }
  }

  private toView(
    row: {
      id: string
      engineCode: string
      enabled: boolean
      credentialEnc: string
      credentialMasked: string | null
      createdAt: Date
      updatedAt: Date
    },
    nameByCode: Map<string, string>,
  ): GeoEngineCredentialView {
    return {
      id: row.id,
      engineCode: row.engineCode,
      engineName: nameByCode.get(row.engineCode) ?? '',
      enabled: row.enabled,
      credentialMasked: parseMasked(row.credentialMasked),
      hasCredentials: row.credentialEnc !== '',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }
}
