/**
 * GEO 看板的数据访问层（技术设计 §4.1 dashboard 一行）。
 *
 * ## 全文没有一处 `tenantId`
 *
 * 与 `brand/geo-brand.service.ts` 同一条约定，`test/arch/no-manual-tenant-filter.spec.ts`
 * （spec 4）扫的就是这件事。
 *
 * ## 只查 `GeoVisibilityDaily`，一条明细都不扫
 *
 * 这是这个模块**唯一**的性能约定，也是 `GeoVisibilityDaily` 这张表存在的全部理由
 * （产品定义 §2：「报表只读它」）。看板是商家每天第一眼看的页面，而明细表
 * （`GeoQueryResult` / `GeoMention` / `GeoCitation`）是按「回答 × 实体」长的——
 * 一个跑了半年的品牌那里有几十万行。在请求路径上 `groupBy` 它们，表现是
 * 首页从 80ms 变成 8s，而且随着数据增长只会更慢。
 *
 * 唯一的例外是 `overview` 里那条「最近一次跑批」：它读 `GeoQueryRun`，
 * 但那是 `findFirst + orderBy + take 1`，走 `[tenantId, brandId, createdAt]` 索引，
 * 与数据量无关。
 *
 * ## 汇总行的取法：`engineCode` / `promptId` 用空串表示"这个维度上的汇总"
 *
 * 这是 `20-geo.prisma` 里定死的约定（用空串而不是 NULL，理由见那张表的注释）。
 * 于是四类查询各取一档：
 *
 * | 接口 | `engineCode` | `promptId` |
 * |---|---|---|
 * | overview / competitors | `''` | `''` |
 * | trend（不指定引擎） | `''` | `''` |
 * | trend（指定引擎） | 该引擎 | `''` |
 * | engines | 任意（排除 `''`） | `''` |
 * | prompts | `''` 或指定引擎 | 任意（排除 `''`） |
 *
 * **每一处都必须把另一个维度钉死**。漏掉 `promptId: ''` 的后果是：同一天的
 * 汇总行与每条 Prompt 的明细行被一起取出来求和，提及数凭空翻了 (Prompt 数 + 1) 倍，
 * 而提及率因为分母同样翻倍**看起来还是对的**——只有 `answers` 那个绝对数会露馅。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { normalizePage, type PageResult } from '@taizan/contracts'
import { PrismaService } from '@taizan/nest-prisma'

import type { AppPrismaService } from '../../../common/prisma.types'
import {
  dateKeyToDbDate,
  dbDateToDateKey,
  shiftDateKey,
  toDateKey,
} from '../aggregate/geo-metrics.rules'
import { GeoBrandService } from '../brand/geo-brand.service'
import { GeoEngineService } from '../engine/geo-engine.service'
import {
  diffRollup,
  parseCompetitorStats,
  rollupCompetitorStats,
  rollupDailyRows,
  type DailyRow,
} from './geo-dashboard.rules'
import {
  GEO_DASHBOARD_DEFAULT_DAYS,
  type GeoDashboardCompetitorsView,
  type GeoDashboardEnginesView,
  type GeoDashboardEngineQueryDto,
  type GeoDashboardOverviewView,
  type GeoDashboardPromptQueryDto,
  type GeoDashboardQueryDto,
  type GeoDashboardTrendView,
  type GeoEngineMetricsView,
  type GeoLastRunView,
  type GeoPromptMetricsView,
  type GeoRollupView,
  type GeoTrendPointView,
} from './dto/geo-dashboard.dto'

/** 从库里读出来的一行日聚合（只选看板要的列）。 */
interface DailyRowFromDb extends DailyRow {
  date: Date
  engineCode: string
  promptId: string
  competitorStats: Prisma.JsonValue
}

/** 一个周期的日期边界（都是 `YYYY-MM-DD`，都含）。 */
interface Period {
  start: string
  end: string
}

/** 当前周期与紧邻的上一等长周期。 */
function periodsOf(days: number, now: Date): { current: Period; previous: Period } {
  const today = toDateKey(now)
  return {
    // 含今天：商家今天早上看的就该是包含"今天已经跑出来的那部分"的数字。
    current: { start: shiftDateKey(today, -(days - 1)), end: today },
    // 紧邻、等长，不重叠：上一周期的最后一天是当前周期第一天的前一天。
    previous: { start: shiftDateKey(today, -(days * 2 - 1)), end: shiftDateKey(today, -days) },
  }
}

