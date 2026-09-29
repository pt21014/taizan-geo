/**
 * 每日可见度指标聚合的业务规则纯函数（GEO P0 技术设计 §4.2 `geo.daily.aggregate`、§4.4 rules
 * 清单；口径依据《GEO-产品定义与P0范围.md》§2）。
 *
 * 全部按 Int 运算（`*Bp` = 基点 = 万分之一，`*X100` = 放大 100 倍取整），不出现 Float/Decimal——
 * 这是蓝图 §10 明确点名的"最容易犯的错误 #6"。
 *
 * @packageDocumentation
 */
import type { GeoEntityKind } from '@prisma/client'

/** 聚合输入：一条 `GeoQueryResult` 的最小切面。 */
export interface ResultRow {
  resultId: string
  engineCode: string
  promptId: string
  answered: boolean
}

/** 聚合输入：一条 `GeoMention` 的最小切面。 */
export interface MentionRow {
  resultId: string
  entityKind: GeoEntityKind
  /** 仅 `entityKind === 'COMPETITOR'` 时有值。 */
  competitorId?: string
  position: number
  isCited: boolean
  /** -100..100。 */
  sentimentScore: number
}

/** 单个竞品的指标（`GeoVisibilityDaily.competitorStats` 里一个 key 的值）。 */
export interface CompetitorMetrics {
  mentions: number
  mentionRateBp: number
  sovBp: number
  avgPositionX100: number
}

/** 一次聚合的完整输出，对应 `GeoVisibilityDaily` 的度量列。 */
export interface Metrics {
  /** 已回答的 `GeoQueryResult` 数。 */
  answers: number
  /** 含 BRAND 提及的 result 数（同一 result 多条 BRAND 提及只算 1）。 */
  mentions: number
  mentionRateBp: number
  sovBp: number
  avgPositionX100: number
  citationRateBp: number
  /**
   * 情感均值 ×100，值域 `[-100, 100]`。
   *
   * **口径（T7 修正，务必读完）**：`GeoMention.sentimentScore` 本身就已经是
   * `-100..100` 的整数——它是产品文档 §2 里"情感均值 ∈ [-1,1]"这个逻辑值
   * **乘以 100 之后**落库的形式。也就是说"×100"这件事由 `sentimentScore`
   * 这一列自己承担了，聚合这一步只要取均值：
   *
   * ```
   * sentimentAvgX100 = round(mean(sentimentScore))
   * ```
   *
   * T6 期间这里写的是 `round(mean(sentimentScore) * 100)`，在一个已经"×100"的
   * 字段上又乘了一次 100，实际值域跑到了 `[-10000, 10000]`。那是个量纲错误：
   * 它与 `20-geo.prisma` 里 `GeoVisibilityDaily.sentimentAvgX100` 的列注释
   * （"平均情感分 ×100"）对不上，前端按 `/100` 展示会得到 `情感 = 90` 这种
   * 越界到 ±100 之外的数，而它不会报错、只会看起来像"情感分特别高"。
   * T7 改成上面这个公式，注释与 spec 同步钉死。
   *
   * 另外两个 `*X100`（{@link Metrics.avgPositionX100} 与竞品的同名字段）**不受影响**：
   * `position` 是 1、2、3 这样的原始位次，它没有预先乘过 100，所以那里的
   * `round(mean(position) * 100)` 是对的。两者形状像但来源不同，别一起改。
   */
  sentimentAvgX100: number
  /** key 是 competitorId。 */
  competitorStats: Record<string, CompetitorMetrics>
}

function ratioBp(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 10000)
}

/** `round(mean(values) * 100)`：给**没有预先放大过**的原始量用（位次）。 */
function meanX100(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return Math.round(mean * 100)
}

/**
 * `round(mean(values))`：给**本身已经是"×100"形式**的量用（情感分）。
 *
 * 与 {@link meanX100} 分成两个函数而不是加一个 `scale` 参数：调用点一共只有三处，
 * 而一个 `scale = 1` 的实参在 diff 里毫不起眼——T6 那次量纲错误恰恰是"看起来都一样"
 * 造成的。两个名字不同的函数在调用点就能读出用的是哪一套口径。
 */
function meanRounded(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return Math.round(mean)
}

