import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { GeoReportDetail, GeoReportOverviewStat, GeoReportPayloadV1 } from '../../api/geo-report'
import { ReportPayloadView } from './GeoReportListPage'

/**
 * `GeoReportListPage` 详情 Drawer 的渲染逻辑回归测试。
 *
 * 背景：这里曾经把 `payload.overview`/`engines`/`competitors` 强制 `as` 成
 * `{current, delta}`/`{items: [...]}` 这种嵌套形状，但 `geo-report.service.ts` 的
 * `buildPayload()` 实际产出的是**扁平的对象/数组**——两边对不上，`overview.current`
 * 是 `undefined`，一读 `.mentionRateBp` 就会在渲染期抛异常（详情 Drawer 直接崩）；
 * `engines`/`competitors` 因为取的是不存在的 `.items`，则是静默展示不出数据。
 * 这份测试用 `buildPayload()` 真实产出的扁平形状构造 payload，锁住修好之后的行为。
 */

function baseOverview(overrides: Partial<GeoReportOverviewStat> = {}): GeoReportOverviewStat {
  return {
    answers: 20,
    mentions: 16,
    mentionRateBp: 8000,
    sovBp: 6000,
    avgPositionX100: 150,
    citationRateBp: 4000,
    sentimentAvgX100: 35,
    top1RateBp: 4500,
    ...overrides,
  }
}

function makeDetail(overrides: {
  payload?: Partial<GeoReportPayloadV1>
} = {}): GeoReportDetail {
  const payload: GeoReportPayloadV1 = {
    version: 1,
    brandId: 'brand-1',
    brandName: '太赞',
    period: 'WEEKLY',
    periodStart: '2026-09-08',
    periodEnd: '2026-09-14',
    generatedAt: '2026-09-15T02:00:00.000Z',
    overview: baseOverview(),
    previous: baseOverview({ mentionRateBp: 7000 }),
    trend: [],
    // 真实形状：扁平数组，不是 `{items: [...]}`。
    engines: [{ engineCode: 'doubao', engineName: '豆包', mentionRateBp: 9000 }],
    competitors: [
      { competitorId: '', name: '太赞', isBrand: true, mentions: 16, mentionRateBp: 8000, sovBp: 6000, avgPositionX100: 150 },
      { competitorId: 'c1', name: '云智软件', isBrand: false, mentions: 8, mentionRateBp: 4000, sovBp: 3000, avgPositionX100: 220 },
    ],
    topCitations: [{ domain: 'zhihu.com', count: 5, category: 'OTHER', platform: '' }],
    promptSuggestions: [],
    contentSuggestions: [],
    ...overrides.payload,
  }
  return {
    id: 'report-1',
    brandId: 'brand-1',
    brandName: '太赞',
    period: 'WEEKLY',
    periodStart: '2026-09-08',
    periodEnd: '2026-09-14',
    status: 'READY',
    createdAt: '2026-09-15T02:00:00.000Z',
    payload,
  }
}

describe('GeoReportListPage · ReportPayloadView', () => {
  it('用 buildPayload() 真实的扁平形状正确渲染 overview/engines/competitors/topCitations', () => {
    render(<ReportPayloadView detail={makeDetail()} />)

    // overview 是扁平对象，不是 { current, delta }：直接读得到这三个百分比。
    expect(screen.getByText('80.00%')).toBeInTheDocument() // 提及率
    // 声量份额 60.00% 在这份数据里出现两次：overview 一次、竞品表里的品牌自己那行
    // （两者本就是同一个数字，`buildPayload()` 里品牌行的 sovBp 就是 overview.sovBp）再一次。
    expect(screen.getAllByText('60.00%')).toHaveLength(2)
    expect(screen.getByText('40.00%')).toBeInTheDocument() // 引用率

    // engines 是扁平数组，不是 { items: [...] }：引擎对比表能渲染出来。
    expect(screen.getByText('引擎对比')).toBeInTheDocument()
    expect(screen.getByText('豆包')).toBeInTheDocument()
    expect(screen.getByText('90.00%')).toBeInTheDocument()

    // competitors 是扁平数组，不是 { items: [...] }：竞品对比表能渲染出来。
    expect(screen.getByText('竞品对比')).toBeInTheDocument()
    expect(screen.getByText('太赞（本品牌）')).toBeInTheDocument()
    expect(screen.getByText('云智软件')).toBeInTheDocument()
    expect(screen.getByText('30.00%')).toBeInTheDocument()

    // topCitations 本来就是扁平数组，形状没变，顺带确认没被之前的改动带崩。
    expect(screen.getByText('引用来源 Top')).toBeInTheDocument()
    expect(screen.getByText('zhihu.com')).toBeInTheDocument()
  })

  it('overview.sovBp 为 null（这个周期没人被提及）时显示「暂无数据」，不崩溃、不显示字面量 null', () => {
    render(
      <ReportPayloadView
        detail={makeDetail({ payload: { overview: baseOverview({ sovBp: null }) } })}
      />,
    )

    expect(screen.getByText('暂无数据')).toBeInTheDocument()
    expect(screen.queryByText('null')).not.toBeInTheDocument()
    expect(screen.queryByText('null%')).not.toBeInTheDocument()
  })

  it('competitors[].sovBp 为 null 时该行显示「暂无数据」，其余竞品数据正常渲染', () => {
    render(
      <ReportPayloadView
        detail={makeDetail({
          payload: {
            competitors: [
              { competitorId: '', name: '太赞', isBrand: true, mentions: 0, mentionRateBp: 0, sovBp: null, avgPositionX100: 0 },
              { competitorId: 'c1', name: '云智软件', isBrand: false, mentions: 0, mentionRateBp: 0, sovBp: null, avgPositionX100: 0 },
            ],
          },
        })}
      />,
    )

    expect(screen.getByText('竞品对比')).toBeInTheDocument()
    expect(screen.getAllByText('暂无数据')).toHaveLength(2)
  })

  it('competitors/topCitations 因 geo.monitor 未放行而整体为 null 时不崩溃，且不渲染对应表格', () => {
    render(
      <ReportPayloadView
        detail={makeDetail({ payload: { competitors: null, topCitations: null } })}
      />,
    )

    expect(screen.queryByText('竞品对比')).not.toBeInTheDocument()
    expect(screen.queryByText('引用来源 Top')).not.toBeInTheDocument()
    // overview 不受门禁影响，照常渲染。
    expect(screen.getByText('80.00%')).toBeInTheDocument()
  })

  it('payload version 不是 1 时展示「还没有对应的渲染器」兜底，不去按 version 1 的形状硬解析', () => {
    const detail = makeDetail()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(detail.payload as any).version = 2

    render(<ReportPayloadView detail={detail} />)

    expect(screen.getByText(/还没有对应的渲染器/)).toBeInTheDocument()
  })
})
