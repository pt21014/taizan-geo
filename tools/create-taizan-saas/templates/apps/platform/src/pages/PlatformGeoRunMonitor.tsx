import { Progress, Typography, message } from 'antd'
import { CrudTable, dateTimeColumn, statusTagColumn, useCrudTable } from '@taizan/admin-ui'
import { formatCents, type PageResult } from '@taizan/contracts'
import {
  GEO_PLATFORM_RUN_STATUSES,
  GEO_PLATFORM_RUN_STATUS_TAGS,
  useGeoPlatformRunApi,
  type GeoPlatformRun,
} from '../api/geo-run'

/**
 * 平台侧「跑批监控与重跑」：全平台跨租户列表 + 失败重跑。
 *
 * 「重跑」按二次确认包住——与 admin 那边「立即刷新」同一个判据：按一下会真的
 * 重新调用引擎、再花一次钱（见后端 `GeoPlatformRunController.retry` 的文件头）。
 */
export default function PlatformGeoRunMonitor() {
  const api = useGeoPlatformRunApi()

  const table = useCrudTable<GeoPlatformRun>({
    list: (query): Promise<PageResult<GeoPlatformRun>> => api.list(query),
    rowKey: 'id',
    syncUrl: true,
    searchSchema: [
      { name: 'tenantId', label: '租户 id' },
      {
        name: 'status',
        label: '状态',
        type: 'select',
        options: GEO_PLATFORM_RUN_STATUSES.map((s) => ({
          label: GEO_PLATFORM_RUN_STATUS_TAGS[s].text,
          value: s,
        })),
      },
    ],
  })

  const retry = async (row: GeoPlatformRun) => {
    try {
      const result = await api.retry(row.id)
      void message.success(`已重新入队 ${result.retriedCount} 条`)
      table.refresh()
    } catch {
      // 提示已由 session.request 的错误码分流负责。
    }
  }

  return (
    <CrudTable<GeoPlatformRun>
      table={table}
      title="GEO 跑批监控"
      emptyText="还没有任何跑批记录"
      columns={[
        { title: '租户', dataIndex: 'tenantName', key: 'tenantName', width: 140 },
        {
          title: '进度',
          key: 'progress',
          width: 140,
          render: (_v: unknown, row: GeoPlatformRun) => {
            const done = row.doneQueries + row.failedQueries
            return (
              <Progress
                percent={row.totalQueries === 0 ? 0 : Math.round((done / row.totalQueries) * 100)}
                size="small"
                status={row.status === 'FAILED' ? 'exception' : undefined}
                format={() => `${done}/${row.totalQueries}`}
              />
            )
          },
        },
        statusTagColumn<GeoPlatformRun>({ title: '状态', dataIndex: 'status', map: GEO_PLATFORM_RUN_STATUS_TAGS }),
        {
          title: '失败',
          key: 'failedQueries',
          width: 80,
          render: (_v: unknown, row: GeoPlatformRun) =>
            row.failedQueries === 0 ? '0' : <Typography.Text type="warning">{row.failedQueries}</Typography.Text>,
        },
        {
          title: '成本',
          key: 'totalCostCents',
          width: 90,
          render: (_v: unknown, row: GeoPlatformRun) =>
            formatCents(row.totalCostCents, { currencySymbol: '¥', grouping: true }),
        },
        dateTimeColumn({ title: '触发时间', dataIndex: 'createdAt' }),
      ]}
      actions={[
        {
          key: 'retry',
          label: '重跑失败',
          hidden: (row) => row.failedQueries === 0,
          confirm: (row) => `会真的再调一次引擎，重新入队 ${row.failedQueries} 条失败的查询，撤不回来。确定重跑吗？`,
          onClick: retry,
        },
      ]}
    />
  )
}