/**
 * 核心聚合函数：给一批 `results` + `mentions`（可以是全量，也可以是按引擎/Prompt
 * 过滤后的子集——{@link groupForDaily} 就是靠反复调用它实现分组聚合），算出一套完整指标。
 *
 * 关键口径：
 * - `answers`：`results` 里 `answered === true` 的**去重** `resultId` 数；
 * - `mentions`（品牌提及数）：有 BRAND 提及的 result 数，同一 result 多条只算 1；
 * - `mentionRateBp = round(mentions / answers * 10000)`，`answers = 0` → 0；
 * - `sovBp = round(品牌提及result数 / (品牌提及result数 + Σ各竞品提及result数) * 10000)`，
 *   分母为 0（谁都没被提及）→ 0；
 * - `avgPositionX100 = round(mean(position) * 100)`，作用在**全部 BRAND 提及行**上
 *   （不是去重后的 result 数），没有提及 → 0；
 * - `citationRateBp = round(被引用的品牌提及result数 / answers * 10000)`；
 * - `sentimentAvgX100 = round(mean(sentimentScore))`——**不再乘 100**，`sentimentScore`
 *   本身就已经是 ×100 的形式，见 {@link Metrics.sentimentAvgX100} 的口径说明；
 * - `competitorStats[cid]`：同一套口径分别对每个竞品算一遍（`mentionRateBp`/`avgPositionX100`
 *   分母/取值都只看这个竞品自己的提及行；`sovBp` 分子换成该竞品的提及 result 数，
 *   分母仍是品牌+全部竞品之和——这样每个竞品的 sovBp 与品牌的 sovBp 才能加总理解）。
 *
 * 只统计 `resultId` 出现在 `answeredIds` 里的 mention 行——`mentions` 里混入了未回答
 * result 的脏数据（理论上不该发生，但防御性地过滤一下代价很低）。
 */
export function computeMetrics(results: ResultRow[], mentions: MentionRow[]): Metrics {
  const answeredIds = new Set((results ?? []).filter((r) => r?.answered === true).map((r) => r.resultId))
  const answers = answeredIds.size

  const validMentions = (mentions ?? []).filter((m) => answeredIds.has(m.resultId))
  const brandMentions = validMentions.filter((m) => m.entityKind === 'BRAND')
  const brandResultIds = new Set(brandMentions.map((m) => m.resultId))
  const brandCitedResultIds = new Set(brandMentions.filter((m) => m.isCited).map((m) => m.resultId))

  const competitorRows = new Map<string, MentionRow[]>()
  for (const m of validMentions) {
    if (m.entityKind !== 'COMPETITOR' || !m.competitorId) continue
    const list = competitorRows.get(m.competitorId) ?? []
    list.push(m)
    competitorRows.set(m.competitorId, list)
  }

  const competitorResultIdSets = new Map<string, Set<string>>()
  let totalCompetitorMentionResults = 0
  for (const [cid, rows] of competitorRows) {
    const ids = new Set(rows.map((r) => r.resultId))
    competitorResultIdSets.set(cid, ids)
    totalCompetitorMentionResults += ids.size
  }

  const sovDenominator = brandResultIds.size + totalCompetitorMentionResults

  const competitorStats: Record<string, CompetitorMetrics> = {}
  for (const [cid, rows] of competitorRows) {
    const ids = competitorResultIdSets.get(cid) ?? new Set<string>()
    competitorStats[cid] = {
      mentions: ids.size,
      mentionRateBp: ratioBp(ids.size, answers),
      sovBp: ratioBp(ids.size, sovDenominator),
      avgPositionX100: meanX100(rows.map((r) => r.position)),
    }
  }

  return {
    answers,
    mentions: brandResultIds.size,
    mentionRateBp: ratioBp(brandResultIds.size, answers),
    sovBp: ratioBp(brandResultIds.size, sovDenominator),
    avgPositionX100: meanX100(brandMentions.map((m) => m.position)),
    citationRateBp: ratioBp(brandCitedResultIds.size, answers),
    sentimentAvgX100: meanRounded(brandMentions.map((m) => m.sentimentScore)),
    competitorStats,
  }
}

