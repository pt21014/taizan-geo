import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeoRun } from '../../../api/geo-run'
import { useGeoDiagnosisProgress, useGeoDiagnosisRunPoll } from './useGeoDiagnosisRunPoll'

const getMock = vi.fn()

vi.mock('../../../api/geo-run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/geo-run')>()
  return { ...actual, useGeoRunApi: () => ({ get: getMock }) }
})

function makeRun(patch: Partial<GeoRun> = {}): GeoRun {
  return {
    id: 'run-1',
    brandId: 'brand-1',
    triggeredBy: 'MANUAL',
    status: 'RUNNING',
    engineCodes: ['mock'],
    sampleSize: 1,
    totalQueries: 10,
    doneQueries: 0,
    failedQueries: 0,
    totalCostCents: 0,
    startedAt: null,
    finishedAt: null,
    errorSummary: null,
    createdBy: null,
    isDiagnosis: true,
    diagnosisReportId: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...patch,
  }
}

// `waitFor` 内部也是靠 `setTimeout` 轮询，和 `vi.useFakeTimers()` 混用会互相卡死
// （它的超时也被换成了假时钟，永远等不到真实时间推进）。这份测试里一律不用 `waitFor`，
// 靠显式 `await vi.advanceTimersByTimeAsync(...)`（它在推进时钟的同时会把期间产生的
// microtask 一起 flush 掉）精确控制到哪一步，断言直接跟在后面。
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('useGeoDiagnosisRunPoll()', () => {
  beforeEach(() => {
    getMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('立刻查一次，diagnosisReportId 非空之前按固定间隔继续轮询', async () => {
    getMock
      .mockResolvedValueOnce(makeRun({ doneQueries: 3 }))
      .mockResolvedValueOnce(makeRun({ doneQueries: 10, status: 'DONE' }))
      .mockResolvedValueOnce(makeRun({ doneQueries: 10, status: 'DONE', diagnosisReportId: 'report-1' }))

    const { result } = renderHook(() => useGeoDiagnosisRunPoll('run-1'))

    await flush()
    expect(getMock).toHaveBeenCalledTimes(1)
    expect(getMock).toHaveBeenCalledWith('run-1')
    expect(result.current.run?.doneQueries).toBe(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(getMock).toHaveBeenCalledTimes(2)
    expect(result.current.run?.status).toBe('DONE')
    expect(result.current.run?.diagnosisReportId).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(getMock).toHaveBeenCalledTimes(3)
    expect(result.current.run?.diagnosisReportId).toBe('report-1')

    // 拿到 diagnosisReportId 之后不再继续排下一次轮询。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(getMock).toHaveBeenCalledTimes(3)
  })

  it('轮询次数到上限仍未出报表：timedOut 变 true；手动 retry 会重新开始', async () => {
    getMock.mockResolvedValue(makeRun())

    const { result } = renderHook(() => useGeoDiagnosisRunPoll('run-1'))
    await flush()
    expect(result.current.run).not.toBeNull()

    // 100 次轮询上限 × 3s 间隔：跑够次数直接推到超时，不用真的等 5 分钟。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * 105)
    })
    expect(result.current.timedOut).toBe(true)

    getMock.mockClear()
    getMock.mockResolvedValueOnce(makeRun({ diagnosisReportId: 'report-2' }))
    act(() => result.current.retry())
    await flush()
    expect(result.current.timedOut).toBe(false)
    expect(result.current.run?.diagnosisReportId).toBe('report-2')
  })

  it('接口报错时不崩，继续按间隔重试', async () => {
    getMock.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(makeRun({ diagnosisReportId: 'r' }))

    const { result } = renderHook(() => useGeoDiagnosisRunPoll('run-1'))
    await flush()
    expect(result.current.loading).toBe(false)
    expect(result.current.run).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(result.current.run?.diagnosisReportId).toBe('r')
  })
})

describe('useGeoDiagnosisProgress()', () => {
  beforeEach(() => {
    getMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('拿到 diagnosisReportId 就调用 onReportReady，只调一次', async () => {
    getMock
      .mockResolvedValueOnce(makeRun())
      .mockResolvedValueOnce(makeRun({ diagnosisReportId: 'report-9' }))
      .mockResolvedValue(makeRun({ diagnosisReportId: 'report-9' }))

    const onReportReady = vi.fn()
    renderHook(() => useGeoDiagnosisProgress('run-1', onReportReady))
    await flush()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(onReportReady).toHaveBeenCalledWith('report-9')
    expect(onReportReady).toHaveBeenCalledTimes(1)

    // 再往后轮询也不会重复调用（`useEffect` 的依赖是 `reportId`，值没变就不会再触发）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(onReportReady).toHaveBeenCalledTimes(1)
  })
})
