import { useEffect, useRef } from 'react'
import { useCrudTable, type CrudTableApi } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import {
  GEO_SOURCE_CATEGORIES,
  GEO_SOURCE_CATEGORY_TAGS,
  useGeoCitationApi,
  type GeoCitation,
  type GeoDashboardDays,
} from '../../../api/geo-citation'

/** 引用明细列表的表格状态。`brandId`/`days` 换了要重查，与 `useGeoRunTable` 同形。 */
export function useGeoCitationTable(
  brandId: string | undefined,
  days: GeoDashboardDays,
): CrudTableApi<GeoCitation> {
  const api = useGeoCitationApi()

  const table = useCrudTable<GeoCitation>({
    list: async (query): Promise<PageResult<GeoCitation>> => {
      if (brandId === undefined) return { items: [], total: 0, page: 1, pageSize: query.pageSize }
      return api.list({ ...query, brandId, days })
    },
    rowKey: 'id',
    syncUrl: true,
    searchSchema: [
      {
        name: 'category',
        label: '归类',
        type: 'select',
        options: GEO_SOURCE_CATEGORIES.map((c) => ({
          label: GEO_SOURCE_CATEGORY_TAGS[c].text,
          value: c,
        })),
      },
      { name: 'domain', label: '域名' },
    ],
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
