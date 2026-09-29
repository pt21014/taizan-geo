/**
 * 周报/月报的生成与读取（技术设计 §4.1 report 一行）。
 *
 * ## 全文没有一处 `tenantId`
 *
 * 与 `brand/geo-brand.service.ts` 同一条约定（spec 4）。
 *
 * ## 为什么生成可以是**同步**的
 *
 * 蓝图 §10 第 4 条说的是「HTTP 请求路径里不许调引擎/LLM」。报表生成一次外部调用
 * 都没有——它读的全是 `GeoVisibilityDaily`（一个周期最多 90 行汇总 + 每引擎/每问法
 * 若干行）加一次 `GeoCitation` 的 `groupBy`。量级是几百到几千行，几十毫秒。
 *
 * 做成异步 job 的代价是：前端点了「生成」之后拿不到结果，只能轮询一个
 * `status: PENDING` 的行——而它 50ms 之后就好了。那是为了纪律而纪律。
 *
 * ## `payload` 是**快照**，不是视图
 *
 * 生成之后 `payload` 就固定了，后续数据修正（补跑、重算）**不会**改它。
 * 这是 `20-geo.prisma` 里写死的语义：「商家看到的那份报告和当时发出去的
 * 必须是同一份」。所以这里不是「读的时候现算」，而是「生成的时候算一次存下来」。
 *
 * ## 幂等：同一个 `(brandId, period, periodStart)` 只生成一次
 *
 * 唯一索引是 `@@unique([tenantId, brandId, period, periodStart])`（**不带 deletedAt**，
 * 这张表没有软删）。cron 每周一跑一次，重启/补跑时会再跑一遍同样的周期——
 * 所以先查再建，已存在就直接返回那一份，而不是抛「已存在」。
 * 抛错的话周报 cron 每次重启都会在日志里刷一屏假错误。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { GeoReportPeriod, Prisma } from '@prisma/client'
import { ErrorCode, normalizePage, type PageResult } from '@taizan/contracts'
import { PLATFORM_GATEWAY, type PlatformGateway } from '@taizan/nest-billing'
import { BizException, requireTenantId } from '@taizan/nest-core'
import { PrismaService } from '@taizan/nest-prisma'

import { autoTenantData, type AppPrismaService } from '../../../common/prisma.types'
import {
  dateKeyToDbDate,
  dayRangeOf,
  dbDateToDateKey,
  shiftDateKey,
} from '../aggregate/geo-metrics.rules'
import { GeoBrandService } from '../brand/geo-brand.service'
import { GeoEngineService } from '../engine/geo-engine.service'
import {
  parseCompetitorStats,
  rollupCompetitorStats,
  rollupDailyRows,
  type DailyRow,
} from '../dashboard/geo-dashboard.rules'
import type {
  GenerateGeoReportDto,
  GeoReportDetailView,
  GeoReportPeriodLike,
  GeoReportStatusLike,
  GeoReportView,
  ListGeoReportQueryDto,
} from './dto/geo-report.dto'
import {
  competitorsWithNullableSov,
  overviewWithNullableSov,
  top1RateBp,
  type GeoDiagnosisContentSuggestion,
  type GeoDiagnosisPromptSuggestion,
} from './geo-report.rules'

/**
 * 报表详情里，哪些字段需要 `geo.monitor` 功能闸门放行才可见（产品需求「先诊断后付费」§3）。
 *
 * 免费可见的核心数字（品牌提及率、首位推荐率、情感倾向）都在 `overview`/`previous`/
 * `trend`/`engines` 里，这份清单不动它们——只挡"往下钻"的明细与增值建议：
 * 竞品逐条对比、引用来源榜单、AI 推荐的问法、内容优化建议。闸门没放行时这四个字段
 * 整体置 `null`（不是不返回这个 key），前端据此渲染"升级解锁"占位，
 * 而不是让前端自己判断"这个字段是不是被隐藏了"——那不是真正的权限控制
 * （任务书原话），门禁必须在后端做。
 */
