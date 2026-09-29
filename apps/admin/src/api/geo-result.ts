import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 一条回答明细（对齐 `GeoResultView`）。**列表里不含原文**。 */
export interface GeoResult {
  id: string
  runId: string
  brandId: string
  promptId: string
  engineCode: string
  sampleIndex: number
  status: 'PENDING' | 'OK' | 'FAILED'
  /** 回答正文的前 500 字。 */
  preview: string
  rawTruncated: boolean
  model: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  searchCalls: number
  costCents: number
  errorKind: string | null
  errorMessage: string | null
  answeredAt: string | null
  analyzedAt: string | null
  createdAt: string
}

/** 一条提及（对齐 `GeoMentionView`）。 */
export interface GeoMention {
  id: string
  entityKind: 'BRAND' | 'COMPETITOR'
  competitorId: string | null
  entityName: string
  position: number
  isCited: boolean
  sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
  sentimentScore: number
  snippet: string
}

/** 一条引用（对齐 `GeoCitationView`）。 */
export interface GeoCitation {
  id: string
  url: string
  domain: string
  platform: string
  category: string
  rank: number
  title: string | null
}

/** 回答详情：原文 + 这条回答分析出来的提及与引用。 */
export interface GeoResultDetail extends GeoResult {
  rawText: string | null
  mentions: GeoMention[]
  citations: GeoCitation[]
}

/** 结果状态的枚举 → Tag 配置。 */
export const GEO_RESULT_STATUS: Record<GeoResult['status'], StatusTagConfig> = {
  PENDING: { text: '待执行' },
  OK: { text: '成功', color: 'success' },
  FAILED: { text: '失败', color: 'error' },
}

/** 情感的展示文案与颜色。 */
export const GEO_SENTIMENT: Record<GeoMention['sentiment'], StatusTagConfig> = {
  POSITIVE: { text: '正面', color: 'success' },
  NEUTRAL: { text: '中性' },
  NEGATIVE: { text: '负面', color: 'error' },
}

/** 引用来源分类的展示文案。 */
export const GEO_SOURCE_CATEGORY_TEXT: Record<string, string> = {
  OWNED: '自有阵地',
  COMPETITOR: '竞品阵地',
  EARNED: '第三方',
  SOCIAL: '社交/社区',
  ENCYCLOPEDIA: '百科',
  PR: '媒体/公关',
  OTHER: '其它',
}

/**
 * 回答明细的接口层：与 `GeoResultController` 一一对应。**全部只读**。
 *
 * 原文只在 `get(id)` 里下发：`rawText` 是一段可能上万字的文本，一页 20 条就是几百 KB，
 * 而列表页上没有任何地方会显示它（列表显示的是 `preview`，服务端截好的前 500 字）。
 */
export function useGeoResultApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) => req.get<PageResult<GeoResult>>('/api/admin/geo/results', query),
    get: (id: string) => req.get<GeoResultDetail>(`/api/admin/geo/results/${id}`),
  }
}
