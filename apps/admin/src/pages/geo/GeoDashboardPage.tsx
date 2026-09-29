import { lazy, Suspense } from 'react'
import { Card, Col, Empty, Row, Segmented, Select, Spin, Statistic, Table, Tag, Typography } from 'antd'
import { CrudTable } from '@taizan/admin-ui'
import { GEO_DASHBOARD_DAYS, type GeoDashboardDays, type GeoPromptMetrics } from '../../api/geo-dashboard'
import { useBrandOptions } from './hooks/useBrandOptions'
import { useGeoDashboard } from './hooks/useGeoDashboard'
import { useGeoDashboardPromptTable } from './hooks/useGeoDashboardPromptTable'

// `@ant-design/plots` 只有这一个页面用，`lazy` 包住不让它拖慢其余页面的首屏（蓝图 §6.3）。
const Line = lazy(() => import('@ant-design/plots').then((m) => ({ default: m.Line })))
const Column = lazy(() => import('@ant-design/plots').then((m) => ({ default: m.Column })))

const bp = (v: number) => `${(v / 100).toFixed(2)}%`
const bpDelta = (v: number) => `${v >= 0 ? '+' : ''}${(v / 100).toFixed(2)}pp`
const position = (v: number) => (v === 0 ? '未提及' : (v / 100).toFixed(2))
const positionDelta = (v: number) => (v === 0 ? '—' : `${v >= 0 ? '+' : ''}${(v / 100).toFixed(2)}`)
const sentiment = (v: number) => (v / 100).toFixed(1)

const FUNNEL_TEXT: Record<string, string> = {
  TOFU: '认知期',
  MOFU: '考虑期',
  BOFU: '决策期',
  UNKNOWN: '未分类',
}

/**
 * GEO 看板：品牌可见度总览、趋势、引擎对比、竞品对比、Prompt 榜，一页五段。
 *
 * 页面里没有裸的 `useState`/`useEffect`（蓝图 §5.2 admin-ui 纪律）：品牌清单归
 * `useBrandOptions`，周期档位与四条聚合数据归 `useGeoDashboard`，Prompt 榜的
 * 分页归 `useGeoDashboardPromptTable`。
 *
 * 五项指标全部是整数口径（bp = 基点，X100 = 放大 100 倍），这里统一在展示层
 * 除回真实单位——与蓝图 §10 第 6 条「后端全程整数」呼应，除法只发生在最后一步。
 */
