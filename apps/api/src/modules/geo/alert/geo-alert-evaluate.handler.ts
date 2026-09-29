/**
 * `geo.alert.evaluate`：按当天与前一天的汇总行评估告警规则，落事件并发通知
 * （技术设计 §4.2 队列流最后一环、§1.5 通知通道）。
 *
 * ```
 * 读当天 / 前一天的 GeoVisibilityDaily 汇总行（engineCode='' && promptId=''）
 *   → 数当天的负面提及
 *   → 读该品牌启用中的 GeoAlertRule
 *   → evaluateAlertRules(rules, { today, yesterday, negativeCount, now, cooldownMs: 24h })
 *   → 逐条：建 GeoAlertEvent → notify.send(INBOX[, SMS]) → rule.lastFiredAt / event.notifiedAt
 * ```
 *
 * ## `concurrency: 1`
 *
 * 这是整条链上唯一一个**会往外发东西**的任务。并发跑的后果不是慢，是同一条规则
 * 被两条消息同时判定为"不在冷却期"，于是同一天发两条一样的短信——
 * 冷却期是靠 `lastFiredAt` 这个**读-判-写**实现的，它不是原子的。
 * 串行执行把这个窗口关掉，代价是告警评估慢一点，而它本来就是每天每品牌一次。
 *
 * ## 通知失败**不影响事件落库**
 *
 * `GeoAlertEvent` 先写、通知后发，通知失败只 catch + log，`notifiedAt` 留空。
 * 反过来（发成功了才落库）的后果是：短信厂商抖一下，这次告警就**彻底消失**了——
 * 没有事件、没有日志、没有人知道昨天品牌可见度掉了 30%。
 * 留一条 `notifiedAt = null` 的事件，至少运营在告警列表里看得到它，
 * 而「通知有没有送达」是次要的（站内信永远送得到，短信是锦上添花）。
 *
 * ## 收件人：**租户店主**，不是品牌的 `createdBy`
 *
 * `GeoBrand.createdBy` 存的是 `Staff.id`（租户域的员工行），而 `NotifyTarget.userId`
 * 在本仓的既有用法里是 **`StaffAccount.id`**（平台域的登录账号，一号多店的载体，
 * 见 `plan-lifecycle/expire-notify.cron.ts` 的 `to: { userId: tenant.ownerAccountId }`）。
 * 两者是不同的 id 空间，混用的表现是站内信写进了一个不存在的收件人——
 * 不报错，只是没人收得到。
 *
 * 把 `Staff.id` 翻成 `StaffAccount.id` 是能做的（`Staff.accountId`），但建品牌那个人
 * 未必还在职、未必是该收告警的人；而「可见度掉了」是一件**要老板知道**的事。
 * 所以 P0 统一发给租户店主（`Tenant.ownerAccountId`），短信发到
 * `StaffAccount.phone`。「按品牌配收件人」是 P1 的事（要在 `GeoAlertRule` 上加一列）。
 *
 * `Tenant` / `StaffAccount` 都是**平台域表**（没有 tenantId 列），所以取店主要走
 * `RawPrismaService`——豁免登记在 `tenancy/raw-reasons.ts` 的
 * `src/modules/geo/alert/` 那一条上。
 *
 * ## 为什么 INBOX 与 SMS 是两次 `send`
 *
 * 一次 `notify.send({ channels: ['INBOX','SMS'] })` 广播的是**同一个模板**的同一份正文。
 * 而短信与站内信要的文案不是一回事：短信按条计费、有签名、要短；站内信可以带
 * 完整的数值与对比。本仓既有的做法就是两个 key（`plan.expire.-7` 与
 * `plan.expire.-7.sms`，见 `@taizan/prisma-base` 的 `notify-templates.ts`），
 * 这里照办：`geo.alert.<kind>` 走 INBOX，`geo.alert.<kind>.sms` 走 SMS。
 *
 * 于是 `rule.channels` 的作用变成「要不要额外发一条短信」：`['INBOX']` 只发站内信，
 * `['INBOX','SMS']` 两条都发。这与 `validateChannels` 只允许这两种组合是配套的。
 *
 * @packageDocumentation
 */

import { Inject, Injectable, Optional } from '@nestjs/common'
import type { GeoAlertKind, Prisma } from '@prisma/client'
import { AppLogger } from '@taizan/nest-core'
import { JobHandler, type JobEnvelope, type JobProcessor } from '@taizan/nest-infra'
import { NotifyService } from '@taizan/nest-notify'
import { PrismaService, RawPrismaService } from '@taizan/nest-prisma'