/** {@link groupForDaily} 的一行输出，直接对应一次 `GeoVisibilityDaily` upsert。 */
export interface DailyGroup {
  /** `''` 表示"全部引擎汇总"。 */
  engineCode: string
  /** `''` 表示"全部 Prompt 汇总"。 */
  promptId: string
  metrics: Metrics
}

function uniqueOrdered(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of values) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/**
 * 按 `(engineCode ∈ {各引擎,''}, promptId ∈ {各Prompt,''})` 产出四类分组的聚合结果
 * （技术设计 §4.2 `geo.daily.aggregate`）：
 *
 * 1. `('', '')`——品牌当天总览；
 * 2. `(engineCode, '')`——每个引擎的汇总；
 * 3. `('', promptId)`——每条 Prompt 跨引擎的汇总；
 * 4. `(engineCode, promptId)`——每个引擎 × 每条 Prompt 的明细。
 *
 * **决策点**：第 4 类只对"这个引擎真的问过这条 Prompt"的组合产出一行，不补全成
 * `engineCodes.length × promptIds.length` 的完全笛卡尔积——引擎集合与 Prompt 集合
 * 在同一个 `GeoQueryRun` 里通常是满笛卡尔积（`planQueries` 就是这么展开的），但这个函数
 * 的入参是"这一天全部 result"，如果同一天里跑过不止一个 run（比如手动补跑了某个引擎），
 * 笛卡尔积会算出一堆"这个组合当天其实没有数据"的全零行，写进 `GeoVisibilityDaily`
 * 之后报表会显示一堆假的"0 提及"而不是"没跑过"。如果 T6/T7 发现下游确实需要完全
 * 笛卡尔积（比如前端要展示"引擎 × Prompt 矩阵"里的空白格），把这条 skip 逻辑去掉即可，
 * 单测会跟着改。
 */
export function groupForDaily(results: ResultRow[], mentions: MentionRow[]): DailyGroup[] {
  const rs = results ?? []
  const ms = mentions ?? []

  const engineCodes = uniqueOrdered(rs.map((r) => r.engineCode))
  const promptIds = uniqueOrdered(rs.map((r) => r.promptId))

  const out: DailyGroup[] = []

  out.push({ engineCode: '', promptId: '', metrics: computeMetrics(rs, ms) })

  for (const engineCode of engineCodes) {
    const subResults = rs.filter((r) => r.engineCode === engineCode)
    const subResultIds = new Set(subResults.map((r) => r.resultId))
    const subMentions = ms.filter((m) => subResultIds.has(m.resultId))
    out.push({ engineCode, promptId: '', metrics: computeMetrics(subResults, subMentions) })
  }

  for (const promptId of promptIds) {
    const subResults = rs.filter((r) => r.promptId === promptId)
    const subResultIds = new Set(subResults.map((r) => r.resultId))
    const subMentions = ms.filter((m) => subResultIds.has(m.resultId))
    out.push({ engineCode: '', promptId, metrics: computeMetrics(subResults, subMentions) })
  }

  for (const engineCode of engineCodes) {
    for (const promptId of promptIds) {
      const subResults = rs.filter((r) => r.engineCode === engineCode && r.promptId === promptId)
      if (subResults.length === 0) continue
      const subResultIds = new Set(subResults.map((r) => r.resultId))
      const subMentions = ms.filter((m) => subResultIds.has(m.resultId))
      out.push({ engineCode, promptId, metrics: computeMetrics(subResults, subMentions) })
    }
  }

  return out
}

/**
 * 把 `Date` 换算成品牌所在时区的 `YYYY-MM-DD`，用于 `GeoVisibilityDaily.date` 与
 * `GeoUsageLedger.month` 之类的归属日判定。
 *
 * `apps/api` 目前没有引入 `dayjs`（检查过 `package.json`），所以用 `Intl.DateTimeFormat`
 * 而不是新增依赖；用 `formatToParts` 而不是直接 `format()` 再拼字符串，是因为
 * `format()` 的段落顺序会随 `locale` 变化，`formatToParts` 拿到的是结构化的年/月/日，
 * 自己拼接不受 locale 影响，更不容易在换一个 Node/ICU 版本时悄悄错位。
 */
