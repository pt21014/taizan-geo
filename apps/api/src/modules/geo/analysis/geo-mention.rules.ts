/**
 * 从回答正文抽取"提及"的业务规则纯函数（GEO P0 技术设计 §4.2 `geo.result.analyze`、§4.4 rules 清单）。
 *
 * 两条抽取路径：
 * - {@link extractMentionsFallback}：正则/`indexOf` 兜底，LLM 结构化抽取失败或还没接线时用；
 * - {@link mergeLlmMentions}：把 LLM 的结构化输出与实体表对齐，解析失败/为空时退回 fallback。
 *
 * 与 `run/geo-run.rules.ts` 同样的约束：不 import `@nestjs/*`，`GeoEntityKind` / `GeoSentiment`
 * 只做 `import type`。
 *
 * @packageDocumentation
 */
import type { GeoEntityKind, GeoSentiment } from '@prisma/client'

/** 一条待写入 `GeoMention` 的草稿（尚未补 `resultId`/`brandId` 等落库才知道的字段）。 */
export interface MentionDraft {
  entityKind: GeoEntityKind
  /** 仅 `entityKind === 'COMPETITOR'` 时有值。 */
  competitorId?: string
  entityName: string
  /** 1-based，同一次回答里多个实体按首次出现顺序排。 */
  position: number
  isCited: boolean
  sentiment: GeoSentiment
  /** -100..100。 */
  sentimentScore: number
  snippet: string
}

/** 参与匹配的实体定义（品牌自己或某个竞品）。 */
export interface EntityDef {
  kind: GeoEntityKind
  /** 竞品 id；`kind === 'BRAND'` 时不需要。 */
  id?: string
  name: string
  aliases: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 文本归一化：全角转半角 + 大小写不敏感 + 空白压缩
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 全角字符转半角（`！`→`!`、`Ａ`→`A`、全角空格→半角空格），不改变字符串长度
 * （逐字符一对一替换），这一点很关键：{@link extractMentionsFallback} 依赖归一化前后
 * 字符串等长，才能拿归一化文本里 `indexOf` 出来的下标直接去原文切 snippet。
 */
// 全角空格 U+3000。不写成正则字面量里的原始字符——那个字符属于 Unicode 的
// "空白类"，会被 eslint `no-irregular-whitespace` 规则拦下来（它专门找源码里
// 长得像空格但不是普通空格/制表符的字符，这正是我们想匹配的东西，但不能直接写在源码里）。
const FULLWIDTH_SPACE = String.fromCharCode(0x3000)

function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .split(FULLWIDTH_SPACE)
    .join(' ')
}

/** 用于在正文里做不区分大小写匹配的归一化：全角转半角 + 转小写。**不**改变长度。 */
function normalizeForMatch(s: string): string {
  return toHalfWidth(s).toLowerCase()
}

/**
 * 别名/实体名归一化：全角转半角、去首尾空白、压缩内部空白。
 * 用在"候选匹配串"上（品牌名、别名、LLM 回传的 entityName），不用在正文上。
 */
function normalizeAliasText(s: string): string {
  return toHalfWidth(s).trim().replace(/\s+/g, ' ')
}

function extractSnippet(text: string, index: number, matchLen: number, context = 60): string {
  const start = Math.max(0, index - context)
  const end = Math.min(text.length, index + matchLen + context)
  return text.slice(start, end)
}