import { autoTenantData, type AppPrismaClient, type AppPrismaService } from '../../../common/prisma.types'
import {
  dateKeyToDbDate,
  dayRangeOf,
  shiftDateKey,
} from '../aggregate/geo-metrics.rules'
import { GEO_ALERT_EVALUATE_JOB_NAME } from '../run/geo-job-names'
import { parseCompetitorStats } from '../dashboard/geo-dashboard.rules'
import {
  evaluateAlertRules,
  type AlertRuleConfig,
  type DailyPoint,
  type FiredAlert,
} from './geo-alert.rules'

/** `geo.alert.evaluate` 的消息体。 */
export interface GeoAlertEvaluatePayload {
  brandId: string
  /** `YYYY-MM-DD`（Asia/Shanghai）。 */
  date: string
}

const CONTEXT = 'GeoAlertEvaluate'

/** 冷却期：同一条规则 24 小时内只报一次。技术设计 §4.2。 */
const COOLDOWN_MS = 24 * 60 * 60 * 1000

/** 三种告警各自的站内信模板 key。SMS 版在它后面加 `.sms`。 */
export const GEO_ALERT_TEMPLATE_KEYS: Record<string, string> = {
  VISIBILITY_DROP: 'geo.alert.visibility-drop',
  COMPETITOR_OVERTAKE: 'geo.alert.competitor-overtake',
  NEGATIVE_MENTION: 'geo.alert.negative-mention',
}

