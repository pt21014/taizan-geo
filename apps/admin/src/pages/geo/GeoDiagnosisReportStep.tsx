import { Button, Card, Col, Empty, Row, Spin, Statistic, Table, Tag, Typography } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'
import type {
  GeoReportCitationStat,
  GeoReportCompetitorStat,
  GeoReportPayloadV1,
} from '../../api/geo-report'
import { useGeoDiagnosisReport } from './hooks/useGeoDiagnosisReport'

/** {@link GeoDiagnosisReportStep} 的入参。 */
export interface GeoDiagnosisReportStepProps {
  reportId: string
  /** 「再诊断一个品牌」，回到入口屏。 */
  onRestart: () => void
}

const bp = (v: number) => `${(v / 100).toFixed(2)}%`
const sentiment = (v: number) => (v / 100).toFixed(1)

/**
 * 「AI可见度诊断」向导 · 屏 4/5：诊断报告——免费摘要 + 按 `geo.monitor` 闸门决定
 * 付费部分是「完整内容」还是「解锁提示」。
 *
 * ## 门禁完全以接口返回为准，不在前端维护「是否付费」的假状态
 *
 * `payload.competitors`/`topCitations`/`promptSuggestions`/`contentSuggestions` 这四个
 * 字段，后端在 `geo.monitor` 功能闸门没放行时整体返回 `null`（见
 * `geo-report.service.ts` 的 `gatePayload`），放行时是真实数组——这里只判"是不是
 * `null`"，没有第二个判断入口。
 *
 * ## 为什么锁定态不像设计稿那样「模糊的表格背景」
 *
 * `designs/geo-diagnosis-flow/screen-report.jsx` 的锁定态是在真实数据上加一层遮罩
 * （商家能隐约看到自己的表格轮廓）。但闸门没放行时后端给的是 `null`，不是"数据在
 * 但脱敏了"——前端手上没有任何东西可以拿来模糊，硬造几行假表格去模糊会正好撞上
 * "看起来能用但实际是假数据硬编码"（任务书明确要避免的反面）。所以锁定态改成一张
 * 说明卡片：告诉商家解锁之后能看到什么，而不是伪造一份看起来真实的预览。
 */
export default function GeoDiagnosisReportStep({ reportId, onRestart }: GeoDiagnosisReportStepProps) {
  const { report, loading } = useGeoDiagnosisReport(reportId)

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    )
  }

  if (report === null) {
    return (
      <Card>
        <Empty description="没有取到这份诊断报告，刷新页面重试" />
      </Card>
    )
  }

  if (report.payload.version !== 1) {
    return (
      <Card>
        <Empty
          description={`这份报告的 payload version=${report.payload.version}，还没有对应的渲染器`}
        />
      </Card>
    )
  }

  const payload = report.payload as GeoReportPayloadV1
  const { overview } = payload
  const unlocked = payload.competitors !== null

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            {report.brandName} · AI 可见度诊断报告
          </Typography.Title>
          <Typography.Text type="secondary">
            诊断时间：{payload.generatedAt.slice(0, 16).replace('T', ' ')} · 基于 {overview.answers} 次真实问答
          </Typography.Text>
        </div>
        <Tag color={unlocked ? 'success' : 'default'}>{unlocked ? '已解锁完整版' : '免费摘要版'}</Tag>
      </div>

      <Row gutter={16} style={{ margin: '16px 0' }}>
        <Col span={8}>
          <Card size="small">
            <Statistic title="品牌提及率" value={bp(overview.mentionRateBp)} />
            <Typography.Text type="secondary">这次诊断的 {overview.answers} 次问答里被提到的占比</Typography.Text>
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic title="首位推荐率" value={bp(overview.top1RateBp)} />
            <Typography.Text type="secondary">AI 把本品牌列为第一顺位提及的占比</Typography.Text>
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic title="情感倾向" value={sentiment(overview.sentimentAvgX100)} />
            <Typography.Text type="secondary">均分，正数偏正面、负数偏负面（-100 ~ 100）</Typography.Text>
          </Card>
        </Col>
      </Row>

      {unlocked ? (
        <GeoDiagnosisReportDetail payload={payload} />
      ) : (
        <Card>
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <LockOutlined style={{ fontSize: 32, color: 'var(--ant-color-text-tertiary, #999)' }} />
            <Typography.Title level={4} style={{ marginTop: 12 }}>
              解锁完整诊断报告
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ maxWidth: 480, margin: '0 auto 16px' }}>
              升级到「AI 可见度监测」后可以看到：逐条竞品对比（Share of Voice）、AI 回答实际引用的信息来源、
              AI 推荐的下一批测试问法，以及基于这次诊断真实数据生成的内容优化建议。
            </Typography.Paragraph>
            <Link to="/billing">
              <Button type="primary" size="large">
                去升级套餐
              </Button>
            </Link>
          </div>
        </Card>
      )}

      <div style={{ textAlign: 'center', marginTop: 24 }}>
        <Button onClick={onRestart}>再诊断一个品牌</Button>
      </div>
    </div>
  )
}

function GeoDiagnosisReportDetail({ payload }: { payload: GeoReportPayloadV1 }) {
  const competitors = payload.competitors ?? []
  const topCitations = payload.topCitations ?? []
  const promptSuggestions = payload.promptSuggestions ?? []
  const contentSuggestions = payload.contentSuggestions ?? []

  return (
    <>
      <Card title="竞品对比" size="small" style={{ marginBottom: 16 }}>
        <Table<GeoReportCompetitorStat>
          size="small"
          rowKey={(row) => row.competitorId || '__brand__'}
          pagination={false}
          dataSource={competitors}
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
              title: '声量份额',
              key: 'sovBp',
              width: 100,
              render: (_v: unknown, row) => (row.sovBp === null ? '暂无数据' : bp(row.sovBp)),
            },
          ]}
        />
      </Card>

      <Card title="引用来源" size="small" style={{ marginBottom: 16 }}>
        <Table<GeoReportCitationStat>
          size="small"
          rowKey="domain"
          pagination={false}
          dataSource={topCitations}
          locale={{ emptyText: '这次诊断没有抓到带引用来源的回答' }}
          columns={[
            { title: '域名', dataIndex: 'domain', key: 'domain' },
            { title: '类别', dataIndex: 'category', key: 'category', width: 100 },
            { title: '被引用次数', dataIndex: 'count', key: 'count', width: 100 },
          ]}
        />
      </Card>

      <Card title="内容优化建议" size="small" style={{ marginBottom: 16 }}>
        {contentSuggestions.length === 0 ? (
          <Empty description="暂无建议" />
        ) : (
          contentSuggestions.map((s, i) => (
            <div key={`${s.kind}-${i}`} style={{ marginBottom: 12 }}>
              <Typography.Text strong>
                {i + 1}. {s.title}
              </Typography.Text>
              <div>
                <Typography.Text type="secondary">{s.detail}</Typography.Text>
              </div>
            </div>
          ))
        )}
      </Card>

      <Card title="AI 推荐的测试问法" size="small">
        {promptSuggestions.length === 0 ? (
          <Empty description="这次诊断复用了已有问法，没有新生成的问法" />
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {promptSuggestions.map((p, i) => (
              <li key={i}>{p.text}</li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
