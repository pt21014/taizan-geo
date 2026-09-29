/**
 * 月度配额重置 cron（技术设计 §1.1 D4 第 3 条、§4.3 的 `geo-quota-month-reset`）。
 *
 * ## 它存在的全部理由
 *
 * 框架的配额是**存量型**的：`quota.consume` 加一、`quota.release` 减一，
 * `QuotaCounter` 上既没有 `periodStart` 列，也没有任何周期概念（这一点是 T3 期间
 * 把全仓 grep 过一遍确认的）。而 `GEO_QUERY_MONTHLY` / `GEO_CONTENT_MONTHLY`
 * 这两档卖的是「每个月多少次」——它们是**流量型**的。
 *
 * 两种语义的差额就靠这一个 cron 抹平：每月 1 号 00:05 把这两档的 `used` 置 0。
 *
 * 为什么不给这两档自建一张带周期的计数表：那等于在配额这件事上出现第二套实现，
 * 而「哪一套说了算」这个问题会在第一次对不上账的时候变成一天的排查。
 *
 * ## 已知代价：重置那一刻的 in-flight job 可能多算 1–2 次
 *
 * 00:05 时如果正好有 `geo.query.execute` 在跑（跨月的长跑批、或者重试退避到了这一刻），
 * 它可能在 `used = 0` 落库之后才 `consume`，于是上个月的那一次被算进了新的一个月；
 * 反过来也可能一次 `release` 把新月份的计数减掉一个。
 *
 * **这个代价是认下来的**，不是漏掉的：
 * - 量级是每租户 1–2 次，而月度额度是几百到几千，误差在千分之几；
 * - 要消掉它就得引入「按月分桶的计数键」，也就是上面说的第二套实现；
 * - 选 00:05 而不是 00:00，本身就是为了错开整点那一批最密集的定时任务。
 *
 * ## 为什么走 `RawPrismaService`
 *
 * `QuotaCounter` 是**租户域表**，但这次写是**跨全部租户**的一条 `updateMany`——
 * cron 没有租户上下文，`prisma.tenant` 在这里会正确地抛。豁免登记在
 * `tenancy/raw-reasons.ts` 的 `src/modules/geo/run/` 那一条上。
 *
 * 用一条 `updateMany` 而不是逐租户处理：这一步没有任何逐行判断
 * （与 `expire-notify.cron.ts` 必须逐个算 `daysLeft` 相反），
 * 一条 SQL 能做完的事不该变成几万次往返。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@taizan/nest-core'
import { LeaderCron } from '@taizan/nest-infra'
import { RawPrismaService } from '@taizan/nest-prisma'

import type { AppPrismaClient } from '../../../common/prisma.types'

const CONTEXT = 'GeoQuotaMonthResetCron'

/**
 * 要清零的配额档位。
 *
 * **只有这两档**：`GEO_BRAND` / `GEO_PROMPT` / `GEO_ENGINE` 是存量型的
 * （品牌删了才减一），把它们一起清零等于把所有商家的用量一笔勾销——
 * 下个月每家店都能再建一遍已有的品牌，而配额形同虚设。
 */
export const GEO_MONTHLY_QUOTA_KINDS = ['GEO_QUERY_MONTHLY', 'GEO_CONTENT_MONTHLY'] as const

/** 一次 cron tick 的产出，供测试与运维台断言。 */
export interface GeoQuotaResetOutcome {
  /** 被置 0 的 `QuotaCounter` 行数。 */
  reset: number
}

@Injectable()
export class GeoQuotaMonthResetCron {
  constructor(
    // raw-reason: 平台域 cron 跨租户——月度配额重置是一次覆盖全部租户的 updateMany，
    // 不属于任何单一租户上下文（QuotaCounter 是租户域表，但这次写跨全部租户）。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  @LeaderCron({
    key: 'geo-quota-month-reset',
    cron: '5 0 1 * *',
    lockTtlMs: 300_000,
    watchdog: true,
    timezone: 'Asia/Shanghai',
  })
  async run(): Promise<GeoQuotaResetOutcome> {
    // raw-reason: 平台域 cron 跨租户——把两档月度配额的 used 一次性置 0，见文件头。
    const result = await this.raw.client.quotaCounter.updateMany({
      where: { kind: { in: [...GEO_MONTHLY_QUOTA_KINDS] } },
      // `version` 不动：`updateWithVersion` 的乐观锁是给并发的 consume/release 用的，
      // 而这一条是「把计数归零」——它本来就该覆盖掉任何 in-flight 的读值（见文件头）。
      data: { used: 0 },
    })

    this.logger.log(
      `月度配额重置：${result.count} 行 QuotaCounter 的 used 置 0（${GEO_MONTHLY_QUOTA_KINDS.join('、')}）`,
      CONTEXT,
    )
    return { reset: result.count }
  }
}
