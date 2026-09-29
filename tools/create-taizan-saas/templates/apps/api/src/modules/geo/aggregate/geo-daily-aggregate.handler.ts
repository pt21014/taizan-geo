/**
 * `geo.daily.aggregate`：把一个品牌某一天的回答聚合成 `GeoVisibilityDaily`
 * （技术设计 §4.2）。
 *
 * ```
 * 读该品牌该天全部 GeoQueryResult（按 answeredAt 落在 Asia/Shanghai 的那一天）
 *   → 当天还有「OK 但 analyzedAt 为空」的？→ 抛，让 BullMQ 重试
 *   → 读同一天的 GeoMention
 *   → groupForDaily(results, mentions)   ← 纯函数，整数口径
 *   → 逐组 upsert GeoVisibilityDaily（唯一键 [tenantId, brandId, engineCode, promptId, date]）
 *   → queue.add('geo.alert.evaluate', { brandId, date })
 * ```
 *
 * ## 为什么要自己再判一次 `analyzedAt`
 *
 * `settle()` 已经要求「这一批」全部分析完才入队（T7 修正一）。但这里管的是
 * **「这一天」**，而这两个不是同一个集合：同一天可以有第二次手动跑批正在进行，
 * 也可以有昨天那一批的补投分析刚好落在今天的窗口边上。
 *
 * 判定口径是「当天有任何 `OK 且 analyzedAt 为空` 的结果 → 抛错」。抛出去让 BullMQ
 * 按 `attempts: 3` 重试，而不是「跳过那几条先算出来」——后者会写出一份偏低的可见度，
 * 而一份**错的**数字比没有数字危险得多：它会进趋势图、会触发「可见度下降」告警、
 * 会发出去一条假的短信，然后下一次重算把它悄悄改对，没有人知道曾经发生过什么。
 *
 * 三次重试都用完之后消息进死信，那一天就没有聚合行了——由
 * `geo-daily-aggregate.cron.ts`（`20 1 * * *`）在第二天凌晨兜底重算。
 *
 * ## 为什么是 `findFirst` + `create`/`update` 而不是 `upsert`
 *
 * `GeoVisibilityDaily` 的唯一键是 `[tenantId, brandId, engineCode, promptId, date]`，
 * 而 Prisma 的 `upsert` 要求 `where` 里给出**完整的**唯一键——也就是要手写
 * `tenantId`。那是 `test/arch/no-manual-tenant-filter.spec.ts`（spec 4）明令禁止的：
 * 租户条件由隔离扩展注入，业务代码一次都不该写。
 *
 * 所以这里按「非租户部分」`findFirst`，再决定 `create` 还是 `update`。
 * 竞态（两条聚合消息同时进来）由 `jobId` 挡掉；真撞上唯一键冲突时 Prisma 抛 P2002，
 * 让 BullMQ 重试一次即可——重试时那一行已经存在，走 `update` 分支。
 *
 * ## 重算是**覆盖**，不是累加
 *
 * 同一天被算第二次时（补投、兜底 cron、运维手工重放），每一组都是整组重新计算后
 * 覆盖写。`GeoVisibilityDaily` 上没有任何「增量」语义——它是一份可重算的派生数据，
 * 真源是 `GeoQueryResult` / `GeoMention`。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { AppLogger } from '@taizan/nest-core'
import {
  JobHandler,
  QueueService,
  type JobEnvelope,
  type JobProcessor,
} from '@taizan/nest-infra'
import { PrismaService } from '@taizan/nest-prisma'

import { autoTenantData, type AppPrismaService } from '../../../common/prisma.types'
import { GEO_ALERT_EVALUATE_JOB_NAME, GEO_DAILY_AGGREGATE_JOB_NAME } from '../run/geo-job-names'
import { alertJobId } from '../run/geo-run.rules'
import {
  dateKeyToDbDate,
  dayRangeOf,
  groupForDaily,
  type MentionRow,
  type Metrics,
  type ResultRow,
} from './geo-metrics.rules'

/** `geo.daily.aggregate` 的消息体。 */
export interface GeoDailyAggregatePayload {
  brandId: string
  /** `YYYY-MM-DD`（`geo-metrics.rules.ts` 的 `toDateKey`，Asia/Shanghai）。 */
  date: string
}

const CONTEXT = 'GeoDailyAggregate'

@Injectable()
@JobHandler({ name: GEO_DAILY_AGGREGATE_JOB_NAME, concurrency: 2, attempts: 3 })
export class GeoDailyAggregateHandler implements JobProcessor<GeoDailyAggregatePayload> {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async process(envelope: JobEnvelope<GeoDailyAggregatePayload>): Promise<void> {
    const { brandId, date } = envelope.data
    const { start, endExclusive } = dayRangeOf(date)
    const answeredWindow = { gte: start, lt: endExclusive }

    // 品牌被软删之后，历史回答仍然在库里（那是刻意的）。但没有品牌就没有
    // 「这个品牌的可见度」这回事，也不该再往趋势图里写新行。
    const brand = await this.prisma.tenant.geoBrand.findFirst({
      where: { id: brandId },
      select: { id: true },
    })
    if (!brand) {
      this.logger.warn(`品牌 ${brandId} 已经不在了，跳过 ${date} 的聚合`, CONTEXT)
      return
    }

