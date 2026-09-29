import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/**
 * 手动生成报表可选的周期类型（`GenerateGeoReportDto.period` 的取值子集）。
 *
 * **不含 `ONE_SHOT`**：那是「先诊断后付费」编排链路收口时由后端内部调用
 * `GeoReportService.generate()` 产出的单日快照，不预期商家直接对着
 * `POST /reports/generate` 传这个值（对齐 `geo-report.dto.ts` 里 `GEO_REPORT_PERIODS`
 * 同一条注释）——所以「生成报表」表单的下拉框只列这两个。
 */
export const GEO_REPORT_PERIODS = ['WEEKLY', 'MONTHLY'] as const

/**
 * `GeoReportPeriod` 的完整取值（对齐后端 `GeoReportPeriodLike`）：**读**报表列表/详情时
 * 可能读到 `ONE_SHOT`（诊断编排产出的那一份），所以这个类型比 {@link GEO_REPORT_PERIODS}
 * 宽——两者故意不是同一个数组派生出来的。
 */
export type GeoReportPeriod = 'WEEKLY' | 'MONTHLY' | 'ONE_SHOT'

export const GEO_REPORT_PERIOD_TEXT: Record<GeoReportPeriod, string> = {
  WEEKLY: '周报',
  MONTHLY: '月报',
  ONE_SHOT: '单次诊断',
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

// ── payload version 1 的具体形状（对齐 `geo-report.service.ts` 的 buildPayload） ──
//
// 上面的 `GeoReportPayload` 故意留了一个宽松的 `[key: string]: unknown`——
// 报告详情抽屉（`GeoReportListPage.tsx`）在版本判断之后自己做局部 cast，不依赖这几个
// 类型。这几个类型是给「AI可见度诊断」向导的报告屏用的，只在 `payload.version === 1`
// 时才可信，读取前务必先判 `version`（历史快照的口径不会跟着代码走）。

/** `overview`/`previous` 的形状（`sovBp` 分母为 0 时是 `null`，见 `geo-report.rules.ts`）。 */
export interface GeoReportOverviewStat {
  answers: number
  mentions: number
  mentionRateBp: number
  sovBp: number | null
  avgPositionX100: number
  citationRateBp: number
  sentimentAvgX100: number
  /** 首位推荐率：AI 把本品牌列为第一顺位提及的回答占比。免费摘要三指标之一。 */
  top1RateBp: number
}

/** `competitors[]` 一条（含品牌自己那条 `isBrand: true`）。付费字段，未放行时整体为 `null`。 */
export interface GeoReportCompetitorStat {
  competitorId: string
  name: string
  isBrand: boolean
  mentions: number
  mentionRateBp: number
  sovBp: number | null
  avgPositionX100: number
}

/** `topCitations[]` 一条。付费字段，未放行时整体为 `null`。 */
export interface GeoReportCitationStat {
  domain: string
  count: number
  category: string
  platform: string
}

/**
 * `promptSuggestions[]` 一条：诊断编排里新生成并自动导入的一条候选问法
 * （`GeoDiagnosisService.finalizeReport` 补写）。WEEKLY/MONTHLY 报表恒为空数组；
 * 付费字段，未放行时整体为 `null`。
 */
export interface GeoDiagnosisPromptSuggestion {
  text: string
  topic: string | null
  funnelStage: string
}

/**
 * `contentSuggestions[]` 一条：内容优化建议（规则生成，不是 LLM 结构化输出，
 * 理由见 `geo-diagnosis.rules.ts` 文件头）。付费字段，未放行时整体为 `null`。
 */
export interface GeoDiagnosisContentSuggestion {
  kind: string
  title: string
  detail: string
}

/** `payload.version === 1` 时，`GeoReportPayload` 上诊断报告用得到的那几个字段。 */
export interface GeoReportPayloadV1 extends GeoReportPayload {
  overview: GeoReportOverviewStat
  previous: GeoReportOverviewStat
  competitors: GeoReportCompetitorStat[] | null
  topCitations: GeoReportCitationStat[] | null
  promptSuggestions: GeoDiagnosisPromptSuggestion[] | null
  contentSuggestions: GeoDiagnosisContentSuggestion[] | null
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
