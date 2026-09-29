/**
 * 查询调度与跑批状态机的业务规则纯函数（GEO P0 技术设计 §4.2 队列流程、§4.4 rules 清单、§5 成本公式）。
 *
 * 与 `brand/geo-brand.rules.ts` 同一条约束：不 import 任何 `@nestjs/*`，不连库、不读时钟
 * （`fingerprintOf` 用的是入参文本而不是 `Date.now()`）。`GeoRunStatus` 这个类型例外地从
 * `@prisma/client` 引入——它只是 `import type`，编译期擦除，不引入任何运行时框架依赖，
 * 和"纯函数不碰 Prisma 运行时"这条红线不冲突。
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto'

import type { GeoRunStatus } from '@prisma/client'

import { GEO_SAMPLE_SIZE_MAX, GEO_SAMPLE_SIZE_MIN } from '../brand/geo-brand.rules'

/** 规划出的一条查询任务：`1 Prompt × 1 引擎 × 1 次采样`（产品定义 §2 对"查询"的计量口径）。 */
export interface PlannedQuery {
  promptId: string
  engineCode: string
  /** 1-based，同一 (promptId, engineCode) 下从 1 数到 sampleSize。 */
  sampleIndex: number
}

/** {@link planQueries} 的入参。 */
export interface PlanQueriesInput {
  brandId: string
  promptIds: string[]
  engineCodes: string[]
  sampleSize: number
}

/**
 * 把"品牌 × Prompt 集 × 引擎集 × 采样数"展开成一份可以逐条入队的查询计划。
 *
 * 三件事：
 * 1. `sampleSize` 夹到 `[1, 10]`——0 次没意义，超过 10 次是在烧配额而不是多采样；
 * 2. `promptIds` / `engineCodes` 去重但**保留首次出现的顺序**，这样同一份输入
 *    每次展开出来的 job 顺序都一样，`geo.query.execute` 的入队顺序才可预测；
 * 3. 展开顺序固定为 `promptId → engineCode → sampleIndex`——外层按 Prompt 分组，
 *    是因为运营在"回答明细"页多半是按 Prompt 看进度，这个顺序让同一条 Prompt
 *    的结果聚在一起产生。
 *
 * `brandId` 只是留在入参里给调用方做日志/追踪用，本函数不使用它。
 */
export function planQueries(input: PlanQueriesInput): PlannedQuery[] {
  const sampleSize = clampSampleSize(input.sampleSize)
  const promptIds = dedupeOrdered(input.promptIds)
  const engineCodes = dedupeOrdered(input.engineCodes)

  const out: PlannedQuery[] = []
  for (const promptId of promptIds) {
    for (const engineCode of engineCodes) {
      for (let sampleIndex = 1; sampleIndex <= sampleSize; sampleIndex++) {
        out.push({ promptId, engineCode, sampleIndex })
      }
    }
  }
  return out
}

function clampSampleSize(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return GEO_SAMPLE_SIZE_MIN
  const n = Math.trunc(raw)
  if (n < GEO_SAMPLE_SIZE_MIN) return GEO_SAMPLE_SIZE_MIN
  if (n > GEO_SAMPLE_SIZE_MAX) return GEO_SAMPLE_SIZE_MAX
  return n
}

