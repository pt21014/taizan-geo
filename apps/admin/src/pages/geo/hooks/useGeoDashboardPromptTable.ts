import { useEffect, useRef } from 'react'
import { useCrudTable, type CrudTableApi } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import {
  useGeoDashboardApi,
  type GeoDashboardDays,
  type GeoPromptMetrics,
} from '../../../api/geo-dashboard'

/**
 * 看板「Prompt 榜」的表格状态。与 `useGeoRunTable` 同一个形状：`brandId`/`days`
 * 换了要重查，靠 `refreshRef` 避免把它们塞进 `useCrudTable` 的 `list` 依赖。
 */
export function useGeoDashboardPromptTable(
  brandId: string | undefined,
  days: GeoDashboardDays,
): CrudTableApi<GeoPromptMetrics> {
  const api = useGeoDashboardApi()

  const table = useCrudTable<GeoPromptMetrics>({
    list: async (query): Promise<PageResult<GeoPromptMetrics>> => {
      if (brandId === undefined) return { items: [], total: 0, page: 1, pageSize: query.pageSize }
      return api.prompts({ ...query, brandId, days } as Parameters<typeof api.prompts>[0])
    },
    rowKey: 'promptId',
  })

  const refreshRef = useRef(table.refresh)
  refreshRef.current = table.refresh
  const firstRef = useRef(true)
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false
      return
    }
    refreshRef.current()
  }, [brandId, days])

  return table
}
