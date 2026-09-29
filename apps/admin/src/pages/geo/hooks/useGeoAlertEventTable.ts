import { useEffect, useRef } from 'react'
import { useCrudTable, type CrudTableApi } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import {
  GEO_ALERT_KIND_TAGS,
  GEO_ALERT_KINDS,
  useGeoAlertApi,
  type GeoAlertEvent,
} from '../../../api/geo-alert'

/** 告警触发记录列表的表格状态：只读，同一个「品牌可选」判据。 */
export function useGeoAlertEventTable(brandId: string | undefined): CrudTableApi<GeoAlertEvent> {
  const api = useGeoAlertApi()

  const table = useCrudTable<GeoAlertEvent>({
    list: async (query): Promise<PageResult<GeoAlertEvent>> =>
      api.listEvents({ ...query, ...(brandId ? { brandId } : {}) }),
    rowKey: 'id',
    syncUrl: true,
    urlPrefix: 'ev_',
    searchSchema: [
      {
        name: 'kind',
        label: '类型',
        type: 'select',
        options: GEO_ALERT_KINDS.map((k) => ({ label: GEO_ALERT_KIND_TAGS[k].text, value: k })),
      },
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
  }, [brandId])

  return table
}
