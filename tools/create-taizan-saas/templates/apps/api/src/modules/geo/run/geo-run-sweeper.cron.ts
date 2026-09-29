/**
 * 跑批兜底清扫 cron（T7 补上 T6 留的那个缺口）。
 *
 * ## 它兜的是哪一个缺口
 *
 * `geo-query-execute.handler.ts` 的文件头写着：一条**可重试**的错误把 6 次尝试用光
 * 之后，消息进死信，而那条 `GeoQueryResult` 会一直停在 `PENDING`。
 * `resolveRunStatus` 见到 `pending > 0` 就回 `null`，于是这一批**永远不收口**——
 * run 永远停在 `RUNNING`，永远不会触发 `geo.daily.aggregate`，
 * 商家的看板上那一天永远是空的。而这件事**没有任何报警**：队列是正常的
 * （消息在死信里）、数据库是正常的（行都在）、只是没有人再往前推一步。
 *
 * T7 的 `settle` 把「完成」的定义收紧到「`OK` 且 `analyzedAt` 非空」之后，
 * 又多了一个同形的卡死点：一条**分析**永远失败的结果同样会把整批卡在 `RUNNING`。
 * 本文件一起兜。
 *
 * ## 判据：`RUNNING` 且 `startedAt` 早于 6 小时
 *
 * 6 小时是「正常跑批绝不可能还没结束」与「别把还在退避重试的那一批误杀」之间的取值：
 * `geo.query.execute` 的退避是 `exponential 5000ms × 6 次`，最坏情况约 5 分钟，
 * 加上 `geo.result.analyze` 的 3 次，一个数千条查询的大批次在限速下也是小时级以内。
 * 6 小时之后还在 `RUNNING`，就不是「慢」，是「卡住了」。
 *
 * ## 配额：**不 release**，这是查过之后的结论，不是漏掉
 *
 * 直觉上「把 PENDING 判 FAILED 就该把占掉的配额还回去」。核对
 * `geo-query-execute.handler.ts` 的 consume 时机之后，结论是**不该还**：
 *
 * | 这条 PENDING 是怎么来的 | 配额净效果 |
 * |---|---|
 * | 限速闸门就抛了（`acquire()` 不 ok） | 还没 `consume`，净 0 |
 * | `quota.consume` 自己抛了 1540301 | 没占上，净 0 |
 * | `adapter.ask()` 抛错 → catch 里 `release(1)` → 可重试就 rethrow | consume + release，净 0 |
 * | 消息根本没被消费（worker 下线 / Redis 被清） | 没跑过，净 0 |
 *
 * 也就是说 execute handler 的 consume/release 是**逐次尝试对称**的（那是它文件头
 * 「关于最后一次尝试」那一段刻意选的写法），所以走到本 cron 的 PENDING 行，
 * 配额上已经是平的。这里再 `release` 一次是**多还**——而 `release` 用的是
 * `Math.max(0, used - delta)`，多还的那一个会把**别的**查询占住的名额吃掉，
 * 表现是月底用量比实际少几次、配额静默放宽，没有任何错误。
 * `markFailed` 刻意不碰配额，也是同一条理由。
 *
 * **唯一真的会漏的窗口**是：进程恰好死在 `consume` 成功之后、catch 的 `release`
 * 之前（或者那次 `release` 本身失败并被 `.catch(() => undefined)` 吞掉）。
 * 这个窗口从库里**分辨不出来**——`GeoQueryResult` 上没有一列记录「这一行 consume 过没有」。
 * 在分辨不出来的情况下，选「少还」而不是「多还」：少还的代价是商家这个月少几次额度
 * （看得见、能人工补），多还的代价是配额闸门静默失效（看不见）。
 * 真要根治，得在表上加一列 `quotaConsumed Boolean`，那是一次 schema 变更，不在 T7 范围。
 *
 * ## 扫描用 raw，写与收口用租户上下文
 *
 * 与 `geo-run-schedule.cron.ts` 完全同一招：cron 不属于任何租户上下文，
 * 扫全平台的 run 只能走 `RawPrismaService`（豁免登记在 `tenancy/raw-reasons.ts`
 * 的 `src/modules/geo/run/` 那一条）；而 `settle()` 全程 `prisma.tenant`，
 * 所以每个 run 都用 `runWithContext({ tenantId })` 现开一个上下文再处理。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ulid } from '@taizan/contracts'
import { AppLogger, runWithContext } from '@taizan/nest-core'
import { LeaderCron, QueueService } from '@taizan/nest-infra'
import { PrismaService, RawPrismaService } from '@taizan/nest-prisma'

import type { AppPrismaClient, AppPrismaService } from '../../../common/prisma.types'
import { GEO_RESULT_ANALYZE_JOB_NAME } from './geo-job-names'
import { analyzeJobId } from './geo-run.rules'
import { GeoRunService } from './geo-run.service'

const CONTEXT = 'GeoRunSweeperCron'

/** 多久没结束算「卡住了」。见文件头。 */
export const GEO_RUN_STUCK_MS = 6 * 60 * 60 * 1000

