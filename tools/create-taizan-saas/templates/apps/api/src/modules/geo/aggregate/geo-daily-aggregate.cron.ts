/**
 * 每日聚合兜底 cron（技术设计 §4.3 的 `geo-daily-aggregate`）：每天凌晨 1:20
 * 扫全平台的 `ACTIVE` 品牌，把**昨天**重算一遍。
 *
 * ## 它兜的是哪几件事
 *
 * 正常路径上 `geo.daily.aggregate` 由 `settle()` 在跑批收口时派生，
 * 一天里可能派生好几次（每批一次）。这条 cron 不是那条路径的替代，而是兜住三种漏：
 *
 * 1. **消息进了死信**：当天有回答一直没分析完，聚合的 3 次重试全用光（见 handler 文件头）；
 * 2. **跑批跨了零点**：23:50 发起的那一批在 00:10 收口，`settle()` 算出的 `date`
 *    是**今天**，而那一批的回答 `answeredAt` 大半落在**昨天**——昨天那一天从此
 *    没有人再去聚合它；
 * 3. **补投的分析**：`geo-run-sweeper.cron.ts` 补投的那些分析落库之后，
 *    当天的聚合行需要重算才能把新的提及算进去。
 *
 * 重算是**覆盖**（见 handler 文件头），所以「已经算过了」的那些品牌重来一遍
 * 只是多花一点数据库，结果完全一样。这就是它可以无脑扫全量的原因。
 *
 * ## 为什么是 1:20 而不是 0:05
 *
 * `geo-run-schedule` 是 `0 3 * * *`（凌晨 3 点发起当天的自动跑批）。1:20 落在
 * 「昨天那一批早就跑完」与「今天那一批还没开始」之间，扫到的品牌数据是稳定的。
 * 贴着零点跑的话，跨零点的那一批正在收口，等于和它抢同一天的数据。
 *
 * ## 扫描用 raw，入队用租户上下文
 *
 * 与 `geo-run-schedule.cron.ts` 完全同一招，理由见那个文件与
 * `tenancy/raw-reasons.ts` 的 `src/modules/geo/aggregate/` 那一条。
 * 这里其实只需要 `tenantId` 来填 `queue.add` 的信封，但仍然开一个真的租户上下文：
 * `QueueService.add` 会从上下文取 `traceId` 串链路，不开的话每条消息都是一条孤儿链路。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ulid } from '@taizan/contracts'
import { AppLogger, runWithContext } from '@taizan/nest-core'
import { LeaderCron, QueueService } from '@taizan/nest-infra'
import { RawPrismaService } from '@taizan/nest-prisma'

import type { AppPrismaClient } from '../../../common/prisma.types'
import { GEO_DAILY_AGGREGATE_JOB_NAME } from '../run/geo-job-names'
import { aggregateJobId } from '../run/geo-run.rules'
import { shiftDateKey, toDateKey } from './geo-metrics.rules'

const CONTEXT = 'GeoDailyAggregateCron'

/** 一次分页取多少个品牌。 */
const PAGE_SIZE = 200

/** 一次 cron tick 的产出，供测试与运维台断言。 */
export interface GeoDailyAggregateCronOutcome {
  /** 扫过的 ACTIVE 品牌数。 */
  scanned: number
  /** 真的入队了重算消息的品牌数。 */
  enqueued: number
  /** 入队失败的品牌数（不影响其它品牌）。 */
  errors: number
  /** 这次重算的是哪一天（`YYYY-MM-DD`）。 */
  date: string
}

/** 扫描时选的那点品牌信息。 */
interface BrandCandidate {
  id: string
  tenantId: string
}

@Injectable()
export class GeoDailyAggregateCron {
  constructor(
    // raw-reason: 平台域 cron 跨租户——兜底重算要扫全平台的 ACTIVE 品牌，
    // 不属于任何单一租户上下文。入队那一步会用 runWithContext 现开租户上下文。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  @LeaderCron({
    key: 'geo-daily-aggregate',
    cron: '20 1 * * *',
    lockTtlMs: 600_000,
    watchdog: true,
    timezone: 'Asia/Shanghai',
  })
  async run(now: Date = new Date()): Promise<GeoDailyAggregateCronOutcome> {
    // 「昨天」按品牌所在时区算（`toDateKey` 默认 Asia/Shanghai），不按进程时区——
    // 进程跑在 UTC 上时，北京时间 1:20 在 UTC 还是前一天 17:20，
    // 用 `now.getDate() - 1` 会算到前天去。
    const date = shiftDateKey(toDateKey(now), -1)
    const outcome: GeoDailyAggregateCronOutcome = { scanned: 0, enqueued: 0, errors: 0, date }
    let cursor: string | undefined

    for (;;) {
      // raw-reason: 平台域 cron 跨租户，游标分页不全表读。
      const page: BrandCandidate[] = await this.raw.client.geoBrand.findMany({
        where: { status: 'ACTIVE', deletedAt: null },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true, tenantId: true },
      })
      if (page.length === 0) break
      cursor = page[page.length - 1]?.id

      for (const brand of page) {
        outcome.scanned += 1
        await this.enqueueOne(brand, date, outcome)
      }
    }

    this.logger.log(
      `每日聚合兜底：扫描 ${outcome.scanned} 个品牌、入队重算 ${outcome.enqueued} 个（${date}）、失败 ${outcome.errors} 个`,
      CONTEXT,
    )
    return outcome
  }

  /** 在这个品牌所属租户的上下文里入队一次重算。失败只记账，不往外抛。 */
  private async enqueueOne(
    brand: BrandCandidate,
    date: string,
    outcome: GeoDailyAggregateCronOutcome,
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
          // `jobId` 与 `settle()` 用的是同一个构造（`agg-租户-品牌-日期`）：
          // 当天已经算过的那些，这条消息会被 BullMQ 按幂等键**丢掉**——
          // 而这正是要的行为，重算只该发生在真的还没算过的品牌上。
          //
          // 已知代价：情况 3（补投分析之后要重算）会因为这个 jobId 撞上而被丢掉，
          // 除非那条旧 job 已经被清理。真要强制重算，走运维手工重放死信那条路。
          await this.queue.add(
            GEO_DAILY_AGGREGATE_JOB_NAME,
            { brandId: brand.id, date },
            { tenantId: brand.tenantId, jobId: aggregateJobId(brand.tenantId, brand.id, date) },
          )
        },
      )
      outcome.enqueued += 1
    } catch (err) {
      outcome.errors += 1
      this.logger.error(
        `品牌 ${brand.id}（租户 ${brand.tenantId}）${date} 的兜底聚合入队失败：${messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
        CONTEXT,
      )
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
