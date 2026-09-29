import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 跑批状态，对齐 `GEO_PLATFORM_RUN_STATUSES`。 */
export const GEO_PLATFORM_RUN_STATUSES = ['PENDING', 'RUNNING', 'DONE', 'PARTIAL', 'FAILED'] as const
export type GeoPlatformRunStatus = (typeof GEO_PLATFORM_RUN_STATUSES)[number]

export const GEO_PLATFORM_RUN_STATUS_TAGS: Record<GeoPlatformRunStatus, StatusTagConfig> = {
  PENDING: { text: '排队中' },
  RUNNING: { text: '进行中', color: 'processing' },
  DONE: { text: '已完成', color: 'success' },
  PARTIAL: { text: '部分失败', color: 'warning' },
  FAILED: { text: '全部失败', color: 'error' },
}

/** 一次跑批（对齐 `GeoPlatformRunView`）。 */
export interface GeoPlatformRun {
  id: string
  tenantId: string
  tenantName: string
  brandId: string
  status: GeoPlatformRunStatus
  totalQueries: number
  doneQueries: number
  failedQueries: number
  totalCostCents: number
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

/** 重跑结果（对齐 `GeoPlatformRunRetryResultView`）。 */
export interface GeoPlatformRunRetryResult {
  id: string
  retriedCount: number
}

/**
 * 平台侧「跑批监控与重跑」接口层：与 `GeoPlatformRunController` 一一对应。
 * 没有权限点（理由见后端 `geo-usage.permissions.ts`）。
 */
export function useGeoPlatformRunApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery & { tenantId?: string; status?: GeoPlatformRunStatus }) =>
      req.get<PageResult<GeoPlatformRun>>('/api/platform/geo/runs', query),
    /** 重置这次跑批里失败的结果并重新入队——会再花钱，见后端控制器文件头。 */
    retry: (id: string) =>
      req.post<GeoPlatformRunRetryResult>(`/api/platform/geo/runs/${id}/retry`, {}),
  }
}
