import { useCrudTable, type CrudTableApi } from '@taizan/admin-ui'
import {
  GEO_REPORT_PERIODS,
  GEO_REPORT_PERIOD_TEXT,
  useGeoReportApi,
  type GeoReport,
} from '../../../api/geo-report'

/** 报表列表的表格状态：`useCrudTable` 标准形状，按品牌/周期类型筛。 */
export function useGeoReportTable(): CrudTableApi<GeoReport> {
  const api = useGeoReportApi()

  return useCrudTable<GeoReport>({
    list: api.list,
    rowKey: 'id',
    syncUrl: true,
    searchSchema: [
      { name: 'brandId', label: '品牌 id' },
      {
        name: 'period',
        label: '周期',
        type: 'select',
        options: GEO_REPORT_PERIODS.map((p) => ({ label: GEO_REPORT_PERIOD_TEXT[p], value: p })),
      },
    ],
  })
}