function dedupeOrdered(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** {@link computeCostCents} 的引擎单价入参（对应 `GeoEngine` 的三个价格列）。 */
export interface EngineCostConfig {
  pricePerQueryCents: number
  priceInPerMTokenCents: number
  priceOutPerMTokenCents: number
}

/** {@link computeCostCents} 的用量入参（对应 `EngineAskOutput.usage`）。 */
export interface UsageTokens {
  inputTokens: number
  outputTokens: number
}

/**
 * 一次查询的成本（分）。技术设计 §5：
 * `pricePerQueryCents + ceil(inputTokens * priceInPerMTokenCents / 1e6) + ceil(outputTokens * priceOutPerMTokenCents / 1e6)`。
 *
 * 全部按 Int 运算，`ceil` 而不是四舍五入——宁可平台多算一点成本也不要少算
 * （少算的差额是平台自己贴钱，多算的差额顶多是账算得比实际保守一点点）。
 * 任何一个入参是负数或非法数字一律当 0，不让脏配置把成本算成负数倒贴钱给租户。
 */
export function computeCostCents(engine: EngineCostConfig, usage: UsageTokens): number {
  const base = nonNegativeInt(engine.pricePerQueryCents)
  const inputCost = Math.ceil(
    (nonNegativeInt(usage.inputTokens) * nonNegativeInt(engine.priceInPerMTokenCents)) / 1_000_000,
  )
  const outputCost = Math.ceil(
    (nonNegativeInt(usage.outputTokens) * nonNegativeInt(engine.priceOutPerMTokenCents)) / 1_000_000,
  )
  return base + inputCost + outputCost
}

function nonNegativeInt(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  const n = Math.trunc(v)
  return n < 0 ? 0 : n
}

/** {@link resolveRunStatus} 的入参：一次 `GeoQueryRun` 下 `GeoQueryResult` 按状态分的计数。 */
export interface RunCounts {
  total: number
  done: number
  failed: number
  pending: number
}

/**
 * 按结果计数推导 `GeoQueryRun.status`。技术设计 §4.2 `settle(runId)`：
 *
 * - `total === 0` → `DONE`（这一步放在最前面判：一个没有任何结果的 run 没有"还在跑"的意义，
 *   不该被下面的 `pending > 0` 分支误判成未结束）；
 * - `pending > 0` → `null`，表示还没到收口的时候，调用方应该什么都不做；
 * - `failed === 0` → `DONE`；
 * - `0 < failed < total` → `PARTIAL`；
 * - `failed === total` → `FAILED`。
 *
 * 返回 `null` 而不是抛错或返回某个哨兵字符串：`settle()` 的调用点本来就是
 * "还没结束就直接 return"，用 `null` 表达"没有状态可写"比拿一个字符串常量
 * 到处判等更不容易被写错。
 */
export function resolveRunStatus(counts: RunCounts): GeoRunStatus | null {
  const { total, failed, pending } = counts
  if (total === 0) return 'DONE'
  if (pending > 0) return null
  if (failed === 0) return 'DONE'
  if (failed === total) return 'FAILED'
  return 'PARTIAL'
}

// process-local: 纯常量集合（三个固定的错误类别名），不跨请求可变、不跨租户、
// 也不需要跨进程一致——每个进程各建一份完全无害。
/** 可重试的错误类别（`EngineErrorKind` 的子集，语义见 `@taizan/geo-engines` 的 `errors.ts`）。 */
const RETRYABLE_ERROR_KINDS = new Set(['RATE_LIMIT', 'TIMEOUT', 'UPSTREAM'])

/**
 * 一个错误类别是否值得让 job 重试。
 *
 * 只看 `kind` 这一个粗粒度维度，不看具体错误消息——`geo.query.execute` 的
 * BullMQ `attempts` 机制是"抛出去就重试、不抛就落 FAILED"，判定逻辑必须简单到
 * 不会在重试路径上再引入新的分支错误。更细的"这条 UPSTREAM 错误其实不该重试"
 * 的判断（如 `classifyHttpError` 对非 5xx 的 4xx 置 `retryable:false`）留在
 * `@taizan/geo-engines` 的适配器层做，这里只做"kind 级别"的兜底分类。
 */
export function isRetryableErrorKind(kind: string): boolean {
  return RETRYABLE_ERROR_KINDS.has(kind)
}

/**
 * 按 `errorKind` 分组计数，落 `GeoQueryRun.errorSummary`（JSON）。
 *
 * `errorKind` 缺失/空串的结果（成功的结果，或还没跑到分析阶段的结果）不计入——
 * 这是"错误分布"统计，不是"全部结果"统计。
 */
export function summarizeErrors(results: Array<{ errorKind?: string | null }>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of results ?? []) {
    const kind = r?.errorKind
    if (kind === undefined || kind === null || kind === '') continue
    out[kind] = (out[kind] ?? 0) + 1
  }
  return out
}

