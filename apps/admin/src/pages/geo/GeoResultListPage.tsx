import { Select, Space, Typography } from 'antd'
import { CrudTable, dateTimeColumn, statusTagColumn, textColumn } from '@taizan/admin-ui'
import { GEO_RESULT_STATUS, type GeoResult } from '../../api/geo-result'
import { GeoResultDetailDrawer } from './GeoResultDetailDrawer'
import { useBrandOptions } from './hooks/useBrandOptions'
import { useGeoResultDetail } from './hooks/useGeoResultDetail'
import { useGeoResultTable } from './hooks/useGeoResultTable'

/**
 * 「回答明细」列表：品牌选择器 + 只读 CrudTable + 原文抽屉。
 *
 * ## 这一页是 T6 的**占位页**
 *
 * 它证明的是接线通了：菜单 → componentKey → 路由 → 接口 → 权限点（`geo-result:view`）。
 * T8 会按设计文档 §6.1 把它做成带提及/引用标记的样子。
 *
 * ## 为什么「详情」是一个行操作而不是「点整行」
 *
 * `CrudTable` 没有暴露 `onRow`（见 admin-ui 的 `CrudTableProps`），能挂在行上的入口
 * 只有 `actions`。这不是绕路：行点击在一张有筛选与分页的表上很容易误触，
 * 而这条操作会**再发一次请求**去取上万字的原文。
 *
 * 页面里**没有裸的 `useState` / `useEffect`**（蓝图 §5.2 的 admin-ui 纪律）。
 */
export default function GeoResultListPage() {
  const brands = useBrandOptions()
  const table = useGeoResultTable(brands.brandId)
  const detail = useGeoResultDetail()

  return (
    <>
      <CrudTable<GeoResult>
        table={table}
        title="回答明细"
        emptyText={
          brands.loading
            ? '加载中…'
            : '还没有回答。先去「监测任务」点一次「立即刷新」，跑完之后这里就有了。'
        }
        toolbar={
          <Space>
            <Select
              style={{ minWidth: 200 }}
              allowClear
              loading={brands.loading}
              value={brands.brandId}
              onChange={brands.setBrandId}
              options={brands.options}
              placeholder="全部品牌"
            />
          </Space>
        }
        columns={[
          textColumn({ title: '引擎', dataIndex: 'engineCode', width: 110 }),
          statusTagColumn({ title: '状态', dataIndex: 'status', map: GEO_RESULT_STATUS }),
          {
            title: '回答摘要',
            key: 'preview',
            render: (_value: unknown, row: GeoResult) => (
              <Typography.Text ellipsis={{ tooltip: row.preview }} style={{ maxWidth: 420 }}>
                {row.preview || (row.errorMessage ?? '—')}
              </Typography.Text>
            ),
          },
          { title: '采样', dataIndex: 'sampleIndex', key: 'sampleIndex', width: 70 },
          {
            title: '耗时',
            key: 'latencyMs',
            width: 90,
            render: (_value: unknown, row: GeoResult) => `${row.latencyMs} ms`,
          },
          {
            title: '分析',
            key: 'analyzedAt',
            width: 80,
            render: (_value: unknown, row: GeoResult) => (row.analyzedAt ? '已分析' : '—'),
          },
          dateTimeColumn({ title: '回答时间', dataIndex: 'answeredAt' }),
        ]}
        actions={[
          {
            key: 'detail',
            label: '详情',
            perm: 'geo-result:view',
            onClick: (row) => detail.openWith(row.id),
          },
        ]}
      />

      <GeoResultDetailDrawer
        detail={detail.detail}
        loading={detail.loading}
        open={detail.open}
        onClose={detail.close}
      />
    </>
  )
}