export default function GeoDashboardPage() {
  const brands = useBrandOptions()
  const dashboard = useGeoDashboard(brands.brandId)
  const promptTable = useGeoDashboardPromptTable(brands.brandId, dashboard.days)

  if (!brands.loading && brands.options.length === 0) {
    return (
      <Card>
        <Empty description="这家店还没有监测品牌。先去「品牌管理」建一个。" />
      </Card>
    )
  }

  const { overview, trend, engines, competitors } = dashboard

  return (
    <Spin spinning={brands.loading || dashboard.loading}>
      <Card
        title="GEO 可见度看板"
        extra={
          <Select
            style={{ minWidth: 200 }}
            loading={brands.loading}
            value={brands.brandId}
            onChange={brands.setBrandId}
            options={brands.options}
          />
        }
        style={{ marginBottom: 16 }}
      >
        <Segmented
          value={dashboard.days}
          onChange={(v) => dashboard.setDays(v as GeoDashboardDays)}
          options={GEO_DASHBOARD_DAYS.map((d) => ({ label: `近 ${d} 天`, value: d }))}
          style={{ marginBottom: 16 }}
        />

        {overview === null ? (
          <Empty description="这个品牌还没有跑出数据。等每天凌晨的自动任务，或去「监测任务」立即刷新一次。" />
        ) : (
          <>
            <Row gutter={16}>
              <Col span={4}>
                <Statistic title="提及率" value={bp(overview.current.mentionRateBp)} />
                <Typography.Text type="secondary">
                  较上期 {bpDelta(overview.delta.mentionRateBp)}
                </Typography.Text>
              </Col>
              <Col span={4}>
                <Statistic title="声量份额" value={bp(overview.current.sovBp)} />
                <Typography.Text type="secondary">
                  较上期 {bpDelta(overview.delta.sovBp)}
                </Typography.Text>
              </Col>
              <Col span={4}>
                <Statistic title="平均位次" value={position(overview.current.avgPositionX100)} />
                <Typography.Text type="secondary">
                  较上期 {positionDelta(overview.delta.avgPositionX100)}（越小越好）
                </Typography.Text>
              </Col>
              <Col span={4}>
                <Statistic title="引用率" value={bp(overview.current.citationRateBp)} />
                <Typography.Text type="secondary">
                  较上期 {bpDelta(overview.delta.citationRateBp)}
                </Typography.Text>
              </Col>
              <Col span={4}>
                <Statistic title="平均情感分" value={sentiment(overview.current.sentimentAvgX100)} />
                <Typography.Text type="secondary">
                  较上期 {(overview.delta.sentimentAvgX100 / 100).toFixed(1)}
                </Typography.Text>
              </Col>
              <Col span={4}>
                <Statistic title="回答总数" value={overview.current.answers} />
                {overview.lastRun !== null && (
                  <Typography.Text type="secondary">
                    上次跑批：
                    <Tag
                      style={{ marginLeft: 4 }}
                      color={overview.lastRun.status === 'FAILED' ? 'error' : 'default'}
                    >
                      {overview.lastRun.status}
                    </Tag>
                  </Typography.Text>
                )}
              </Col>
            </Row>
          </>
        )}
      </Card>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={14}>
          <Card title="提及率趋势" size="small">
            {trend === null || trend.points.length === 0 ? (
              <Empty description="没有跑过的天不出点" />
            ) : (
              <Suspense fallback={<Spin />}>
                <Line
                  height={260}
                  data={trend.points.map((p) => ({ date: p.date, value: p.mentionRateBp / 100 }))}
                  xField="date"
                  yField="value"
                  point={{ size: 3 }}
                  yAxis={{ label: { formatter: (v: string) => `${v}%` } }}
                  tooltip={{ formatter: (d: { date: string; value: number }) => ({
                    name: '提及率',
                    value: `${d.value.toFixed(2)}%`,
                  }) }}
                />
              </Suspense>
            )}
          </Card>
        </Col>
        <Col span={10}>
          <Card title="引擎对比" size="small">
            {engines === null || engines.items.length === 0 ? (
              <Empty description="没有数据" />
            ) : (
              <Suspense fallback={<Spin />}>
                <Column
                  height={260}
                  data={engines.items.map((e) => ({ engine: e.engineName, value: e.mentionRateBp / 100 }))}
                  xField="engine"
                  yField="value"
                  yAxis={{ label: { formatter: (v: string) => `${v}%` } }}
                  tooltip={{ formatter: (d: { engine: string; value: number }) => ({
                    name: '提及率',
                    value: `${d.value.toFixed(2)}%`,
                  }) }}
                />
              </Suspense>
            )}
          </Card>
        </Col>
      </Row>

      <Card title="竞品对比" size="small" style={{ marginBottom: 16 }}>
        <Table
          size="small"
          rowKey={(row) => row.competitorId || '__brand__'}
          pagination={false}
          dataSource={competitors?.items ?? []}
          locale={{ emptyText: '还没有配竞品，去「品牌管理」加几个' }}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              key: 'name',
              render: (v: string, row) => (row.isBrand ? <Tag color="blue">{v}（本品牌）</Tag> : v),
            },
            { title: '提及次数', dataIndex: 'mentions', key: 'mentions', width: 100 },
            {
              title: '提及率',
              key: 'mentionRateBp',
              width: 100,
              render: (_v: unknown, row) => bp(row.mentionRateBp),
            },
            {
              title: '声量份额',
              key: 'sovBp',
              width: 100,
              render: (_v: unknown, row) => bp(row.sovBp),
            },
            {
              title: '平均位次',
              key: 'avgPositionX100',
              width: 100,
              render: (_v: unknown, row) => position(row.avgPositionX100),
            },
          ]}
        />
      </Card>

      <CrudTable<GeoPromptMetrics>
        table={promptTable}
        title="Prompt 榜"
        emptyText="这个品牌还没有跑出 Prompt 维度的数据"
        columns={[
          { title: '问法', dataIndex: 'text', key: 'text', ellipsis: true },
          {
            title: '阶段',
            key: 'funnelStage',
            width: 90,
            render: (_v: unknown, row: GeoPromptMetrics) =>
              FUNNEL_TEXT[row.funnelStage] ?? row.funnelStage,
          },
          {
            title: '提及率',
            key: 'mentionRateBp',
            width: 100,
            render: (_v: unknown, row: GeoPromptMetrics) => bp(row.mentionRateBp),
          },
          {
            title: '声量份额',
            key: 'sovBp',
            width: 100,
            render: (_v: unknown, row: GeoPromptMetrics) => bp(row.sovBp),
          },
          {
            title: '平均位次',
            key: 'avgPositionX100',
            width: 100,
            render: (_v: unknown, row: GeoPromptMetrics) => position(row.avgPositionX100),
          },
          { title: '回答数', dataIndex: 'answers', key: 'answers', width: 80 },
        ]}
      />
    </Spin>
  )
}
