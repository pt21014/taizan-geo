import { useEffect, useRef } from 'react'
import { useCrudTable, type CrudTableApi } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import {
  GEO_ALERT_KIND_TAGS,
  GEO_ALERT_KINDS,
  useGeoAlertApi,
  type GeoAlertRule,
} from '../../../api/geo-alert'

/**
 * 告警规则列表的表格状态。`brandId` 可选（不传 = 全部品牌），与 `useGeoRunTable`
 * 同一个理由：顶部品牌选择器放工具栏而不是搜索表单，清空之后的语义是「看全部」。
 */
export function useGeoAlertRuleTable(brandId: string | undefined): CrudTableApi<GeoAlertRule> {
  const api = useGeoAlertApi()

  const table = useCrudTable<GeoAlertRule>({
    list: async (query): Promise<PageResult<GeoAlertRule>> =>
      api.listRules({ ...query, ...(brandId ? { brandId } : {}) }),
    remove: async (row) => {
      await api.removeRule(row)
    },
    rowKey: 'id',
    syncUrl: true,
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
