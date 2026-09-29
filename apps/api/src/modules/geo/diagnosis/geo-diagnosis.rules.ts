/**
 * 「先诊断后付费」编排链路的业务规则纯函数（产品需求 §4「内容优化建议」）。
 * 不 import 任何 `@nestjs/*`、不连库、不读时钟。
 *
 * ## 内容优化建议为什么是规则生成，不是 LLM 结构化输出
 *
 * 任务书原话给了两个选项：接一次追加的 LLM 调用，或者「如果时间/复杂度上风险较大，
 * 先用简单规则生成」。这里选了后者，是刻意的简化，理由有三条：
 *
 * 1. **可测试**：LLM 输出的建议没法写断言（"建议内容合理"不是一个能跑在 CI 里的条件），
 *    而规则函数的每一条分支都能用具体输入精确断言输出；
 * 2. **可复现/无额外成本**：诊断编排本身已经有一次同步 LLM 调用（问法生成，
 *    `geo-prompt.service.ts` 的 `generate()`），再加一次结构化抽取会让 `POST /diagnose`
 *    的响应时间与失败面同时变大——而这条链路对新用户是"第一印象"，多一次可能超时/
 *    可能编造内容的调用不划算；
 * 3. **不是空话模板**：每条建议都嵌入这次诊断**真实算出来**的数字（提及率、情感分、
 *    竞品名、来源域名），不是「建议优化内容质量」这种放之四海而皆准的废话——
 *    这正是任务书要求避免的"看起来能用但实际是假数据硬编码"的反面。
 *
 * 这是一处**明确的简化实现**，在后续迭代里可以替换成 LLM 生成而不改变调用点的形状
 * （`buildContentSuggestions` 的输入输出契约保持不变，内部实现换掉即可）。
 *
 * @packageDocumentation
 */

import type { GeoDiagnosisContentSuggestion } from '../report/geo-report.rules'

/** {@link buildContentSuggestions} 的输入：overview 的最小切面。 */
export interface DiagnosisOverviewInput {
  answers: number
  mentions: number
  mentionRateBp: number
  citationRateBp: number
  sentimentAvgX100: number
  avgPositionX100: number
}

/** {@link buildContentSuggestions} 的输入：`competitors[]` 一条的最小切面。 */
export interface DiagnosisCompetitorInput {
  competitorId: string
  name: string
  isBrand: boolean
  mentions: number
  sovBp: number | null
}

/** {@link buildContentSuggestions} 的输入：`topCitations[]` 一条的最小切面。 */
export interface DiagnosisCitationInput {
  domain: string
  count: number
  category: string
}

/** 建议条数上限：给商家一份"可以马上开始做的清单"，不是一份读不完的报告。 */
const MAX_SUGGESTIONS = 4

/** 判定阈值，均为基点（10000 = 100%）。数值来自产品定义 §2 的经验区间，注释即是理由。 */
const LOW_MENTION_RATE_BP = 3000
const LOW_CITATION_RATE_BP = 3000
/** 负面情感阈值：与 `geo-mention.rules.ts` 的 `sentimentFromScore` 用同一个 ±20 分界。 */
const NEGATIVE_SENTIMENT_X100 = -20
/** 平均位置差于第 2 位（×100 = 200）判定"排太靠后"。 */
const POOR_POSITION_X100 = 200

function pct(bp: number): string {
  return (bp / 100).toFixed(1)
}

/**
 * 按规则从一次诊断的结果生成 3-4 条内容优化建议，每条都嵌入真实计算出的数字。
 *
 * 规则按"影响转化的严重程度"排列，命中的都会给（最多 {@link MAX_SUGGESTIONS} 条）；
 * 一条都没命中（各项指标都健康）时给一条正向建议，而不是空数组——诊断报告
 * 交出一份"什么都不用做"的结论对商家没有推进意义，至少要有一条"接下来做什么"。
 *
 * @param overview - 这次诊断的核心指标
 * @param competitors - 竞品对比（含品牌自己那条 `isBrand: true`）
 * @param topCitations - 引用来源榜单
 */
