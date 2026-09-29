import { useSession } from '../session'

/** 按租户拆的一行（对齐 `GeoPlatformUsageTenantView`）。 */
export interface GeoPlatformUsageTenant {
  tenantId: string
  tenantName: string
  quantity: number
  costCents: number
}

/** 按引擎拆的一行（对齐 `GeoPlatformUsageEngineView`）。 */
export interface GeoPlatformUsageEngine {
  engineCode: string
  quantity: number
  costCents: number
}

/** `GET /platform/geo/usage` 的返回（对齐 `GeoPlatformUsageSummaryView`）。 */
export interface GeoPlatformUsageSummary {
  month: string
  totalCostCents: number
  byTenant: GeoPlatformUsageTenant[]
  byEngine: GeoPlatformUsageEngine[]
}

/**
 * 平台侧「全平台用量与成本」接口层：与 `GeoPlatformUsageController` 一一对应。
 * 一条只读路由，没有权限点（理由见后端 `geo-usage.permissions.ts`）。
 */
export function useGeoPlatformUsageApi() {
  const req = useSession((s) => s.request)
  return {
    summary: (query: { month?: string; tenantId?: string }) =>
      req.get<GeoPlatformUsageSummary>('/api/platform/geo/usage', query),
  }
}
