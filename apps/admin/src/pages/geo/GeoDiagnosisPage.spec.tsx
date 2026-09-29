import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeoReportDetail, GeoReportPayloadV1 } from '../../api/geo-report'
import * as brandApiModule from '../../api/geo-brand'
import * as diagnosisApiModule from '../../api/geo-diagnosis'
import * as reportApiModule from '../../api/geo-report'
import * as runApiModule from '../../api/geo-run'
import GeoDiagnosisPage from './GeoDiagnosisPage'

vi.mock('../../api/geo-brand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/geo-brand')>()
  return { ...actual, useGeoBrandApi: vi.fn(), useGeoEngineOptionApi: vi.fn() }
})
vi.mock('../../api/geo-diagnosis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/geo-diagnosis')>()
  return { ...actual, useGeoDiagnosisApi: vi.fn() }
})
vi.mock('../../api/geo-run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/geo-run')>()
  return { ...actual, useGeoRunApi: vi.fn() }
})
vi.mock('../../api/geo-report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/geo-report')>()
  return { ...actual, useGeoReportApi: vi.fn() }
})

const createBrand = vi.fn()
const triggerDiagnosis = vi.fn()
const listEngines = vi.fn()
const getRun = vi.fn()
const getReport = vi.fn()

function makeReport(): GeoReportDetail {
  const payload: GeoReportPayloadV1 = {
    version: 1,
    brandId: 'brand-1',
    brandName: '太赞',
    period: 'ONE_SHOT',
    periodStart: '2026-09-19',
    periodEnd: '2026-09-19',
    generatedAt: '2026-09-19T14:32:00.000Z',
    overview: {
      answers: 5,
      mentions: 5,
      mentionRateBp: 10000,
      sovBp: 10000,
      avgPositionX100: 100,
      citationRateBp: 10000,
      sentimentAvgX100: 20,
      top1RateBp: 10000,
    },
    previous: {
      answers: 0,
      mentions: 0,
      mentionRateBp: 0,
      sovBp: null,
      avgPositionX100: 0,
      citationRateBp: 0,
      sentimentAvgX100: 0,
      top1RateBp: 0,
    },
    trend: [],
    engines: [],
    competitors: null,
    topCitations: null,
    promptSuggestions: null,
    contentSuggestions: null,
  }
  return {
    id: 'report-1',
    brandId: 'brand-1',
    brandName: '太赞',
    period: 'ONE_SHOT',
    periodStart: '2026-09-19',
    periodEnd: '2026-09-19',
    status: 'READY',
    createdAt: '2026-09-19T14:32:00.000Z',
    payload,
  }
}

/**
 * 端到端走一遍「AI可见度诊断」向导：入口表单提交 → 轮询跑批到出报表 → 报告屏。
 * 三个子屏各自已经有更细的单测（`GeoDiagnosisEntryStep.spec.tsx`/
 * `useGeoDiagnosisRunPoll.spec.ts`/`GeoDiagnosisReportStep.spec.tsx`），这里只验证
 * `GeoDiagnosisPage.tsx` 真的把它们接对了——`onTriggered`/`onReportReady`/`onRestart`
 * 三个回调確实驱动了 `useGeoDiagnosisWizard` 切屏。
 */
describe('GeoDiagnosisPage：端到端向导', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()

    vi.mocked(brandApiModule.useGeoBrandApi).mockReturnValue({
      create: createBrand,
    } as unknown as ReturnType<typeof brandApiModule.useGeoBrandApi>)
    vi.mocked(brandApiModule.useGeoEngineOptionApi).mockReturnValue({ list: listEngines })
    vi.mocked(diagnosisApiModule.useGeoDiagnosisApi).mockReturnValue({
      trigger: triggerDiagnosis,
    } as unknown as ReturnType<typeof diagnosisApiModule.useGeoDiagnosisApi>)
    vi.mocked(runApiModule.useGeoRunApi).mockReturnValue({
      get: getRun,
    } as unknown as ReturnType<typeof runApiModule.useGeoRunApi>)
    vi.mocked(reportApiModule.useGeoReportApi).mockReturnValue({
      get: getReport,
    } as unknown as ReturnType<typeof reportApiModule.useGeoReportApi>)

    listEngines.mockResolvedValue([{ code: 'mock', name: 'Mock', vendor: 'taizan', accessType: 'API' }])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('提交表单 → 轮询到诊断报表就绪 → 展示免费摘要报告', async () => {
    createBrand.mockResolvedValue({ id: 'brand-1', name: '太赞' })
    triggerDiagnosis.mockResolvedValue({
      runId: 'run-1',
      brandId: 'brand-1',
      promptsGenerated: 5,
      plannedQueries: 5,
      reusedExistingPrompts: false,
    })
    getRun
      .mockResolvedValueOnce({
        id: 'run-1',
        brandId: 'brand-1',
        triggeredBy: 'MANUAL',
        status: 'RUNNING',
        engineCodes: ['mock'],
        sampleSize: 1,
        totalQueries: 5,
        doneQueries: 2,
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
      })
      .mockResolvedValueOnce({
        id: 'run-1',
        brandId: 'brand-1',
        triggeredBy: 'MANUAL',
        status: 'DONE',
        engineCodes: ['mock'],
        sampleSize: 1,
        totalQueries: 5,
        doneQueries: 5,
        failedQueries: 0,
        totalCostCents: 0,
        startedAt: null,
        finishedAt: null,
        errorSummary: null,
        createdBy: null,
        isDiagnosis: true,
        diagnosisReportId: 'report-1',
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z',
      })
    getReport.mockResolvedValue(makeReport())

    // `waitFor`/`findBy*` 内部靠 `setTimeout` 轮询，和 `vi.useFakeTimers()` 混用会
    // 互相卡死（原因见 `useGeoDiagnosisRunPoll.spec.ts` 顶部注释）——这份测试全程用
    // 显式 `flush()` 精确推进，断言一律用同步的 `getByText`。
    const flush = async (ms = 0) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    }

    render(
      <MemoryRouter>
        <GeoDiagnosisPage />
      </MemoryRouter>,
    )

    // 屏 1：入口表单。
    expect(screen.getByText('新建品牌诊断')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('品牌名'), { target: { value: '太赞' } })
    await flush() // 让引擎清单落地并自动全选
    fireEvent.click(screen.getByRole('button', { name: /开始诊断/ }))
    await flush() // 校验 → create → trigger → onTriggered 切屏 → 进度屏挂载后的第一次轮询

    // 屏 2：诊断进行中——第一次轮询显示查询进度。
    expect(screen.getByText('诊断进行中')).toBeInTheDocument()
    expect(screen.getByText(/已完成 2\/5/)).toBeInTheDocument()

    // 再轮询一次拿到 diagnosisReportId，自动切到屏 3（报告屏挂载后还要再拉一次报告接口）。
    await flush(3000)
    await flush()

    // 屏 3：报告——免费摘要版（本例 payload 的付费字段为 null）。
    expect(screen.getByText('免费摘要版')).toBeInTheDocument()
    expect(screen.getByText('太赞 · AI 可见度诊断报告')).toBeInTheDocument()
    expect(getReport).toHaveBeenCalledWith('report-1')

    // 「再诊断一个品牌」能回到入口屏。
    fireEvent.click(screen.getByRole('button', { name: '再诊断一个品牌' }))
    expect(screen.getByText('新建品牌诊断')).toBeInTheDocument()
  })
})
