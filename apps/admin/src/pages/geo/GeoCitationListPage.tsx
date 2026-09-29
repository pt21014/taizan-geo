import { lazy, Suspense } from 'react'
import { Alert, Card, Col, Empty, List, Row, Segmented, Select, Space, Spin, Table, Tag } from 'antd'
import { CrudTable, dateTimeColumn } from '@taizan/admin-ui'
import {
  GEO_DASHBOARD_DAYS,
  GEO_SOURCE_CATEGORY_TAGS,
  type GeoCitation,
  type GeoDashboardDays,
} from '../../api/geo-citation'
import { useBrandOptions } from './hooks/useBrandOptions'
import { useDaysOption } from './hooks/useDaysOption'
import { useGeoCitationGaps } from './hooks/useGeoCitationGaps'
import { useGeoCitationSummary } from './hooks/useGeoCitationSummary'
import { useGeoCitationTable } from './hooks/useGeoCitationTable'

const Pie = lazy(() => import('@ant-design/plots').then((m) => ({ default: m.Pie })))

/**
 * 引用来源：平台占比饼图 + 域名榜 + 引用明细（CrudTable）。
 *
 * 没有裸的 `useState`/`useEffect`：品牌归 `useBrandOptions`，周期档位归
 * `useDaysOption`，域名/平台两条汇总归 `useGeoCitationSummary`，明细分页归
 * `useGeoCitationTable`。
 */
export default function GeoCitationListPage() {
  const brands = useBrandOptions()
  const { days, setDays } = useDaysOption()
  const summary = useGeoCitationSummary(brands.brandId, days)
  const gaps = useGeoCitationGaps(brands.brandId, days)
  const table = useGeoCitationTable(brands.brandId, days)

  if (!brands.loading && brands.options.length === 0) {
    return (
      <Card>
        <Empty description="这家店还没有监测品牌。先去「品牌管理」建一个。" />
      </Card>
    )
  }

  return (
    <Spin spinning={brands.loading}>
      <Card
        title="引用来源"
        extra={
          <Space>
            <Segmented
              value={days}
              onChange={(v) => setDays(v as GeoDashboardDays)}
              options={GEO_DASHBOARD_DAYS.map((d) => ({ label: `近 ${d} 天`, value: d }))}
            />
            <Select
              style={{ minWidth: 200 }}
              loading={brands.loading}
              value={brands.brandId}
              onChange={brands.setBrandId}
              options={brands.options}
            />
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Spin spinning={summary.loading}>
          <Row gutter={16}>
            <Col span={10}>
              <Card title="来源归类占比" size="small" bordered={false}>
                {summary.platforms === null || summary.platforms.items.length === 0 ? (
                  <Empty description="这个周期还没有引用数据" />
                ) : (
                  <Suspense fallback={<Spin />}>
                    <Pie
                      height={240}
                      data={summary.platforms.items.map((i) => ({
                        category: GEO_SOURCE_CATEGORY_TAGS[i.category].text,
                        value: i.count,
                      }))}
                      angleField="value"
                      colorField="category"
                      label={{ text: 'category', style: { fontSize: 11 } }}
                    />
                  </Suspense>
                )}
              </Card>
            </Col>
            <Col span={14}>
              <Card title="域名榜（Top 50）" size="small" bordered={false}>
                <Table
                  size="small"
                  rowKey="domain"
                  pagination={{ pageSize: 8, size: 'small' }}
                  dataSource={summary.domains?.items ?? []}
                  locale={{ emptyText: '这个周期还没有引用数据' }}
                  columns={[
                    { title: '域名', dataIndex: 'domain', key: 'domain', ellipsis: true },
                    {
                      title: '归类',
                      key: 'category',
                      width: 100,
                      render: (_v: unknown, row) => (
                        <Tag color={GEO_SOURCE_CATEGORY_TAGS[row.category].color}>
                          {GEO_SOURCE_CATEGORY_TAGS[row.category].text}
                        </Tag>
                      ),
                    },
                    { title: '次数', dataIndex: 'count', key: 'count', width: 70 },
                  ]}
                />
              </Card>
            </Col>
          </Row>
        </Spin>
      </Card>

      <Card title="引用缺口 · 内容优化建议" style={{ marginBottom: 16 }} loading={gaps.loading}>
        {gaps.gaps === null || gaps.gaps.items.length === 0 ? (
          <Empty description="这个周期没有发现明显的引用缺口——要么竞品也没怎么被提及，要么品牌和竞品被引用的来源基本重合" />
        ) : (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message={`下面这些来源在"提到了 ${gaps.gaps.competitorNames.join('、')}、但完全没提到你的品牌"的回答里被引用过——去这些渠道补内容，最有希望被 AI 引用到。`}
            />
            <List
              itemLayout="horizontal"
              dataSource={gaps.gaps.items}
              renderItem={(item) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space>
                        <span>{item.domain}</span>
                        <Tag color={GEO_SOURCE_CATEGORY_TAGS[item.category].color}>
                          {GEO_SOURCE_CATEGORY_TAGS[item.category].text}
                        </Tag>
                        <span style={{ color: 'rgba(0,0,0,0.45)' }}>被引用 {item.count} 次</span>
                      </Space>
                    }
                    description={item.suggestion}
                  />
                </List.Item>
              )}
            />
          </>
        )}
      </Card>

      <CrudTable<GeoCitation>
        table={table}
        title="引用明细"
        emptyText="这个品牌这个周期还没有产生任何引用"
        columns={[
          { title: '问法', dataIndex: 'promptText', key: 'promptText', ellipsis: true, width: 220 },
          { title: '引擎', dataIndex: 'engineCode', key: 'engineCode', width: 90 },
          { title: '#', dataIndex: 'rank', key: 'rank', width: 50 },
          { title: '域名', dataIndex: 'domain', key: 'domain', ellipsis: true },
          {
            title: '归类',
            key: 'category',
            width: 100,
            render: (_v: unknown, row: GeoCitation) => (
              <Tag color={GEO_SOURCE_CATEGORY_TAGS[row.category].color}>
                {GEO_SOURCE_CATEGORY_TAGS[row.category].text}
              </Tag>
            ),
          },
          {
            title: '链接',
            key: 'url',
            ellipsis: true,
            render: (_v: unknown, row: GeoCitation) => (
              <a href={row.url} target="_blank" rel="noreferrer">
                {row.title ?? row.url}
              </a>
            ),
          },
          dateTimeColumn({ title: '产生时间', dataIndex: 'answeredAt' }),
        ]}
      />
    </Spin>
  )
}