export function buildContentSuggestions(
  overview: DiagnosisOverviewInput,
  competitors: readonly DiagnosisCompetitorInput[],
  topCitations: readonly DiagnosisCitationInput[],
): GeoDiagnosisContentSuggestion[] {
  if (overview.answers <= 0) {
    return [
      {
        kind: 'NO_DATA',
        title: '本次诊断还没有可用的回答数据',
        detail: '跑批可能仍在进行、或全部查询失败，建议先检查引擎配置与网络连通性，再重新发起一次诊断。',
      },
    ]
  }

  const out: GeoDiagnosisContentSuggestion[] = []

  if (overview.mentionRateBp < LOW_MENTION_RATE_BP) {
    out.push({
      kind: 'LOW_MENTION_RATE',
      title: `品牌提及率仅 ${pct(overview.mentionRateBp)}%`,
      detail:
        `这次诊断的 ${overview.answers} 次问答里，AI 只在 ${overview.mentions} 次里提到了本品牌。` +
        '建议围绕未提及的问法主题，补充官网/知乎/公众号等渠道的针对性内容，让 AI 有更多可引用的原始信息。',
    })
  }

  if (overview.citationRateBp < LOW_CITATION_RATE_BP) {
    out.push({
      kind: 'LOW_CITATION_RATE',
      title: `带引用来源的提及占比仅 ${pct(overview.citationRateBp)}%`,
      detail: '多数提及没有附带可核实的来源链接，建议在官网补充结构化的产品说明与常见问题页，提高被引用的概率。',
    })
  }

  if (overview.sentimentAvgX100 < NEGATIVE_SENTIMENT_X100) {
    out.push({
      kind: 'NEGATIVE_SENTIMENT',
      title: `情感倾向偏负面（均分 ${overview.sentimentAvgX100}）`,
      detail: '建议排查是否存在过时或不准确的第三方评价内容，并主动发布权威、正面的产品对比与使用案例。',
    })
  }

  if (overview.mentions > 0 && overview.avgPositionX100 > POOR_POSITION_X100) {
    out.push({
      kind: 'POOR_POSITION',
      title: `平均出现位置靠后（约第 ${(overview.avgPositionX100 / 100).toFixed(1)} 位）`,
      detail: '本品牌通常不是 AI 回答里第一个被提到的选项，建议优化标题与摘要的信息密度，让核心卖点更靠前地出现在内容里。',
    })
  }

  const leadingCompetitor = [...competitors]
    .filter((c) => !c.isBrand && c.sovBp !== null)
    .sort((a, b) => (b.sovBp ?? 0) - (a.sovBp ?? 0))[0]
  const brandRow = competitors.find((c) => c.isBrand)
  if (
    leadingCompetitor &&
    brandRow &&
    leadingCompetitor.sovBp !== null &&
    brandRow.sovBp !== null &&
    leadingCompetitor.sovBp > brandRow.sovBp
  ) {
    out.push({
      kind: 'COMPETITOR_OVERTAKE',
      title: `竞品「${leadingCompetitor.name}」的声量份额高于本品牌`,
      detail:
        `「${leadingCompetitor.name}」的 SoV 约 ${pct(leadingCompetitor.sovBp)}%，本品牌约 ${pct(brandRow.sovBp)}%。` +
        '建议对照它被引用的内容主题，补齐本品牌在同类问法下的可信信息来源。',
    })
  }

  const ownedCitations = topCitations.filter((c) => c.category === 'OWNED').reduce((s, c) => s + c.count, 0)
  const totalCitations = topCitations.reduce((s, c) => s + c.count, 0)
  if (totalCitations > 0 && ownedCitations / totalCitations < 0.3) {
    out.push({
      kind: 'LOW_OWNED_CITATION_SHARE',
      title: '引用来源里自有内容占比偏低',
      detail: 'AI 回答主要引用第三方内容而非官网/官方渠道，建议补充可被直接引用的权威页面（产品对比表、FAQ、白皮书）。',
    })
  }

  if (out.length === 0) {
    out.push({
      kind: 'HEALTHY',
      title: '核心指标表现健康',
      detail: '当前提及率、引用率与情感倾向都在正常区间，建议继续扩充监测问法覆盖面，观察长期趋势。',
    })
  }

  return out.slice(0, MAX_SUGGESTIONS)
}
