import { describe, expect, it } from 'vitest'

import { buildContentSuggestions, type DiagnosisOverviewInput } from './geo-diagnosis.rules'

const HEALTHY_OVERVIEW: DiagnosisOverviewInput = {
  answers: 10,
  mentions: 9,
  mentionRateBp: 9000,
  citationRateBp: 8000,
  sentimentAvgX100: 50,
  avgPositionX100: 100,
}

describe('buildContentSuggestions', () => {
  it('answers 为 0 时只返回一条「没有数据」的建议', () => {
    const out = buildContentSuggestions({ ...HEALTHY_OVERVIEW, answers: 0 }, [], [])
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('NO_DATA')
  })

  it('各项指标都健康时返回一条正向建议，不是空数组', () => {
    const out = buildContentSuggestions(HEALTHY_OVERVIEW, [], [])
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('HEALTHY')
  })

  it('提及率低时给出带具体数字的建议', () => {
    const overview: DiagnosisOverviewInput = { ...HEALTHY_OVERVIEW, mentionRateBp: 1500, mentions: 1, answers: 10 }
    const out = buildContentSuggestions(overview, [], [])
    const hit = out.find((s) => s.kind === 'LOW_MENTION_RATE')
    expect(hit).toBeDefined()
    expect(hit?.title).toContain('15.0%')
  })

  it('引用率低时命中 LOW_CITATION_RATE', () => {
    const overview: DiagnosisOverviewInput = { ...HEALTHY_OVERVIEW, citationRateBp: 1000 }
    const out = buildContentSuggestions(overview, [], [])
    expect(out.some((s) => s.kind === 'LOW_CITATION_RATE')).toBe(true)
  })

  it('情感均分为负且低于阈值时命中 NEGATIVE_SENTIMENT', () => {
    const overview: DiagnosisOverviewInput = { ...HEALTHY_OVERVIEW, sentimentAvgX100: -40 }
    const out = buildContentSuggestions(overview, [], [])
    expect(out.some((s) => s.kind === 'NEGATIVE_SENTIMENT')).toBe(true)
  })

  it('平均位置靠后（且确实有提及）时命中 POOR_POSITION', () => {
    const overview: DiagnosisOverviewInput = { ...HEALTHY_OVERVIEW, avgPositionX100: 350 }
    const out = buildContentSuggestions(overview, [], [])
    expect(out.some((s) => s.kind === 'POOR_POSITION')).toBe(true)
  })

  it('没有任何提及时不因为 avgPositionX100=0 误判成"位置靠前"以外的东西（不命中 POOR_POSITION）', () => {
    const overview: DiagnosisOverviewInput = { ...HEALTHY_OVERVIEW, mentions: 0, mentionRateBp: 0, avgPositionX100: 0 }
    const out = buildContentSuggestions(overview, [], [])
    expect(out.some((s) => s.kind === 'POOR_POSITION')).toBe(false)
  })

  it('竞品声量份额反超品牌时命中 COMPETITOR_OVERTAKE，且两个 sovBp 都不为 null 才判定', () => {
    const competitors = [
      { competitorId: '', name: '本品牌', isBrand: true, mentions: 3, sovBp: 3000 },
      { competitorId: 'c1', name: '竞品A', isBrand: false, mentions: 7, sovBp: 7000 },
    ]
    const out = buildContentSuggestions(HEALTHY_OVERVIEW, competitors, [])
    const hit = out.find((s) => s.kind === 'COMPETITOR_OVERTAKE')
    expect(hit).toBeDefined()
    expect(hit?.title).toContain('竞品A')
  })

  it('竞品 sovBp 为 null（分母为 0）时不参与反超判定', () => {
    const competitors = [
      { competitorId: '', name: '本品牌', isBrand: true, mentions: 0, sovBp: null },
      { competitorId: 'c1', name: '竞品A', isBrand: false, mentions: 0, sovBp: null },
    ]
    const out = buildContentSuggestions(HEALTHY_OVERVIEW, competitors, [])
    expect(out.some((s) => s.kind === 'COMPETITOR_OVERTAKE')).toBe(false)
  })

  it('自有引用占比低于 30% 时命中 LOW_OWNED_CITATION_SHARE', () => {
    const citations = [
      { domain: 'zhihu.com', count: 8, category: 'SOCIAL' },
      { domain: 'brand.example.com', count: 2, category: 'OWNED' },
    ]
    const out = buildContentSuggestions(HEALTHY_OVERVIEW, [], citations)
    expect(out.some((s) => s.kind === 'LOW_OWNED_CITATION_SHARE')).toBe(true)
  })

  it('最多返回 4 条，即使命中的规则更多', () => {
    const overview: DiagnosisOverviewInput = {
      answers: 10,
      mentions: 1,
      mentionRateBp: 1000,
      citationRateBp: 1000,
      sentimentAvgX100: -50,
      avgPositionX100: 400,
    }
    const competitors = [
      { competitorId: '', name: '本品牌', isBrand: true, mentions: 1, sovBp: 1000 },
      { competitorId: 'c1', name: '竞品A', isBrand: false, mentions: 9, sovBp: 9000 },
    ]
    const citations = [{ domain: 'zhihu.com', count: 10, category: 'SOCIAL' }]
    const out = buildContentSuggestions(overview, competitors, citations)
    expect(out.length).toBeLessThanOrEqual(4)
    expect(out.length).toBeGreaterThan(1)
  })
})