const GEO_MONITOR_GATED_PAYLOAD_FIELDS = [
  'competitors',
  'topCitations',
  'promptSuggestions',
  'contentSuggestions',
] as const

/**
 * `payload` 的形状版本号。
 *
 * 改 `buildPayload` 的**结构**（加字段不算，删/改字段算）时 +1，让前端能按版本
 * 分支渲染。历史快照不会被重写，所以两代形状会长期共存——没有版本号的话，
 * 渲染器只能靠"这个字段在不在"去猜，而那种猜法在第三代时就撑不住了。
 */
export const GEO_REPORT_PAYLOAD_VERSION = 1

/** 报表里引用榜取前几名。 */
const TOP_CITATION_LIMIT = 10

@Injectable()
export class GeoReportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(GeoBrandService) private readonly brands: GeoBrandService,
    @Inject(GeoEngineService) private readonly engineCatalog: GeoEngineService,
    // 字段级付费门禁用（见文件头 `GEO_MONITOR_GATED_PAYLOAD_FIELDS`）。与
    // `QuotaService` 同一个模式：直接注入网关，`tenantId` 用 `requireTenantId()`
    // 从上下文取，不接受调用方传参——报表详情从来只在"当前登录租户"的语境里被读。
    @Inject(PLATFORM_GATEWAY) private readonly billing: PlatformGateway,
  ) {}

  // ── 读 ──────────────────────────────────────────────────────────────────

  /** 报表列表（不含 payload）。 */
  async list(query: ListGeoReportQueryDto): Promise<PageResult<GeoReportView>> {
    const { page, pageSize } = normalizePage(query)

    const where: Prisma.GeoReportWhereInput = {}
    if (query.brandId) where.brandId = query.brandId
    if (query.period) where.period = query.period as GeoReportPeriod

    const [rows, total] = await Promise.all([
      this.prisma.tenant.geoReport.findMany({
        where,
        orderBy: [{ periodStart: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        // **不选 payload**：它是几十 KB 的 Json，一页 20 条就是几百 KB，
        // 而列表页一个字段都用不上。
        select: {
          id: true,
          brandId: true,
          period: true,
          periodStart: true,
          periodEnd: true,
          status: true,
          createdAt: true,
        },
      }),
      this.prisma.tenant.geoReport.count({ where }),
    ])

    const nameById = await this.brandNames(rows.map((r) => r.brandId))
    return {
      items: rows.map((r) => ({
        id: r.id,
        brandId: r.brandId,
        brandName: nameById.get(r.brandId) ?? '',
        period: r.period as GeoReportPeriodLike,
        periodStart: dbDateToDateKey(r.periodStart),
        periodEnd: dbDateToDateKey(r.periodEnd),
        status: r.status as GeoReportStatusLike,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    }
  }

  /**
   * 报表详情（含 payload 快照，按 `geo.monitor` 闸门做字段级门禁）。
   *
   * ## 为什么门禁在这里做，不在控制器/路由层
   *
   * 路由级的功能闸门（`registry/features.ts` 的 `pathPrefixes`）只能整条路由
   * 放行或拦截，而报表详情**必须整条放行**（到期的店仍要看得到免费摘要那几个数字，
   * 见 `geo-report.controller.ts` 文件头「不进 pathPrefixes」的说明）——门禁的粒度
   * 落在"这条路由内的哪几个 JSON 字段"，路由层的粗粒度机制表达不了这件事。
   * 所以这里在拿到完整快照之后，读一次当前租户的闸门状态，按结果整体置空
   * {@link GEO_MONITOR_GATED_PAYLOAD_FIELDS} 那四个字段——`null` 而不是删掉这个 key，
   * 前端拿到的是"这个字段存在但需要升级"，不是"这个字段不存在"，两者对应不同的 UI。
   *
   * @throws 1240300 报表不存在或不属于本店
   */
  async get(id: string): Promise<GeoReportDetailView> {
    const row = await this.prisma.tenant.geoReport.findFirst({ where: { id } })
    if (!row) {
      throw new BizException(ErrorCode.CROSS_TENANT_FORBIDDEN, '报表不存在，或不属于当前店铺')
    }
    const nameById = await this.brandNames([row.brandId])
    const allowed = await this.billing.hasFeature(requireTenantId(), 'geo.monitor')
    return {
      id: row.id,
      brandId: row.brandId,
      brandName: nameById.get(row.brandId) ?? '',
      period: row.period as GeoReportPeriodLike,
      periodStart: dbDateToDateKey(row.periodStart),
      periodEnd: dbDateToDateKey(row.periodEnd),
      status: row.status as GeoReportStatusLike,
      createdAt: row.createdAt.toISOString(),
      payload: gatePayload(toPayload(row.payload), allowed),
    }
  }

  // ── 写 ──────────────────────────────────────────────────────────────────

  /**
   * 生成一份报表（同步）。已经存在同周期的那一份时**直接返回它**，不重新算。
   *
   * @throws 1240300 品牌不存在或不属于本店
   */
  async generate(dto: GenerateGeoReportDto): Promise<GeoReportDetailView> {
    const brand = await this.brands.requireBrand(dto.brandId)
    const periodStart = dto.periodStart
    const periodEnd = periodEndOf(dto.period, periodStart)

    const existing = await this.prisma.tenant.geoReport.findFirst({
      where: {
        brandId: brand.id,
        period: dto.period as GeoReportPeriod,
        periodStart: dateKeyToDbDate(periodStart),
      },
      select: { id: true },
    })
    if (existing) return this.get(existing.id)

    const payload = await this.buildPayload({
      brandId: brand.id,
      brandName: brand.name,
      period: dto.period,
      periodStart,
      periodEnd,
    })

    const row = await this.prisma.tenant.geoReport.create({
      data: autoTenantData<Prisma.GeoReportCreateInput>({
        brandId: brand.id,
        period: dto.period as GeoReportPeriod,
        periodStart: dateKeyToDbDate(periodStart),
        periodEnd: dateKeyToDbDate(periodEnd),
        payload: payload as unknown as Prisma.InputJsonValue,
        // 同步生成完就是 READY。`PENDING` 那一档留给以后真的做成异步任务时用
        // （那时才会有"建了行但还没算完"的中间态）。
        status: 'READY',
      }),
    })
    return this.get(row.id)
  }

  /**
   * 给周报 cron 用的幂等入口：已存在就回 `null`（表示这次跳过了），否则生成并回 id。
   *
   * 与 {@link GeoReportService.generate} 分开，是因为 cron 要能区分
   * 「这次真的生成了」与「本来就有」——它要把这个数字打进日志。
   * `generate` 对调用方（HTTP）来说两者没有区别，它只关心"给我那份报表"。
   */
  async generateIfAbsent(dto: GenerateGeoReportDto): Promise<string | null> {
    const brand = await this.brands.requireBrand(dto.brandId)
    const existing = await this.prisma.tenant.geoReport.findFirst({
      where: {
        brandId: brand.id,
        period: dto.period as GeoReportPeriod,
        periodStart: dateKeyToDbDate(dto.periodStart),
      },
      select: { id: true },
    })
    if (existing) return null
    const created = await this.generate(dto)
    return created.id
  }

  // ── 快照构造 ────────────────────────────────────────────────────────────

  /**
   * 把一个周期的数据算成一份快照。
   *
   * 形状（`version: 1`）：
   * ```
   * {
   *   version, brandId, brandName, period, periodStart, periodEnd, generatedAt,
   *   overview:     { days, answers, mentions, mentionRateBp, sovBp, avgPositionX100,
   *                   citationRateBp, sentimentAvgX100 },
   *   previous:     同 overview（上一等长周期，用来算环比）
   *   trend:        [{ date, answers, mentions, mentionRateBp, sovBp, avgPositionX100,
   *                    citationRateBp, sentimentAvgX100 }]
   *   engines:      [{ engineCode, engineName, ...度量列 }]
   *   competitors:  [{ competitorId, name, isBrand, mentions, mentionRateBp, sovBp,
   *                    avgPositionX100 }]
   *   topCitations: [{ domain, count, category, platform }]
   * }
   * ```
   *
   * 与看板的五条接口**故意同形**：T8 画报告页时可以直接复用看板的那几个组件，
   * 不用为报告再写一套渲染器。差别只有一个——看板的数字是现查的（会变），
   * 报告里的是快照（不会变）。
   */
  private async buildPayload(ctx: {
    brandId: string
    brandName: string
    period: GeoReportPeriodLike
    periodStart: string
    periodEnd: string
  }): Promise<Record<string, unknown>> {
    const { brandId, periodStart, periodEnd } = ctx
    const spanDays = daysBetween(periodStart, periodEnd)
    const prevEnd = shiftDateKey(periodStart, -1)
    const prevStart = shiftDateKey(prevEnd, -(spanDays - 1))

    const [summaryRows, prevRows, engineRows, competitorRows, nameByCode, topCitations, top1, prevTop1] =
      await Promise.all([
        this.readDaily(brandId, { engineCode: '', promptId: '' }, periodStart, periodEnd),
        this.readDaily(brandId, { engineCode: '', promptId: '' }, prevStart, prevEnd),
        this.readDaily(brandId, { engineCode: { not: '' }, promptId: '' }, periodStart, periodEnd),
        this.prisma.tenant.geoCompetitor.findMany({
          where: { brandId },
          select: { id: true, name: true },
        }),
        this.engineCatalog.nameByCode(),
        this.topCitations(brandId, periodStart, periodEnd),
        // 首位推荐率不是预聚合列（`GeoVisibilityDaily` 上没有这一维度），只能直接扫
        // `GeoMention`——见 `top1RateForRange` 的说明。只在生成报表这一步付这次代价
        // （一次带索引的 count，不是高频路径）。
        this.top1RateForRange(brandId, periodStart, periodEnd),
        this.top1RateForRange(brandId, prevStart, prevEnd),
      ])

    const overviewRollup = rollupDailyRows(summaryRows)
    const previousRollup = rollupDailyRows(prevRows)
    // 竞品提及总数（品牌自己不算）：SoV 的「分母为 0 → null」判定要用它，见
    // `geo-report.rules.ts` 的文件头说明。
    const competitorMentionsTotal = rollupCompetitorStats(
      summaryRows.map((r) => ({ answers: r.answers, competitorStats: parseCompetitorStats(r.competitorStats) })),
    ).reduce((sum, c) => sum + c.mentions, 0)
    const prevCompetitorMentionsTotal = rollupCompetitorStats(
      prevRows.map((r) => ({ answers: r.answers, competitorStats: parseCompetitorStats(r.competitorStats) })),
    ).reduce((sum, c) => sum + c.mentions, 0)

    const overview = overviewWithNullableSov(
      { ...overviewRollup, top1RateBp: top1 },
      competitorMentionsTotal,
    )
    const previous = overviewWithNullableSov(
      { ...previousRollup, top1RateBp: prevTop1 },
      prevCompetitorMentionsTotal,
    )
    const nameById = new Map(competitorRows.map((c) => [c.id, c.name]))

    const byEngine = new Map<string, DailyRowFromDb[]>()
    for (const r of engineRows) {
      const list = byEngine.get(r.engineCode) ?? []
      list.push(r)
      byEngine.set(r.engineCode, list)
    }

    return {
      version: GEO_REPORT_PAYLOAD_VERSION,
      brandId,
      brandName: ctx.brandName,
      period: ctx.period,
      periodStart,
      periodEnd,
      generatedAt: new Date().toISOString(),
      overview,
      previous,
      trend: summaryRows.map((r) => ({ date: dbDateToDateKey(r.date), ...metricsOf(r) })),
      engines: [...byEngine.entries()]
        .map(([engineCode, list]) => ({
          engineCode,
          engineName: nameByCode.get(engineCode) ?? engineCode,
          ...stripDays(rollupDailyRows(list)),
        }))
        .sort((a, b) => b.mentionRateBp - a.mentionRateBp || a.engineCode.localeCompare(b.engineCode)),
      // `competitorsWithNullableSov` 在这里整体重算一遍 null 语义：品牌与全部竞品
      // 共用同一个分母（品牌+竞品提及之和），必须放在数组拼好之后一次性处理，
      // 不能只改品牌那一条或只改竞品那些——见 `geo-report.rules.ts` 的函数说明。
      competitors: competitorsWithNullableSov([
        {
          competitorId: '',
          name: ctx.brandName,
          isBrand: true,
          mentions: overview.mentions,
          mentionRateBp: overview.mentionRateBp,
          sovBp: overview.sovBp ?? 0,
          avgPositionX100: overview.avgPositionX100,
        },
        ...rollupCompetitorStats(
          summaryRows.map((r) => ({
            answers: r.answers,
            competitorStats: parseCompetitorStats(r.competitorStats),
          })),
        ).map((c) => ({
          competitorId: c.competitorId,
          name: nameById.get(c.competitorId) ?? '已删除的竞品',
          isBrand: false,
          mentions: c.mentions,
          mentionRateBp: c.mentionRateBp,
          sovBp: c.sovBp,
          avgPositionX100: c.avgPositionX100,
        })),
      ]),
      topCitations,
      // 「先诊断后付费」编排链路（诊断完成后由 `GeoDiagnosisService.finalizeReport`
      // 补写）用的两个字段。WEEKLY/MONTHLY 报表不跑那条编排，恒为空数组——
      // 空数组而不是不带这个 key：payload 形状对所有周期保持一致，前端不用先判
      // 「这个字段存不存在」再判「是不是空」。
      promptSuggestions: [] as GeoDiagnosisPromptSuggestion[],
      contentSuggestions: [] as GeoDiagnosisContentSuggestion[],
    }
  }

  /**
   * 一段日期内的首位推荐率（基点）。直接扫 `GeoQueryResult`/`GeoMention`，
   * **不读 `GeoVisibilityDaily`**——那张预聚合表没有"是不是排第一"这一维度
   * （`avgPositionX100` 是均值，不是"占比"），临时加一列意味着一次表结构迁移 +
   * 回填存量数据，代价与收益不成比例：这个指标只在生成报表这一步才需要，
   * 不是高频读路径，两次带索引的 `count`（`@@index([tenantId, brandId, answeredAt])`）
   * 足够便宜。
   */
  private async top1RateForRange(brandId: string, start: string, end: string): Promise<number> {
    const answeredAt = { gte: dayRangeOf(start).start, lt: dayRangeOf(end).endExclusive }
    const [answers, top1] = await Promise.all([
      this.prisma.tenant.geoQueryResult.count({ where: { brandId, status: 'OK', answeredAt } }),
      this.prisma.tenant.geoMention.count({
        where: { brandId, entityKind: 'BRAND', position: 1, answeredAt },
      }),
    ])
    return top1RateBp(top1, answers)
  }

  /** 读一段日期内、指定维度档位的日聚合行。 */
  private async readDaily(
    brandId: string,
    dims: { engineCode: Prisma.StringFilter | string; promptId: Prisma.StringFilter | string },
    start: string,
    end: string,
  ): Promise<DailyRowFromDb[]> {
    return this.prisma.tenant.geoVisibilityDaily.findMany({
      where: {
        brandId,
        engineCode: dims.engineCode,
        promptId: dims.promptId,
        date: { gte: dateKeyToDbDate(start), lte: dateKeyToDbDate(end) },
      },
      orderBy: [{ date: 'asc' }],
      select: {
        date: true,
        engineCode: true,
        answers: true,
        mentions: true,
        mentionRateBp: true,
        sovBp: true,
        avgPositionX100: true,
        citationRateBp: true,
        sentimentAvgX100: true,
        competitorStats: true,
      },
    })
  }

  /**
   * 周期内被引用最多的前 10 个域名。
   *
   * 这是报表里唯一一处扫明细（`GeoCitation`）——理由与 `citation/geo-citation.service.ts`
   * 的文件头一样：域名维度没有预聚合表，而报告里没有它就少了「AI 在拿谁的内容
   * 回答关于你的问题」这条最可操作的结论。
   */
  private async topCitations(
    brandId: string,
    start: string,
    end: string,
  ): Promise<Array<Record<string, unknown>>> {
    const answeredAt = {
      gte: dayRangeOf(start).start,
      lt: dayRangeOf(end).endExclusive,
    }
    const grouped = await this.prisma.tenant.geoCitation.groupBy({
      by: ['domain', 'category', 'platform'],
      where: { brandId, answeredAt },
      _count: { _all: true },
      orderBy: { _count: { domain: 'desc' } },
      take: TOP_CITATION_LIMIT,
    })
    return grouped.map((g) => ({
      domain: g.domain,
      count: g._count._all,
      category: g.category,
      platform: g.platform,
    }))
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
}

/** 从库里读出来的一行（`readDaily` 的 select 决定）。 */
interface DailyRowFromDb extends DailyRow {
  date: Date
  engineCode: string
  competitorStats: Prisma.JsonValue
}

/** 摘出度量列（趋势点用）。 */
function metricsOf(r: DailyRow): DailyRow {
  return {
    answers: r.answers,
    mentions: r.mentions,
    mentionRateBp: r.mentionRateBp,
    sovBp: r.sovBp,
    avgPositionX100: r.avgPositionX100,
    citationRateBp: r.citationRateBp,
    sentimentAvgX100: r.sentimentAvgX100,
  }
}

/** 引擎行不需要 `days`（那是"这个周期跑过几天"，对单个引擎没有独立意义）。 */
function stripDays(rollup: DailyRow & { days: number }): DailyRow {
  return metricsOf(rollup)
}

/**
 * 按周期类型推出结束日（含）。
 *
 * - `WEEKLY`：起始日 + 6 天；
 * - `MONTHLY`：起始日所在自然月的最后一天（**不是 +29 天**——2 月和 7 月不一样长，
 *   用固定天数会让 2 月的月报多出三天别人家的数据）；
 * - `ONE_SHOT`：就是 `periodStart` 本身（单日快照，诊断编排只跑一天的数据）。
 */
export function periodEndOf(period: GeoReportPeriodLike, periodStart: string): string {
  if (period === 'WEEKLY') return shiftDateKey(periodStart, 6)
  if (period === 'ONE_SHOT') return periodStart
  const d = dateKeyToDbDate(periodStart)
  // 下个月的第 0 天 = 这个月的最后一天。
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  return last.toISOString().slice(0, 10)
}

/** 两个 `YYYY-MM-DD` 之间的天数（含两端）。 */
function daysBetween(start: string, end: string): number {
  const ms = dateKeyToDbDate(end).getTime() - dateKeyToDbDate(start).getTime()
  return Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)) + 1)
}

/** `payload` 是 Json 列；不是对象时回空对象。 */
function toPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** `GeoReportService.get` 的字段级门禁：`allowed` 为假时把付费字段整体置 `null`。 */
function gatePayload(payload: Record<string, unknown>, allowed: boolean): Record<string, unknown> {
  if (allowed) return payload
  const out = { ...payload }
  for (const key of GEO_MONITOR_GATED_PAYLOAD_FIELDS) out[key] = null
  return out
}
