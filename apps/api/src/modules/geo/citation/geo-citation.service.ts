/**
 * 引用来源的数据访问层（技术设计 §4.1 citation 一行）。
 *
 * ## 全文没有一处 `tenantId`
 *
 * 与 `brand/geo-brand.service.ts` 同一条约定（spec 4）。
 *
 * ## 这个模块**必须**扫明细表，与 dashboard 的约定相反
 *
 * `GeoVisibilityDaily` 里没有任何按域名/归类的维度——`competitorStats` 存的是竞品，
 * 不是来源。做一张「按域名的日聚合」在 P0 是过度设计：域名的基数不受控
 * （一个品牌一周可能引到几百个不同的站），预聚合表会比明细表还长。
 *
 * 所以这里直接查 `GeoCitation`，靠三件事控制代价：
 * 1. `answeredAt` 的时间窗（7/30/90 三档封顶，与看板同一份枚举）；
 * 2. 走 `@@index([tenantId, brandId, answeredAt])` 与 `@@index([tenantId, brandId, domain])`；
 * 3. 榜单类接口 `take 50`，明细类接口分页上限 200。
 *
 * ## 域名榜为什么不用 `groupBy` 拿 platform/category
 *
 * `groupBy(['domain'])` 只能给计数，而榜单上每一行还要显示平台标识与归类。
 * 把它们一起放进 `by` 里的话，同一个域名在归类规则改动前后会分成两行
 * （`GeoCitation.platform`/`category` 是**落库时的快照**，规则改了历史行不变——
 * 那是 `21-geo-platform.prisma` 刻意的设计）。
 *
 * 所以这里 `groupBy(['domain'])` 拿计数排出 top 50，再用一次 `findMany` 按
 * 「每个域名最近一条」补上平台与归类。「最近一条」= 当前规则下的判定，
 * 这正是运营想看的那一个（旧快照是历史，不是当前结论）。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { normalizePage, type PageResult } from '@taizan/contracts'
import { PrismaService } from '@taizan/nest-prisma'

import type { AppPrismaService } from '../../../common/prisma.types'
import { dayRangeOf, shiftDateKey, toDateKey } from '../aggregate/geo-metrics.rules'
import { GeoBrandService } from '../brand/geo-brand.service'
import {
  GEO_DASHBOARD_DEFAULT_DAYS,
  type GeoDashboardDays,
} from '../dashboard/dto/geo-dashboard.dto'
import type {
  GeoCitationCategoryView,
  GeoCitationDomainsView,
  GeoCitationDomainView,
  GeoCitationGapsView,
  GeoCitationPlatformsView,
  GeoCitationView,
  GeoCitationRangeQueryDto,
  GeoSourceCategoryLike,
  ListGeoCitationQueryDto,
} from './dto/geo-citation.dto'
import { buildGapItems, diffGapResultIds, type GapDomainCount, type GapSourceCategory } from './geo-citation-gap.rules'

/** 域名榜最多给多少行。见文件头。 */
const DOMAIN_TOP_N = 50