@Injectable()
@JobHandler({ name: GEO_ALERT_EVALUATE_JOB_NAME, concurrency: 1, attempts: 3 })
export class GeoAlertEvaluateHandler implements JobProcessor<GeoAlertEvaluatePayload> {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    // raw-reason: 告警收件人是租户店主，挂在平台域表 Tenant.ownerAccountId 与
    // StaffAccount.phone 上（两张表都没有 tenantId 列）。见文件头。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(AppLogger) private readonly logger: AppLogger,
    // `@Optional()`：与 `expire-notify.cron.ts` 一致——没装 NotifyModule 的环境
    // （某些单测装配）仍然要能跑评估与落库，只是不发通知。
    @Optional() @Inject(NotifyService) private readonly notify?: NotifyService,
  ) {}

  async process(envelope: JobEnvelope<GeoAlertEvaluatePayload>): Promise<void> {
    const { brandId, date } = envelope.data
    const tenantId = envelope.originTenantId

    const brand = await this.prisma.tenant.geoBrand.findFirst({
      where: { id: brandId },
      select: { id: true, name: true },
    })
    if (!brand) {
      this.logger.warn(`品牌 ${brandId} 已经不在了，跳过 ${date} 的告警评估`, CONTEXT)
      return
    }

    const rules = await this.prisma.tenant.geoAlertRule.findMany({
      where: { brandId, enabled: true, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, kind: true, thresholdBp: true, enabled: true, lastFiredAt: true, channels: true },
    })
    if (rules.length === 0) return

    const today = await this.readPoint(brandId, date)
    if (!today) {
      // 当天没有汇总行 = 那天没跑。没有"今天"就没有可比的东西，
      // 而不是"今天提及率 0%"（那会让每个没跑的日子都报一次可见度暴跌）。
      this.logger.log(`品牌 ${brandId} 在 ${date} 没有汇总行，跳过告警评估`, CONTEXT)
      return
    }
    const yesterday = await this.readPoint(brandId, shiftDateKey(date, -1))
    const negativeCount = await this.countNegativeMentions(brandId, date)

    const configs: AlertRuleConfig[] = rules.map((r) => ({
      id: r.id,
      kind: r.kind,
      thresholdBp: r.thresholdBp,
      enabled: r.enabled,
      lastFiredAt: r.lastFiredAt,
    }))
    const now = new Date()
    const fired = evaluateAlertRules(configs, {
      today,
      ...(yesterday ? { yesterday } : {}),
      negativeCount,
      now,
      cooldownMs: COOLDOWN_MS,
    })
    if (fired.length === 0) return

    const channelsByRuleId = new Map(rules.map((r) => [r.id, toChannels(r.channels)]))
    const recipient = tenantId === undefined ? null : await this.findRecipient(tenantId)

    for (const alert of fired) {
      await this.handleOne(alert, {
        brandId,
        brandName: brand.name,
        date,
        now,
        ...(tenantId === undefined ? {} : { tenantId }),
        channels: channelsByRuleId.get(alert.ruleId) ?? ['INBOX'],
        recipient,
      })
    }
  }

  // ── 单条告警的落库与通知 ────────────────────────────────────────────────

  private async handleOne(
    alert: FiredAlert,
    ctx: {
      brandId: string
      brandName: string
      date: string
      now: Date
      tenantId?: string
      channels: string[]
      recipient: Recipient | null
    },
  ): Promise<void> {
    // 1) 先落事件。通知失败不回滚它，见文件头。
    const event = await this.prisma.tenant.geoAlertEvent.create({
      data: autoTenantData<Prisma.GeoAlertEventCreateInput>({
        ruleId: alert.ruleId,
        brandId: ctx.brandId,
        kind: alert.kind as GeoAlertKind,
        payload: { ...alert.payload, date: ctx.date } as unknown as Prisma.InputJsonValue,
      }),
    })

    // 2) 更新规则的冷却起点。**在通知之前**：通知慢/失败时冷却期照样生效，
    //    否则一条发不出去的短信会让这条规则每次评估都重新触发。
    await this.prisma.tenant.geoAlertRule.update({
      where: { id: alert.ruleId },
      data: { lastFiredAt: ctx.now },
    })

    // 3) 发通知。整段包在 try 里——它失败只意味着"这次没通知到"。
    const notified = await this.sendNotifications(alert, ctx)
    if (notified) {
      await this.prisma.tenant.geoAlertEvent.update({
        where: { id: event.id },
        data: { notifiedAt: new Date() },
      })
    }

    this.logger.log(
      `品牌「${ctx.brandName}」触发告警 ${alert.kind}（规则 ${alert.ruleId}，${ctx.date}）` +
        `，通知${notified ? '已发出' : '未发出'}`,
      CONTEXT,
    )
  }

  /**
   * 发站内信（必发）+ 短信（`channels` 含 SMS 且店主有手机号时）。
   *
   * @returns 至少有一条通知发出去了
   */
  private async sendNotifications(
    alert: FiredAlert,
    ctx: {
      brandName: string
      date: string
      tenantId?: string
      channels: string[]
      recipient: Recipient | null
    },
  ): Promise<boolean> {
    if (!this.notify || ctx.tenantId === undefined) return false
    if (!ctx.recipient) {
      this.logger.warn(`租户 ${ctx.tenantId} 找不到店主账号，告警只落库不通知`, CONTEXT)
      return false
    }

    const templateKey = GEO_ALERT_TEMPLATE_KEYS[alert.kind]
    if (templateKey === undefined) {
      // 走到这里说明新加了一种 GeoAlertKind 但没登记模板。`NotifyService.send`
      // 对未登记的 key 是**同步抛错**，那会让整条 job 失败并重试三次——
      // 而重试改变不了"模板没登记"这件事。先挡住。
      this.logger.error(`告警类型 ${alert.kind} 没有登记通知模板`, undefined, CONTEXT)
      return false
    }

    const vars = buildVars(alert, ctx.brandName, ctx.date)
    let sent = false

    try {
      await this.notify.send({
        tenantId: ctx.tenantId,
        templateKey,
        to: { userId: ctx.recipient.accountId },
        vars,
        channels: ['INBOX'],
        // 广播而不是降级：这里只有一个通道，`fallback` 的语义（第一个成功就停）
        // 用不上，而显式写 false 是任务书钉死的。
        fallback: false,
      })
      sent = true
    } catch (err) {
      this.logger.warn(`告警站内信发送失败（${templateKey}）：${messageOf(err)}`, CONTEXT)
    }

    if (ctx.channels.includes('SMS') && ctx.recipient.phone) {
      try {
        await this.notify.send({
          tenantId: ctx.tenantId,
          templateKey: `${templateKey}.sms`,
          to: { phone: ctx.recipient.phone },
          vars,
          channels: ['SMS'],
          fallback: false,
        })
        sent = true
      } catch (err) {
        this.logger.warn(`告警短信发送失败（${templateKey}.sms）：${messageOf(err)}`, CONTEXT)
      }
    }

    return sent
  }

  // ── 取数 ────────────────────────────────────────────────────────────────

  /**
   * 读某一天的全局汇总行（两个维度都是空串）。没有那一行时回 `undefined`——
   * `evaluateVisibilityDrop` 见到 `yesterday === undefined` 会**不触发**，
   * 那正是要的行为（没有基线就没有"下降"这回事）。
   */
  private async readPoint(brandId: string, date: string): Promise<DailyPoint | undefined> {
    const row = await this.prisma.tenant.geoVisibilityDaily.findFirst({
      where: { brandId, engineCode: '', promptId: '', date: dateKeyToDbDate(date) },
      select: { mentionRateBp: true, sovBp: true, sentimentAvgX100: true, competitorStats: true },
    })
    if (!row) return undefined
    return {
      mentionRateBp: row.mentionRateBp,
      sovBp: row.sovBp,
      sentimentAvgX100: row.sentimentAvgX100,
      competitorStats: parseCompetitorStats(row.competitorStats),
    }
  }

  /**
   * 当天的负面提及条数。
   *
   * 这是本 handler 里唯一一处扫明细表（`GeoMention`）——`GeoVisibilityDaily`
   * 上只有情感**均值**，而「出现了 3 条负面」与「均值偏负」是两回事：
   * 99 条中性 + 3 条极负面的均值几乎不动，但那 3 条恰恰是要报的。
   *
   * 走 `@@index([tenantId, brandId, answeredAt])`，一天的量级，代价可接受。
   */
  private async countNegativeMentions(brandId: string, date: string): Promise<number> {
    const { start, endExclusive } = dayRangeOf(date)
    return this.prisma.tenant.geoMention.count({
      where: {
        brandId,
        // 只数**本品牌**的负面提及。竞品的负面对商家不是坏消息。
        entityKind: 'BRAND',
        sentiment: 'NEGATIVE',
        answeredAt: { gte: start, lt: endExclusive },
      },
    })
  }

  /** 找这家店的店主账号（`Tenant.ownerAccountId` → `StaffAccount`）。见文件头。 */
  private async findRecipient(tenantId: string): Promise<Recipient | null> {
    // raw-reason: Tenant 是平台域表（没有 tenantId 列），这里按主键取店主账号 id。
    const tenant = await this.raw.client.tenant.findUnique({
      where: { id: tenantId },
      select: { ownerAccountId: true },
    })
    if (!tenant?.ownerAccountId) return null

    // raw-reason: StaffAccount 是平台域表（一号多店的载体），短信要它的手机号。
    const account = await this.raw.client.staffAccount.findUnique({
      where: { id: tenant.ownerAccountId },
      select: { id: true, phone: true },
    })
    if (!account) return null
    return { accountId: account.id, phone: account.phone ?? '' }
  }
}

