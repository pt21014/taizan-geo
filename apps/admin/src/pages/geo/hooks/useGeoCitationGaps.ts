import { useEffect, useState } from 'react'
import { useGeoCitationApi, type GeoCitationGaps, type GeoDashboardDays } from '../../../api/geo-citation'

/** {@link useGeoCitationGaps} 的返回值。 */
export interface GeoCitationGapsState {
  loading: boolean
  gaps: GeoCitationGaps | null
}

/**
 * 引用缺口榜：竞品被提及、本品牌完全没被提及的回答里 AI 实际引用了哪些第三方来源，
 * 附内容优化建议。与 {@link useGeoCitationSummary} 分开维护——它是独立的一块只读汇总，
 * 换品牌/周期就整份重拉，不参与明细分页。
 */
export function useGeoCitationGaps(brandId: string | undefined, days: GeoDashboardDays): GeoCitationGapsState {
  const api = useGeoCitationApi()
  const [loading, setLoading] = useState(false)
  const [gaps, setGaps] = useState<GeoCitationGaps | null>(null)
  const [token, setToken] = useState(0)

  useEffect(() => {
    if (brandId === undefined) {
      setGaps(null)
      return
    }
    const mine = token + 1
    setToken(mine)
    setLoading(true)
    api
      .gaps(brandId, days)
      .then((g) => {
        setToken((current) => {
          if (current !== mine) return current
          setGaps(g)
          return current
        })
      })
      .catch(() => {
        setToken((current) => {
          if (current !== mine) return current
          setGaps(null)
          return current
        })
      })
      .finally(() => {
        setToken((current) => {
          if (current === mine) setLoading(false)
          return current
        })
      })
  }, [brandId, days])

  return { loading, gaps }
}
