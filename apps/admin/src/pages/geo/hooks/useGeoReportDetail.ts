import { useCallback, useState } from 'react'
import { useGeoReportApi, type GeoReportDetail } from '../../../api/geo-report'

/** {@link useGeoReportDetail} 的返回值。 */
export interface GeoReportDetailState {
  open: boolean
  loading: boolean
  detail: GeoReportDetail | null
  openWith: (id: string) => void
  close: () => void
}

/**
 * 「点一行 → 打开只读详情抽屉」，与 `useGeoResultDetail` 同一套并发判据
 * （请求序号，只认最后一次打开的结果）。
 */
export function useGeoReportDetail(): GeoReportDetailState {
  const api = useGeoReportApi()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<GeoReportDetail | null>(null)
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
    [token],
  )

  const close = useCallback(() => setOpen(false), [])

  return { open, loading, detail, openWith, close }
}
