import { describe, expect, it } from 'vitest'

import {
  competitorsWithNullableSov,
  overviewWithNullableSov,
  top1RateBp,
} from './geo-report.rules'

describe('overviewWithNullableSov', () => {
  it('品牌与竞品都没有任何提及（分母为 0）时，sovBp 变成 null', () => {
    const overview = { mentions: 0, sovBp: 0, other: 'x' }
    const result = overviewWithNullableSov(overview, 0)
    expect(result.sovBp).toBeNull()
    expect(result.other).toBe('x')
  })

  it('品牌提及率恰好是 0（但竞品有提及）时，分母不为 0，sovBp 保留原值 0', () => {
    const overview = { mentions: 0, sovBp: 0 }
    const result = overviewWithNullableSov(overview, 5)
    expect(result.sovBp).toBe(0)
  })

  it('分母不为 0 时，sovBp 原样保留（不是 0 也不改）', () => {
    const overview = { mentions: 3, sovBp: 6000 }
    const result = overviewWithNullableSov(overview, 2)
    expect(result.sovBp).toBe(6000)
  })

  it('传入的竞品提及总数是负数（防御性）时按 0 处理', () => {
    const overview = { mentions: 0, sovBp: 0 }
    const result = overviewWithNullableSov(overview, -3)
    expect(result.sovBp).toBeNull()
  })
})

describe('competitorsWithNullableSov', () => {
  it('全部条目 mentions 都是 0 时，每一条的 sovBp 都变成 null', () => {
    const rows = [
      { competitorId: '', name: '品牌自己', mentions: 0, sovBp: 0 },
      { competitorId: 'c1', name: '竞品A', mentions: 0, sovBp: 0 },
    ]
    const result = competitorsWithNullableSov(rows)
    expect(result.every((r) => r.sovBp === null)).toBe(true)
  })

  it('至少一条有提及时，共享分母不为 0，全部条目保留原始 sovBp（包括 0）', () => {
    const rows = [
      { competitorId: '', name: '品牌自己', mentions: 0, sovBp: 0 },
      { competitorId: 'c1', name: '竞品A', mentions: 4, sovBp: 10000 },
    ]
    const result = competitorsWithNullableSov(rows)
    expect(result[0]?.sovBp).toBe(0)
    expect(result[1]?.sovBp).toBe(10000)
  })

  it('空数组回空数组，不抛错', () => {
    expect(competitorsWithNullableSov([])).toEqual([])
  })
})

describe('top1RateBp', () => {
  it('answers 为 0 时回 0（不是 null——分母语义与 SoV 不同）', () => {
    expect(top1RateBp(0, 0)).toBe(0)
  })

  it('没有任何第一顺位提及时回 0（不是 null）', () => {
    expect(top1RateBp(0, 10)).toBe(0)
  })

  it('精确计算：3/10 = 3000bp', () => {
    expect(top1RateBp(3, 10)).toBe(3000)
  })

  it('负数 top1Count（防御性）按 0 处理', () => {
    expect(top1RateBp(-5, 10)).toBe(0)
  })
})
