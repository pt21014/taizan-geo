import { useEffect, useState } from 'react'
import {
  useGeoCitationApi,
  type GeoCitationDomains,
  type GeoCitationPlatforms,
  type GeoDashboardDays,
} from '../../../api/geo-citation'

/** {@link useGeoCitationSummary} 的返回值。 */
export interface GeoCitationSummaryState {
  loading: boolean
  domains: GeoCitationDomains | null
  platforms: GeoCitationPlatforms | null
}

/**
 * 引用来源页顶部「域名榜 + 平台占比」两条只读汇总——与明细列表（`useCrudTable`）
 * 分开维护，因为它们不分页、不搜索，换品牌/周期就整份重拉。
 */
export function useGeoCitationSummary(
  brandId: string | undefined,
  days: GeoDashboardDays,
): GeoCitationSummaryState {
  const api = useGeoCitationApi()
  const [loading, setLoading] = useState(false)
  const [domains, setDomains] = useState<GeoCitationDomains | null>(null)
  const [platforms, setPlatforms] = useState<GeoCitationPlatforms | null>(null)
  const [token, setToken] = useState(0)

  useEffect(() => {
    if (brandId === undefined) {
      setDomains(null)
      setPlatforms(null)
      return
    }
    const mine = token + 1
    setToken(mine)
    setLoading(true)
    Promise.all([api.domains(brandId, days), api.platforms(brandId, days)])
      .then(([d, p]) => {
        setToken((current) => {
          if (current !== mine) return current
          setDomains(d)
          setPlatforms(p)
          return current
        })
      })
      .catch(() => {
        setToken((current) => {
          if (current !== mine) return current
          setDomains(null)
          setPlatforms(null)
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

  return { loading, domains, platforms }
}
