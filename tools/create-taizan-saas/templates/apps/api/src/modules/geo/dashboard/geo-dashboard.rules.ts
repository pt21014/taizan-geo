/**
 * 看板「把若干天的日聚合行合成一个周期指标」的业务规则纯函数
 * （GEO P0 技术设计 §4.1 dashboard 一行；口径依据《GEO-产品定义与P0范围.md》§2）。
 *
 * 不 import 任何 `@nestjs/*`、不连库、不读时钟。全部整数运算（`*Bp` / `*X100`），
 * 与 `aggregate/geo-metrics.rules.ts` 同一套约定。
 *
 * ## 这个文件存在的理由：**加权，不是平均**
 *
 * `GeoVisibilityDaily` 里每一行是**一天**的指标。看板要的是「最近 7 天」这一个数字，
 * 而 7 天的提及率**不是 7 个提及率的算术平均**——那会让「只跑了 2 条回答的那天」
 * 和「跑了 200 条的那天」权重一样。周一跑了 200 条提及率 10%、周二补跑 2 条恰好
 * 都提到了（100%），算术平均得出 55%，而真实的周提及率是 `(20+2)/202 ≈ 10.9%`。
 *
 * 所以每个指标都要带着它自己的分母合。哪个分母，见 {@link rollupDailyRows} 的说明。
 *
 * @packageDocumentation
 */

/** 一行日聚合的最小切面（对应 `GeoVisibilityDaily` 的度量列）。 */
export interface DailyRow {
  answers: number
  mentions: number
  mentionRateBp: number
  sovBp: number
  avgPositionX100: number
  citationRateBp: number
  sentimentAvgX100: number
}

/** {@link rollupDailyRows} 的产出：一个周期的合计指标，字段与 {@link DailyRow} 同名。 */
export interface RollupMetrics extends DailyRow {
  /** 参与合计的天数（`answers > 0` 的行数）。0 表示这个周期一天都没跑过。 */
  days: number
}

/** 全零的合计结果。周期内没有任何数据时返回它，而不是 `null`——前端少一层判空。 */
export const EMPTY_ROLLUP: RollupMetrics = {
  days: 0,
  answers: 0,
  mentions: 0,
  mentionRateBp: 0,
  sovBp: 0,
  avgPositionX100: 0,
  citationRateBp: 0,
  sentimentAvgX100: 0,
}

function toInt(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.trunc(v)
}

/** 加权平均，权重非正时跳过该项；总权重为 0 → 0。 */
function weightedMean(pairs: Array<{ value: number; weight: number }>): number {
  let sum = 0
  let weight = 0
  for (const p of pairs) {
    const w = toInt(p.weight)
    if (w <= 0) continue
    sum += toInt(p.value) * w
    weight += w
  }
  if (weight <= 0) return 0
  return Math.round(sum / weight)
}

/**
 * 把一个周期内的若干行日聚合合成一套指标。
 *
 * **每个指标用的分母不一样**，这是本函数唯一有分量的地方：
 *
 * | 指标 | 怎么合 | 为什么 |
 * |---|---|---|
 * | `answers` / `mentions` | 直接求和 | 它们本来就是计数 |
 * | `mentionRateBp` | `round(Σmentions / Σanswers × 10000)` | **精确重算**，不是加权——两个计数都在行上，没必要用近似 |
 * | `sovBp` | 按 `answers` 加权平均 | 份额的真分母（品牌+竞品提及数）没有存在行上，只能近似；`answers` 是与它最相关的量 |
 * | `citationRateBp` | 按 `answers` 加权平均 | 同上，被引用的 result 数没有单独存 |
 * | `avgPositionX100` | 按 **`mentions`** 加权平均 | 见下 |
 * | `sentimentAvgX100` | 按 **`mentions`** 加权平均 | 见下 |
 *
 * ### 位次与情感为什么按 `mentions` 而不是 `answers` 加权
 *
 * 任务书写的是「权重 answers」。对前三个比率型指标这是对的（它们的分母就是回答数）。
 * 但 `avgPositionX100` 与 `sentimentAvgX100` 是**只在有提及时才有定义**的量：
 * 一天没有任何提及时，`computeMetrics` 给的是 `0`（见 `geo-metrics.rules.ts`），
 * 而"位次 0"在业务上不存在——位次从 1 起。
 *
 * 用 `answers` 加权的话，一个「跑了 100 条、一次都没提到」的日子会带着
 * `avgPositionX100 = 0` 和权重 100 进来，把周平均硬拉向 0，于是看板显示
 * 「平均位次 0.3」——一个比最好的可能值（1.0）还好的数字。那不是不精确，是错。
 *
 * 用 `mentions` 加权时，`mentions = 0` 的行权重为 0 被跳过，剩下的正好是
 * 「真的有位次可言」的那些天。同理适用于情感分（没提及就没有情感）。
 * 这是本函数对任务书口径的唯一一处刻意偏离，理由就是上面这段。
 *
 * @param rows - 周期内的日聚合行，顺序无关
 */
