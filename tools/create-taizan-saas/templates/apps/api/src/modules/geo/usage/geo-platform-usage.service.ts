/**
 * 平台侧「全平台 GEO 用量与成本看板」（`/api/platform/geo/usage`，
 * 技术设计 §4.1 usage(平台) 一行）。
 *
 * ## 为什么走 `RawPrismaService`
 *
 * 平台要按「租户 × 引擎」汇总全平台的 `GeoUsageLedger`（租户域表），还要读
 * `Tenant.name` 把租户 id 翻成店名（`Tenant` 是平台域表，没有 `tenantId` 列）。
 * 两件事都天然跨租户，走 `prisma.tenant` 会被隔离扩展当成未登记模型/无上下文直接抛。
 * 豁免登记在 `tenancy/raw-reasons.ts` 的 `src/modules/geo/usage/` 那一条——
 * `/api/platform/geo/usage` 与 `/api/platform/geo/runs` 是同一块平台看板，共用一条豁免。
 *
 * ## 一次 `groupBy(['tenantId','engineCode'])`，两个维度都从它归并
 *
 * 与商家侧 `geo-usage.service.ts` 不同：商家侧两个维度分两次查是因为各自能用上
 * 同一组索引、写法更直白。这里改成一次查询在应用层归并成两个维度，是因为
 * 「按租户」与「按引擎」两次 `groupBy` 都要扫全平台这张表的同一个月份分区，
 * 拆成两次意味着多扫一遍；这张表是全平台共享的，代价在这里比在单租户的
 * 商家侧更值得省。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { RawPrismaService } from '@taizan/nest-prisma'

import type { AppPrismaClient } from '../../../common/prisma.types'
import type {
  GeoPlatformUsageEngineView,
  GeoPlatformUsageQueryDto,
  GeoPlatformUsageSummaryView,
  GeoPlatformUsageTenantView,
} from './dto/geo-platform-usage.dto'

/** `GeoUsageLedger.month` 的格式：`YYYY-MM`。 */
function monthKeyOf(d: Date): string {
  return d.toISOString().slice(0, 7)
}

/** 归并用的累加桶。 */
interface Bucket {
  quantity: number
  costCents: number
}

function addInto(map: Map<string, Bucket>, key: string, quantity: number, costCents: number): void {
  const cur = map.get(key) ?? { quantity: 0, costCents: 0 }
  cur.quantity += quantity
  cur.costCents += costCents
  map.set(key, cur)
}

@Injectable()
export class GeoPlatformUsageService {
  constructor(
    // raw-reason: 平台成本看板天然跨租户，见文件头。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
  ) {}

  async summary(
    query: GeoPlatformUsageQueryDto,
    now = new Date(),
  ): Promise<GeoPlatformUsageSummaryView> {
    const month = query.month ?? monthKeyOf(now)

    // 与 `where:` 内联不同，这里先落一个变量再传（`test/arch/no-manual-tenant-filter.spec.ts`
    // 只认「`where` 紧跟 `:` 再跟 `{`」这个字面量形状，与 `citation/geo-citation.service.ts`
    // 等一样先落变量、不在 `where:` 后面直接写 `tenantId` 键）。这里的 `tenantId` 不是
    // 「业务代码自己决定查哪家店」的隔离条件，而是平台看板**可选的展示范围**——
    // 不传就是全平台，这正是 raw 句柄存在的理由（见文件头）。
    const where = { month, ...(query.tenantId ? { tenantId: query.tenantId } : {}) }
    // raw-reason: 横跨全部租户按「租户 × 引擎」汇总，见文件头。
    const grouped = await this.raw.client.geoUsageLedger.groupBy({
      by: ['tenantId', 'engineCode'],
      where,
      _sum: { quantity: true, costCents: true },
    })

    const byTenant = new Map<string, Bucket>()
    const byEngine = new Map<string, Bucket>()
    for (const g of grouped) {
      const quantity = g._sum.quantity ?? 0
      const costCents = g._sum.costCents ?? 0
      addInto(byTenant, g.tenantId, quantity, costCents)
      // 引擎无关的用量（LLM 分析）落库时 engineCode 为 null，见 `20-geo.prisma`。
      addInto(byEngine, g.engineCode ?? '', quantity, costCents)
    }

    // raw-reason: `Tenant` 是平台域表，把上面聚合出来的租户 id 翻成店名。
    const tenantIds = [...byTenant.keys()]
    const tenants =
      tenantIds.length === 0
        ? []
        : await this.raw.client.tenant.findMany({
            where: { id: { in: tenantIds } },
            select: { id: true, name: true },
          })
    const nameById = new Map(tenants.map((t) => [t.id, t.name]))

    const byTenantView: GeoPlatformUsageTenantView[] = [...byTenant.entries()]
      .map(([tenantId, v]) => ({
        tenantId,
        tenantName: nameById.get(tenantId) ?? '未知租户',
        quantity: v.quantity,
        costCents: v.costCents,
      }))
      .sort((a, b) => b.costCents - a.costCents)

    const byEngineView: GeoPlatformUsageEngineView[] = [...byEngine.entries()]
      .map(([engineCode, v]) => ({ engineCode, quantity: v.quantity, costCents: v.costCents }))
      .sort((a, b) => b.costCents - a.costCents)

    return {
      month,
      totalCostCents: byTenantView.reduce((sum, t) => sum + t.costCents, 0),
      byTenant: byTenantView,
      byEngine: byEngineView,
    }
  }
}
