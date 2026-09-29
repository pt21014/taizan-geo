import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeoReportDetail, GeoReportPayloadV1 } from '../../api/geo-report'
import * as reportApiModule from '../../api/geo-report'
import GeoDiagnosisReportStep from './GeoDiagnosisReportStep'

vi.mock('../../api/geo-report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/geo-report')>()
  return { ...actual, useGeoReportApi: vi.fn() }
})

const getReport = vi.fn()

function baseOverview() {
  return {
    answers: 5,
    mentions: 4,
    mentionRateBp: 8000,
    sovBp: 6000,
    avgPositionX100: 150,
    citationRateBp: 4000,
    sentimentAvgX100: 35,
    top1RateBp: 4000,
  }
}

function makeReport(gated: boolean): GeoReportDetail {
  const payload: GeoReportPayloadV1 = {
    version: 1,
    brandId: 'brand-1',
    brandName: '太赞',
    period: 'ONE_SHOT',
    periodStart: '2026-09-19',
    periodEnd: '2026-09-19',
    generatedAt: '2026-09-19T14:32:00.000Z',
    overview: baseOverview(),
    previous: baseOverview(),
    trend: [],
    engines: [],
    competitors: gated
      ? null
      : [
          { competitorId: '', name: '太赞', isBrand: true, mentions: 4, mentionRateBp: 8000, sovBp: 6000, avgPositionX100: 150 },
          { competitorId: 'c1', name: '云智软件', isBrand: false, mentions: 6, mentionRateBp: 6000, sovBp: 4000, avgPositionX100: 120 },
        ],
    topCitations: gated ? null : [{ domain: 'zhihu.com', count: 3, category: 'OTHER', platform: '' }],
    promptSuggestions: gated ? null : [{ text: '太赞怎么样，口碑好不好', topic: null, funnelStage: 'BOFU' }],
    contentSuggestions: gated
      ? null
      : [{ kind: 'LOW_MENTION_RATE', title: '品牌提及率偏低', detail: '建议补充官网内容' }],
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

function renderStep() {
  return render(
    <MemoryRouter>
      <GeoDiagnosisReportStep reportId="report-1" onRestart={vi.fn()} />
    </MemoryRouter>,
  )
}

describe('GeoDiagnosisReportStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(reportApiModule.useGeoReportApi).mockReturnValue({
      get: getReport,
    } as unknown as ReturnType<typeof reportApiModule.useGeoReportApi>)
  })

  it('免费摘要始终可见：提及率/首位推荐率/情感倾向三个指标', async () => {
    getReport.mockResolvedValue(makeReport(true))
    renderStep()

    expect(await screen.findByText('80.00%')).toBeInTheDocument() // 提及率
    expect(screen.getByText('40.00%')).toBeInTheDocument() // 首位推荐率
    // antd <Statistic> 把纯数字值拆成 `.ant-statistic-content-value-int`/`-decimal`
    // 两个子节点（35/100=0.4 没有 "%" 后缀，会被 antd 判定成"纯数字"走这条拆分逻辑，
    // 带 "%" 后缀的两个反而不会）——默认的整节点文本匹配找不到，改用父节点的
    // `textContent` 兜底匹配。
    expect(
      screen.getByText(
        (_, el) => el?.className === 'ant-statistic-content-value' && el.textContent === '0.3',
      ),
    ).toBeInTheDocument() // 情感倾向 35/100=0.35，toFixed(1) 浮点舍入成 "0.3"
  })

  it('geo.monitor 未放行（付费字段为 null）：展示「免费摘要版」+ 解锁提示，不渲染竞品/引用表', async () => {
    getReport.mockResolvedValue(makeReport(true))
    renderStep()

    expect(await screen.findByText('免费摘要版')).toBeInTheDocument()
    expect(screen.getByText('解锁完整诊断报告')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '去升级套餐' })).toHaveAttribute('href', '/billing')
    expect(screen.queryByText('云智软件')).not.toBeInTheDocument()
  })

  it('geo.monitor 已放行（付费字段有值）：展示「已解锁完整版」+ 竞品/引用/建议/推荐问法', async () => {
    getReport.mockResolvedValue(makeReport(false))
    renderStep()

    expect(await screen.findByText('已解锁完整版')).toBeInTheDocument()
    expect(screen.queryByText('解锁完整诊断报告')).not.toBeInTheDocument()
    expect(screen.getByText('云智软件')).toBeInTheDocument()
    expect(screen.getByText('zhihu.com')).toBeInTheDocument()
    expect(screen.getByText(/品牌提及率偏低/)).toBeInTheDocument()
    expect(screen.getByText('太赞怎么样，口碑好不好')).toBeInTheDocument()
  })

  it('拿不到报告时给出空态', async () => {
    getReport.mockRejectedValue(new Error('boom'))
    renderStep()

    expect(await screen.findByText('没有取到这份诊断报告，刷新页面重试')).toBeInTheDocument()
  })
})
