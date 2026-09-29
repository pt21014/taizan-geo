/**
 * `geo-metrics.rules.ts` 的单测。
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest'

import {
  computeMetrics,
  dateKeyToDbDate,
  dayRangeOf,
  dbDateToDateKey,
  groupForDaily,
  shiftDateKey,
  toDateKey,
  type MentionRow,
  type ResultRow,
} from './geo-metrics.rules'

describe('computeMetrics', () => {
  it('0 分母：没有已回答的 result → 全部指标为 0', () => {
    const out = computeMetrics([], [])
    expect(out).toEqual({
      answers: 0,
      mentions: 0,
      mentionRateBp: 0,
      sovBp: 0,
      avgPositionX100: 0,
      citationRateBp: 0,
      sentimentAvgX100: 0,
      competitorStats: {},
    })
  })

  it('answers 只数 answered=true 的 result，且按 resultId 去重', () => {
    const results: ResultRow[] = [
      { resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true },
      { resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true }, // 重复行
      { resultId: 'r2', engineCode: 'qwen', promptId: 'p1', answered: false },
    ]
    expect(computeMetrics(results, []).answers).toBe(1)
  })

  it('mentionRateBp：同一 result 多条 BRAND 提及只算 1', () => {
    const results: ResultRow[] = [
      { resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true },
      { resultId: 'r2', engineCode: 'qwen', promptId: 'p1', answered: true },
    ]
    const mentions: MentionRow[] = [
      { resultId: 'r1', entityKind: 'BRAND', position: 1, isCited: false, sentimentScore: 0 },
      { resultId: 'r1', entityKind: 'BRAND', position: 2, isCited: false, sentimentScore: 0 },
    ]
    const out = computeMetrics(results, mentions)
    expect(out.mentions).toBe(1)
    expect(out.mentionRateBp).toBe(5000) // 1/2 = 50.00%
  })

  it('sovBp：品牌与竞品提及数的份额，四舍五入到基点', () => {
    const results: ResultRow[] = [
      { resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true },
      { resultId: 'r2', engineCode: 'qwen', promptId: 'p1', answered: true },
      { resultId: 'r3', engineCode: 'qwen', promptId: 'p1', answered: true },
    ]
    const mentions: MentionRow[] = [
      { resultId: 'r1', entityKind: 'BRAND', position: 1, isCited: false, sentimentScore: 0 },
      { resultId: 'r2', entityKind: 'COMPETITOR', competitorId: 'c1', position: 1, isCited: false, sentimentScore: 0 },
    ]
    const out = computeMetrics(results, mentions)
    // sov = 1 / (1 + 1) = 5000bp
    expect(out.sovBp).toBe(5000)
    expect(out.competitorStats['c1']).toEqual({
      mentions: 1,
      mentionRateBp: 3333, // round(1/3*10000) = 3333
      sovBp: 5000,
      avgPositionX100: 100,
    })
  })

  it('sovBp 分母为 0（谁都没被提及）→ 0，不抛错', () => {
    const results: ResultRow[] = [{ resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true }]
    expect(computeMetrics(results, []).sovBp).toBe(0)
  })

  it('avgPositionX100：作用在全部 BRAND 提及行上（不去重），无提及 → 0', () => {
    const results: ResultRow[] = [
      { resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true },
      { resultId: 'r2', engineCode: 'qwen', promptId: 'p1', answered: true },
    ]
    const mentions: MentionRow[] = [
      { resultId: 'r1', entityKind: 'BRAND', position: 1, isCited: false, sentimentScore: 0 },
      { resultId: 'r2', entityKind: 'BRAND', position: 3, isCited: false, sentimentScore: 0 },
    ]
    expect(computeMetrics(results, mentions).avgPositionX100).toBe(200) // mean=2 → *100=200
    expect(computeMetrics(results, []).avgPositionX100).toBe(0)
  })

  it('citationRateBp：只数被引用的品牌提及 result（去重）', () => {
    const results: ResultRow[] = [
      { resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true },
      { resultId: 'r2', engineCode: 'qwen', promptId: 'p1', answered: true },
    ]
    const mentions: MentionRow[] = [
      { resultId: 'r1', entityKind: 'BRAND', position: 1, isCited: true, sentimentScore: 0 },
      { resultId: 'r2', entityKind: 'BRAND', position: 1, isCited: false, sentimentScore: 0 },
    ]
    expect(computeMetrics(results, mentions).citationRateBp).toBe(5000)
  })

  // ── 情感均值的量纲：T7 修正的那条 ────────────────────────────────────
  //
  // `sentimentScore` 本身就是 -100..100（"情感均值 ∈ [-1,1]" × 100 之后落库的形式），
  // 所以聚合只取均值、**不再乘一次 100**。T6 写成 `mean * 100` 时值域跑到了 ±10000，
  // 与 `GeoVisibilityDaily.sentimentAvgX100` 的列注释对不上。下面三条把口径钉死。
  it('sentimentAvgX100：口径是 round(mean(sentimentScore))，不再乘 100', () => {
    const results: ResultRow[] = [
      { resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true },
      { resultId: 'r2', engineCode: 'qwen', promptId: 'p1', answered: true },
    ]
    const mentions: MentionRow[] = [
      { resultId: 'r1', entityKind: 'BRAND', position: 1, isCited: false, sentimentScore: 80 },
      { resultId: 'r2', entityKind: 'BRAND', position: 1, isCited: false, sentimentScore: 100 },
    ]
    // mean(80,100) = 90 → 90（不是 9000）
    expect(computeMetrics(results, mentions).sentimentAvgX100).toBe(90)
  })

  it('sentimentAvgX100 边界：单条 sentimentScore=100 → 100（值域上限，不是 10000）', () => {
    const results: ResultRow[] = [{ resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true }]
    const mentions: MentionRow[] = [
      { resultId: 'r1', entityKind: 'BRAND', position: 1, isCited: false, sentimentScore: 100 },
    ]
    expect(computeMetrics(results, mentions).sentimentAvgX100).toBe(100)
  })

  it('sentimentAvgX100 负值同样不放大：单条 -60 → -60', () => {
    const results: ResultRow[] = [{ resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true }]
    const mentions: MentionRow[] = [
      { resultId: 'r1', entityKind: 'BRAND', position: 1, isCited: false, sentimentScore: -60 },
    ]
    expect(computeMetrics(results, mentions).sentimentAvgX100).toBe(-60)
  })

  it('avgPositionX100 仍然乘 100（position 是原始位次，没有预先放大过）', () => {
    const results: ResultRow[] = [
      { resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true },
      { resultId: 'r2', engineCode: 'qwen', promptId: 'p1', answered: true },
    ]
    const mentions: MentionRow[] = [
      { resultId: 'r1', entityKind: 'BRAND', position: 1, isCited: false, sentimentScore: 50 },
      { resultId: 'r2', entityKind: 'BRAND', position: 2, isCited: false, sentimentScore: 50 },
    ]
    const out = computeMetrics(results, mentions)
    // 两个 X100 字段的口径**不同**：位次 mean(1,2)=1.5 → 150；情感 mean(50,50)=50 → 50。
    expect(out.avgPositionX100).toBe(150)
    expect(out.sentimentAvgX100).toBe(50)
  })

  it('未回答 result 上挂的 mention 不计入（防御性过滤）', () => {
    const results: ResultRow[] = [{ resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: false }]
    const mentions: MentionRow[] = [
      { resultId: 'r1', entityKind: 'BRAND', position: 1, isCited: false, sentimentScore: 0 },
    ]
    const out = computeMetrics(results, mentions)
    expect(out.mentions).toBe(0)
    expect(out.answers).toBe(0)
  })

  it('多个竞品各自独立统计，互不干扰', () => {
    const results: ResultRow[] = [
      { resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true },
      { resultId: 'r2', engineCode: 'qwen', promptId: 'p1', answered: true },
    ]
    const mentions: MentionRow[] = [
      { resultId: 'r1', entityKind: 'COMPETITOR', competitorId: 'c1', position: 1, isCited: false, sentimentScore: 0 },
      { resultId: 'r2', entityKind: 'COMPETITOR', competitorId: 'c2', position: 2, isCited: false, sentimentScore: 0 },
    ]
    const out = computeMetrics(results, mentions)
    expect(Object.keys(out.competitorStats).sort()).toEqual(['c1', 'c2'])
    expect(out.competitorStats['c1']?.avgPositionX100).toBe(100)
    expect(out.competitorStats['c2']?.avgPositionX100).toBe(200)
  })
})

describe('groupForDaily', () => {
  const results: ResultRow[] = [
    { resultId: 'r1', engineCode: 'qwen', promptId: 'p1', answered: true },
    { resultId: 'r2', engineCode: 'ernie', promptId: 'p1', answered: true },
    { resultId: 'r3', engineCode: 'qwen', promptId: 'p2', answered: true },
  ]
  const mentions: MentionRow[] = [
    { resultId: 'r1', entityKind: 'BRAND', position: 1, isCited: false, sentimentScore: 0 },
  ]

  it('产出四类分组：总览、每引擎、每Prompt、每引擎×每Prompt（仅有数据的组合）', () => {
    const out = groupForDaily(results, mentions)
    const keys = out.map((g) => `${g.engineCode}|${g.promptId}`).sort()
    // 默认 Array.prototype.sort 按码点比较，'e'(0x65)/'q'(0x71) 都小于 '|'(0x7C)，
    // 所以带引擎名的 key 排在纯 '|...' 的汇总 key 前面。
    expect(keys).toEqual(['ernie|', 'ernie|p1', 'qwen|', 'qwen|p1', 'qwen|p2', '|', '|p1', '|p2'])
  })

  it('不产出没有数据的引擎×Prompt 组合（qwen 没问过 p1 以外……这里反过来验证 ernie×p2 不存在）', () => {
    const out = groupForDaily(results, mentions)
    expect(out.find((g) => g.engineCode === 'ernie' && g.promptId === 'p2')).toBeUndefined()
  })

  it('总览分组（engineCode=\'\', promptId=\'\'）的 metrics 等于对全量数据 computeMetrics', () => {
    const out = groupForDaily(results, mentions)
    const overview = out.find((g) => g.engineCode === '' && g.promptId === '')
    expect(overview?.metrics.answers).toBe(3)
    expect(overview?.metrics.mentions).toBe(1)
  })

  it('每引擎分组只统计该引擎自己的 result', () => {
    const out = groupForDaily(results, mentions)
    const qwenOnly = out.find((g) => g.engineCode === 'qwen' && g.promptId === '')
    expect(qwenOnly?.metrics.answers).toBe(2)
  })

  it('空输入 → 只剩总览这一条全零分组', () => {
    const out = groupForDaily([], [])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ engineCode: '', promptId: '' })
  })
})

describe('toDateKey', () => {
  it('按给定时区换算日期', () => {
    // UTC 2026-01-01 16:30 = 上海时间 2026-01-02 00:30，跨过了 UTC 的日界
    const d = new Date('2026-01-01T16:30:00Z')
    expect(toDateKey(d, 'Asia/Shanghai')).toBe('2026-01-02')
    expect(toDateKey(d, 'UTC')).toBe('2026-01-01')
  })

  it('默认时区是 Asia/Shanghai', () => {
    const d = new Date('2026-01-01T16:30:00Z')
    expect(toDateKey(d)).toBe('2026-01-02')
  })

  it('月/日个位数补零', () => {
    const d = new Date('2026-01-05T01:00:00Z') // 上海时间 09:00，同一天
    expect(toDateKey(d, 'Asia/Shanghai')).toBe('2026-01-05')
  })
})

describe('dayRangeOf / dateKeyToDbDate —— 按日切的两套口径', () => {
  it('dayRangeOf 给的是「上海那一天」对应的 UTC 区间（左闭右开）', () => {
    const { start, endExclusive } = dayRangeOf('2026-09-14')
    // 上海 2026-09-14 00:00 = UTC 2026-09-13 16:00
    expect(start.toISOString()).toBe('2026-09-13T16:00:00.000Z')
    expect(endExclusive.toISOString()).toBe('2026-09-14T16:00:00.000Z')
  })

  it('与 toDateKey 互逆：区间内的时刻 toDateKey 落在同一天，区间外落在别的天', () => {
    const { start, endExclusive } = dayRangeOf('2026-09-14')
    expect(toDateKey(start)).toBe('2026-09-14')
    expect(toDateKey(new Date(endExclusive.getTime() - 1))).toBe('2026-09-14')
    expect(toDateKey(new Date(start.getTime() - 1))).toBe('2026-09-13')
    // 右开：区间的 end 本身已经属于第二天了
    expect(toDateKey(endExclusive)).toBe('2026-09-15')
  })

  it('dateKeyToDbDate 对齐 UTC 零点（@db.Date 的存法），不是 dayRangeOf 的 start', () => {
    expect(dateKeyToDbDate('2026-09-14').toISOString()).toBe('2026-09-14T00:00:00.000Z')
    expect(dateKeyToDbDate('2026-09-14').toISOString()).not.toBe(
      dayRangeOf('2026-09-14').start.toISOString(),
    )
  })

  it('dbDateToDateKey 是 dateKeyToDbDate 的逆', () => {
    expect(dbDateToDateKey(dateKeyToDbDate('2026-01-05'))).toBe('2026-01-05')
  })

  it('shiftDateKey 跨月/跨年都对', () => {
    expect(shiftDateKey('2026-09-14', -1)).toBe('2026-09-13')
    expect(shiftDateKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDateKey('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDateKey('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDateKey('2026-09-14', -7)).toBe('2026-09-07')
  })
})
