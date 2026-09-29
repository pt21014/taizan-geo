/**
 * `geo-dashboard.rules.ts` 的单测。
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest'

import {
  diffRollup,
  EMPTY_ROLLUP,
  parseCompetitorStats,
  rollupCompetitorStats,
  rollupDailyRows,
  type DailyRow,
} from './geo-dashboard.rules'

function row(partial: Partial<DailyRow>): DailyRow {
  return {
    answers: 0,
    mentions: 0,
    mentionRateBp: 0,
    sovBp: 0,
    avgPositionX100: 0,
    citationRateBp: 0,
    sentimentAvgX100: 0,
    ...partial,
  }
}

describe('rollupDailyRows', () => {
  it('空输入 → 全零，days = 0（不是 null，前端少一层判空）', () => {
    expect(rollupDailyRows([])).toEqual(EMPTY_ROLLUP)
  })

  it('mentionRateBp 是精确重算（Σmentions / Σanswers），不是逐日算术平均', () => {
    // 周一 200 条回答提及 20 次（1000bp）；周二 2 条回答都提及（10000bp）。
    // 算术平均会得出 5500bp（55%），而真实的周提及率是 22/202 ≈ 1089bp。
    const out = rollupDailyRows([
      row({ answers: 200, mentions: 20, mentionRateBp: 1000 }),
      row({ answers: 2, mentions: 2, mentionRateBp: 10000 }),
    ])
    expect(out.answers).toBe(202)
    expect(out.mentions).toBe(22)
    expect(out.mentionRateBp).toBe(1089)
    expect(out.mentionRateBp).not.toBe(5500)
  })

  it('answers = 0 时 mentionRateBp 为 0，不抛（除零）', () => {
    expect(rollupDailyRows([row({})]).mentionRateBp).toBe(0)
  })

  it('sovBp / citationRateBp 按 answers 加权', () => {
    const out = rollupDailyRows([
      row({ answers: 90, sovBp: 1000, citationRateBp: 2000 }),
      row({ answers: 10, sovBp: 9000, citationRateBp: 4000 }),
    ])
    // (1000*90 + 9000*10) / 100 = 1800
    expect(out.sovBp).toBe(1800)
    // (2000*90 + 4000*10) / 100 = 2200
    expect(out.citationRateBp).toBe(2200)
  })

  it('**avgPositionX100 按 mentions 加权**：0 提及的那天不该把位次拉向 0', () => {
    const out = rollupDailyRows([
      // 跑了 100 条一次都没提到：avgPositionX100 是 0，但"位次 0"不存在。
      row({ answers: 100, mentions: 0, avgPositionX100: 0 }),
      // 跑了 2 条都提到了，平均位次 2.00。
      row({ answers: 2, mentions: 2, avgPositionX100: 200 }),
    ])
    expect(out.avgPositionX100).toBe(200)
    // 按 answers 加权会得到 round(200*2/102) = 4，也就是"平均位次 0.04"——
    // 比最好的可能值（1.00）还好，那是个错的数字而不是不精确的数字。
    expect(out.avgPositionX100).not.toBe(4)
  })

  it('sentimentAvgX100 同样按 mentions 加权', () => {
    const out = rollupDailyRows([
      row({ answers: 100, mentions: 0, sentimentAvgX100: 0 }),
      row({ answers: 4, mentions: 4, sentimentAvgX100: 80 }),
      row({ answers: 4, mentions: 4, sentimentAvgX100: 40 }),
    ])
    expect(out.sentimentAvgX100).toBe(60)
  })

  it('days 只数真的跑过的那些天（answers > 0）', () => {
    const out = rollupDailyRows([
      row({ answers: 3, mentions: 1 }),
      row({ answers: 0 }),
      row({ answers: 5, mentions: 2 }),
    ])
    expect(out.days).toBe(2)
  })

  it('单行输入等于它自己（除了 mentionRateBp 会按计数重算）', () => {
    const out = rollupDailyRows([
      row({ answers: 10, mentions: 3, mentionRateBp: 3000, sovBp: 5000, avgPositionX100: 150 }),
    ])
    expect(out.mentionRateBp).toBe(3000)
    expect(out.sovBp).toBe(5000)
    expect(out.avgPositionX100).toBe(150)
  })
})

describe('parseCompetitorStats', () => {
  it('正常对象逐个解析', () => {
    const out = parseCompetitorStats({
      c1: { mentions: 2, mentionRateBp: 5000, sovBp: 3000, avgPositionX100: 200 },
    })
    expect(out['c1']).toEqual({
      mentions: 2,
      mentionRateBp: 5000,
      sovBp: 3000,
      avgPositionX100: 200,
    })
  })

  it('null / 数组 / 字符串一律回空对象，不抛（历史快照可能是任何形状）', () => {
    expect(parseCompetitorStats(null)).toEqual({})
    expect(parseCompetitorStats([1, 2])).toEqual({})
    expect(parseCompetitorStats('x')).toEqual({})
  })

  it('认不出来的条目丢掉，认得出的留下', () => {
    const out = parseCompetitorStats({ c1: 'bad', c2: { mentions: 1 } })
    expect(out['c1']).toBeUndefined()
    expect(out['c2']).toEqual({ mentions: 1, mentionRateBp: 0, sovBp: 0, avgPositionX100: 0 })
  })
})

describe('rollupCompetitorStats', () => {
  it('每个竞品各合一行，按 sovBp 降序', () => {
    const out = rollupCompetitorStats([
      {
        answers: 10,
        competitorStats: {
          c1: { mentions: 2, mentionRateBp: 2000, sovBp: 1000, avgPositionX100: 100 },
          c2: { mentions: 5, mentionRateBp: 5000, sovBp: 4000, avgPositionX100: 300 },
        },
      },
    ])
    expect(out.map((x) => x.competitorId)).toEqual(['c2', 'c1'])
    expect(out[0]?.mentions).toBe(5)
  })

  it('跨天合并：mentions 求和、比率按 answers 加权、位次按该竞品的 mentions 加权', () => {
    const out = rollupCompetitorStats([
      {
        answers: 90,
        competitorStats: { c1: { mentions: 9, mentionRateBp: 1000, sovBp: 1000, avgPositionX100: 100 } },
      },
      {
        answers: 10,
        competitorStats: { c1: { mentions: 1, mentionRateBp: 1000, sovBp: 9000, avgPositionX100: 300 } },
      },
    ])
    expect(out[0]?.mentions).toBe(10)
    // sov: (1000*90 + 9000*10) / 100 = 1800
    expect(out[0]?.sovBp).toBe(1800)
    // 位次按 mentions 加权: (100*9 + 300*1) / 10 = 120
    expect(out[0]?.avgPositionX100).toBe(120)
  })

  it('一个竞品都没有 → 空数组', () => {
    expect(rollupCompetitorStats([{ answers: 3, competitorStats: {} }])).toEqual([])
  })
})

describe('diffRollup', () => {
  it('逐字段 current - previous', () => {
    const cur = { ...EMPTY_ROLLUP, answers: 10, mentionRateBp: 5000, avgPositionX100: 150 }
    const prev = { ...EMPTY_ROLLUP, answers: 4, mentionRateBp: 2000, avgPositionX100: 300 }
    const d = diffRollup(cur, prev)
    expect(d.answers).toBe(6)
    expect(d.mentionRateBp).toBe(3000)
    // 位次变小是**变好**，但这里如实给负数；涨跌箭头的颜色由前端决定。
    expect(d.avgPositionX100).toBe(-150)
  })

  it('上一周期全空时给的是绝对差，不是变化率（p=0 时变化率没有定义）', () => {
    const d = diffRollup({ ...EMPTY_ROLLUP, mentionRateBp: 500 }, EMPTY_ROLLUP)
    expect(d.mentionRateBp).toBe(500)
  })
})
