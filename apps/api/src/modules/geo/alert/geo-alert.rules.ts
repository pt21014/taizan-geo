/**
 * 告警规则评估的业务规则纯函数（GEO P0 技术设计 §4.2 `geo.alert.evaluate`、§4.4 rules 清单）。
 *
 * 三种告警各自一个 `evaluateXxx` 纯函数，{@link evaluateAlertRules} 只是把"启用/冷却期"
 * 这两条与具体判定无关的前置条件抽出来，再按 `rule.kind` 分发给对应的 `evaluateXxx`。
 * 不读时钟：`now` 一律由调用方传入。
 *
 * @packageDocumentation
 */
import type { GeoAlertKind } from '@prisma/client'

/** 单个竞品当天的份额切面，与 `aggregate/geo-metrics.rules.ts` 的 `CompetitorMetrics` 同形
 * 但刻意不 import 那个文件——告警规则只需要 `sovBp`，没必要跟聚合模块耦合。 */
export interface CompetitorDailyStat {
  mentions: number
  mentionRateBp: number
  sovBp: number
  avgPositionX100: number
}

/** 一天的可见度快照（取自 `GeoVisibilityDaily` 某一行）。 */
export interface DailyPoint {
  mentionRateBp: number
  sovBp: number
  sentimentAvgX100: number
  /** key 是 competitorId。 */
  competitorStats: Record<string, CompetitorDailyStat>
}

/** {@link evaluateVisibilityDrop} 的返回。 */
export interface VisibilityDropResult {
  fired: boolean
  /** `yesterday.mentionRateBp - today.mentionRateBp`，正数表示下降了多少 bp；没有昨天数据时为 0。 */
  deltaBp: number
  payload: Record<string, unknown>
}

/**
 * 可见度（提及率）下降告警：`today.mentionRateBp <= yesterday.mentionRateBp - thresholdBp` 时触发。
 *
 * `yesterday` 缺失（品牌刚开始监测，还没有前一天的数据）时不触发——没有基线就没有"下降"
 * 这回事，不能拿 0 当昨天的提及率去比（那样品牌第一天就会立刻被判"暴跌"）。
 */
export function evaluateVisibilityDrop(
  today: DailyPoint,
  yesterday: DailyPoint | undefined,
  thresholdBp: number,
): VisibilityDropResult {
  if (!yesterday) return { fired: false, deltaBp: 0, payload: {} }

  const deltaBp = yesterday.mentionRateBp - today.mentionRateBp
  const fired = today.mentionRateBp <= yesterday.mentionRateBp - thresholdBp

  return {
    fired,
    deltaBp,
    payload: fired
      ? {
          kind: 'VISIBILITY_DROP',
          todayMentionRateBp: today.mentionRateBp,
          yesterdayMentionRateBp: yesterday.mentionRateBp,
          deltaBp,
          thresholdBp,
        }
      : {},
  }
}

/** {@link evaluateCompetitorOvertake} 的返回。 */
export interface CompetitorOvertakeResult {
  fired: boolean
  /** 反超品牌的那个竞品；`fired === false` 时不存在。 */
  competitorId?: string
  payload: Record<string, unknown>
}

/**
 * 竞品声量份额反超告警：昨天品牌 `sovBp >= 某竞品.sovBp`，今天 `< 该竞品.sovBp`。
 *
 * 按 `yesterday.competitorStats` 的 key 顺序（对象属性的插入顺序，即调用方构造
 * `DailyPoint` 时的顺序）依次判定，**返回第一个满足条件的竞品**——P0 的告警事件
 * 表按 `(brandId, kind)` 唯一（`GeoAlertRule` 是这样，`GeoAlertEvent` 没有这层唯一约束，
 * 但一次评估产出多条"被反超"事件对运营来说是噪音而不是信息），所以只报一个最值得
 * 关注的即可；如果真的同时被两个竞品反超，剩下那个会在下一次评估周期继续满足条件。
 */
export function evaluateCompetitorOvertake(
  today: DailyPoint,
  yesterday: DailyPoint | undefined,
): CompetitorOvertakeResult {
  if (!yesterday) return { fired: false, payload: {} }

  for (const competitorId of Object.keys(yesterday.competitorStats ?? {})) {
    const yesterdayCompetitorSovBp = yesterday.competitorStats[competitorId]?.sovBp ?? 0
    const todayCompetitorSovBp = today.competitorStats?.[competitorId]?.sovBp ?? 0
    const wasLeadingOrTied = yesterday.sovBp >= yesterdayCompetitorSovBp
    const nowTrailing = today.sovBp < todayCompetitorSovBp

    if (wasLeadingOrTied && nowTrailing) {
      return {
        fired: true,
        competitorId,
        payload: {
          kind: 'COMPETITOR_OVERTAKE',
          competitorId,
          yesterdayBrandSovBp: yesterday.sovBp,
          yesterdayCompetitorSovBp,
          todayBrandSovBp: today.sovBp,
          todayCompetitorSovBp,
        },
      }
    }
  }

  return { fired: false, payload: {} }
}

/** {@link evaluateNegativeMention} 的返回。 */
export interface NegativeMentionResult {
  fired: boolean
  payload: Record<string, unknown>
}

/**
 * 负面提及告警：当天负面提及数 `>= thresholdCount` 时触发。
 *
 * `thresholdCount <= 0` 视为"规则没配置有效阈值"，不触发——否则 0 条负面提及也会
 * 天天告警，那不是"负面提及告警"，是噪音源。
 */
