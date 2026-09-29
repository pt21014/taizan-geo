import { useCallback, useEffect, useState } from 'react'
import { useGeoBrandApi, type GeoBrand } from '../../../api/geo-brand'

/** {@link useBrandOptions} 的返回值。 */
export interface BrandOptions {
  /** 给 `<Select>` 直接用的选项 */
  options: { label: string; value: string }[]
  /** 原始行（需要读 `sampleSize` / `engineCodes` 之类时用） */
  brands: GeoBrand[]
  loading: boolean
  /** 当前选中的品牌 id；一条都没有时为 `undefined` */
  brandId: string | undefined
  setBrandId: (id: string) => void
}

/**
 * 「顶部那个品牌选择器」的数据源。
 *
 * ## 为什么它不是 `useCrudTable`
 *
 * 这不是一张表，是一个下拉框：不分页、不排序、不搜索，只要「这家店有哪些品牌」。
 * 用 `useCrudTable` 会把分页参数同步进地址栏（`syncUrl`），而地址栏里出现
 * `?page=1&pageSize=200` 却看不到任何表格，是纯粹的噪声。
 *
 * ## 为什么 `useState` / `useEffect` 在这里是允许的
 *
 * 与 `useDrawerState` 同一个判据：admin-ui 的纪律禁止的是**页面文件里**出现它们，
 * 因为那会让数据获取散进视图。收进一个带名字的 hook 之后，「品牌清单从哪来、
 * 什么时候拉」只有这一处答案，页面只拿结果。
 *
 * ## 默认选中第一个
 *
 * Prompt 列表的 `brandId` 是**必填**参数——不默认选一个的话，页面打开是空的，
 * 而运营看到的是「我的问法都没了」。所以第一次拉回来就选中第一条。
 */
export function useBrandOptions(): BrandOptions {
  const api = useGeoBrandApi()
  const [brands, setBrands] = useState<GeoBrand[]>([])
  const [loading, setLoading] = useState(true)
  const [brandId, setBrandId] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setLoading(true)
    // 200 是列表接口的 pageSize 上限。一家店的监测品牌数受 `GEO_BRAND` 配额约束，
    // 真实数量是个位数到几十——一次拉完比做成可搜索的远程下拉简单得多。
    api
      .list({ page: 1, pageSize: 200 })
      .then((page) => {
        if (!alive) return
        setBrands(page.items)
        setBrandId((current) => current ?? page.items[0]?.id)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // 只在挂载时拉一次：`api` 是每次渲染现造的对象，放进依赖会无限循环。
  }, [])

  const select = useCallback((id: string) => setBrandId(id), [])

  return {
    options: brands.map((brand) => ({ label: brand.name, value: brand.id })),
    brands,
    loading,
    brandId,
    setBrandId: select,
  }
}
