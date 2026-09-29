import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 看板周期档位，对齐 `GEO_DASHBOARD_DAYS`。 */
export const GEO_DASHBOARD_DAYS = [7, 30, 90] as const
export type GeoDashboardDays = (typeof GEO_DASHBOARD_DAYS)[number]

/** 一个周期的合计指标（对齐 `GeoRollupView`）。 */
export interface GeoRollup {
  start: string
  end: string
  days: number
  answers: number
  mentions: number
  mentionRateBp: number
  sovBp: number
  avgPositionX100: number
  citationRateBp: number
  sentimentAvgX100: number
}

/** 环比差值（对齐 `GeoRollupDeltaView`）。 */
export type GeoRollupDelta = Omit<GeoRollup, 'start' | 'end' | 'days'>

/** 最近一次跑批状态（对齐 `GeoLastRunView`）。 */
export interface GeoLastRun {
  id: string
  status: string
  triggeredBy: string
  totalQueries: number
  doneQueries: number
  failedQueries: number
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

/** `GET /dashboard/overview` 的返回。 */
export interface GeoDashboardOverview {
  brandId: string
  brandName: string
  days: number
  current: GeoRollup
  previous: GeoRollup
  delta: GeoRollupDelta
  lastRun: GeoLastRun | null
}

/** 度量列（对齐 `GeoMetricsFieldsView`）。 */
export interface GeoMetricsFields {
  answers: number
  mentions: number
  mentionRateBp: number
  sovBp: number
  avgPositionX100: number
  citationRateBp: number
  sentimentAvgX100: number
}

/** 趋势里的一天。 */
export interface GeoTrendPoint extends GeoMetricsFields {
  date: string
}

/** `GET /dashboard/trend` 的返回。 */
export interface GeoDashboardTrend {
  brandId: string
  days: number
  engineCode: string
  points: GeoTrendPoint[]
}

/** 每引擎一行（对齐 `GeoEngineMetricsView`）。 */
export interface GeoEngineMetrics extends GeoMetricsFields {
  engineCode: string
  engineName: string
}

/** `GET /dashboard/engines` 的返回。 */
export interface GeoDashboardEngines {
  brandId: string
  days: number
  items: GeoEngineMetrics[]
}

/** 品牌/竞品对照一行（对齐 `GeoCompetitorMetricsView`）。 */
export interface GeoCompetitorMetrics {
  competitorId: string
  name: string
  isBrand: boolean
  mentions: number
  mentionRateBp: number
  sovBp: number
  avgPositionX100: number
}

/** `GET /dashboard/competitors` 的返回。 */
export interface GeoDashboardCompetitors {
  brandId: string
  days: number
  items: GeoCompetitorMetrics[]
}

/** 每条 Prompt 一行（对齐 `GeoPromptMetricsView`）。 */
export interface GeoPromptMetrics extends GeoMetricsFields {
  promptId: string
  text: string
  topic: string | null
  funnelStage: string
}

/**
 * GEO 看板的接口层：与 `GeoDashboardController` 一一对应。
 *
 * 五条路由全部只读、全部要求 `brandId`——不传的话页面无法渲染，所以这里没有
 * `brandId` 可选参数这一说，交给调用方在没选中品牌前不要调它。
 */
export function useGeoDashboardApi() {
  const req = useSession((s) => s.request)
  return {
    overview: (brandId: string, days?: GeoDashboardDays) =>
      req.get<GeoDashboardOverview>('/api/admin/geo/dashboard/overview', { brandId, days }),
    trend: (brandId: string, days?: GeoDashboardDays, engineCode?: string) =>
      req.get<GeoDashboardTrend>('/api/admin/geo/dashboard/trend', { brandId, days, engineCode }),
    engines: (brandId: string, days?: GeoDashboardDays) =>
      req.get<GeoDashboardEngines>('/api/admin/geo/dashboard/engines', { brandId, days }),
    competitors: (brandId: string, days?: GeoDashboardDays) =>
      req.get<GeoDashboardCompetitors>('/api/admin/geo/dashboard/competitors', { brandId, days }),
    prompts: (query: {
      brandId: string
      days?: GeoDashboardDays
      engineCode?: string
      page?: number
      pageSize?: number
    }) => req.get<PageResult<GeoPromptMetrics>>('/api/admin/geo/dashboard/prompts', query),
  }
}
