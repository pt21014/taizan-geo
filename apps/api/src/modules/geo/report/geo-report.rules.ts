/**
 * 报表快照的业务规则纯函数：Share of Voice 的「分母为 0 → null」语义，以及
 * 首位推荐率的口径。不 import 任何 `@nestjs/*`、不连库、不读时钟。
 *
 * ## 为什么 SoV 的「分母为 0」要单独处理，而不是复用 `aggregate/geo-metrics.rules.ts` 的 `ratioBp`
 *
 * `GeoVisibilityDaily.sovBp` 是一列 `Int`（技术设计 §3.1 的整数口径约定），落库时
 * 分母为 0（这一天/这个组合谁都没被提及）已经写成 `0`——那是**存量数据**的既有语义，
 * 半年的历史行不会因为这次改动重新解释，牵一发动全身（趋势图、告警阈值、加权汇总
 * 全部读这一列）。
 *
 * 但 `GeoReport.payload` 是 `Json`，没有这种历史包袱：报表快照是"生成时算一次"，
 * 这里可以按参考的 elmo 口径把"没有任何品牌/竞品被提及"与"品牌提及率恰好是 0%"
 * 分开——前者 `sovBp: null`，后者是一个有意义的 0。所以这两个函数只作用在
 * **payload 组装这一步**，不改 `GeoVisibilityDaily` 或 `computeMetrics` 的既有产出。
 *
 * @packageDocumentation
 */

/** {@link Overview} 与 {@link CompetitorEntry} 共享的 SoV 字段形状。 */
interface SovBearing {
  sovBp: number
}

/** 报表 payload 里 `overview`/`previous` 的最小切面（只取本文件需要动的字段）。 */
export interface OverviewLike extends SovBearing {
  mentions: number
  [key: string]: unknown
}

/** 报表 payload 里 `competitors[]` 一条的最小切面。 */
export interface CompetitorEntryLike extends SovBearing {
  mentions: number
  [key: string]: unknown
}

/** {@link applySovNullSemantics} 的产出：字段改成 `number | null`。 */
export type WithNullableSov<T extends SovBearing> = Omit<T, 'sovBp'> & { sovBp: number | null }

/**
 * 单个 `overview`/`previous` 汇总：分母（品牌 mentions + 全部竞品 mentions）为 0 时
 * 把 `sovBp` 改成 `null`。
 *
 * 分母不是直接存在这些对象上的——它要从 `overview.mentions`（品牌）与
 * `competitors[]` 里非品牌条目的 `mentions` 求和得到，所以调用点必须把两者一起传。
 *
 * @param overview - 待处理的汇总对象
 * @param competitorMentionsTotal - 同一周期内**全部竞品**（不含品牌自己）的提及数之和
 */
export function overviewWithNullableSov<T extends OverviewLike>(
  overview: T,
  competitorMentionsTotal: number,
): WithNullableSov<T> {
  const denominator = overview.mentions + Math.max(0, competitorMentionsTotal)
  return { ...overview, sovBp: denominator > 0 ? overview.sovBp : null }
}

/**
 * `competitors[]`（含品牌自己那条伪记录 `isBrand: true`）逐条按同一个共享分母
 * 把 `sovBp` 改成 `null`。
 *
 * 分母对这个周期内**所有**条目是同一个数（品牌提及 + 全部竞品提及之和）——SoV
 * 的定义就是"每个人占同一块蛋糕的份额"，蛋糕总量为 0 时，谁的份额都没有意义，
 * 不能只置空品牌那一条、留着竞品条目还显示一个数字。
 *
 * @param competitors - 报表 payload 的 `competitors` 数组（第一条通常是品牌自己）
 */
export function competitorsWithNullableSov<T extends CompetitorEntryLike>(
  competitors: readonly T[],
): Array<WithNullableSov<T>> {
  const denominator = (competitors ?? []).reduce((sum, c) => sum + Math.max(0, c.mentions), 0)
  return (competitors ?? []).map((c) => ({ ...c, sovBp: denominator > 0 ? c.sovBp : null }))
}

/**
 * 首位推荐率：品牌在回答里被列为第一顺位提及的结果数 ÷ 总回答数，基点。
 *
 * 与 `mentionRateBp` 的区别：`mentionRateBp` 只看"提没提"，这个指标看"提到的时候
 * 是不是排第一"——对商家来说"AI 推荐的第一选择是不是我"比"AI 有没有提到我"
 * 更接近转化意义上的"可见度"，这也是它被列进免费摘要的原因（产品需求 §3）。
 *
 * `answers = 0` 时回 0（不是 null）：这与 `mentionRateBp`/`citationRateBp` 同一口径——
 * 这个指标的分母是"回答总数"，不是"提及数"，跑批还没出结果时"0 次推荐第一"是
 * 一个有意义的陈述，不是"没有定义"，SoV 的 null 语义不适用于它。
 *
 * @param top1Count - `entityKind=BRAND && position=1` 的结果数（已按 resultId 去重）
 * @param answers - 同一周期内的回答总数
 */
export function top1RateBp(top1Count: number, answers: number): number {
  if (answers <= 0) return 0
  const n = Math.max(0, Math.trunc(top1Count))
  return Math.round((n / answers) * 10000)
}

// ─────────────────────────────────────────────────────────────────────────────
// 「先诊断后付费」编排链路补写的两个 payload 字段的形状
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `payload.promptSuggestions` 一条：诊断编排里新生成并自动导入的一条候选问法
 * （`GeoDiagnosisService.finalizeReport` 补写）。WEEKLY/MONTHLY 报表恒为空数组。
 */
export interface GeoDiagnosisPromptSuggestion {
  text: string
  topic: string | null
  funnelStage: string
}

/**
 * `payload.contentSuggestions` 一条：内容优化建议（`GeoDiagnosisService.finalizeReport`
 * 按规则从这次诊断的 overview/competitors/topCitations 里生成，不是 LLM 调用——
 * 简化实现，理由见 `diagnosis/geo-diagnosis.rules.ts` 文件头）。
 */
export interface GeoDiagnosisContentSuggestion {
  /** 这条建议对应哪个观察到的问题，纯展示用的分类标签。 */
  kind: string
  title: string
  detail: string
}