/** 一次分页取多少个 run。 */
const PAGE_SIZE = 100

/** 判 FAILED 时写进 `errorKind` 的值。与引擎返回的 `TIMEOUT` 同名是刻意的——
 * 对商家来说它就是「这条超时了没跑出来」，`errorMessage` 里的 `sweeper` 区分来源。 */
const SWEEP_ERROR_KIND = 'TIMEOUT'
/** 判 FAILED 时写进 `errorMessage` 的值。任务书钉死的字面量，运维按它捞行。 */
const SWEEP_ERROR_MESSAGE = 'sweeper'

/** 一次 cron tick 的产出，供测试与运维台断言。 */
export interface GeoRunSweepOutcome {
  /** 扫到的卡住的 run 数。 */
  scanned: number
  /** 被判 FAILED 的 `GeoQueryResult` 行数。 */
  failedResults: number
  /** 补投的 `geo.result.analyze` 消息数（OK 但一直没分析的那些）。 */
  requeuedAnalyze: number
  /** 真的被收口（进了终态）的 run 数。 */
  settled: number
  /** 单个 run 处理失败的次数（不影响其它 run）。 */
  errors: number
}

/** 扫描时选的那点 run 信息。 */
interface StuckRun {
  id: string
  tenantId: string
  brandId: string
}