export function toDateKey(d: Date, tz = 'Asia/Shanghai'): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = fmt.formatToParts(d)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * 品牌所在时区相对 UTC 的偏移（分钟）。P0 固定 `Asia/Shanghai` = UTC+8。
 *
 * 写成常量而不是从 `Intl` 反推：中国时区**没有夏令时**，偏移是恒定的 +480；
 * 而"从 Intl 反推偏移"要处理夏令时切换日那两个小时的歧义（那一天有 23 或 25 小时），
 * 为一个用不到的能力引入一整套边界条件不划算。真要支持多时区时，
 * 这个常量会变成 `GeoBrand.locale` 派生出来的一个参数，{@link dayRangeOf} 的签名已经留好位了。
 */
export const GEO_TZ_OFFSET_MINUTES = 480

/** {@link dayRangeOf} 的返回：左闭右开的 UTC 时刻区间。 */
export interface DayRange {
  /** 含。 */
  start: Date
  /** **不含**。 */
  endExclusive: Date
}

/**
 * 把 `YYYY-MM-DD`（品牌时区的某一天）换算成一段可以直接喂给
 * `where: { answeredAt: { gte, lt } }` 的 UTC 区间。
 *
 * 与 {@link toDateKey} 互为逆运算：`toDateKey(d)` 落在 `date` 上，当且仅当
 * `d ∈ [start, endExclusive)`。两者一致是这个模块的核心不变量——不一致的表现是
 * 某些回答在"按日切"时归错了天，日聚合与明细对不上，而两边各自看都是对的。
 *
 * **右开区间**，不是 `lte 23:59:59`：后者会漏掉 `23:59:59.500` 这样的毫秒，
 * 而 `answeredAt` 是 `new Date()` 写进去的，带毫秒。漏掉的那条会既不属于今天
 * 也不属于明天，从此在任何日聚合里都查不到。
 *
 * @param dateKey - `YYYY-MM-DD`
 * @param offsetMinutes - 时区偏移，默认 {@link GEO_TZ_OFFSET_MINUTES}
 */
export function dayRangeOf(dateKey: string, offsetMinutes = GEO_TZ_OFFSET_MINUTES): DayRange {
  // `Date.UTC` 解析出来的是"这一天在 UTC 的零点"，减去偏移就是"这一天在目标时区的零点"
  // 对应的 UTC 时刻（UTC+8 的 00:00 = UTC 的前一天 16:00）。
  const [y, m, d] = dateKey.split('-').map((v) => Number.parseInt(v, 10))
  const utcMidnight = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  const start = new Date(utcMidnight - offsetMinutes * 60_000)
  return { start, endExclusive: new Date(start.getTime() + 24 * 60 * 60 * 1000) }
}

/**
 * 把 `YYYY-MM-DD` 换算成写进 `GeoVisibilityDaily.date`（`@db.Date`）的值。
 *
 * `@db.Date` 在 MySQL 里只存年月日，Prisma 读写时按 **UTC 零点**对齐。
 * 所以这里给的是 `2026-09-14T00:00:00.000Z` 而**不是** {@link dayRangeOf} 的 `start`
 * （那是 `2026-09-13T16:00:00.000Z`，落库会变成 9 月 13 号——整张表的日期差一天，
 * 而趋势图看起来只是"整体左移了"，没人会当成 bug）。
 *
 * 两个函数的返回值刻意不通用，就是为了让这个差别在调用点是显式的。
 */
export function dateKeyToDbDate(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`)
}

/**
 * {@link dateKeyToDbDate} 的逆：把库里读出来的 `@db.Date` 值变回 `YYYY-MM-DD`。
 *
 * 用 `toISOString().slice(0, 10)` 而不是 {@link toDateKey}：这一列存的已经是
 * "对齐到 UTC 零点的日期"，再按 Asia/Shanghai 换算一次会把它推到第二天。
 */
export function dbDateToDateKey(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/**
 * 把一个 `YYYY-MM-DD` 往前/往后挪若干天，仍然回 `YYYY-MM-DD`。
 *
 * 告警要"昨天那一行"、趋势要"最近 N 天"、周报要"上周一到上周日"，
 * 三处都要这件事。走 UTC 零点做加减，不碰本地时区。
 */
export function shiftDateKey(dateKey: string, days: number): string {
  const base = dateKeyToDbDate(dateKey).getTime()
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
