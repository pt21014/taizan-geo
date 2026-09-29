/**
 * 周报生成 cron（技术设计 §4.3 的 `geo-weekly-report`）：每周一早上 8 点
 * 给全平台每个 `ACTIVE` 品牌生成**上周**（上周一到上周日）的 `GeoReport`。
 *
 * ## 为什么是周一 8:00
 *
 * 上周日的数据在 `geo-daily-aggregate`（周一 01:20 兜底重算周日那天）之后才齐。
 * 8:00 留了六个多小时的余量，同时又赶在商家上班之前——周报的用处就是
 * 「周一早上打开后台第一眼看到上周怎么样」。
 *
 * ## 幂等
 *
 * 走 `GeoReportService.generateIfAbsent`：唯一键是
 * `(tenantId, brandId, period, periodStart)`，已经有那一份就跳过。
 * 于是这个 cron 可以安全地重跑（部署重启、leader 切换、运维手工触发），
 * 不会产生第二份内容不同的"上周报告"——而那恰恰是最糟的情况：
 * 两份都叫"上周报告"，数字不一样，谁也说不清哪份是对的。
 *
 * ## 扫描用 raw，生成用租户上下文
 *
 * 与 `geo-run-schedule.cron.ts` 完全同一招。`GeoReportService` 全程 `prisma.tenant`，
 * 所以每个品牌都用 `runWithContext({ tenantId })` 现开一个上下文再调。
 * 豁免登记在 `tenancy/raw-reasons.ts` 的 `src/modules/geo/report/` 那一条上。
 *
 * ## 单个品牌失败不拖垮整批
 *
 * 每个品牌包在 try/catch 里。一个品牌的数据有问题（比如某天的
 * `competitorStats` 是脏的）不该让后面几百家店这周都没有报告。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ulid } from '@taizan/contracts'
import { AppLogger, runWithContext } from '@taizan/nest-core'
import { LeaderCron } from '@taizan/nest-infra'
import { RawPrismaService } from '@taizan/nest-prisma'

import type { AppPrismaClient } from '../../../common/prisma.types'
import { shiftDateKey, toDateKey } from '../aggregate/geo-metrics.rules'
import { GeoReportService } from './geo-report.service'

const CONTEXT = 'GeoWeeklyReportCron'

/** 一次分页取多少个品牌。 */
const PAGE_SIZE = 200

/** 一次 cron tick 的产出，供测试与运维台断言。 */
export interface GeoWeeklyReportOutcome {
  /** 扫过的 ACTIVE 品牌数。 */
  scanned: number
  /** 真的新生成的报告数。 */
  generated: number
  /** 本来就有（幂等跳过）的品牌数。 */
  skipped: number
  /** 单个品牌失败的次数（不影响其它品牌）。 */
  errors: number
  /** 这次生成的是哪一周（周一，`YYYY-MM-DD`）。 */
  periodStart: string
}

/** 扫描时选的那点品牌信息。 */
interface BrandCandidate {
  id: string
  tenantId: string
  name: string
}

/**
 * 算出「上一个完整周」的周一。
 *
 * `now` 是本周一时，回的是**上周一**（`-7`）。用「本周一减 7」而不是「今天减 7 再
 * 找那一周的周一」：后者在 cron 因故延迟到周二才跑时会算出同一个答案（好），
 * 但在周日跑时会算出**本周**（坏）——而 leader 切换导致的延迟是真的会发生的。
 *
 * 导出成纯函数是为了让调用方/测试能直接对着它断言，而不用操纵系统时钟。
 *
 * @param now - 判定用的时刻
 */
export function lastWeekMondayOf(now: Date): string {
  const today = toDateKey(now)
  // `getUTCDay()`：0=周日、1=周一。用 UTC 是因为 `dateKeyToDbDate` 把日期对齐到
  // UTC 零点，两者必须是同一套坐标（混用本地时区会在 UTC+8 的下午偏一天）。
  const dow = new Date(`${today}T00:00:00.000Z`).getUTCDay()
  // 周日（0）要往回退 6 天才到本周一，其余是 dow - 1。
  const backToMonday = dow === 0 ? 6 : dow - 1
  return shiftDateKey(today, -backToMonday - 7)
}

@Injectable()
export class GeoWeeklyReportCron {
  constructor(
    // raw-reason: 平台域 cron 跨租户——周报要扫全平台的 ACTIVE 品牌，
    // 不属于任何单一租户上下文。生成那一步会用 runWithContext 现开租户上下文。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(GeoReportService) private readonly reports: GeoReportService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  @LeaderCron({
    key: 'geo-weekly-report',
    cron: '0 8 * * 1',
    lockTtlMs: 600_000,
    watchdog: true,
    timezone: 'Asia/Shanghai',
  })
  async run(now: Date = new Date()): Promise<GeoWeeklyReportOutcome> {
    const periodStart = lastWeekMondayOf(now)
    const outcome: GeoWeeklyReportOutcome = {
      scanned: 0,
      generated: 0,
      skipped: 0,
      errors: 0,
      periodStart,
    }
    let cursor: string | undefined

    for (;;) {
      // raw-reason: 平台域 cron 跨租户，游标分页不全表读。
      const page: BrandCandidate[] = await this.raw.client.geoBrand.findMany({
        where: { status: 'ACTIVE', deletedAt: null },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true, tenantId: true, name: true },
      })
      if (page.length === 0) break
      cursor = page[page.length - 1]?.id

      for (const brand of page) {
        outcome.scanned += 1
        await this.generateOne(brand, periodStart, outcome)
      }
    }

    this.logger.log(
      `周报生成（${periodStart} 那一周）：扫描 ${outcome.scanned} 个品牌、` +
        `新生成 ${outcome.generated} 份、已存在跳过 ${outcome.skipped} 份、失败 ${outcome.errors} 个`,
      CONTEXT,
    )
    return outcome
  }

  /** 在这个品牌所属租户的上下文里生成一份。失败只记账，不往外抛。 */
  private async generateOne(
    brand: BrandCandidate,
    periodStart: string,
    outcome: GeoWeeklyReportOutcome,
  ): Promise<void> {
    try {
      await runWithContext(
        {
          traceId: ulid(),
          tenantId: brand.tenantId,
          ip: { client: 'cron', edge: 'cron' },
          startedAt: Date.now(),
        },
        async () => {
          const id = await this.reports.generateIfAbsent({
            brandId: brand.id,
            period: 'WEEKLY',
            periodStart,
          })
          if (id === null) outcome.skipped += 1
          else outcome.generated += 1
        },
      )
    } catch (err) {
      outcome.errors += 1
      this.logger.error(
        `品牌「${brand.name}」（租户 ${brand.tenantId}）周报生成失败：${messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
        CONTEXT,
      )
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