@Injectable()
export class GeoRunSweeperCron {
  constructor(
    // raw-reason: 平台域 cron 跨租户——兜底清扫要扫全平台卡在 RUNNING 的跑批，
    // 不属于任何单一租户上下文。真正的写与收口会用 runWithContext 现开租户上下文。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(GeoRunService) private readonly runs: GeoRunService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  @LeaderCron({
    key: 'geo-run-sweeper',
    cron: '*/30 * * * *',
    lockTtlMs: 300_000,
    watchdog: true,
    timezone: 'Asia/Shanghai',
  })
  async run(now: Date = new Date()): Promise<GeoRunSweepOutcome> {
    const outcome: GeoRunSweepOutcome = {
      scanned: 0,
      failedResults: 0,
      requeuedAnalyze: 0,
      settled: 0,
      errors: 0,
    }
    const threshold = new Date(now.getTime() - GEO_RUN_STUCK_MS)
    let cursor: string | undefined

    for (;;) {
      // raw-reason: 平台域 cron 跨租户，游标分页不全表读。
      // `startedAt: { lt }` 已经排除了 startedAt 为空的行（NULL 比较不成立）——
      // 那种行是「dispatch 还没跑到」，它由 dispatch 的重试负责，不归本 cron 管。
      const page: StuckRun[] = await this.raw.client.geoQueryRun.findMany({
        where: { status: 'RUNNING', startedAt: { lt: threshold } },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true, tenantId: true, brandId: true },
      })
      if (page.length === 0) break
      cursor = page[page.length - 1]?.id

      for (const stuck of page) {
        outcome.scanned += 1
        await this.sweepOne(stuck, outcome)
      }
    }

    if (outcome.scanned > 0) {
      this.logger.warn(
        `跑批兜底清扫：${outcome.scanned} 个跑批卡在 RUNNING 超过 6 小时，` +
          `判失败 ${outcome.failedResults} 条、补投分析 ${outcome.requeuedAnalyze} 条、` +
          `收口 ${outcome.settled} 个、失败 ${outcome.errors} 个`,
        CONTEXT,
      )
    }
    return outcome
  }

  /** 在这个 run 所属租户的上下文里清扫一个。失败只记账，不往外抛。 */
  private async sweepOne(stuck: StuckRun, outcome: GeoRunSweepOutcome): Promise<void> {
    try {
      await runWithContext(
        {
          // 每个 run 一个新的 traceId：一次 tick 可能清扫上百个，共用一个 traceId
          // 的话日志会糊成一团，而「这一批为什么卡住」是按 run 问的。
          traceId: ulid(),
          tenantId: stuck.tenantId,
          // cron 没有客户端，填一个明确的哨兵值而不是 127.0.0.1（后者会让日志
          // 看起来像是有人从本机发了一个请求）。
          ip: { client: 'cron', edge: 'cron' },
          startedAt: Date.now(),
        },
        async () => {
          outcome.failedResults += await this.failPendingResults(stuck.id)
          outcome.requeuedAnalyze += await this.requeueStaleAnalyze(stuck)
          // `settle` 自己会判「还有没完成的就什么都不做」。补投分析那条路径上，
          // 这次多半仍然收不了口——下一个 tick（30 分钟后）会在分析落库之后收。
          const status = await this.runs.settle(stuck.id)
          if (status !== null) outcome.settled += 1
        },
      )
    } catch (err) {
      outcome.errors += 1
      this.logger.error(
        `跑批 ${stuck.id}（租户 ${stuck.tenantId}）兜底清扫失败：${messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
        CONTEXT,
      )
    }
  }

  /**
   * 把这一批还停在 `PENDING` 的结果判 FAILED，并把 `failedQueries` 加上去。
   *
   * 用一条 `updateMany` 而不是逐行 `update`：这一步没有任何逐行判断，
   * 每行都写同样的三个值。`errorMessage` 里已有的内容（最后一次尝试的错误详情）
   * 会被覆盖成 `sweeper`——那是刻意的，`errorKind` 保留了分类，
   * 而「这条是被 sweeper 判的」比「最后一次是 ECONNRESET」更要紧。
   *
   * **不碰配额**，理由见文件头「配额：不 release」。
   */
  private async failPendingResults(runId: string): Promise<number> {
    const answeredAt = new Date()
    const result = await this.prisma.tenant.geoQueryResult.updateMany({
      where: { runId, status: 'PENDING' },
      data: {
        status: 'FAILED',
        errorKind: SWEEP_ERROR_KIND,
        errorMessage: SWEEP_ERROR_MESSAGE,
        answeredAt,
      },
    })
    if (result.count > 0) {
      await this.prisma.tenant.geoQueryRun.update({
        where: { id: runId },
        data: { failedQueries: { increment: result.count } },
      })
    }
    return result.count
  }

  /**
   * 把「执行成功了、但 `analyzedAt` 一直是空」的结果重新投一遍分析。
   *
   * T7 的 `settle` 要求 `analyzedAt` 非空才算完成，所以这种行同样会把整批卡死。
   * 它与 PENDING 不同的地方是：**钱已经花了、正文已经在库里了**，判 FAILED 等于
   * 把一条有效回答扔掉（它的提及与引用本来是算得出来的）。所以这里补投一次分析，
   * 而不是判失败。
   *
   * 已知代价：`jobId` 仍然是 `analyzeJobId(resultId)`。如果 BullMQ 里那个 id 还在
   * （上一条消息还没被清理），这次 `add` 是一个静默的 no-op，要等它被清掉之后的
   * 下一个 tick 才真的投进去。这比换一个随机 jobId 好——后者会让「同一条回答
   * 被分析两遍」变成可能，而分析是 `deleteMany + createMany`，两遍并发跑会互相删。
   */
  private async requeueStaleAnalyze(stuck: StuckRun): Promise<number> {
    const rows = await this.prisma.tenant.geoQueryResult.findMany({
      where: { runId: stuck.id, status: 'OK', analyzedAt: null },
      select: { id: true },
      take: PAGE_SIZE,
    })
    for (const row of rows) {
      await this.queue.add(
        GEO_RESULT_ANALYZE_JOB_NAME,
        // 不带 `citations`：引擎返回的引用列表在 `GeoQueryResult` 上没有一列能存
        //（见 analyze handler 的文件头），补投时只能让它退回从正文抠 URL。
        // 有损但不是空，而卡死是彻底没有。
        { resultId: row.id },
        { tenantId: stuck.tenantId, jobId: analyzeJobId(row.id) },
      )
    }
    return rows.length
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