/** 把一个周期变成 `where.date` 的区间条件。`@db.Date` 按 UTC 零点对齐（见 `dateKeyToDbDate`）。 */
function dateRangeOf(period: Period): Prisma.DateTimeFilter {
  return { gte: dateKeyToDbDate(period.start), lte: dateKeyToDbDate(period.end) }
}

/** 看板要读的那几列。抽成常量是为了让五条查询选的列完全一致。 */
const DAILY_SELECT = {
  date: true,
  engineCode: true,
  promptId: true,
  answers: true,
  mentions: true,
  mentionRateBp: true,
  sovBp: true,
  avgPositionX100: true,
  citationRateBp: true,
  sentimentAvgX100: true,
  competitorStats: true,
} as const

@Injectable()
export class GeoDashboardService {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(GeoBrandService) private readonly brands: GeoBrandService,
    // 注入名刻意叫 `engineCatalog` 而不是 `engines`：本类有一个同名的公开方法
    // `engines()`，两者撞名时 TypeScript 报的是 `Duplicate identifier`，
    // 而真正的症状会是控制器调 `dashboard.engines(query)` 时拿到那个注入的 service。
    @Inject(GeoEngineService) private readonly engineCatalog: GeoEngineService,
  ) {}

  /**
   * 总览：当前周期 + 上一周期 + 环比 + 最近一次跑批。
   *
   * @throws 1240300 品牌不存在或不属于本店（`requireBrand` 抛，与品牌页同码）
   */
  async overview(query: GeoDashboardQueryDto, now = new Date()): Promise<GeoDashboardOverviewView> {
    const brand = await this.brands.requireBrand(query.brandId)
    const days = query.days ?? GEO_DASHBOARD_DEFAULT_DAYS
    const { current, previous } = periodsOf(days, now)

    // 一次查两个周期（`previous.start` 到 `current.end` 是连续的），回来再按日期切开。
    // 分两次查省不了什么（同一个索引区间），但会多一次往返。
    const rows = await this.readSummaryRows(brand.id, {
      start: previous.start,
      end: current.end,
    })
    const inPeriod = (p: Period) => (r: DailyRowFromDb) => {
      const key = dbDateToDateKey(r.date)
      return key >= p.start && key <= p.end
    }

    const cur = rollupDailyRows(rows.filter(inPeriod(current)))
    const prev = rollupDailyRows(rows.filter(inPeriod(previous)))

    return {
      brandId: brand.id,
      brandName: brand.name,
      days,
      current: { ...cur, start: current.start, end: current.end } satisfies GeoRollupView,
      previous: { ...prev, start: previous.start, end: previous.end } satisfies GeoRollupView,
      delta: diffRollup(cur, prev),
      lastRun: await this.lastRun(brand.id),
    }
  }

  /** 趋势：按日序列。可指定引擎（不指定看跨引擎汇总那一档）。 */
  async trend(query: GeoDashboardEngineQueryDto, now = new Date()): Promise<GeoDashboardTrendView> {
    const brand = await this.brands.requireBrand(query.brandId)
    const days = query.days ?? GEO_DASHBOARD_DEFAULT_DAYS
    const engineCode = query.engineCode ?? ''
    const { current } = periodsOf(days, now)

    const rows = await this.prisma.tenant.geoVisibilityDaily.findMany({
      // `promptId: ''` 必须写死——见文件头那张表。
      where: { brandId: brand.id, engineCode, promptId: '', date: dateRangeOf(current) },
      orderBy: [{ date: 'asc' }],
      select: DAILY_SELECT,
    })

    return {
      brandId: brand.id,
      days,
      engineCode,
      // **不补零**：没跑过的那天在图上应该是断点，不是"提及率 0%"。
      // 前端要连线的话自己决定怎么连，服务端不该替它编一个不存在的数据点。
      points: rows.map((r): GeoTrendPointView => ({ date: dbDateToDateKey(r.date), ...metricsOf(r) })),
    }
  }

  /** 每引擎的周期汇总（`promptId = ''`，排除跨引擎汇总那一行）。 */
  async engines(query: GeoDashboardQueryDto, now = new Date()): Promise<GeoDashboardEnginesView> {
    const brand = await this.brands.requireBrand(query.brandId)
    const days = query.days ?? GEO_DASHBOARD_DEFAULT_DAYS
    const { current } = periodsOf(days, now)

    const [rows, nameByCode] = await Promise.all([
      this.prisma.tenant.geoVisibilityDaily.findMany({
        where: {
          brandId: brand.id,
          // 排除 `''`：那是跨引擎汇总行，把它当成"一个叫空串的引擎"混进列表里，
          // 会得到一行合计值等于其它所有行之和的"幽灵引擎"。
          engineCode: { not: '' },
          promptId: '',
          date: dateRangeOf(current),
        },
        select: DAILY_SELECT,
      }),
      this.engineCatalog.nameByCode(),
    ])

    const byEngine = new Map<string, DailyRowFromDb[]>()
    for (const r of rows) {
      const list = byEngine.get(r.engineCode) ?? []
      list.push(r)
      byEngine.set(r.engineCode, list)
    }

    const items: GeoEngineMetricsView[] = []
    for (const [engineCode, list] of byEngine) {
      const rollup = rollupDailyRows(list)
      items.push({
        engineCode,
        // 平台把这个引擎删了之后仍然要显示得出来——退回 code 本身，
        // 比显示一个空名字有用（运营至少知道是哪一家）。
        engineName: nameByCode.get(engineCode) ?? engineCode,
        answers: rollup.answers,
        mentions: rollup.mentions,
        mentionRateBp: rollup.mentionRateBp,
        sovBp: rollup.sovBp,
        avgPositionX100: rollup.avgPositionX100,
        citationRateBp: rollup.citationRateBp,
        sentimentAvgX100: rollup.sentimentAvgX100,
      })
    }
    items.sort((a, b) => b.mentionRateBp - a.mentionRateBp || a.engineCode.localeCompare(b.engineCode))

    return { brandId: brand.id, days, items }
  }

  /**
   * 品牌 + 各竞品的对照。
   *
   * 竞品的数字来自汇总行的 `competitorStats`（Json 列），不是从 `GeoMention` 现算——
   * 那正是这一列存在的理由（`20-geo.prisma`：「它只被整体读走喂图表」）。
   *
   * 竞品名从 `GeoCompetitor` 现取：`competitorStats` 里只有 id。
   * 竞品被软删之后历史快照里仍然有它的 id，那一行会显示成 `已删除的竞品`——
   * 比显示一个 ULID 好，也比把它整行丢掉好（丢掉会让份额加起来不到 100%）。
   */
  async competitors(
    query: GeoDashboardQueryDto,
    now = new Date(),
  ): Promise<GeoDashboardCompetitorsView> {
    const brand = await this.brands.requireBrand(query.brandId)
    const days = query.days ?? GEO_DASHBOARD_DEFAULT_DAYS
    const { current } = periodsOf(days, now)

    const [rows, competitorRows] = await Promise.all([
      this.readSummaryRows(brand.id, current),
      this.prisma.tenant.geoCompetitor.findMany({
        where: { brandId: brand.id },
        select: { id: true, name: true },
      }),
    ])
    const nameById = new Map(competitorRows.map((c) => [c.id, c.name]))

    const brandRollup = rollupDailyRows(rows)
    const competitorRollups = rollupCompetitorStats(
      rows.map((r) => ({ answers: r.answers, competitorStats: parseCompetitorStats(r.competitorStats) })),
    )

    return {
      brandId: brand.id,
      days,
      items: [
        // 本品牌永远是第一行：这一页要回答的问题是「我和他们比怎么样」，
        // 把自己混在按份额排序的列表里，第一眼要先找自己在哪。
        {
          competitorId: '',
          name: brand.name,
          isBrand: true,
          mentions: brandRollup.mentions,
          mentionRateBp: brandRollup.mentionRateBp,
          sovBp: brandRollup.sovBp,
          avgPositionX100: brandRollup.avgPositionX100,
        },
        ...competitorRollups.map((c) => ({
          competitorId: c.competitorId,
          name: nameById.get(c.competitorId) ?? '已删除的竞品',
          isBrand: false,
          mentions: c.mentions,
          mentionRateBp: c.mentionRateBp,
          sovBp: c.sovBp,
          avgPositionX100: c.avgPositionX100,
        })),
      ],
    }
  }

  /**
   * 每条 Prompt 的周期汇总，按提及率降序，分页。
   *
   * 分页在**应用层**做（先把周期内的行全取出来、合完再切页），不在 SQL 里：
   * 要分的是「合计之后的 Prompt」，而库里一条 Prompt 在周期内有 N 行（每天一行），
   * SQL 的 `LIMIT` 切的是行不是 Prompt。周期上限 90 天 × 问法配额上限（几百条）
   * 是万行级，一次取回来完全在内存预算内。
   */
  async prompts(
    query: GeoDashboardPromptQueryDto,
    now = new Date(),
  ): Promise<PageResult<GeoPromptMetricsView>> {
    const brand = await this.brands.requireBrand(query.brandId)
    const days = query.days ?? GEO_DASHBOARD_DEFAULT_DAYS
    const engineCode = query.engineCode ?? ''
    const { page, pageSize } = normalizePage(query)
    const { current } = periodsOf(days, now)

    const rows = await this.prisma.tenant.geoVisibilityDaily.findMany({
      where: {
        brandId: brand.id,
        engineCode,
        // 排除 `''`：那是跨 Prompt 汇总行（等于 overview），不是某一条 Prompt。
        promptId: { not: '' },
        date: dateRangeOf(current),
      },
      select: DAILY_SELECT,
    })

    const byPrompt = new Map<string, DailyRowFromDb[]>()
    for (const r of rows) {
      const list = byPrompt.get(r.promptId) ?? []
      list.push(r)
      byPrompt.set(r.promptId, list)
    }

    const promptIds = [...byPrompt.keys()]
    const promptRows =
      promptIds.length === 0
        ? []
        : await this.prisma.tenant.geoPrompt.findMany({
            where: { id: { in: promptIds } },
            select: { id: true, text: true, topic: true, funnelStage: true },
          })
    const promptById = new Map(promptRows.map((p) => [p.id, p]))

    const items: GeoPromptMetricsView[] = []
    for (const [promptId, list] of byPrompt) {
      const rollup = rollupDailyRows(list)
      const prompt = promptById.get(promptId)
      items.push({
        promptId,
        // 问法被软删之后，历史汇总行还在。回空串而不是丢掉这一行：
        // 那几天的回答是真的跑过的，从榜单里抹掉它会让 answers 对不上。
        text: prompt?.text ?? '',
        topic: prompt?.topic ?? null,
        funnelStage: prompt?.funnelStage ?? 'UNKNOWN',
        answers: rollup.answers,
        mentions: rollup.mentions,
        mentionRateBp: rollup.mentionRateBp,
        sovBp: rollup.sovBp,
        avgPositionX100: rollup.avgPositionX100,
        citationRateBp: rollup.citationRateBp,
        sentimentAvgX100: rollup.sentimentAvgX100,
      })
    }
    items.sort((a, b) => b.mentionRateBp - a.mentionRateBp || a.promptId.localeCompare(b.promptId))

    return {
      items: items.slice((page - 1) * pageSize, page * pageSize),
      total: items.length,
      page,
      pageSize,
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** 取一段日期内的「全局汇总行」（两个维度都是空串）。 */
  private async readSummaryRows(brandId: string, period: Period): Promise<DailyRowFromDb[]> {
    return this.prisma.tenant.geoVisibilityDaily.findMany({
      where: { brandId, engineCode: '', promptId: '', date: dateRangeOf(period) },
      orderBy: [{ date: 'asc' }],
      select: DAILY_SELECT,
    })
  }

  /** 最近一次跑批。从没跑过时回 `null`（前端据它显示「还没跑过」）。 */
  private async lastRun(brandId: string): Promise<GeoLastRunView | null> {
    const row = await this.prisma.tenant.geoQueryRun.findFirst({
      where: { brandId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        status: true,
        triggeredBy: true,
        totalQueries: true,
        doneQueries: true,
        failedQueries: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
      },
    })
    if (!row) return null
    return {
      id: row.id,
      status: row.status,
      triggeredBy: row.triggeredBy,
      totalQueries: row.totalQueries,
      doneQueries: row.doneQueries,
      failedQueries: row.failedQueries,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }
  }
}

/** 把库里那一行的度量列摘出来（趋势点用）。 */
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
