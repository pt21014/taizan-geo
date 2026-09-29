import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 一行品牌（对齐 `apps/api/src/modules/geo/brand/dto/geo-brand.dto.ts` 的 `GeoBrandView`）。 */
export interface GeoBrand {
  id: string
  name: string
  domain: string | null
  aliases: string[]
  industry: string | null
  locale: string | null
  status: 'ACTIVE' | 'PAUSED'
  refreshFreq: 'WEEKLY' | 'DAILY'
  sampleSize: number
  engineCodes: string[]
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** 新建/编辑时提交的字段（对齐 `CreateGeoBrandDto` / `UpdateGeoBrandDto`）。 */
export type GeoBrandInput = Pick<
  GeoBrand,
  'name' | 'industry' | 'locale' | 'status' | 'refreshFreq' | 'sampleSize'
> & {
  domain?: string | null
  aliases?: string[]
  engineCodes?: string[]
}

/** 一行竞品（对齐 `GeoCompetitorView`）。 */
export interface GeoCompetitor {
  id: string
  brandId: string
  name: string
  domain: string | null
  aliases: string[]
  createdAt: string
  updatedAt: string
}

/** 新建/编辑竞品时提交的字段。 */
export interface GeoCompetitorInput {
  name: string
  domain?: string | null
  aliases?: string[]
}

/** 状态列的枚举 → Tag 配置。 */
export const GEO_BRAND_STATUS: Record<GeoBrand['status'], StatusTagConfig> = {
  ACTIVE: { text: '监测中', color: 'success' },
  PAUSED: { text: '已暂停' },
}

/** 刷新频率的展示文案。 */
export const GEO_REFRESH_FREQ_OPTIONS = [
  { label: '每周', value: 'WEEKLY' },
  { label: '每日', value: 'DAILY' },
] as const

/** 一条可选引擎（对齐 `apps/api/src/modules/geo/engine/dto/geo-engine.dto.ts` 的 `GeoEngineOptionView`）。 */
export interface GeoEngineOption {
  code: string
  name: string
  vendor: string
  /** `BROWSER` = 浏览器自动化抓取，比 API 慢一个数量级、也更容易被风控挡掉。 */
  accessType: 'API' | 'BROWSER'
}

/**
 * 可选引擎清单的接口层（T5 起，替换掉 T4 写死在这里的 `GEO_ENGINE_OPTIONS`）。
 *
 * 写死的版本有两个代价，第二个才是真问题：
 * ① 平台上了一个新引擎，前端要发一次版；
 * ② **平台停用了一个引擎，商家的下拉框里它还在**——选了保存下去，跑批时静默跳过，
 *    而商家以为自己在监测它。
 *
 * 这条接口只回 code/name/vendor/accessType 四个字段，不含任何密钥与成本参数
 * （那是平台的商务数据，见后端 `geo-engine-public.controller.ts`）。
 * 权限点 `geo-engine:list`。
 */
export function useGeoEngineOptionApi() {
  const req = useSession((s) => s.request)
  return {
    list: () => req.get<GeoEngineOption[]>('/api/admin/geo/engines'),
  }
}

/**
 * 品牌模块的接口层：与 `GeoBrandController` 一一对应（蓝图 §5.2 的标准形状）。
 * 页面里不直接拼 URL，是为了让业务页面只剩下「长什么样」这一件事。
 */
export function useGeoBrandApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) => req.get<PageResult<GeoBrand>>('/api/admin/geo/brands', query),
    get: (id: string) => req.get<GeoBrand>(`/api/admin/geo/brands/${id}`),
    create: (values: GeoBrandInput) => req.post<GeoBrand>('/api/admin/geo/brands', values),
    update: (id: string, values: GeoBrandInput) =>
      req.put<GeoBrand>(`/api/admin/geo/brands/${id}`, values),
    remove: (row: GeoBrand) => req.delete<void>(`/api/admin/geo/brands/${row.id}`),

    // ── 竞品（品牌的子资源） ──────────────────────────────────────────────
    listCompetitors: (brandId: string) =>
      req.get<GeoCompetitor[]>(`/api/admin/geo/brands/${brandId}/competitors`),
    createCompetitor: (brandId: string, values: GeoCompetitorInput) =>
      req.post<GeoCompetitor>(`/api/admin/geo/brands/${brandId}/competitors`, values),
    updateCompetitor: (brandId: string, competitorId: string, values: GeoCompetitorInput) =>
      req.put<GeoCompetitor>(
        `/api/admin/geo/brands/${brandId}/competitors/${competitorId}`,
        values,
      ),
    removeCompetitor: (brandId: string, competitorId: string) =>
      req.delete<void>(`/api/admin/geo/brands/${brandId}/competitors/${competitorId}`),
  }
}