export function evaluateNegativeMention(todayNegativeCount: number, thresholdCount: number): NegativeMentionResult {
  const count = Number.isFinite(todayNegativeCount) ? Math.trunc(todayNegativeCount) : 0
  const threshold = Number.isFinite(thresholdCount) ? Math.trunc(thresholdCount) : 0
  const fired = threshold > 0 && count >= threshold

  return {
    fired,
    payload: fired ? { kind: 'NEGATIVE_MENTION', todayNegativeCount: count, thresholdCount: threshold } : {},
  }
}

/**
 * 校验告警通道配置：只允许 `['INBOX']` 或 `['INBOX', 'SMS']`（顺序也要一致），
 * 不合法直接 `throw`。
 *
 * 与 `brand/geo-brand.rules.ts` 的 `validateBrandInput` 系列不同：那一系列的函数签名
 * 是"返回 violation 数组"，因为调用方要在同一次校验里收集多个字段的错误一起展示；
 * 这里的签名是任务书钉死的 `(channels: unknown) => string[]`——返回类型里没有第二个
 * 通道装错误，所以选择直接抛一个不依赖任何框架的 `Error`（不是 Nest 的 `BizException`，
 * 这个文件不能 import `@nestjs/*`）。调用方（T6/T7 的 `alert-rule.service.ts`）在
 * service 层 catch 住这个 `Error`，按 `apps/api` 的错误码约定转换成 `BizException`。
 */
export function validateChannels(channels: unknown): string[] {
  if (!Array.isArray(channels)) {
    throw new Error('告警通道必须是数组')
  }
  if (!channels.every((c): c is string => typeof c === 'string')) {
    throw new Error('告警通道必须全部是字符串')
  }

  const valid = ['INBOX'].join(',') === channels.join(',') || ['INBOX', 'SMS'].join(',') === channels.join(',')
  if (!valid) {
    throw new Error('告警通道只能是 ["INBOX"] 或 ["INBOX","SMS"]')
  }
  return [...channels]
}

/** 一条告警规则的最小切面（对应 `GeoAlertRule`）。 */
export interface AlertRuleConfig {
  id: string
  kind: GeoAlertKind
  /**
   * 阈值列，三种告警共用同一个 Int 列：`VISIBILITY_DROP`/`COMPETITOR_OVERTAKE` 语义是
   * 基点（bp），`NEGATIVE_MENTION` 语义是条数——这是 `GeoAlertRule` schema 本身的设计
   * （单表单列，没有为每种 kind 单独开一列），不是这个函数编出来的。
   */
  thresholdBp: number
  enabled: boolean
  lastFiredAt?: Date | null
}

/** {@link evaluateAlertRules} 的上下文。 */
export interface EvaluateAlertRulesContext {
  today: DailyPoint
  yesterday?: DailyPoint
  negativeCount: number
  now: Date
  /** 冷却期毫秒数，典型值 24 小时（`24 * 60 * 60 * 1000`）。 */
  cooldownMs: number
}

/** {@link evaluateAlertRules} 的一条输出，直接对应一条要建的 `GeoAlertEvent`。 */
export interface FiredAlert {
  ruleId: string
  kind: GeoAlertKind
  payload: Record<string, unknown>
}

function isInCooldown(lastFiredAt: Date | null | undefined, now: Date, cooldownMs: number): boolean {
  if (!lastFiredAt) return false
  return now.getTime() - lastFiredAt.getTime() < cooldownMs
}

function evaluateOneRule(rule: AlertRuleConfig, ctx: EvaluateAlertRulesContext): Record<string, unknown> | null {
  switch (rule.kind) {
    case 'VISIBILITY_DROP': {
      const r = evaluateVisibilityDrop(ctx.today, ctx.yesterday, rule.thresholdBp)
      return r.fired ? r.payload : null
    }
    case 'COMPETITOR_OVERTAKE': {
      const r = evaluateCompetitorOvertake(ctx.today, ctx.yesterday)
      return r.fired ? r.payload : null
    }
    case 'NEGATIVE_MENTION': {
      const r = evaluateNegativeMention(ctx.negativeCount, rule.thresholdBp)
      return r.fired ? r.payload : null
    }
    default:
      return null
  }
}

/**
 * 批量评估一个品牌的全部告警规则。跳过两类规则：`enabled === false` 的；
 * 以及还在冷却期内的（`now - lastFiredAt < cooldownMs`——避免同一条规则连续几天
 * 都满足触发条件时，每天都建一条 `GeoAlertEvent` 疯狂发通知）。
 *
 * 不在这里更新 `lastFiredAt`：这个函数是纯函数，不产生副作用；调用方建完
 * `GeoAlertEvent` 之后自己去写 `GeoAlertRule.lastFiredAt = now`。
 */
export function evaluateAlertRules(rules: AlertRuleConfig[], ctx: EvaluateAlertRulesContext): FiredAlert[] {
  const out: FiredAlert[] = []
  for (const rule of rules ?? []) {
    if (!rule.enabled) continue
    if (isInCooldown(rule.lastFiredAt, ctx.now, ctx.cooldownMs)) continue
    const payload = evaluateOneRule(rule, ctx)
    if (payload !== null) out.push({ ruleId: rule.id, kind: rule.kind, payload })
  }
  return out
}