@Injectable()
export class GeoCitationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(GeoBrandService) private readonly brands: GeoBrandService,
  ) {}

  /**
   * 引用明细，分页，附问法原文。
   *
   * @throws 1240300 品牌不存在或不属于本店
   */
  async list(query: ListGeoCitationQueryDto, now = new Date()): Promise<PageResult<GeoCitationView>> {
    const brand = await this.brands.requireBrand(query.brandId)
    const { page, pageSize } = normalizePage(query)

    const where: Prisma.GeoCitationWhereInput = {
      brandId: brand.id,
      answeredAt: windowOf(query.days, now),
    }
    if (query.engineCode) where.engineCode = query.engineCode
    if (query.category) where.category = query.category
    if (query.domain) where.domain = query.domain

    const [rows, total] = await Promise.all([
      this.prisma.tenant.geoCitation.findMany({
        where,
        orderBy: [{ answeredAt: 'desc' }, { rank: 'asc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tenant.geoCitation.count({ where }),
    ])

    // 问法原文按这一页里出现过的 id 一次取回（N+1 会让一页 200 条变成 201 次查询）。
    const promptIds = [...new Set(rows.map((r) => r.promptId))]
    const prompts =
      promptIds.length === 0
        ? []
        : await this.prisma.tenant.geoPrompt.findMany({
            where: { id: { in: promptIds } },
            select: { id: true, text: true },
          })
    const textById = new Map(prompts.map((p) => [p.id, p.text]))

    return {
      items: rows.map(
        (r): GeoCitationView => ({
          id: r.id,
          resultId: r.resultId,
          promptId: r.promptId,
          // 问法被软删之后引用行还在。回空串而不是丢掉这一行——
          // 那条引用是真的发生过的，抹掉它会让域名榜与明细对不上。
          promptText: textById.get(r.promptId) ?? '',
          engineCode: r.engineCode,
          url: r.url,
          domain: r.domain,
          platform: r.platform,
          category: r.category as GeoSourceCategoryLike,
          rank: r.rank,
          title: r.title,
          answeredAt: r.answeredAt.toISOString(),
        }),
      ),
      total,
      page,
      pageSize,
    }
  }

  /** 域名榜：按被引用次数降序，top 50，附平台标识、归类与「是不是自有阵地」。 */
  async domains(query: GeoCitationRangeQueryDto, now = new Date()): Promise<GeoCitationDomainsView> {
    const brand = await this.brands.requireBrand(query.brandId)
    const days = query.days ?? GEO_DASHBOARD_DEFAULT_DAYS
    const where: Prisma.GeoCitationWhereInput = {
      brandId: brand.id,
      answeredAt: windowOf(query.days, now),
    }

    const [grouped, total] = await Promise.all([
      this.prisma.tenant.geoCitation.groupBy({
        by: ['domain'],
        where,
        _count: { _all: true },
        orderBy: { _count: { domain: 'desc' } },
        take: DOMAIN_TOP_N,
      }),
      this.prisma.tenant.geoCitation.count({ where }),
    ])

    const domains = grouped.map((g) => g.domain)
    // 每个域名的平台/归类取**最近一条**的快照，见文件头。一次查回来，
    // 按 answeredAt 升序遍历并覆盖写 Map，最后留下的就是每个域名最新的那一条。
    const latest =
      domains.length === 0
        ? []
        : await this.prisma.tenant.geoCitation.findMany({
            where: { ...where, domain: { in: domains } },
            orderBy: [{ answeredAt: 'asc' }, { id: 'asc' }],
            select: { domain: true, platform: true, category: true },
          })
    const metaByDomain = new Map<string, { platform: string; category: GeoSourceCategoryLike }>()
    for (const row of latest) {
      metaByDomain.set(row.domain, {
        platform: row.platform,
        category: row.category as GeoSourceCategoryLike,
      })
    }

    return {
      brandId: brand.id,
      days,
      total,
      items: grouped.map((g): GeoCitationDomainView => {
        const meta = metaByDomain.get(g.domain)
        const category = meta?.category ?? 'OTHER'
        return {
          domain: g.domain,
          count: g._count._all,
          platform: meta?.platform ?? '',
          category,
          // 「自有阵地」= 归类为 OWNED。判据在 `analysis/geo-citation.rules.ts` 的
          // `classifySource`（拿品牌域名比），这里只是把那个结论翻译成一个布尔值——
          // 不在这里重新拿 brand.domain 比一遍：两处判据迟早会不一致，
          // 而落库时那一次才是真源（规则改了历史行不变，那是刻意的）。
          owned: category === 'OWNED',
        }
      }),
    }
  }

  /** 按归类聚合的占比（饼图数据源）。 */
  async platforms(
    query: GeoCitationRangeQueryDto,
    now = new Date(),
  ): Promise<GeoCitationPlatformsView> {
    const brand = await this.brands.requireBrand(query.brandId)
    const days = query.days ?? GEO_DASHBOARD_DEFAULT_DAYS
    const where: Prisma.GeoCitationWhereInput = {
      brandId: brand.id,
      answeredAt: windowOf(query.days, now),
    }

    const grouped = await this.prisma.tenant.geoCitation.groupBy({
      by: ['category'],
      where,
      _count: { _all: true },
    })
    // 分母用分组结果求和，不再查一次 `count`：两次查询之间可能刚好插进来一条新引用，
    // 那样占比加起来就不是 10000bp 了，而饼图上会看出一条缝。
    const total = grouped.reduce((a, g) => a + g._count._all, 0)

    const items: GeoCitationCategoryView[] = grouped
      .map((g) => ({
        category: g.category as GeoSourceCategoryLike,
        count: g._count._all,
        shareBp: total > 0 ? Math.round((g._count._all / total) * 10000) : 0,
      }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))

    return { brandId: brand.id, days, total, items }
  }

  /**
   * 引用缺口：竞品被提及、但本品牌完全没被提及的回答里，AI 实际引用了哪些第三方来源，
   * 附模板化内容优化建议。见 `geo-citation-gap.rules.ts` 文件头，为什么这是"回答层面"
   * 而不是"域名层面"的对比。
   *
   * 两步找缺口回答：① 这个品牌名下、时间窗内，哪些回答提到了竞品；② 这些回答里，
   * 哪些完全没有品牌自己的提及行——纯集合差，逻辑在 `diffGapResultIds`。
   * 再对缺口回答的引用行按域名聚合（排除 OWNED/COMPETITOR），取 top 50。
   */
  async gaps(query: GeoCitationRangeQueryDto, now = new Date()): Promise<GeoCitationGapsView> {
    const brand = await this.brands.requireBrand(query.brandId)
    const days = query.days ?? GEO_DASHBOARD_DEFAULT_DAYS
    const window = windowOf(query.days, now)

    const competitorMentions = await this.prisma.tenant.geoMention.findMany({
      where: { brandId: brand.id, entityKind: 'COMPETITOR', answeredAt: window },
      select: { resultId: true, entityName: true },
    })
    if (competitorMentions.length === 0) {
      return { brandId: brand.id, days, competitorNames: [], items: [] }
    }
    const candidateResultIds = [...new Set(competitorMentions.map((m) => m.resultId))]

    const brandMentions = await this.prisma.tenant.geoMention.findMany({
      where: { brandId: brand.id, entityKind: 'BRAND', resultId: { in: candidateResultIds } },
      select: { resultId: true },
    })
    const { gapResultIds, competitorNames } = diffGapResultIds(
      competitorMentions,
      brandMentions.map((m) => m.resultId),
    )
    if (gapResultIds.length === 0) {
      return { brandId: brand.id, days, competitorNames: [], items: [] }
    }

    const gapWhere: Prisma.GeoCitationWhereInput = {
      brandId: brand.id,
      resultId: { in: gapResultIds },
      category: { notIn: ['OWNED', 'COMPETITOR'] },
    }
    const grouped = await this.prisma.tenant.geoCitation.groupBy({
      by: ['domain'],
      where: gapWhere,
      _count: { _all: true },
      orderBy: { _count: { domain: 'desc' } },
      take: DOMAIN_TOP_N,
    })

    const domains = grouped.map((g) => g.domain)
    // 同一逻辑见 `domains()`：category/platform 是落库快照，取每个域名最近一条当前结论。
    const latest =
      domains.length === 0
        ? []
        : await this.prisma.tenant.geoCitation.findMany({
            where: { ...gapWhere, domain: { in: domains } },
            orderBy: [{ answeredAt: 'asc' }, { id: 'asc' }],
            select: { domain: true, platform: true, category: true },
          })
    const metaByDomain = new Map<string, { platform: string; category: GapSourceCategory }>()
    for (const row of latest) {
      metaByDomain.set(row.domain, { platform: row.platform, category: row.category as GapSourceCategory })
    }

    const rows: GapDomainCount[] = grouped.map((g) => {
      const meta = metaByDomain.get(g.domain)
      return {
        domain: g.domain,
        count: g._count._all,
        platform: meta?.platform ?? '',
        category: meta?.category ?? ('OTHER' as GapSourceCategory),
      }
    })

    return { brandId: brand.id, days, competitorNames, items: buildGapItems(rows) }
  }
}

/**
 * 把「回溯 N 天」变成 `answeredAt` 的区间条件。
 *
 * 与看板的周期口径**完全一致**：含今天、按 Asia/Shanghai 切天、右开。
 * 不一致的话，「域名榜里 taizan.com 有 12 次」与「看板说这周期引用率 100%、
 * 共 6 条回答」会对不上，而没有人能一眼看出是口径差还是数据错。
 */
function windowOf(days: GeoDashboardDays | undefined, now: Date): Prisma.DateTimeFilter {
  const n = days ?? GEO_DASHBOARD_DEFAULT_DAYS
  const today = toDateKey(now)
  const start = dayRangeOf(shiftDateKey(today, -(n - 1))).start
  const end = dayRangeOf(today).endExclusive
  return { gte: start, lt: end }
}
