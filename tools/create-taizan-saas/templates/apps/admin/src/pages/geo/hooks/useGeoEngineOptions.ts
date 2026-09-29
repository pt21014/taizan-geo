import { useEffect, useState } from 'react'
import { useGeoEngineOptionApi, type GeoEngineOption } from '../../../api/geo-brand'

/** {@link useGeoEngineOptions} 的返回值。 */
export interface GeoEngineOptionsState {
  /** 给 `<Select>` 直接用的选项（`BROWSER` 类在标签上带一个后缀，见下）。 */
  options: { label: string; value: string }[]
  /** 原始行，需要按 `vendor` 分组或读 `accessType` 时用。 */
  engines: GeoEngineOption[]
  loading: boolean
}

/**
 * 「品牌表单里那个监测引擎多选框」的数据源。
 *
 * ## 为什么它不是 `useCrudTable`
 *
 * 与 `useBrandOptions` 同一个判据：这不是一张表，是一个下拉框。不分页、不排序、
 * 不搜索，只要「此刻平台启用了哪些引擎」。用 `useCrudTable` 会把分页参数同步进
 * 地址栏（`syncUrl`），而地址栏里出现 `?page=1&pageSize=20` 却看不到任何表格，
 * 是纯粹的噪声。
 *
 * ## 为什么 `useState` / `useEffect` 在这里是允许的
 *
 * admin-ui 的纪律禁止的是**页面文件里**出现它们（那会让数据获取散进视图）。
 * 收进一个带名字的 hook 之后，「引擎清单从哪来、什么时候拉」只有这一处答案。
 * `useBrandOptions` / `useDrawerState` 是同一种处理。
 *
 * ## 拉不到时**回空数组**，不抛
 *
 * 这个下拉框所在的表单还有十来个别的字段。接口挂了就让整个抽屉打不开的话，
 * 运营连改个品牌名都做不到。空数组的表现是「暂时没有可选引擎」，
 * 而那正好也是「平台一个引擎都没启用」的真实表现——两者都该让人去找平台，
 * 不需要在 UI 上分开。
 *
 * ## `BROWSER` 类为什么在标签上标出来
 *
 * 浏览器自动化类引擎慢一个数量级、也更容易被风控挡掉。运营在勾的时候就该知道
 * 「多勾这一个，跑批时间会明显变长」，而不是等跑批跑了半小时才去问。
 */
export function useGeoEngineOptions(): GeoEngineOptionsState {
  const api = useGeoEngineOptionApi()
  const [engines, setEngines] = useState<GeoEngineOption[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .list()
      .then((items) => {
        if (alive) setEngines(items)
      })
      .catch(() => {
        if (alive) setEngines([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // 只在挂载时拉一次：`api` 是每次渲染现造的对象，放进依赖会无限循环。
  }, [])

  return {
    options: engines.map((engine) => ({
      label: engine.accessType === 'BROWSER' ? `${engine.name}（浏览器抓取）` : engine.name,
      value: engine.code,
    })),
    engines,
    loading,
  }
}
