import { useCallback, useEffect, useState } from 'react'
import { useGeoPlatformUsageApi, type GeoPlatformUsageSummary } from '../../api/geo-usage'

/** {@link usePlatformGeoUsage} 的返回值。 */
export interface PlatformGeoUsageState {
  month: string
  setMonth: (month: string) => void
  tenantId: string
  setTenantId: (tenantId: string) => void
  loading: boolean
  summary: GeoPlatformUsageSummary | null
}

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 平台用量看板的数据获取：月份/租户筛选 + 一条汇总请求，收进一个 hook
 * （与 admin 那边的 admin-ui 纪律同一个判据：数据获取不散进页面文件）。
 */
export function usePlatformGeoUsage(): PlatformGeoUsageState {
  const api = useGeoPlatformUsageApi()
  const [month, setMonth] = useState(currentMonth())
  const [tenantId, setTenantId] = useState('')
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<GeoPlatformUsageSummary | null>(null)
  const [token, setToken] = useState(0)

  const load = useCallback(
    (mine: number) => {
      setLoading(true)
      api
        .summary({ month: month || undefined, tenantId: tenantId || undefined })
        .then((s) => {
          setToken((current) => {
            if (current === mine) setSummary(s)
            return current
          })
        })
        .catch(() => {
          setToken((current) => {
            if (current === mine) setSummary(null)
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
    [month, tenantId],
  )

  useEffect(() => {
    const mine = token + 1
    setToken(mine)
    load(mine)
  }, [month, tenantId])

  return { month, setMonth, tenantId, setTenantId, loading, summary }
}
