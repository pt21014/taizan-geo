/**
 * 告警规则与告警事件的数据访问层。
 *
 * ## 全文没有一处 `tenantId`
 *
 * 与 `brand/geo-brand.service.ts` 同一条约定（spec 4）。
 *
 * ## 活跃唯一靠应用层兜，不靠唯一索引
 *
 * `GeoAlertRule` 的唯一索引是 `@@unique([tenantId, brandId, kind, deletedAt])`。
 * MySQL 把 `NULL` 视为**互不相同**，所以两条 `deletedAt = NULL` 的活跃行**不冲突**——
 * 那个索引挡住的只是「同一天软删两条一模一样的」。真正的「同品牌同类型只能有一条
 * 活跃规则」必须在这里判（蓝图 §10 第 9 条，与 `goods.service.ts` 的
 * `assertNameAvailable` 同形）。
 *
 * 判完再写之间有竞态窗口（两个请求同时通过校验）。P0 接受它：结果是同一个品牌
 * 有两条同类型规则，表现是一次评估发两条一样的通知——烦人但不是数据错误，
 * 而消掉它要引入一把分布式锁。
 *
 * ## 通道校验为什么在 service 而不是 DTO
 *
 * `validateChannels`（`geo-alert.rules.ts`）是纯函数，它抛的是一个不带框架的 `Error`
 * ——那个文件不能 import `@nestjs/*`。所以在这里 catch 住再转成 `BizException`，
 * 这是那个函数的文件头里写好的分工。DTO 上的 `@IsIn` 只挡「是不是 INBOX/SMS 这两个字」，
 * 挡不住 `['SMS']`（合法的字、非法的组合）——短信不配站内信是刻意禁止的：
 * 短信可能发失败且没有留档，站内信是那条通知唯一的可查底本。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { GeoAlertKind, Prisma } from '@prisma/client'
import { ErrorCode, normalizePage, type PageResult } from '@taizan/contracts'
import { BizException } from '@taizan/nest-core'
import { PrismaService } from '@taizan/nest-prisma'

import { autoTenantData, type AppPrismaService } from '../../../common/prisma.types'
import { GeoBrandService } from '../brand/geo-brand.service'
import { validateChannels } from './geo-alert.rules'
import type {
  CreateGeoAlertRuleDto,
  GeoAlertChannelLike,
  GeoAlertEventView,
  GeoAlertKindLike,
  GeoAlertRuleView,
  ListGeoAlertEventQueryDto,
  ListGeoAlertRuleQueryDto,
  UpdateGeoAlertRuleDto,
} from './dto/geo-alert.dto'

/** 通道默认值：只发站内信。短信要钱，默认不给。 */
const DEFAULT_CHANNELS: GeoAlertChannelLike[] = ['INBOX']

/** 库里 `channels` 是 Json 列；业务层约定它是字符串数组，这个函数是那条约定的唯一落点。 */
function toChannels(value: unknown): GeoAlertChannelLike[] {
  if (!Array.isArray(value)) return [...DEFAULT_CHANNELS]
  const out = value.filter((v): v is GeoAlertChannelLike => v === 'INBOX' || v === 'SMS')
  return out.length > 0 ? out : [...DEFAULT_CHANNELS]
}