/** 收件人：站内信要 `accountId`，短信要 `phone`。 */
interface Recipient {
  accountId: string
  phone: string
}

/** 库里 `channels` 是 Json 列。 */
function toChannels(value: unknown): string[] {
  if (!Array.isArray(value)) return ['INBOX']
  return value.filter((v): v is string => typeof v === 'string')
}

/**
 * 把 `FiredAlert.payload`（形状随 kind 变）摊平成模板变量。
 *
 * 全部转成字符串：`renderTemplate` 只做 `{{var}}` 的字面替换，给它一个数字
 * 在类型上就不成立。比率从基点换算成百分数（`1234bp` → `12.34%`）——
 * 模板文案里直接放 `{{deltaPercent}}%` 就对了，不用让运营去理解基点。
 */
function buildVars(alert: FiredAlert, brandName: string, date: string): Record<string, string> {
  const p = alert.payload
  const bp = (key: string): string => bpToPercent(p[key])
  return {
    brandName,
    date,
    kind: alert.kind,
    // VISIBILITY_DROP
    todayMentionRate: bp('todayMentionRateBp'),
    yesterdayMentionRate: bp('yesterdayMentionRateBp'),
    deltaPercent: bp('deltaBp'),
    thresholdPercent: bp('thresholdBp'),
    // COMPETITOR_OVERTAKE
    todayBrandSov: bp('todayBrandSovBp'),
    todayCompetitorSov: bp('todayCompetitorSovBp'),
    competitorId: String(p['competitorId'] ?? ''),
    // NEGATIVE_MENTION
    negativeCount: String(p['todayNegativeCount'] ?? 0),
    thresholdCount: String(p['thresholdCount'] ?? 0),
  }
}

/** `1234`（基点）→ `'12.34'`。非数字回 `'0'`。 */
function bpToPercent(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
  return (value / 100).toFixed(2)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