function capSnippet(s: string, max: number): string {
  const codePoints = Array.from(s)
  return codePoints.length <= max ? s : codePoints.slice(0, max).join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// 正则/indexOf 兜底抽取
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 正则/`indexOf` 兜底抽取：对每个实体，在正文里找它的名字或任一别名第一次出现的位置，
 * 按"谁先出现"排 `position`，没出现的实体直接不产出。
 *
 * 兜底的局限很明确：只能判断"出现没出现"和"第几个出现"，判断不出语义层面的情感、
 * 也判断不出"提到但其实在说别的东西"——这些留给 LLM 路径（{@link mergeLlmMentions}）。
 * `sentiment` 固定 `NEUTRAL`、`sentimentScore` 固定 `0`，`isCited` 固定 `false`
 * （引用命中由 {@link markCited} 单独判定）。
 *
 * @param text - 回答正文
 * @param entities - 候选实体（品牌自己 + 全部竞品）
 */
export function extractMentionsFallback(text: unknown, entities: EntityDef[]): MentionDraft[] {
  const src = typeof text === 'string' ? text : ''
  const haystack = normalizeForMatch(src)

  const hits: Array<{ entity: EntityDef; index: number; len: number }> = []
  for (const entity of entities ?? []) {
    const candidates = [entity.name, ...(entity.aliases ?? [])]
      .filter((c): c is string => typeof c === 'string')
      .map((c) => normalizeAliasText(c))
      .filter((c) => c !== '')

    let best: { index: number; len: number } | null = null
    for (const candidate of candidates) {
      const needle = candidate.toLowerCase()
      const idx = haystack.indexOf(needle)
      if (idx === -1) continue
      if (best === null || idx < best.index) best = { index: idx, len: needle.length }
    }
    if (best !== null) hits.push({ entity, index: best.index, len: best.len })
  }

  // 按首次出现的下标排序；下标相同（理论上不会，除非两个实体名字重叠）时保持原顺序。
  hits.sort((a, b) => a.index - b.index)

  return hits.map((hit, i) => ({
    entityKind: hit.entity.kind,
    ...(hit.entity.kind === 'COMPETITOR' && hit.entity.id ? { competitorId: hit.entity.id } : {}),
    entityName: hit.entity.name,
    position: i + 1,
    isCited: false,
    sentiment: 'NEUTRAL' as GeoSentiment,
    sentimentScore: 0,
    snippet: extractSnippet(src, hit.index, hit.len, 60),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 情感分数/枚举
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 情感分数归一化：四舍五入取整后夹到 `[-100, 100]`；非数字（`undefined`/字符串/`NaN`……
 * LLM 结构化输出偶尔会把数字写成字符串）一律当 0（中性），不让脏数据把情感均值带偏。
 */
export function normalizeSentimentScore(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  const n = Math.round(v)
  if (n < -100) return -100
  if (n > 100) return 100
  return n
}

/**
 * 分数 → 情感枚举：`> 20` 正面，`< -20` 负面，`[-20, 20]` 中性。
 * 阈值不取 0 是因为生成式回答的措辞天然偏客气，score 在 ±20 以内的大多是
 * "提到了但没有明显褒贬"，全部判正/负会让情感分布失真。
 */
export function sentimentFromScore(score: number): GeoSentiment {
  const s = normalizeSentimentScore(score)
  if (s > 20) return 'POSITIVE'
  if (s < -20) return 'NEGATIVE'
  return 'NEUTRAL'
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM 结构化输出对齐
// ─────────────────────────────────────────────────────────────────────────────

// process-local: 纯常量集合（`GeoSentiment` 枚举的三个取值），不跨请求可变、
// 不跨租户、也不需要跨进程一致——每个进程各建一份完全无害。
const SENTIMENT_VALUES: ReadonlySet<string> = new Set(['POSITIVE', 'NEUTRAL', 'NEGATIVE'])

function toRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
}

function matchEntity(rawName: unknown, entities: EntityDef[]): EntityDef | null {
  if (typeof rawName !== 'string') return null
  const needle = normalizeAliasText(rawName).toLowerCase()
  if (needle === '') return null
  for (const entity of entities ?? []) {
    const candidates = [entity.name, ...(entity.aliases ?? [])]
    for (const c of candidates) {
      if (typeof c !== 'string') continue
      if (normalizeAliasText(c).toLowerCase() === needle) return entity
    }
  }
  return null
}

/** 缺失/非法 position 排到最后，而不是让它抢到"最小 position"的去重优先级。 */
function normalizePosition(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.trunc(v)
  return Number.MAX_SAFE_INTEGER
}

function normalizeSentimentEnum(v: unknown, score: number): GeoSentiment {
  if (typeof v === 'string' && SENTIMENT_VALUES.has(v)) return v as GeoSentiment
  return sentimentFromScore(score)
}

/**
 * 把 LLM 的结构化输出（`{ mentions: [{ entityName, position, isCited, sentiment,
 * sentimentScore, snippet }] }`）与实体表对齐，产出 {@link MentionDraft}。
 *
 * 对齐规则：
 * - `llmJson` 可以是已经 `JSON.parse` 过的对象，也可以是原始字符串（本函数会尝试
 *   `JSON.parse`）；解析失败、不是对象、没有 `mentions` 数组、或数组为空，一律退回 `fallback`；
 * - 每条 `mentions[i]` 按 `entityName` 做**归一化精确匹配**（大小写不敏感、全角转半角、
 *   去空白）到 `entities` 里的某个品牌/竞品；匹配不上的直接丢弃（不是错误，是 LLM
 *   编出了实体表里没有的名字）；
 * - 同一个实体出现多条时，只保留 `position` 最小的那条；
 * - 最终结果按 `position` 升序返回。
 *
 * `entityName` 在输出里统一替换成实体表里的**权威名字**（`entity.name`），
 * 不用 LLM 回传的原始写法——落库的 `entityName` 要和品牌/竞品管理页显示的名字一致。
 */
export function mergeLlmMentions(llmJson: unknown, entities: EntityDef[], fallback: MentionDraft[]): MentionDraft[] {
  const record = toRecord(llmJson)
  const rawList = record && Array.isArray(record['mentions']) ? (record['mentions'] as unknown[]) : null
  if (rawList === null || rawList.length === 0) return fallback

  const byKey = new Map<string, MentionDraft>()
  for (const raw of rawList) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const entity = matchEntity(r['entityName'], entities)
    if (entity === null) continue

    const key = `${entity.kind}:${entity.id ?? ''}:${entity.name}`
    const position = normalizePosition(r['position'])
    const sentimentScore = normalizeSentimentScore(r['sentimentScore'])
    const draft: MentionDraft = {
      entityKind: entity.kind,
      ...(entity.kind === 'COMPETITOR' && entity.id ? { competitorId: entity.id } : {}),
      entityName: entity.name,
      position,
      isCited: r['isCited'] === true,
      sentiment: normalizeSentimentEnum(r['sentiment'], sentimentScore),
      sentimentScore,
      snippet: capSnippet(typeof r['snippet'] === 'string' ? r['snippet'] : '', 500),
    }

    const existing = byKey.get(key)
    if (!existing || draft.position < existing.position) byKey.set(key, draft)
  }

  if (byKey.size === 0) return fallback
  return [...byKey.values()].sort((a, b) => a.position - b.position)
}

// ─────────────────────────────────────────────────────────────────────────────
// 引用命中标记
// ─────────────────────────────────────────────────────────────────────────────

/** `domain` 是不是 `root` 本身或它的子域（`shop.example.org` 命中 `example.org`）。 */
function domainMatchesRoot(domain: string, root: string): boolean {
  if (root === '') return false
  return domain === root || domain.endsWith(`.${root}`)
}

function normalizeDomainForCompare(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase().replace(/^www\./, '')
}

function anyDomainMatches(domains: ReadonlySet<string>, root: string): boolean {
  if (root === '') return false
  for (const d of domains) {
    if (domainMatchesRoot(d, root)) return true
  }
  return false
}

/**
 * 用引用列表回填 `isCited`：品牌提及命中 `brandDomain`（含子域）、竞品提及命中该
 * 竞品在 `competitorDomains` 里登记的域名（含子域），命中就把 `isCited` 置 `true`。
 *
 * 不改变入参数组，命中结果不变的条目原样返回（同一引用对象），改变的条目返回新对象——
 * 这样调用方可以用 `!==` 判断"这条有没有被这一步改过"，不需要额外传变更标记。
 */
export function markCited(
  mentions: MentionDraft[],
  citations: Array<{ domain: string }>,
  brandDomain: string | undefined,
  competitorDomains: Record<string, string>,
): MentionDraft[] {
  const citedDomains = new Set(
    (citations ?? []).map((c) => normalizeDomainForCompare(c?.domain)).filter((d) => d !== ''),
  )
  const brandRoot = normalizeDomainForCompare(brandDomain)

  return (mentions ?? []).map((m) => {
    let isCited = false
    if (m.entityKind === 'BRAND') {
      isCited = anyDomainMatches(citedDomains, brandRoot)
    } else if (m.entityKind === 'COMPETITOR' && m.competitorId) {
      const root = normalizeDomainForCompare(competitorDomains?.[m.competitorId])
      isCited = anyDomainMatches(citedDomains, root)
    }
    return isCited === m.isCited ? m : { ...m, isCited }
  })
}
