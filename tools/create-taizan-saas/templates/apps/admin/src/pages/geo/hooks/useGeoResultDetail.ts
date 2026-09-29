import { useCallback, useState } from 'react'
import { useGeoResultApi, type GeoResultDetail } from '../../../api/geo-result'

/** {@link useGeoResultDetail} 的返回值。 */
export interface GeoResultDetailState {
  open: boolean
  loading: boolean
  /** 正在看的那一条；还没取到或已关闭时为 `null`。 */
  detail: GeoResultDetail | null
  /** 打开抽屉并去取详情。 */
  openWith: (id: string) => void
  close: () => void
}

/**
 * 「点一行 → 打开只读详情抽屉」这件事的状态。
 *
 * 与 `useDrawerState` 分开写而不是复用它：这个抽屉打开时要**再发一次请求**
 * （列表里没有 `rawText` / `mentions` / `citations`），于是它比「开关 + 上下文」多两件事——
 * 加载中、以及「请求回来时抽屉可能已经被关了」。
 *
 * 后一件是这个 hook 存在的主要理由：不判的话，快速点开两行会让先回来的那次覆盖后打开的那条，
 * 表现是「点 A 看到 B 的内容」。这里用一个**请求序号**解决——只认最后一次打开的结果。
 *
 * ## 为什么 `useState` 在这里是允许的
 *
 * admin-ui 的纪律禁止的是**页面文件里**出现它（蓝图 §5.2）。收进一个带名字的 hook 之后，
 * 「详情从哪来、什么时候取、并发怎么办」只有这一处答案。
 */
export function useGeoResultDetail(): GeoResultDetailState {
  const api = useGeoResultApi()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<GeoResultDetail | null>(null)
  // 请求序号：每次打开 +1，只有序号最大的那次回来的数据会被采纳。
  const [token, setToken] = useState(0)

  const openWith = useCallback(
    (id: string) => {
      const mine = token + 1
      setToken(mine)
      setDetail(null)
      setLoading(true)
      setOpen(true)
      api
        .get(id)
        .then((row) => {
          // 用函数式更新读当前序号：闭包里的 `token` 是这次渲染的旧值。
          setToken((current) => {
            if (current === mine) setDetail(row)
            return current
          })
        })
        .catch(() => {
          setToken((current) => {
            if (current === mine) setDetail(null)
            return current
          })
        })
        .finally(() => {
          setToken((current) => {
            if (current === mine) setLoading(false)
            return current
          })
        })
    },
    // `api` 每次渲染现造，放进依赖会让这个回调每次都变；`token` 必须在依赖里，
    // 否则 `mine` 永远是 1。
    [token],
  )

  const close = useCallback(() => setOpen(false), [])

  return { open, loading, detail, openWith, close }
}
