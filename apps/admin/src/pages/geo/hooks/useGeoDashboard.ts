import { useCallback, useEffect, useState } from 'react'
import {
  GEO_DASHBOARD_DAYS,
  useGeoDashboardApi,
  type GeoDashboardCompetitors,
  type GeoDashboardDays,
  type GeoDashboardEngines,
  type GeoDashboardOverview,
  type GeoDashboardTrend,
} from '../../../api/geo-dashboard'

/** {@link useGeoDashboard} 的返回值。 */
export interface GeoDashboardState {
  days: GeoDashboardDays
  setDays: (days: GeoDashboardDays) => void
  loading: boolean
  overview: GeoDashboardOverview | null
  trend: GeoDashboardTrend | null
  engines: GeoDashboardEngines | null
  competitors: GeoDashboardCompetitors | null
  refresh: () => void
}

/**
 * 看板总览页的数据获取：一次拉齐总览 + 趋势 + 引擎对比 + 竞品对比四条只读接口。
 *
 * 「周期档位」放在这个 hook 里而不是页面的裸 `useState`（蓝图 §5.2 admin-ui 纪律）：
 * 换档位要联动四条请求一起重发，只有收进一个带名字的 hook，这件事才只有一处答案。
 *
 * 与 `useGeoResultDetail` 同一个并发判据：请求带一个自增序号，只有最后一次触发的
 * 那组结果会被采纳——防止「品牌 A 的请求比品牌 B 的慢，回来时把 B 的数据覆盖掉」。
 */
export function useGeoDashboard(brandId: string | undefined): GeoDashboardState {
  const api = useGeoDashboardApi()
  const [days, setDays] = useState<GeoDashboardDays>(GEO_DASHBOARD_DAYS[0])
  const [loading, setLoading] = useState(false)
  const [overview, setOverview] = useState<GeoDashboardOverview | null>(null)
  const [trend, setTrend] = useState<GeoDashboardTrend | null>(null)
  const [engines, setEngines] = useState<GeoDashboardEngines | null>(null)
  const [competitors, setCompetitors] = useState<GeoDashboardCompetitors | null>(null)
  const [token, setToken] = useState(0)

  const load = useCallback(
    (mine: number) => {
      if (brandId === undefined) {
        setOverview(null)
        setTrend(null)
        setEngines(null)
        setCompetitors(null)
        setLoading(false)
        return
      }
      setLoading(true)
      Promise.all([
        api.overview(brandId, days),
        api.trend(brandId, days),
        api.engines(brandId, days),
        api.competitors(brandId, days),
      ])
        .then(([o, t, e, c]) => {
          setToken((current) => {
            if (current !== mine) return current
            setOverview(o)
            setTrend(t)
            setEngines(e)
            setCompetitors(c)
            return current
          })
        })
        .catch(() => {
          setToken((current) => {
            if (current !== mine) return current
            setOverview(null)
            setTrend(null)
            setEngines(null)
            setCompetitors(null)
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
    // `api` 每次渲染现造，不放进依赖：放进去会导致这个回调每次渲染都换身份，
    // 与 `useGeoResultDetail` 同一个判据。
    [brandId, days],
  )

  useEffect(() => {
    const mine = token + 1
    setToken(mine)
    load(mine)
    // `token` 故意不进依赖：它只用来标记"这一次"是谁发起的，进依赖会在 load 内部
    // setToken 之后立刻触发下一轮，形成死循环。
  }, [brandId, days])

  const refresh = useCallback(() => {
    setToken((current) => {
      const mine = current + 1
      load(mine)
      return mine
    })
  }, [load])

  return { days, setDays, loading, overview, trend, engines, competitors, refresh }
}
