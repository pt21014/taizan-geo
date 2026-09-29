/**
 * 商家侧「本店 GEO 用量与成本」的数据访问层（技术设计 §4.1 usage 一行）。
 *
 * ## 全文没有一处 `tenantId`
 *
 * 与 `brand/geo-brand.service.ts` 同一条约定（`test/arch/no-manual-tenant-filter.spec.ts`，
 * spec 4）。平台侧的同名看板在 `geo-platform-usage.service.ts` 里，走
 * `RawPrismaService`——理由见那个文件的文件头。
 *
 * ## 两次 `groupBy` 而不是一次
 *
 * `GeoUsageLedger` 的读者要同时看"这个月钱花在了哪类事情上"（metric）与
 * "花在了哪个引擎上"（engineCode）。一次 `groupBy(['metric','engineCode'])` 能拿到
 * 两个维度的笛卡尔积，但那是给一张交叉表用的；这里的下发形状是两份各自独立的
 * 排行榜（前端各画一个饼图），在应用层把交叉表拆回两份反而要多写归并逻辑。
 * `where` 完全一致，两次查询走的是同一组索引（`@@index([tenantId, month, metric])`），
 * 代价可以接受。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '@taizan/nest-prisma'

import type { AppPrismaService } from '../../../common/prisma.types'
import { GeoBrandService } from '../brand/geo-brand.service'
import type {
  GeoUsageEngineBreakdownView,
  GeoUsageMetricBreakdownView,
  GeoUsageMetricLike,
  GeoUsageQueryDto,
  GeoUsageSummaryView,
} from './dto/geo-usage.dto'

/** `GeoUsageLedger.month` 的格式：`YYYY-MM`。与 `geo-query-execute.handler.ts` 落库时同一个口径。 */
function monthKeyOf(d: Date): string {
  return d.toISOString().slice(0, 7)
}

@Injectable()
export class GeoUsageService {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(GeoBrandService) private readonly brands: GeoBrandService,
  ) {}

  /**
   * 本店（或本店某个品牌）某个月的用量与成本汇总。
   *
   * @throws 1240300 brandId 不存在或不属于本店
   */
  async summary(query: GeoUsageQueryDto, now = new Date()): Promise<GeoUsageSummaryView> {
    const month = query.month ?? monthKeyOf(now)
    const brandId = query.brandId ? (await this.brands.requireBrand(query.brandId)).id : undefined

    const where = { month, ...(brandId ? { brandId } : {}) }

    const [byMetricRaw, byEngineRaw] = await Promise.all([
      this.prisma.tenant.geoUsageLedger.groupBy({
        by: ['metric'],
        where,
        _sum: { quantity: true, costCents: true },
      }),
      this.prisma.tenant.geoUsageLedger.groupBy({
        by: ['engineCode'],
        where,
        _sum: { quantity: true, costCents: true },
      }),
    ])

    const byMetric: GeoUsageMetricBreakdownView[] = byMetricRaw
      .map((g) => ({
        metric: g.metric as GeoUsageMetricLike,
        quantity: g._sum.quantity ?? 0,
        costCents: g._sum.costCents ?? 0,
      }))
      .sort((a, b) => b.costCents - a.costCents)

    const byEngine: GeoUsageEngineBreakdownView[] = byEngineRaw
      .map((g) => ({
        // 引擎无关的用量（LLM 分析）落库时 `engineCode` 为 null，见 `20-geo.prisma`。
        engineCode: g.engineCode ?? '',
        quantity: g._sum.quantity ?? 0,
        costCents: g._sum.costCents ?? 0,
      }))
      .sort((a, b) => b.costCents - a.costCents)

    return {
      month,
      brandId: brandId ?? '',
      // 用 `byMetric` 求和而不是再查一次 `aggregate`：两次查询之间可能刚好插进来
      // 一条新用量，那样 `totalCostCents` 会与 `byMetric` 的和对不上——
      // 现在这份汇总保证内部自洽（不变的是"与库里当前状态"完全一致，不保证瞬时一致）。
      totalCostCents: byMetric.reduce((sum, m) => sum + m.costCents, 0),
      byMetric,
      byEngine,
    }
  }
}
