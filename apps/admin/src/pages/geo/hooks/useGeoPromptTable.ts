import { useEffect, useRef, useState } from 'react'
import { useCrudTable, type CrudTableApi } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useGeoPromptApi, type GeoPrompt, type GeoPromptSet } from '../../../api/geo-prompt'

/** {@link useGeoPromptTable} 的返回值。 */
export interface GeoPromptTable {
  table: CrudTableApi<GeoPrompt>
  /** 当前品牌下的 Prompt 集，给筛选下拉与导入抽屉用 */
  sets: GeoPromptSet[]
  /** 集合增删改之后调它，重新拉一次集清单 */
  refreshSets: () => void
}

/**
 * 问法列表的表格状态 + 当前品牌的 Prompt 集清单。
 *
 * ## `brandId` 为什么不走 `searchSchema`
 *
 * `GET /api/admin/geo/prompts` 的 `brandId` 是**必填**的（问法永远属于某个品牌）。
 * 放进搜索表单意味着它可以被「重置」清空，而清空之后那条请求会直接 400——
 * 一个点了「重置」就报错的列表页比没有重置按钮糟得多。所以品牌选择器在工具栏上，
 * 由这个 hook 注进每一次查询。
 *
 * ## 为什么这里有 `useEffect`
 *
 * 两件事只能靠它做：① 品牌换了要重查（`useCrudTable` 只在分页/搜索/排序变化时重查，
 * 它看不见工具栏上的品牌）；② 集清单要跟着品牌重拉。
 * 收进这个 hook 是 admin-ui 纪律的兑现方式——页面文件里一个 `useEffect` 都没有，
 * 「什么时候重查」这件事只有这一处答案。
 */
export function useGeoPromptTable(brandId: string | undefined): GeoPromptTable {
  const api = useGeoPromptApi()
  const [sets, setSets] = useState<GeoPromptSet[]>([])
  const [setsToken, setSetsToken] = useState(0)

  const table = useCrudTable<GeoPrompt>({
    list: async (query): Promise<PageResult<GeoPrompt>> => {
      // 还没选出品牌（首屏、或这家店一个品牌都没建）：返回空页而不是发一条注定 400 的请求。
      if (brandId === undefined || brandId === '') {
        const pageSize = typeof query.pageSize === 'number' ? query.pageSize : 20
        return { items: [], total: 0, page: 1, pageSize }
      }
      return api.list({ ...query, brandId })
    },
    remove: (row) => api.remove(row).then(() => undefined),
    rowKey: 'id',
    syncUrl: true,
    searchSchema: [
      { name: 'keyword', label: '正文/主题' },
      {
        name: 'funnelStage',
        label: '阶段',
        type: 'select',
        options: [
          { label: '认知（TOFU）', value: 'TOFU' },
          { label: '考虑（MOFU）', value: 'MOFU' },
          { label: '决策（BOFU）', value: 'BOFU' },
          { label: '未分类', value: 'UNKNOWN' },
        ],
      },
      {
        name: 'isTracked',
        label: '是否追踪',
        type: 'select',
        options: [
          { label: '追踪中', value: 'true' },
          { label: '已停用', value: 'false' },
        ],
      },
    ],
  })

  // 品牌换了就重查。`refreshRef` 是为了不把 `table.refresh`（每次渲染身份稳定，
  // 但类型上不保证）写进依赖数组——真正的触发条件只有 `brandId` 一个。
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

  // 集清单跟着品牌走。
  useEffect(() => {
    if (brandId === undefined || brandId === '') {
      setSets([])
      return
    }
    let alive = true
    api
      .listSets(brandId)
      .then((rows) => {
        if (alive) setSets(rows)
      })
      .catch(() => {
        if (alive) setSets([])
      })
    return () => {
      alive = false
    }
    // `api` 每次渲染现造，放进依赖会无限循环。
  }, [brandId, setsToken])

  return { table, sets, refreshSets: () => setSetsToken((n) => n + 1) }
}
