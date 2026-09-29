/**
 * `geo-citation-gap.rules.ts` 的单测。
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest'

import {
  buildGapItems,
  diffGapResultIds,
  suggestionForCategory,
  type CompetitorMentionRow,
  type GapDomainCount,
} from './geo-citation-gap.rules'

describe('diffGapResultIds', () => {
  it('竞品提及为空 → 缺口为空', () => {
    expect(diffGapResultIds([], [])).toEqual({ gapResultIds: [], competitorNames: [] })
  })

  it('同一个回答里品牌也被提及 → 不算缺口', () => {
    const mentions: CompetitorMentionRow[] = [{ resultId: 'r1', entityName: '竞品甲' }]
    const out = diffGapResultIds(mentions, ['r1'])
    expect(out).toEqual({ gapResultIds: [], competitorNames: [] })
  })

  it('回答里只提了竞品、没提品牌 → 算缺口，附竞品名', () => {
    const mentions: CompetitorMentionRow[] = [{ resultId: 'r1', entityName: '竞品甲' }]
    const out = diffGapResultIds(mentions, [])
    expect(out).toEqual({ gapResultIds: ['r1'], competitorNames: ['竞品甲'] })
  })

  it('多个回答混合：部分缺口、部分品牌也在场，各自正确归类', () => {
    const mentions: CompetitorMentionRow[] = [
      { resultId: 'r1', entityName: '竞品甲' },
      { resultId: 'r2', entityName: '竞品乙' },
      { resultId: 'r3', entityName: '竞品甲' },
    ]
    // r2 品牌也被提及，不算缺口；r1/r3 算。
    const out = diffGapResultIds(mentions, ['r2'])
    expect(out.gapResultIds.sort()).toEqual(['r1', 'r3'])
    expect(out.competitorNames).toEqual(['竞品甲'])
  })

  it('同一回答多个竞品都被提及 → 竞品名去重且按字典序排', () => {
    const mentions: CompetitorMentionRow[] = [
      { resultId: 'r1', entityName: '竞品乙' },
      { resultId: 'r1', entityName: '竞品甲' },
      { resultId: 'r2', entityName: '竞品甲' },
    ]
    const out = diffGapResultIds(mentions, [])
    expect(out.gapResultIds.sort()).toEqual(['r1', 'r2'])
    expect(out.competitorNames).toEqual(['竞品乙', '竞品甲'].sort((a, b) => a.localeCompare(b)))
  })

  it('entityName 为空串不计入 competitorNames，但 resultId 仍算缺口', () => {
    const mentions: CompetitorMentionRow[] = [{ resultId: 'r1', entityName: '' }]
    const out = diffGapResultIds(mentions, [])
    expect(out.gapResultIds).toEqual(['r1'])
    expect(out.competitorNames).toEqual([])
  })
})

describe('suggestionForCategory', () => {
  it('五个非 OWNED/COMPETITOR 归类各自有不同的建议文案', () => {
    const categories = ['EARNED', 'SOCIAL', 'ENCYCLOPEDIA', 'PR', 'OTHER'] as const
    const texts = categories.map((c) => suggestionForCategory(c))
    expect(new Set(texts).size).toBe(categories.length)
    for (const t of texts) expect(t.length).toBeGreaterThan(0)
  })

  it('未知归类退回 OTHER 的文案', () => {
    // @ts-expect-error 故意传一个不在 GapSourceCategory 里的值，验证运行期防御
    expect(suggestionForCategory('NOT_A_CATEGORY')).toBe(suggestionForCategory('OTHER'))
  })
})

describe('buildGapItems', () => {
  it('按次数降序排列，并附上对应建议', () => {
    const rows: GapDomainCount[] = [
      { domain: 'a.com', count: 3, platform: 'A', category: 'SOCIAL' },
      { domain: 'b.com', count: 8, platform: 'B', category: 'ENCYCLOPEDIA' },
    ]
    const out = buildGapItems(rows)
    expect(out.map((i) => i.domain)).toEqual(['b.com', 'a.com'])
    expect(out[0]?.suggestion).toBe(suggestionForCategory('ENCYCLOPEDIA'))
    expect(out[1]?.suggestion).toBe(suggestionForCategory('SOCIAL'))
  })

  it('次数相同按域名字典序排，保证结果稳定', () => {
    const rows: GapDomainCount[] = [
      { domain: 'z.com', count: 2, platform: '', category: 'OTHER' },
      { domain: 'a.com', count: 2, platform: '', category: 'OTHER' },
    ]
    const out = buildGapItems(rows)
    expect(out.map((i) => i.domain)).toEqual(['a.com', 'z.com'])
  })

  it('空输入返回空数组', () => {
    expect(buildGapItems([])).toEqual([])
  })
})
