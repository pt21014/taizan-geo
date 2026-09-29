import { Card, Col, Empty, Input, Row, Space, Spin, Statistic, Table } from 'antd'
import { formatCents } from '@taizan/contracts'
import { usePlatformGeoUsage } from './hooks/usePlatformGeoUsage'

/**
 * 平台侧「全平台用量与成本」看板：一条只读汇总接口，按租户/引擎两个维度拆。
 *
 * 月份/租户筛选收进 `usePlatformGeoUsage`（admin-ui 纪律同样适用于 platform：
 * 数据获取不裸写在页面文件里，`PlatformGeoEngineList` 的三处 `useState` 都是
 * 纯视图状态，这里的月份/租户是要触发重新请求的业务状态，理应收进 hook）。
 */
export default function PlatformGeoUsage() {
  const state = usePlatformGeoUsage()

  return (
    <Spin spinning={state.loading}>
      <Card
        title="GEO 全平台用量"
        extra={
          <Space>
            <Input
              placeholder="YYYY-MM"
              style={{ width: 120 }}
              value={state.month}
              onChange={(e) => state.setMonth(e.target.value)}
            />
            <Input
              placeholder="按租户 id 筛（留空 = 全平台）"
              style={{ width: 240 }}
              value={state.tenantId}
              onChange={(e) => state.setTenantId(e.target.value)}
              allowClear
            />
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        {state.summary === null ? (
          <Empty description="这个月还没有用量数据" />
        ) : (
          <Statistic title={`${state.summary.month} 总成本`} value={formatCents(state.summary.totalCostCents, { currencySymbol: '¥', grouping: true })} />
        )}
      </Card>

      <Row gutter={16}>
        <Col span={12}>
          <Card title="按租户" size="small">
            <Table
              size="small"
              rowKey="tenantId"
              pagination={{ pageSize: 10, size: 'small' }}
              dataSource={state.summary?.byTenant ?? []}
              locale={{ emptyText: '没有数据' }}
              columns={[
                { title: '租户', dataIndex: 'tenantName', key: 'tenantName' },
                { title: '用量', dataIndex: 'quantity', key: 'quantity', width: 90 },
                {
                  title: '成本',
                  key: 'costCents',
                  width: 100,
                  render: (_v: unknown, row: { costCents: number }) => formatCents(row.costCents, { currencySymbol: '¥', grouping: true }),
                },
              ]}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="按引擎" size="small">
            <Table
              size="small"
              rowKey="engineCode"
              pagination={{ pageSize: 10, size: 'small' }}
              dataSource={state.summary?.byEngine ?? []}
              locale={{ emptyText: '没有数据' }}
              columns={[
                {
                  title: '引擎',
                  dataIndex: 'engineCode',
                  key: 'engineCode',
                  render: (v: string) => v || '（与引擎无关）',
                },
                { title: '用量', dataIndex: 'quantity', key: 'quantity', width: 90 },
                {
                  title: '成本',
                  key: 'costCents',
                  width: 100,
                  render: (_v: unknown, row: { costCents: number }) => formatCents(row.costCents, { currencySymbol: '¥', grouping: true }),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Spin>
  )
}
