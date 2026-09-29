import { useEffect, useRef } from 'react'
import { useCrudTable, type CrudTableApi } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useGeoRunApi, type GeoRun } from '../../../api/geo-run'

/**
 * 「监测任务」列表的表格状态。
 *
 * 与 `useGeoPromptTable` 同一个形状，差别只有一处：**`brandId` 在这里是可选的**。
 * 跑批列表不带品牌也查得出来（一家店的全部跑批），而问法列表不带 `brandId` 会 400——
 * 那是两条接口的契约差异，不是这里的疏忽。
 *
 * ## 为什么 `useState` / `useEffect` 在这里是允许的
 *
 * admin-ui 的纪律禁止的是**页面文件里**出现它们（蓝图 §5.2）。收进一个带名字的 hook
 * 之后，「品牌换了要重查」这件事只有这一处答案，页面只拿结果。
 */
export function useGeoRunTable(brandId: string | undefined): CrudTableApi<GeoRun> {
  const api = useGeoRunApi()

  const table = useCrudTable<GeoRun>({
    list: async (query): Promise<PageResult<GeoRun>> =>
      api.list({ ...query, ...(brandId ? { brandId } : {}) }),
    rowKey: 'id',
    syncUrl: true,
    searchSchema: [
      {
        name: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '排队中', value: 'PENDING' },
          { label: '进行中', value: 'RUNNING' },
          { label: '已完成', value: 'DONE' },
          { label: '部分失败', value: 'PARTIAL' },
          { label: '全部失败', value: 'FAILED' },
        ],
      },
    ],
  })

  // 品牌换了就重查。`refreshRef` 是为了不把 `table.refresh` 写进依赖数组——
  // 真正的触发条件只有 `brandId` 一个。
  const refreshRef = useRef(table.refresh)
  refreshRef.current = table.refresh
  const firstRef = useRef(true)
  useEffect(() => {
    // 首次挂载时 `useCrudTable` 自己会查一次，这里再 refresh 一次是多余的一次请求。
    if (firstRef.current) {
      firstRef.current = false
      return
    }
    refreshRef.current()
  }, [brandId])

  return table
}
