import { useEffect, useState } from 'react'
import { useGeoReportApi, type GeoReportDetail } from '../../../api/geo-report'

/** {@link useGeoDiagnosisReport} 的返回值。 */
export interface GeoDiagnosisReportState {
  report: GeoReportDetail | null
  loading: boolean
}

/**
 * 「诊断报告」屏的数据源：`reportId` 一出现（诊断跑批的 `diagnosisReportId` 非空）
 * 就去 `GET /reports/:id` 取一次。
 *
 * 与 `useGeoReportDetail`（报表列表页的详情抽屉）故意不是同一个 hook：那个是
 * "点一行手动打开/关闭"的抽屉状态（`open`/`openWith`/`close`），这里没有开关，
 * `reportId` 就是唯一的数据源——`reportId` 一变就重新拉，`null` 就什么都不做。
 */
export function useGeoDiagnosisReport(reportId: string | null): GeoDiagnosisReportState {
  const api = useGeoReportApi()
  const [report, setReport] = useState<GeoReportDetail | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (reportId === null) return
    let alive = true
    setLoading(true)
    api
      .get(reportId)
      .then((row) => {
        if (alive) setReport(row)
      })
      .catch(() => {
        if (alive) setReport(null)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // `api` 是每次渲染现造的对象，只在 `reportId` 变化时重拉——与
    // `useGeoEngineOptions`/`useBrandOptions` 同一条注释。
  }, [reportId])

  return { report, loading }
}