export function rollupDailyRows(rows: readonly DailyRow[]): RollupMetrics {
  const list = (rows ?? []).filter((r) => r !== null && r !== undefined)
  if (list.length === 0) return { ...EMPTY_ROLLUP }

  const answers = list.reduce((a, r) => a + toInt(r.answers), 0)
  const mentions = list.reduce((a, r) => a + toInt(r.mentions), 0)

  return {
    days: list.filter((r) => toInt(r.answers) > 0).length,
    answers,
    mentions,
    // 精确重算：两个计数都在手上，没有理由用加权近似。
    mentionRateBp: answers > 0 ? Math.round((mentions / answers) * 10000) : 0,
    sovBp: weightedMean(list.map((r) => ({ value: r.sovBp, weight: r.answers }))),
    citationRateBp: weightedMean(list.map((r) => ({ value: r.citationRateBp, weight: r.answers }))),
    // 按 mentions 加权：没有提及的那天没有位次/情感可言，见上面的表格与说明。
    avgPositionX100: weightedMean(list.map((r) => ({ value: r.avgPositionX100, weight: r.mentions }))),
    sentimentAvgX100: weightedMean(
      list.map((r) => ({ value: r.sentimentAvgX100, weight: r.mentions })),
    ),
  }
}

/** 一个竞品在 `GeoVisibilityDaily.competitorStats` 里的那一份。 */
export interface CompetitorStat {
  mentions: number
  mentionRateBp: number
  sovBp: number
  avgPositionX100: number
}

/** {@link rollupCompetitorStats} 的一条产出。 */
export interface CompetitorRollup extends CompetitorStat {
  competitorId: string
}

/**
 * `competitorStats` 是 `Json` 列，形状由 `computeMetrics` 写死。这个函数负责
 * 把"从库里读出来的 `unknown`"安全地变回 {@link CompetitorStat}——认不出来的条目丢掉。
 *
 * 宽松解析而不是抛错：这一列是**历史快照**，口径改过之后老行的形状可能不一样，
 * 而看板因为半年前一行脏数据整页 500 是不能接受的（那一天的数据没了就没了）。
 */
export function parseCompetitorStats(raw: unknown): Record<string, CompetitorStat> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, CompetitorStat> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const v = value as Record<string, unknown>
    out[id] = {
      mentions: toInt(v['mentions']),
      mentionRateBp: toInt(v['mentionRateBp']),
      sovBp: toInt(v['sovBp']),
      avgPositionX100: toInt(v['avgPositionX100']),
    }
  }
  return out
}

/**
 * 把若干天的 `competitorStats` 合成每个竞品一行。
 *
 * 权重口径与 {@link rollupDailyRows} 一致：比率按当天的 `answers` 加权，
 * 位次按该竞品当天的 `mentions` 加权（同样是为了不让"没被提到的那天"把位次拉向 0）。
 *
 * 输出按 `sovBp` 降序——看板上"谁的声量最大"是第一眼要看的东西，
 * 而 `Object.entries` 的顺序（插入顺序，即某一天恰好先出现谁）对读者没有意义。
 *
 * @param rows - 周期内的日聚合行，每行带它自己的 `answers` 与已解析的 `competitorStats`
 */
export function rollupCompetitorStats(
  rows: ReadonlyArray<{ answers: number; competitorStats: Record<string, CompetitorStat> }>,
): CompetitorRollup[] {
  const byId = new Map<string, Array<{ answers: number; stat: CompetitorStat }>>()
  for (const row of rows ?? []) {
    for (const [id, stat] of Object.entries(row?.competitorStats ?? {})) {
      const list = byId.get(id) ?? []
      list.push({ answers: toInt(row.answers), stat })
      byId.set(id, list)
    }
  }

  const out: CompetitorRollup[] = []
  for (const [competitorId, list] of byId) {
    out.push({
      competitorId,
      mentions: list.reduce((a, x) => a + toInt(x.stat.mentions), 0),
      mentionRateBp: weightedMean(
        list.map((x) => ({ value: x.stat.mentionRateBp, weight: x.answers })),
      ),
      sovBp: weightedMean(list.map((x) => ({ value: x.stat.sovBp, weight: x.answers }))),
      avgPositionX100: weightedMean(
        list.map((x) => ({ value: x.stat.avgPositionX100, weight: x.stat.mentions })),
      ),
    })
  }
  return out.sort((a, b) => b.sovBp - a.sovBp || a.competitorId.localeCompare(b.competitorId))
}

/** 环比差值：`current - previous`，逐字段。正数 = 涨了。 */
export interface RollupDelta {
  answers: number
  mentionRateBp: number
  sovBp: number
  avgPositionX100: number
  citationRateBp: number
  sentimentAvgX100: number
}

/**
 * 算环比差值。
 *
 * **不算百分比变化率**（`(c - p) / p`），只给绝对差：`p = 0` 时变化率没有定义，
 * 而"从 0 涨到 5%"恰恰是新品牌最常见的第一周。给绝对差之后前端展示
 * 「+500bp」永远成立，要不要再除一下由前端按有没有基线自己决定。
 *
 * `avgPositionX100` 的差值**越小越好**（位次 1 比位次 3 好），这一点由前端的
 * 涨跌箭头颜色负责，不在这里反号——在这里反号的话，字段名与数值的关系就骗人了。
 */
export function diffRollup(current: RollupMetrics, previous: RollupMetrics): RollupDelta {
  return {
    answers: current.answers - previous.answers,
    mentionRateBp: current.mentionRateBp - previous.mentionRateBp,
    sovBp: current.sovBp - previous.sovBp,
    avgPositionX100: current.avgPositionX100 - previous.avgPositionX100,
    citationRateBp: current.citationRateBp - previous.citationRateBp,
    sentimentAvgX100: current.sentimentAvgX100 - previous.sentimentAvgX100,
  }
}