// ──────────────────────────────────────────────────────────────────────────────
// 队列 jobId 构造（技术设计 §4.2 的幂等键）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 分隔符是 `-` 而不是设计文档里写的 `:`。
 *
 * **BullMQ 硬性限制**：自定义 jobId 里不允许出现冒号，入队时直接抛
 * `Error: Custom Id cannot contain :`（它拿冒号当 Redis key 的分段符）。
 * 技术设计 §4.2 里的 `run:${runId}` 是照写的习惯写法，落地时才发现跑不通——
 * 表现是 `POST /geo/runs` 直接 9050000，整条流水线一步都走不了。
 *
 * 换成 `-` 之后幂等语义一点不变（它只需要“同一件事算出同一个字符串”），
 * 而 ULID 本身是 Crockford Base32（只有大写字母与数字），不含 `-`，所以
 * `run-<ulid>` 与 `q-<ulid>` 之间不可能撞。`date` 那一档形如 `2026-01-01`，
 * 它里面的 `-` 只在最后一段，同样不会让两个不同的 (tenant, brand, date) 组合撞到一起。
 */
const JOB_ID_SEP = '-'

/** `geo.run.dispatch` 的幂等键。 */
export function runJobId(runId: string): string {
  return `run${JOB_ID_SEP}${runId}`
}

/** `geo.query.execute` 的幂等键。 */
export function queryJobId(resultId: string): string {
  return `q${JOB_ID_SEP}${resultId}`
}

/** `geo.result.analyze` 的幂等键。 */
export function analyzeJobId(resultId: string): string {
  return `a${JOB_ID_SEP}${resultId}`
}

/** `geo.daily.aggregate` 的幂等键。 */
export function aggregateJobId(tenantId: string, brandId: string, date: string): string {
  return ['agg', tenantId, brandId, date].join(JOB_ID_SEP)
}

/** `geo.alert.evaluate` 的幂等键。 */
export function alertJobId(tenantId: string, brandId: string, date: string): string {
  return ['al', tenantId, brandId, date].join(JOB_ID_SEP)
}

// ─────────────────────────────────────────────────────────────────────────────
// 原文截断 / 预览 / 指纹（技术设计 D6：DB 只存截断预览，原文走对象存储）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 截断回答原文。
 *
 * 按**码点**而不是 UTF-16 code unit 计数（与 `geo-brand.rules.ts` 的 `[...name].length`
 * 同一套约定）——否则一个 emoji/生僻字这种由代理对组成的字符可能被从中间切开，
 * 落库后变成一个非法字符串。
 *
 * @param raw - 回答原文；非字符串一律当空字符串处理（引擎偶尔会返回 `null`）
 * @param max - 截断阈值，默认 60000（对应 `GeoQueryResult.rawText @db.Text` 的实用上限）
 */
export function truncateRawText(raw: unknown, max = 60000): { text: string; truncated: boolean } {
  const text = typeof raw === 'string' ? raw : ''
  const codePoints = Array.from(text)
  if (codePoints.length <= max) return { text, truncated: false }
  return { text: codePoints.slice(0, max).join(''), truncated: true }
}

/** 取前 N 个码点做预览，默认 500（对应 `GeoQueryResult.preview @db.VarChar(500)`）。 */
export function makePreview(raw: unknown, max = 500): string {
  const text = typeof raw === 'string' ? raw : ''
  const codePoints = Array.from(text)
  return codePoints.length <= max ? text : codePoints.slice(0, max).join('')
}

/**
 * 一条回答的指纹（sha256 hex），用于排查"这条回答是不是重复内容"。
 *
 * 三段之间插入 ` ` 分隔：不加分隔符的话 `("ab","c",...)` 和 `("a","bc",...)`
 * 拼出来的哈希输入是同一个字符串，会撞出两条本不该相同的指纹。
 */
export function fingerprintOf(engineCode: string, promptId: string, text: string): string {
  const hash = createHash('sha256')
  hash.update(String(engineCode ?? ''))
  hash.update(' ')
  hash.update(String(promptId ?? ''))
  hash.update(' ')
  hash.update(String(text ?? ''))
  return hash.digest('hex')
}
