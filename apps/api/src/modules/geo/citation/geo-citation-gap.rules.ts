/**
 * 引用缺口分析的业务规则纯函数（"竞品被提及、本品牌完全没被提及"的回答里，
 * AI 实际引用了哪些第三方信息源）+ 模板化内容优化建议。
 *
 * ## 为什么不是"竞品官网被引用 vs 品牌官网没被引用"
 *
 * `GeoCitation.category` 里的 OWNED/COMPETITOR 只表示"这条引用的域名是不是品牌/某个
 * 竞品自己的官网"（见 `analysis/geo-citation.rules.ts` 的 `classifySource`），不表示
 * "这条引用是在讨论谁"。一条知乎链接被引用，判断不出它是在讨论品牌还是竞品。
 *
 * 真正可用的信号是**回答（result）层面**的提及缺口：同一次回答里，`GeoMention` 记录
 * 了哪些实体（品牌/竞品）被提到、`GeoCitation` 记录了这次回答引用了哪些来源——
 * 两者共享 `resultId`。找出"竞品被提到、品牌完全没被提到"的那些回答，看它们引用了
 * 哪些第三方来源（排除 OWNED/COMPETITOR，那两档是"自己人"，不是缺口），就是 AI 在
 * 讨论这个话题时实际参考的信息源，也正是品牌应该去补内容的地方。
 *
 * @packageDocumentation
 */
import type { GeoSourceCategory } from '@prisma/client'

/** 用于 diff 的一条竞品提及行（DB 查询结果的最小切片）。 */
export interface CompetitorMentionRow {
  resultId: string
  entityName: string
}

/** {@link diffGapResultIds} 的返回。 */
export interface GapDiffResult {
  /** 竞品被提及、品牌完全没被提及的回答 id（去重）。 */
  gapResultIds: string[]
  /** 这些回答里出现过的竞品名字（去重、按字典序排）。 */
  competitorNames: string[]
}

/**
 * 找出"竞品被提及、但本品牌完全没被提及"的回答 id 集合。
 *
 * `brandMentionResultIds` 只需要传"候选回答里，品牌被提及的那部分"——调用方在查询时
 * 应该已经把范围限定在 `competitorMentions` 涉及的 resultId 集合内，这里不重新校验。
 */
export function diffGapResultIds(
  competitorMentions: CompetitorMentionRow[],
  brandMentionResultIds: string[],
): GapDiffResult {
  const brandSet = new Set(brandMentionResultIds)
  const gapSet = new Set<string>()
  const nameSet = new Set<string>()

  for (const m of competitorMentions ?? []) {
    if (brandSet.has(m.resultId)) continue
    gapSet.add(m.resultId)
    if (m.entityName) nameSet.add(m.entityName)
  }

  return {
    gapResultIds: [...gapSet],
    competitorNames: [...nameSet].sort((a, b) => a.localeCompare(b)),
  }
}

/** 缺口榜只关心第三方来源；OWNED/COMPETITOR 是"自己人"，不是缺口。 */
export type GapSourceCategory = Exclude<GeoSourceCategory, 'OWNED' | 'COMPETITOR'>

const GAP_SUGGESTION_TEMPLATES: Record<GapSourceCategory, string> = {
  EARNED: '这类自然媒体/测评渠道报道过竞品，建议争取媒体评测或投稿软文，提升被 AI 引用的概率。',
  SOCIAL: '知乎/小红书这类问答与社交平台适合发布深度对比、测评类内容，能直接提高被 AI 抓取引用的机会。',
  ENCYCLOPEDIA: '完善或新建品牌百科词条——百科类内容是 AI 高频引用的信息源之一。',
  PR: '考虑投放新闻稿或公关稿，扩大在这类渠道的曝光。',
  OTHER: '这个来源暂未归类到具体平台类型，建议人工核实一下内容形态，再决定要不要投放。',
}

/** 按来源归类给一句模板化建议；未知/超出枚举范围的归类一律退回 `OTHER` 的文案。 */
export function suggestionForCategory(category: GapSourceCategory): string {
  return GAP_SUGGESTION_TEMPLATES[category] ?? GAP_SUGGESTION_TEMPLATES.OTHER
}

/** 一条待翻译的域名计数（DB 聚合结果）。 */
export interface GapDomainCount {
  domain: string
  count: number
  platform: string
  category: GapSourceCategory
}

/** 附了建议文案的一条缺口榜行。 */
export interface GapItem extends GapDomainCount {
  suggestion: string
}

/**
 * 把域名计数翻译成"缺口榜"：按次数降序（次数相同按域名字典序，保证排序稳定、
 * 测试可断言），逐行附上模板化建议文案。
 */
export function buildGapItems(rows: GapDomainCount[]): GapItem[] {
  return [...(rows ?? [])]
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .map((r) => ({ ...r, suggestion: suggestionForCategory(r.category) }))
}
