/**
 * `geo-run.rules.ts` 的单测。
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest'

import {
  aggregateJobId,
  alertJobId,
  analyzeJobId,
  computeCostCents,
  fingerprintOf,
  isRetryableErrorKind,
  makePreview,
  planQueries,
  queryJobId,
  resolveRunStatus,
  runJobId,
  summarizeErrors,
  truncateRawText,
} from './geo-run.rules'

describe('planQueries', () => {
  it('按 promptId → engineCode → sampleIndex 展开', () => {
    const out = planQueries({
      brandId: 'b1',
      promptIds: ['p1', 'p2'],
      engineCodes: ['qwen', 'ernie'],
      sampleSize: 2,
    })
    expect(out).toEqual([
      { promptId: 'p1', engineCode: 'qwen', sampleIndex: 1 },
      { promptId: 'p1', engineCode: 'qwen', sampleIndex: 2 },
      { promptId: 'p1', engineCode: 'ernie', sampleIndex: 1 },
      { promptId: 'p1', engineCode: 'ernie', sampleIndex: 2 },
      { promptId: 'p2', engineCode: 'qwen', sampleIndex: 1 },
      { promptId: 'p2', engineCode: 'qwen', sampleIndex: 2 },
      { promptId: 'p2', engineCode: 'ernie', sampleIndex: 1 },
      { promptId: 'p2', engineCode: 'ernie', sampleIndex: 2 },
    ])
  })

  it('sampleSize 夹到 1..10：0 → 1，11 → 10', () => {
    expect(planQueries({ brandId: 'b1', promptIds: ['p1'], engineCodes: ['qwen'], sampleSize: 0 })).toHaveLength(1)
    expect(planQueries({ brandId: 'b1', promptIds: ['p1'], engineCodes: ['qwen'], sampleSize: 11 })).toHaveLength(10)
    expect(
      planQueries({ brandId: 'b1', promptIds: ['p1'], engineCodes: ['qwen'], sampleSize: Number.NaN }),
    ).toHaveLength(1)
  })

  it('promptIds / engineCodes 去重，保留首次出现的顺序', () => {
    const out = planQueries({
      brandId: 'b1',
      promptIds: ['p1', 'p2', 'p1'],
      engineCodes: ['qwen', 'qwen', 'ernie'],
      sampleSize: 1,
    })
    expect(out.map((q) => `${q.promptId}:${q.engineCode}`)).toEqual(['p1:qwen', 'p1:ernie', 'p2:qwen', 'p2:ernie'])
  })

  it('空数组入参 → 空计划', () => {
    expect(planQueries({ brandId: 'b1', promptIds: [], engineCodes: ['qwen'], sampleSize: 3 })).toEqual([])
    expect(planQueries({ brandId: 'b1', promptIds: ['p1'], engineCodes: [], sampleSize: 3 })).toEqual([])
  })
})

describe('computeCostCents', () => {
  const engine = { pricePerQueryCents: 10, priceInPerMTokenCents: 200, priceOutPerMTokenCents: 800 }

  it('按公式计算：pricePerQuery + ceil(in) + ceil(out)', () => {
    // in: 100000 * 200 / 1e6 = 20（整除，无需 ceil）
    // out: 50000 * 800 / 1e6 = 40（整除）
    expect(computeCostCents(engine, { inputTokens: 100_000, outputTokens: 50_000 })).toBe(10 + 20 + 40)
  })

  it('ceil 边界：1 token 也要算够 1 分', () => {
    // 1 * 200 / 1e6 = 0.0002 → ceil → 1
    expect(computeCostCents(engine, { inputTokens: 1, outputTokens: 0 })).toBe(10 + 1 + 0)
  })

  it('0 分母/0 用量 → 只收基础单价', () => {
    expect(computeCostCents(engine, { inputTokens: 0, outputTokens: 0 })).toBe(10)
  })

  it('负数一律视为 0', () => {
    expect(
      computeCostCents(
        { pricePerQueryCents: -5, priceInPerMTokenCents: 200, priceOutPerMTokenCents: 800 },
        { inputTokens: -100, outputTokens: -100 },
      ),
    ).toBe(0)
  })

  it('非法数字（NaN/Infinity）视为 0', () => {
    expect(
      computeCostCents(
        { pricePerQueryCents: Number.NaN, priceInPerMTokenCents: 200, priceOutPerMTokenCents: 800 },
        { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0 },
      ),
    ).toBe(0)
  })
})

describe('resolveRunStatus', () => {
  it('total === 0 → DONE（优先于 pending 判断）', () => {
    expect(resolveRunStatus({ total: 0, done: 0, failed: 0, pending: 0 })).toBe('DONE')
  })

  it('pending > 0 → null（未结束）', () => {
    expect(resolveRunStatus({ total: 10, done: 5, failed: 0, pending: 5 })).toBeNull()
  })

  it('failed === 0 → DONE', () => {
    expect(resolveRunStatus({ total: 10, done: 10, failed: 0, pending: 0 })).toBe('DONE')
  })

  it('0 < failed < total → PARTIAL', () => {
    expect(resolveRunStatus({ total: 10, done: 7, failed: 3, pending: 0 })).toBe('PARTIAL')
  })

  it('failed === total → FAILED', () => {
    expect(resolveRunStatus({ total: 10, done: 0, failed: 10, pending: 0 })).toBe('FAILED')
  })

  it('failed === total === 1 的边界（单条查询全失败）', () => {
    expect(resolveRunStatus({ total: 1, done: 0, failed: 1, pending: 0 })).toBe('FAILED')
  })
})

describe('isRetryableErrorKind', () => {
  it('RATE_LIMIT / TIMEOUT / UPSTREAM 可重试', () => {
    expect(isRetryableErrorKind('RATE_LIMIT')).toBe(true)
    expect(isRetryableErrorKind('TIMEOUT')).toBe(true)
    expect(isRetryableErrorKind('UPSTREAM')).toBe(true)
  })

  it('AUTH / CONTENT_FILTER / PARSE 不可重试', () => {
    expect(isRetryableErrorKind('AUTH')).toBe(false)
    expect(isRetryableErrorKind('CONTENT_FILTER')).toBe(false)
    expect(isRetryableErrorKind('PARSE')).toBe(false)
  })

  it('未知类别一律不可重试', () => {
    expect(isRetryableErrorKind('SOMETHING_ELSE')).toBe(false)
    expect(isRetryableErrorKind('')).toBe(false)
  })
})

describe('summarizeErrors', () => {
  it('按 errorKind 分组计数', () => {
    expect(
      summarizeErrors([{ errorKind: 'TIMEOUT' }, { errorKind: 'TIMEOUT' }, { errorKind: 'AUTH' }]),
    ).toEqual({ TIMEOUT: 2, AUTH: 1 })
  })

  it('空数组 → 空对象', () => {
    expect(summarizeErrors([])).toEqual({})
  })

  it('errorKind 缺失/null/空串不计入（成功结果不该出现在错误分布里）', () => {
    expect(summarizeErrors([{}, { errorKind: null }, { errorKind: '' }, { errorKind: 'AUTH' }])).toEqual({
      AUTH: 1,
    })
  })
})

describe('jobId 构造', () => {
  it('各自按约定格式拼接', () => {
    expect(runJobId('run1')).toBe('run-run1')
    expect(queryJobId('res1')).toBe('q-res1')
    expect(analyzeJobId('res1')).toBe('a-res1')
    expect(aggregateJobId('t1', 'b1', '2026-01-01')).toBe('agg-t1-b1-2026-01-01')
    expect(alertJobId('t1', 'b1', '2026-01-01')).toBe('al-t1-b1-2026-01-01')
  })

  // 回归钉子：BullMQ 的自定义 jobId 不允许含冒号（入队时抛
  // `Custom Id cannot contain :`）。技术设计 §4.2 里写的是 `run:${runId}`，
  // 照字面实现的话整条流水线第一步就走不通。
  it('一个冒号都不能有（BullMQ 硬性限制）', () => {
    const ids = [
      runJobId('01J000000000000000000000'),
      queryJobId('01J000000000000000000001'),
      analyzeJobId('01J000000000000000000002'),
      aggregateJobId('t1', 'b1', '2026-01-01'),
      alertJobId('t1', 'b1', '2026-01-01'),
    ]
    expect(ids.filter((id) => id.includes(':'))).toEqual([])
  })
})

describe('truncateRawText', () => {
  it('未超限 → 原样返回，truncated=false', () => {
    expect(truncateRawText('abc', 60000)).toEqual({ text: 'abc', truncated: false })
  })

  it('长度恰好等于 max → 不截断（边界）', () => {
    const text = 'a'.repeat(5)
    expect(truncateRawText(text, 5)).toEqual({ text, truncated: false })
  })

  it('超出 1 个字符 → 截断（边界）', () => {
    const text = 'a'.repeat(6)
    const out = truncateRawText(text, 5)
    expect(out.truncated).toBe(true)
    expect(out.text).toBe('a'.repeat(5))
  })

  it('按码点截断，不劈开代理对（emoji）', () => {
    const text = '😀'.repeat(3) // 每个 emoji 占 2 个 UTF-16 code unit
    const out = truncateRawText(text, 2)
    expect(out.truncated).toBe(true)
    expect(out.text).toBe('😀😀')
    // 不应该出现孤立的半个代理对
    expect([...out.text]).toHaveLength(2)
  })

  it('非字符串入参一律当空串', () => {
    expect(truncateRawText(undefined)).toEqual({ text: '', truncated: false })
    expect(truncateRawText(null)).toEqual({ text: '', truncated: false })
  })

  it('空字符串 → 不截断', () => {
    expect(truncateRawText('', 60000)).toEqual({ text: '', truncated: false })
  })
})

describe('makePreview', () => {
  it('未超限 → 原样返回', () => {
    expect(makePreview('abc', 500)).toBe('abc')
  })

  it('恰好等于 max → 不截断', () => {
    const text = 'a'.repeat(500)
    expect(makePreview(text, 500)).toBe(text)
  })

  it('超出 → 截到 max 个码点', () => {
    const text = 'a'.repeat(501)
    expect(makePreview(text, 500)).toBe('a'.repeat(500))
  })

  it('非字符串入参一律当空串', () => {
    expect(makePreview(123)).toBe('')
  })
})

describe('fingerprintOf', () => {
  it('相同入参得到相同指纹（确定性）', () => {
    const a = fingerprintOf('qwen', 'p1', '你好世界')
    const b = fingerprintOf('qwen', 'p1', '你好世界')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('三段拼接带分隔符，不会因为边界挪动而撞出相同哈希', () => {
    const a = fingerprintOf('ab', 'c', 'x')
    const b = fingerprintOf('a', 'bc', 'x')
    expect(a).not.toBe(b)
  })

  it('文本不同 → 指纹不同', () => {
    expect(fingerprintOf('qwen', 'p1', '文本A')).not.toBe(fingerprintOf('qwen', 'p1', '文本B'))
  })
})
