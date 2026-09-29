import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 报表周期类型，对齐 `GEO_REPORT_PERIODS`。 */
export const GEO_REPORT_PERIODS = ['WEEKLY', 'MONTHLY'] as const
export type GeoReportPeriod = (typeof GEO_REPORT_PERIODS)[number]

export const GEO_REPORT_PERIOD_TEXT: Record<GeoReportPeriod, string> = {
  WEEKLY: '周报',
  MONTHLY: '月报',
}

/** 报表状态，对齐 `GEO_REPORT_STATUSES`。 */
export const GEO_REPORT_STATUSES = ['PENDING', 'READY', 'FAILED'] as const
export type GeoReportStatus = (typeof GEO_REPORT_STATUSES)[number]

export const GEO_REPORT_STATUS_TAGS: Record<GeoReportStatus, StatusTagConfig> = {
  PENDING: { text: '生成中' },
  READY: { text: '已就绪', color: 'success' },
  FAILED: { text: '生成失败', color: 'error' },
}

/** 报表列表里的一行（对齐 `GeoReportView`，不含 payload）。 */
export interface GeoReport {
  id: string
  brandId: string
  brandName: string
  period: GeoReportPeriod
  periodStart: string
  periodEnd: string
  status: GeoReportStatus
  createdAt: string
}

/** 手动生成报表提交的字段（对齐 `GenerateGeoReportDto`）。 */
export interface GenerateGeoReportInput {
  brandId: string
  period: GeoReportPeriod
  periodStart: string
}

/**
 * 报表详情的 payload 快照（对齐 `geo-report.service.ts` 的 `buildPayload`）。
 * 带 `version`：快照是历史数据，口径变了老报告不会跟着变，渲染器按 version 分支。
 */
export interface GeoReportPayload {
  version: number
  brandId: string
  brandName: string
  period: GeoReportPeriod
  periodStart: string
  periodEnd: string
  generatedAt: string
  [key: string]: unknown
}

/** 报表详情 = 列表行 + payload（对齐 `GeoReportDetailView`）。 */
export interface GeoReportDetail extends GeoReport {
  payload: GeoReportPayload
}

/**
 * 报表模块的接口层：与 `GeoReportController` 一一对应。
 */
export function useGeoReportApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery & { brandId?: string; period?: GeoReportPeriod }) =>
      req.get<PageResult<GeoReport>>('/api/admin/geo/reports', query),
    generate: (values: GenerateGeoReportInput) =>
      req.post<GeoReportDetail>('/api/admin/geo/reports/generate', values),
    get: (id: string) => req.get<GeoReportDetail>(`/api/admin/geo/reports/${id}`),
  }
}
