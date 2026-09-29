import { useEffect, useRef } from 'react'
import { useCrudTable, type CrudTableApi } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useGeoResultApi, type GeoResult } from '../../../api/geo-result'

/**
 * 「回答明细」列表的表格状态。
 *
 * 与 `useGeoRunTable` 同形。`runId` 从地址栏读（`?runId=…`）——「监测任务」页上点
 * 「看回答」会带着它跳过来，而 `syncUrl` 开着的 `useCrudTable` 会把它当成一个普通的
 * 搜索条件保留在地址栏里，刷新页面仍然看得到同一屏。
 */
export function useGeoResultTable(brandId: string | undefined): CrudTableApi<GeoResult> {
  const api = useGeoResultApi()

  const table = useCrudTable<GeoResult>({
    list: async (query): Promise<PageResult<GeoResult>> =>
      api.list({ ...query, ...(brandId ? { brandId } : {}) }),
    rowKey: 'id',
    syncUrl: true,
    searchSchema: [
      { name: 'runId', label: '跑批 id' },
      { name: 'engineCode', label: '引擎' },
      {
        name: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '待执行', value: 'PENDING' },
          { label: '成功', value: 'OK' },
          { label: '失败', value: 'FAILED' },
        ],
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