@Injectable()
export class GeoAlertService {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(GeoBrandService) private readonly brands: GeoBrandService,
  ) {}

  // ── 规则 ────────────────────────────────────────────────────────────────

  /** 规则分页列表，附品牌名。 */
  async listRules(query: ListGeoAlertRuleQueryDto): Promise<PageResult<GeoAlertRuleView>> {
    const { page, pageSize } = normalizePage(query)

    const where: Prisma.GeoAlertRuleWhereInput = { deletedAt: null }
    if (query.brandId) where.brandId = query.brandId
    if (query.kind) where.kind = query.kind as GeoAlertKind

    const [rows, total] = await Promise.all([
      this.prisma.tenant.geoAlertRule.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tenant.geoAlertRule.count({ where }),
    ])

    const nameById = await this.brandNames(rows.map((r) => r.brandId))
    return {
      items: rows.map((r) => this.toRuleView(r, nameById)),
      total,
      page,
      pageSize,
    }
  }

  /**
   * 新建。
   *
   * @throws 1240300 品牌不存在或不属于本店；1040000 通道不合法或同类型规则已存在
   */
  async createRule(dto: CreateGeoAlertRuleDto): Promise<GeoAlertRuleView> {
    const brand = await this.brands.requireBrand(dto.brandId)
    const channels = this.normalizeChannels(dto.channels)
    await this.assertRuleAvailable(brand.id, dto.kind)

    const row = await this.prisma.tenant.geoAlertRule.create({
      data: autoTenantData<Prisma.GeoAlertRuleCreateInput>({
        brandId: brand.id,
        kind: dto.kind as GeoAlertKind,
        thresholdBp: dto.thresholdBp,
        channels,
        enabled: dto.enabled ?? true,
      }),
    })
    return this.toRuleView(row, new Map([[brand.id, brand.name]]))
  }

  /** 改。`brandId` / `kind` 不可改，理由见 `UpdateGeoAlertRuleDto` 的说明。 */
  async updateRule(id: string, dto: UpdateGeoAlertRuleDto): Promise<GeoAlertRuleView> {
    const current = await this.requireRule(id)
    const channels = dto.channels === undefined ? undefined : this.normalizeChannels(dto.channels)

    const row = await this.prisma.tenant.geoAlertRule.update({
      where: { id },
      data: {
        ...(dto.thresholdBp !== undefined ? { thresholdBp: dto.thresholdBp } : {}),
        ...(channels !== undefined ? { channels } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    })
    return this.toRuleView(row, await this.brandNames([current.brandId]))
  }

  /**
   * 软删。
   *
   * 软删而不是硬删：`GeoAlertEvent.ruleId` 指向它，硬删之后历史事件就成了
   * 一堆指向虚空的 id。软删之后至少还能反查出「那条规则当时的阈值是多少」，
   * 而那正是复盘一次误报时唯一要看的东西。
   */
  async removeRule(id: string): Promise<{ id: string }> {
    await this.requireRule(id)
    await this.prisma.tenant.geoAlertRule.update({
      where: { id },
      data: { deletedAt: new Date() },
    })
    return { id }
  }

  // ── 事件 ────────────────────────────────────────────────────────────────

  /** 告警事件分页列表，附品牌名。**不软删**（审计性质的流水）。 */
  async listEvents(query: ListGeoAlertEventQueryDto): Promise<PageResult<GeoAlertEventView>> {
    const { page, pageSize } = normalizePage(query)

    const where: Prisma.GeoAlertEventWhereInput = {}
    if (query.brandId) where.brandId = query.brandId
    if (query.kind) where.kind = query.kind as GeoAlertKind

    const [rows, total] = await Promise.all([
      this.prisma.tenant.geoAlertEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tenant.geoAlertEvent.count({ where }),
    ])

    const nameById = await this.brandNames(rows.map((r) => r.brandId))
    return {
      items: rows.map(
        (r): GeoAlertEventView => ({
          id: r.id,
          ruleId: r.ruleId,
          brandId: r.brandId,
          brandName: nameById.get(r.brandId) ?? '',
          kind: r.kind as GeoAlertKindLike,
          payload: toPayload(r.payload),
          notifiedAt: r.notifiedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        }),
      ),
      total,
      page,
      pageSize,
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** 拿一条属于本店的活跃规则，否则 1240300（与品牌那边同形）。 */
  private async requireRule(id: string): Promise<{ id: string; brandId: string }> {
    const row = await this.prisma.tenant.geoAlertRule.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, brandId: true },
    })
    if (!row) {
      throw new BizException(ErrorCode.CROSS_TENANT_FORBIDDEN, '告警规则不存在，或不属于当前店铺')
    }
    return row
  }

  /** 同品牌同类型的活跃规则只能有一条。见文件头。 */
  private async assertRuleAvailable(brandId: string, kind: GeoAlertKindLike): Promise<void> {
    const existing = await this.prisma.tenant.geoAlertRule.findFirst({
      where: { brandId, kind: kind as GeoAlertKind, deletedAt: null },
      select: { id: true },
    })
    if (existing) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        '这个品牌已经有一条同类型的告警规则了；改那一条的阈值，或者先把它删掉',
      )
    }
  }

  /** 走纯函数校验通道白名单，把它抛的裸 `Error` 转成 `BizException`。见文件头。 */
  private normalizeChannels(raw: GeoAlertChannelLike[] | undefined): GeoAlertChannelLike[] {
    const input = raw ?? DEFAULT_CHANNELS
    try {
      return validateChannels(input) as GeoAlertChannelLike[]
    } catch (err) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        err instanceof Error ? err.message : '告警通道配置不合法',
      )
    }
  }

  /** 一次把这一页涉及的品牌名取回来（逐行查是 N+1）。 */
  private async brandNames(brandIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(brandIds)]
    if (ids.length === 0) return new Map()
    const rows = await this.prisma.tenant.geoBrand.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    })
    return new Map(rows.map((b) => [b.id, b.name]))
  }

  private toRuleView(
    row: {
      id: string
      brandId: string
      kind: string
      thresholdBp: number
      channels: Prisma.JsonValue
      enabled: boolean
      lastFiredAt: Date | null
      createdAt: Date
      updatedAt: Date
    },
    nameById: Map<string, string>,
  ): GeoAlertRuleView {
    return {
      id: row.id,
      brandId: row.brandId,
      // 品牌被软删之后规则还在（不级联删是刻意的）。回空串而不是丢掉这一行——
      // 那条规则仍然占着「同品牌同类型唯一」的名额，看不见它才是真的困惑。
      brandName: nameById.get(row.brandId) ?? '',
      kind: row.kind as GeoAlertKindLike,
      thresholdBp: row.thresholdBp,
      channels: toChannels(row.channels),
      enabled: row.enabled,
      lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }
}

/** `payload` 是 Json 列；不是对象时回空对象（历史行可能是任何形状）。 */
function toPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}