    // ── 闸门：当天还有没分析完的回答就不算 ──────────────────────────────
    const unanalyzed = await this.prisma.tenant.geoQueryResult.count({
      where: { brandId, status: 'OK', analyzedAt: null, answeredAt: answeredWindow },
    })
    if (unanalyzed > 0) {
      // 抛出去 = 这次尝试失败，交给 BullMQ 的 attempts: 3 重试。见文件头。
      throw new Error(
        `品牌 ${brandId} 在 ${date} 还有 ${unanalyzed} 条回答没分析完，聚合先不算（等重试）`,
      )
    }

    // ── 取数 ────────────────────────────────────────────────────────────
    const [resultRows, mentionRows] = await Promise.all([
      this.prisma.tenant.geoQueryResult.findMany({
        where: { brandId, answeredAt: answeredWindow },
        select: { id: true, engineCode: true, promptId: true, status: true },
      }),
      this.prisma.tenant.geoMention.findMany({
        where: { brandId, answeredAt: answeredWindow },
        select: {
          resultId: true,
          entityKind: true,
          competitorId: true,
          position: true,
          isCited: true,
          sentimentScore: true,
        },
      }),
    ])

    if (resultRows.length === 0) {
      // 这一天这个品牌一条回答都没有。**不写任何行**——写一堆全零行会让报表显示
      // 「那天提及率 0%」，而事实是「那天没跑」。两者在图上长得一样，含义相反。
      this.logger.log(`品牌 ${brandId} 在 ${date} 没有回答，跳过聚合`, CONTEXT)
      return
    }

    const results: ResultRow[] = resultRows.map((r) => ({
      resultId: r.id,
      engineCode: r.engineCode,
      promptId: r.promptId,
      // 只有 OK 才算「回答了」。FAILED 的行留在 `results` 里是为了让
      // `groupForDaily` 认得出这个引擎/问法当天被跑过（于是产出一行 0 提及，
      // 而不是一行都没有）——「跑了没提到」和「没跑」在报表上必须能分开。
      answered: r.status === 'OK',
    }))
    const mentions: MentionRow[] = mentionRows.map((m) => ({
      resultId: m.resultId,
      entityKind: m.entityKind,
      ...(m.competitorId ? { competitorId: m.competitorId } : {}),
      position: m.position,
      isCited: m.isCited,
      sentimentScore: m.sentimentScore,
    }))

    // ── 聚合 + 落库 ─────────────────────────────────────────────────────
    const groups = groupForDaily(results, mentions)
    const dbDate = dateKeyToDbDate(date)
    for (const group of groups) {
      await this.writeDaily(brandId, group.engineCode, group.promptId, dbDate, group.metrics)
    }

    this.logger.log(
      `品牌 ${brandId} 在 ${date} 聚合完成：${resultRows.length} 条回答、` +
        `${mentionRows.length} 条提及、写了 ${groups.length} 行汇总`,
      CONTEXT,
    )

    // ── 派生告警评估 ────────────────────────────────────────────────────
    // 顺序不能反：告警比的是「今天 vs 昨天」的汇总行，聚合没写完就评估
    // 等于拿半份数据报警。`tenantId` 必须显式传（worker 侧没有 HTTP 请求）。
    const tenantId = envelope.originTenantId
    if (tenantId === undefined) {
      // 走到这里说明入队方漏传了 `tenantId`。上面的 `prisma.tenant` 已经跑通了，
      // 所以上下文是有的——但信封里没有，派生消息就没法带。记一条日志，
      // 聚合本身的成果不回滚（它已经落库了）。
      this.logger.warn(`聚合消息没带 tenantId，跳过派生告警评估（品牌 ${brandId}，${date}）`, CONTEXT)
      return
    }
    await this.queue.add(
      GEO_ALERT_EVALUATE_JOB_NAME,
      { brandId, date },
      { tenantId, jobId: alertJobId(tenantId, brandId, date) },
    )
  }

  /**
   * 写一行 `GeoVisibilityDaily`（存在就覆盖）。
   *
   * `where` 里**没有 `tenantId`**：租户条件由隔离扩展注入（spec 4）。
   * 剩下四列 `[brandId, engineCode, promptId, date]` 在本租户内已经唯一。
   */
  private async writeDaily(
    brandId: string,
    engineCode: string,
    promptId: string,
    date: Date,
    metrics: Metrics,
  ): Promise<void> {
    const data = {
      answers: metrics.answers,
      mentions: metrics.mentions,
      mentionRateBp: metrics.mentionRateBp,
      sovBp: metrics.sovBp,
      avgPositionX100: metrics.avgPositionX100,
      citationRateBp: metrics.citationRateBp,
      sentimentAvgX100: metrics.sentimentAvgX100,
      // `Record<string, CompetitorMetrics>` 与 Prisma 的 `InputJsonValue` 联合类型
      // 在结构上对不上（后者含数组分支），过一道 `unknown` 是 Prisma 文档里的标准写法。
      competitorStats: metrics.competitorStats as unknown as Prisma.InputJsonValue,
    }

    const existing = await this.prisma.tenant.geoVisibilityDaily.findFirst({
      where: { brandId, engineCode, promptId, date },
      select: { id: true },
    })
    if (existing) {
      await this.prisma.tenant.geoVisibilityDaily.update({ where: { id: existing.id }, data })
      return
    }
    await this.prisma.tenant.geoVisibilityDaily.create({
      data: autoTenantData<Prisma.GeoVisibilityDailyCreateInput>({
        brandId,
        engineCode,
        promptId,
        date,
        ...data,
      }),
    })
  }
}
