/**
 * `geo-alert.rules.ts` 的单测。
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest'

import {
  evaluateAlertRules,
  evaluateCompetitorOvertake,
  evaluateNegativeMention,
  evaluateVisibilityDrop,
  validateChannels,
  type AlertRuleConfig,
  type DailyPoint,
} from './geo-alert.rules'

function point(overrides: Partial<DailyPoint> = {}): DailyPoint {
  return { mentionRateBp: 5000, sovBp: 5000, sentimentAvgX100: 0, competitorStats: {}, ...overrides }
}

describe('evaluateVisibilityDrop', () => {
  it('下降超过阈值 → 触发', () => {
    const today = point({ mentionRateBp: 2000 })
    const yesterday = point({ mentionRateBp: 5000 })
    const out = evaluateVisibilityDrop(today, yesterday, 2000)
    expect(out.fired).toBe(true)
    expect(out.deltaBp).toBe(3000)
  })

  it('恰好等于阈值 → 触发（边界，<=）', () => {
    const today = point({ mentionRateBp: 3000 })
    const yesterday = point({ mentionRateBp: 5000 })
    expect(evaluateVisibilityDrop(today, yesterday, 2000).fired).toBe(true)
  })

  it('差一点没到阈值 → 不触发', () => {
    const today = point({ mentionRateBp: 3001 })
    const yesterday = point({ mentionRateBp: 5000 })
    expect(evaluateVisibilityDrop(today, yesterday, 2000).fired).toBe(false)
  })

  it('yesterday 缺失 → 不触发', () => {
    const out = evaluateVisibilityDrop(point({ mentionRateBp: 0 }), undefined, 100)
    expect(out.fired).toBe(false)
    expect(out.deltaBp).toBe(0)
    expect(out.payload).toEqual({})
  })

  it('提及率上升不触发', () => {
    const out = evaluateVisibilityDrop(point({ mentionRateBp: 6000 }), point({ mentionRateBp: 5000 }), 500)
    expect(out.fired).toBe(false)
  })
})

describe('evaluateCompetitorOvertake', () => {
  it('昨天品牌领先或持平、今天落后 → 触发', () => {
    const yesterday = point({ sovBp: 5000, competitorStats: { c1: { mentions: 1, mentionRateBp: 0, sovBp: 5000, avgPositionX100: 0 } } })
    const today = point({ sovBp: 3000, competitorStats: { c1: { mentions: 1, mentionRateBp: 0, sovBp: 6000, avgPositionX100: 0 } } })
    const out = evaluateCompetitorOvertake(today, yesterday)
    expect(out).toMatchObject({ fired: true, competitorId: 'c1' })
  })

  it('昨天持平（>=）也算"曾经领先"的起点', () => {
    const yesterday = point({ sovBp: 5000, competitorStats: { c1: { mentions: 1, mentionRateBp: 0, sovBp: 5000, avgPositionX100: 0 } } })
    const today = point({ sovBp: 4000, competitorStats: { c1: { mentions: 1, mentionRateBp: 0, sovBp: 4001, avgPositionX100: 0 } } })
    expect(evaluateCompetitorOvertake(today, yesterday).fired).toBe(true)
  })

  it('昨天已经落后（不是"反超"，是一直落后）→ 不触发', () => {
    const yesterday = point({ sovBp: 3000, competitorStats: { c1: { mentions: 1, mentionRateBp: 0, sovBp: 5000, avgPositionX100: 0 } } })
    const today = point({ sovBp: 2000, competitorStats: { c1: { mentions: 1, mentionRateBp: 0, sovBp: 6000, avgPositionX100: 0 } } })
    expect(evaluateCompetitorOvertake(today, yesterday).fired).toBe(false)
  })

  it('yesterday 缺失 → 不触发', () => {
    expect(evaluateCompetitorOvertake(point(), undefined)).toEqual({ fired: false, payload: {} })
  })

  it('没有竞品数据 → 不触发', () => {
    expect(evaluateCompetitorOvertake(point(), point()).fired).toBe(false)
  })

  it('多个竞品都满足条件时，返回第一个（按 yesterday.competitorStats 的 key 顺序）', () => {
    const yesterday = point({
      sovBp: 5000,
      competitorStats: {
        c1: { mentions: 1, mentionRateBp: 0, sovBp: 5000, avgPositionX100: 0 },
        c2: { mentions: 1, mentionRateBp: 0, sovBp: 5000, avgPositionX100: 0 },
      },
    })
    const today = point({
      sovBp: 1000,
      competitorStats: {
        c1: { mentions: 1, mentionRateBp: 0, sovBp: 6000, avgPositionX100: 0 },
        c2: { mentions: 1, mentionRateBp: 0, sovBp: 6000, avgPositionX100: 0 },
      },
    })
    expect(evaluateCompetitorOvertake(today, yesterday).competitorId).toBe('c1')
  })
})

describe('evaluateNegativeMention', () => {
  it('达到阈值 → 触发（边界，>=）', () => {
    expect(evaluateNegativeMention(3, 3).fired).toBe(true)
  })

  it('差一条不触发', () => {
    expect(evaluateNegativeMention(2, 3).fired).toBe(false)
  })

  it('0 条负面 → 不触发', () => {
    expect(evaluateNegativeMention(0, 3).fired).toBe(false)
  })

  it('阈值 <= 0 视为未配置，不触发（即便当天 0 条负面）', () => {
    expect(evaluateNegativeMention(0, 0).fired).toBe(false)
    expect(evaluateNegativeMention(5, -1).fired).toBe(false)
  })

  it('非法数字按 0 处理', () => {
    expect(evaluateNegativeMention(Number.NaN, 3).fired).toBe(false)
  })
})

describe('validateChannels', () => {
  it('["INBOX"] 合法', () => {
    expect(validateChannels(['INBOX'])).toEqual(['INBOX'])
  })

  it('["INBOX","SMS"] 合法', () => {
    expect(validateChannels(['INBOX', 'SMS'])).toEqual(['INBOX', 'SMS'])
  })

  it('顺序反了不合法', () => {
    expect(() => validateChannels(['SMS', 'INBOX'])).toThrow()
  })

  it('["SMS"] 单独出现不合法', () => {
    expect(() => validateChannels(['SMS'])).toThrow()
  })

  it('空数组不合法', () => {
    expect(() => validateChannels([])).toThrow()
  })

  it('非数组不合法', () => {
    expect(() => validateChannels('INBOX')).toThrow()
    expect(() => validateChannels(undefined)).toThrow()
    expect(() => validateChannels(null)).toThrow()
  })

  it('数组里混入非字符串不合法', () => {
    expect(() => validateChannels(['INBOX', 1])).toThrow()
  })

  it('重复项不合法', () => {
    expect(() => validateChannels(['INBOX', 'INBOX'])).toThrow()
  })
})

describe('evaluateAlertRules', () => {
  const now = new Date('2026-01-02T00:00:00Z')
  const cooldownMs = 24 * 60 * 60 * 1000

  it('未启用的规则跳过', () => {
    const rules: AlertRuleConfig[] = [{ id: 'r1', kind: 'VISIBILITY_DROP', thresholdBp: 1, enabled: false }]
    const out = evaluateAlertRules(rules, {
      today: point({ mentionRateBp: 0 }),
      yesterday: point({ mentionRateBp: 10000 }),
      negativeCount: 0,
      now,
      cooldownMs,
    })
    expect(out).toEqual([])
  })

  it('冷却期内跳过（即便条件满足）', () => {
    const rules: AlertRuleConfig[] = [
      { id: 'r1', kind: 'VISIBILITY_DROP', thresholdBp: 1, enabled: true, lastFiredAt: new Date('2026-01-01T12:00:00Z') },
    ]
    const out = evaluateAlertRules(rules, {
      today: point({ mentionRateBp: 0 }),
      yesterday: point({ mentionRateBp: 10000 }),
      negativeCount: 0,
      now,
      cooldownMs,
    })
    expect(out).toEqual([])
  })

  it('冷却期已过 → 正常触发', () => {
    const rules: AlertRuleConfig[] = [
      { id: 'r1', kind: 'VISIBILITY_DROP', thresholdBp: 1, enabled: true, lastFiredAt: new Date('2025-01-01T00:00:00Z') },
    ]
    const out = evaluateAlertRules(rules, {
      today: point({ mentionRateBp: 0 }),
      yesterday: point({ mentionRateBp: 10000 }),
      negativeCount: 0,
      now,
      cooldownMs,
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ ruleId: 'r1', kind: 'VISIBILITY_DROP' })
  })

  it('从没触发过（lastFiredAt 缺失）不受冷却期影响', () => {
    const rules: AlertRuleConfig[] = [{ id: 'r1', kind: 'NEGATIVE_MENTION', thresholdBp: 2, enabled: true }]
    const out = evaluateAlertRules(rules, {
      today: point(),
      yesterday: point(),
      negativeCount: 5,
      now,
      cooldownMs,
    })
    expect(out).toHaveLength(1)
  })

  it('按 kind 分发到对应的 evaluateXxx，条件不满足时不产出', () => {
    const rules: AlertRuleConfig[] = [
      { id: 'r1', kind: 'VISIBILITY_DROP', thresholdBp: 9999, enabled: true },
      { id: 'r2', kind: 'COMPETITOR_OVERTAKE', thresholdBp: 0, enabled: true },
      { id: 'r3', kind: 'NEGATIVE_MENTION', thresholdBp: 100, enabled: true },
    ]
    const out = evaluateAlertRules(rules, {
      today: point(),
      yesterday: point(),
      negativeCount: 1,
      now,
      cooldownMs,
    })
    expect(out).toEqual([])
  })

  it('多条规则同时满足条件时全部产出', () => {
    const rules: AlertRuleConfig[] = [
      { id: 'r1', kind: 'VISIBILITY_DROP', thresholdBp: 1, enabled: true },
      { id: 'r3', kind: 'NEGATIVE_MENTION', thresholdBp: 1, enabled: true },
    ]
    const out = evaluateAlertRules(rules, {
      today: point({ mentionRateBp: 0 }),
      yesterday: point({ mentionRateBp: 10000 }),
      negativeCount: 5,
      now,
      cooldownMs,
    })
    expect(out.map((a) => a.ruleId).sort()).toEqual(['r1', 'r3'])
  })

  it('空规则数组 → 空数组', () => {
    expect(evaluateAlertRules([], { today: point(), negativeCount: 0, now, cooldownMs })).toEqual([])
  })
})
