import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'
import { GEO_DASHBOARD_DAYS, type GeoDashboardDays } from './geo-dashboard'

export { GEO_DASHBOARD_DAYS }
export type { GeoDashboardDays }

/** 来源归类，对齐 `GEO_SOURCE_CATEGORIES`。 */
export const GEO_SOURCE_CATEGORIES = [
  'OWNED',
  'COMPETITOR',
  'EARNED',
  'SOCIAL',
  'ENCYCLOPEDIA',
  'PR',
  'OTHER',
] as const
export type GeoSourceCategory = (typeof GEO_SOURCE_CATEGORIES)[number]

/** 来源归类的展示配置。 */
export const GEO_SOURCE_CATEGORY_TAGS: Record<GeoSourceCategory, StatusTagConfig> = {
  OWNED: { text: '自有阵地', color: 'success' },
  COMPETITOR: { text: '竞品阵地', color: 'error' },
  EARNED: { text: '自然媒体', color: 'blue' },
  SOCIAL: { text: '社交平台', color: 'purple' },
  ENCYCLOPEDIA: { text: '百科', color: 'cyan' },
  PR: { text: '公关稿', color: 'orange' },
  OTHER: { text: '其他' },
}

/** 一条引用明细（对齐 `GeoCitationView`）。 */
export interface GeoCitation {
  id: string
  resultId: string
  promptId: string
  promptText: string
  engineCode: string
  url: string
  domain: string
  platform: string
  category: GeoSourceCategory
  rank: number
  title: string | null
  answeredAt: string
}

/** 域名榜里的一行（对齐 `GeoCitationDomainView`）。 */
export interface GeoCitationDomain {
  domain: string
  count: number
  platform: string
  category: GeoSourceCategory
  owned: boolean
}

/** `GET /citations/domains` 的返回。 */
export interface GeoCitationDomains {
  brandId: string
  days: number
  total: number
  items: GeoCitationDomain[]
}

/** 平台占比一行（对齐 `GeoCitationCategoryView`）。 */
export interface GeoCitationCategoryShare {
  category: GeoSourceCategory
  count: number
  shareBp: number
}

/** `GET /citations/platforms` 的返回。 */
export interface GeoCitationPlatforms {
  brandId: string
  days: number
  total: number
  items: GeoCitationCategoryShare[]
}

/** 缺口榜只关心第三方来源，不含 OWNED/COMPETITOR。 */
export type GeoCitationGapCategory = Exclude<GeoSourceCategory, 'OWNED' | 'COMPETITOR'>

/** 一条引用缺口（对齐 `GeoCitationGapItemView`）。 */
export interface GeoCitationGapItem {
  domain: string
  count: number
  platform: string
  category: GeoCitationGapCategory
  suggestion: string
}

/** `GET /citations/gaps` 的返回。 */
export interface GeoCitationGaps {
  brandId: string
  days: number
  competitorNames: string[]
  items: GeoCitationGapItem[]
}

/**
 * 引用来源模块的接口层：与 `GeoCitationController` 一一对应。三条路由全部只读。
 */
export function useGeoCitationApi() {
  const req = useSession((s) => s.request)
  return {
    domains: (brandId: string, days?: GeoDashboardDays) =>
      req.get<GeoCitationDomains>('/api/admin/geo/citations/domains', { brandId, days }),
    platforms: (brandId: string, days?: GeoDashboardDays) =>
      req.get<GeoCitationPlatforms>('/api/admin/geo/citations/platforms', { brandId, days }),
    gaps: (brandId: string, days?: GeoDashboardDays) =>
      req.get<GeoCitationGaps>('/api/admin/geo/citations/gaps', { brandId, days }),
    list: (
      query: CrudListQuery & {
        brandId: string
        days?: GeoDashboardDays
        engineCode?: string
        category?: GeoSourceCategory
        domain?: string
      },
    ) => req.get<PageResult<GeoCitation>>('/api/admin/geo/citations', query),
  }
}
