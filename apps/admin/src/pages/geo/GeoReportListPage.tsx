import { Descriptions, Drawer, Empty, Form, Input, Modal, Select, Spin, Table, Tag } from 'antd'
import { CrudTable, dateTimeColumn, statusTagColumn } from '@taizan/admin-ui'
import {
  GEO_REPORT_PERIODS,
  GEO_REPORT_PERIOD_TEXT,
  GEO_REPORT_STATUS_TAGS,
  type GeoReport,
  type GeoReportCitationStat,
  type GeoReportCompetitorStat,
  type GeoReportDetail,
  type GeoReportPayloadV1,
} from '../../api/geo-report'
import { useBrandOptions } from './hooks/useBrandOptions'
import { useGeoReportDetail } from './hooks/useGeoReportDetail'
import { useGeoReportGenerateForm } from './hooks/useGeoReportGenerateForm'
import { useGeoReportTable } from './hooks/useGeoReportTable'

/**
 * 基点转百分比。`sovBp`（声量份额）在分母为 0（这个周期谁都没被提及）时
 * 是 `null`（见 `geo-report.rules.ts` 的 SoV 空语义说明），显示「暂无数据」，
 * 不能硬 `/100` 崩掉，也不能直接拼出 `"null%"` 这种字面量。
 */
const bp = (v: number | null) => (v === null ? '暂无数据' : `${(v / 100).toFixed(2)}%`)

/**
 * 报表：CrudTable（列表，不含 payload）+「生成」Modal 表单 + 详情 Drawer（payload 快照）。
 *
 * 详情渲染只认 `version: 1`（当前唯一存在过的版本）：payload 是历史快照，口径改了
 * 老报告不会跟着变（那正是它存在的理由），未来加 version 2 时这里要按版本分支，
 * 现在先老实报「这份报告的版本我还不认识」而不是硬渲染可能已经变形的字段。
 */
export default function GeoReportListPage() {
  const brands = useBrandOptions()
  const table = useGeoReportTable()
  const detail = useGeoReportDetail()
  const generate = useGeoReportGenerateForm((id) => {
    table.refresh()
    detail.openWith(id)
  })

  return (
    <>
      <CrudTable<GeoReport>
        table={table}
        title="报表"
        emptyText="还没有生成过报表"
        create={{ label: '生成报表', perm: 'geo-report:generate', onClick: generate.openForm }}
        actions={[{ key: 'view', label: '详情', onClick: (row) => detail.openWith(row.id) }]}
        columns={[
          { title: '品牌', dataIndex: 'brandName', key: 'brandName', width: 140 },
          {
            title: '类型',
            key: 'period',
            width: 80,
            render: (_v: unknown, row: GeoReport) => GEO_REPORT_PERIOD_TEXT[row.period],
          },
          { title: '周期', key: 'range', width: 200, render: (_v: unknown, row: GeoReport) => `${row.periodStart} ~ ${row.periodEnd}` },
          statusTagColumn<GeoReport>({ title: '状态', dataIndex: 'status', map: GEO_REPORT_STATUS_TAGS }),
          dateTimeColumn({ title: '生成时间', dataIndex: 'createdAt' }),
        ]}
      />

      <Modal
        title="生成报表"
        open={generate.open}
        onCancel={generate.closeForm}
        confirmLoading={generate.submitting}
        onOk={() => void generate.submit()}
        okText="生成"
      >
        <Form form={generate.antdForm} layout="vertical">
          <Form.Item name="brandId" label="品牌" rules={[{ required: true, message: '请选一个品牌' }]}>
            <Select options={brands.options} loading={brands.loading} />
          </Form.Item>
          <Form.Item name="period" label="周期类型" initialValue="WEEKLY" rules={[{ required: true }]}>
            <Select
              options={GEO_REPORT_PERIODS.map((p) => ({ label: GEO_REPORT_PERIOD_TEXT[p], value: p }))}
            />
          </Form.Item>
          <Form.Item
            name="periodStart"
            label="周期第一天"
            tooltip="WEEKLY 建议传周一，MONTHLY 建议传当月 1 号"
            rules={[
              { required: true, message: '请填周期第一天' },
              { pattern: /^\d{4}-\d{2}-\d{2}$/, message: '格式必须是 YYYY-MM-DD' },
            ]}
          >
            <Input placeholder="2026-09-15" />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title="报表详情" width={760} open={detail.open} onClose={detail.close} destroyOnClose>
        {detail.loading ? (
          <Spin />
        ) : detail.detail === null ? (
          <Empty description="没有取到这份报告" />
        ) : (
          <ReportPayloadView detail={detail.detail} />
        )}
      </Drawer>
    </>
  )
}

/**
 * `payload.engines` 一条的最小切面。真实形状（`buildPayload()` 产出）是**扁平数组**，
 * 不是 `{items: [...]}`——`GeoReportPayloadV1` 没有单独声明这个字段（它是给诊断向导
 * 用的类型，那个页面不展示引擎明细），这里就地声明够渲染用的几列即可。
 */
interface GeoReportEngineStat {
  engineCode: string
  engineName: string
  mentionRateBp: number
}

/**
 * 报表详情 Drawer 的内容。导出是为了能被组件测试直接挂载，不用连带 mock
 * `CrudTable`/`useBrandOptions` 这些跟 payload 渲染无关的依赖。
 *
 * ## 这里渲染的到底是谁的数据
 *
 * 这个 Drawer 由列表页的「详情」按钮打开——而列表页不按 `period` 强制过滤
 * （`useGeoReportTable` 的 `period` 只是可选筛选项），所以这里既会渲染 WEEKLY/MONTHLY
 * 报表，也会渲染 ONE_SHOT（诊断编排产出的那一份）：三者的 `payload`（version 1）
 * 是**同一个 `buildPayload()` 产出的同一种形状**，唯一区别是 ONE_SHOT 的
 * `promptSuggestions`/`contentSuggestions` 可能非空——但那两个字段主要在
 * 「AI 可见度诊断」向导的报告屏（`GeoDiagnosisReportStep.tsx`）里专门展示，这里不重复做。
 */
export function ReportPayloadView({ detail }: { detail: GeoReportDetail }) {
  const { payload } = detail

  if (payload.version !== 1) {
    return (
      <>
        <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
          <Descriptions.Item label="品牌">{detail.brandName}</Descriptions.Item>
          <Descriptions.Item label="周期">
            {detail.periodStart} ~ {detail.periodEnd}
          </Descriptions.Item>
        </Descriptions>
        <Empty description={`这份报告的 payload version=${payload.version}，还没有对应的渲染器，先看原始 JSON`} />
        <pre style={{ maxHeight: 400, overflow: 'auto', background: 'rgba(0,0,0,0.03)', padding: 12 }}>
          {JSON.stringify(payload, null, 2)}
        </pre>
      </>
    )
  }

  // `payload.overview` 是扁平对象（`answers`/`mentionRateBp`/`sovBp`/... 直接是它的字段），
  // 不是 `{current, delta}` 这种嵌套形状——对齐 `geo-report.service.ts` 的 `buildPayload()`。
  const v1 = payload as GeoReportPayloadV1
  const overview = v1.overview
  // `engines`/`competitors`/`topCitations` 同理，都是扁平数组，不是 `{items: [...]}`。
  // `competitors`/`topCitations` 在 `geo.monitor` 闸门没放行时整体是 `null`（不是空数组），
  // 用 `?? []` 落到「按空表渲染」，不会在这里再去猜「是不是应该显示解锁提示」——
  // 那是诊断向导报告屏的职责（见上面文件头说明），这个通用报表列表页只保证不崩。
  const engines = (payload.engines as GeoReportEngineStat[] | undefined) ?? []
  const competitors = v1.competitors ?? []
  const topCitations = v1.topCitations ?? []

  return (
    <>
      <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="品牌">{detail.brandName}</Descriptions.Item>
        <Descriptions.Item label="周期">
          {detail.periodStart} ~ {detail.periodEnd}
        </Descriptions.Item>
        <Descriptions.Item label="生成时间">{payload.generatedAt}</Descriptions.Item>
        <Descriptions.Item label="提及率">{bp(overview.mentionRateBp)}</Descriptions.Item>
        <Descriptions.Item label="声量份额">{bp(overview.sovBp)}</Descriptions.Item>
        <Descriptions.Item label="引用率">{bp(overview.citationRateBp)}</Descriptions.Item>
      </Descriptions>

      {engines.length > 0 && (
        <Table<GeoReportEngineStat>
          size="small"
          rowKey="engineCode"
          pagination={false}
          dataSource={engines}
          style={{ marginBottom: 16 }}
          title={() => '引擎对比'}
          columns={[
            { title: '引擎', dataIndex: 'engineName', key: 'engineName' },
            {
              title: '提及率',
              key: 'mentionRateBp',
              render: (_v: unknown, row: GeoReportEngineStat) => bp(row.mentionRateBp),
            },
          ]}
        />
      )}

      {competitors.length > 0 && (
        <Table<GeoReportCompetitorStat>
          size="small"
          rowKey={(row) => row.competitorId || '__brand__'}
          pagination={false}
          dataSource={competitors}
          style={{ marginBottom: 16 }}
          title={() => '竞品对比'}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              key: 'name',
              render: (v: string, row: GeoReportCompetitorStat) =>
                row.isBrand ? <Tag color="blue">{v}（本品牌）</Tag> : v,
            },
            {
              title: '声量份额',
              key: 'sovBp',
              render: (_v: unknown, row: GeoReportCompetitorStat) => bp(row.sovBp),
            },
          ]}
        />
      )}

      {topCitations.length > 0 && (
        <Table<GeoReportCitationStat>
          size="small"
          rowKey="domain"
          pagination={false}
          dataSource={topCitations}
          title={() => '引用来源 Top'}
          columns={[
            { title: '域名', dataIndex: 'domain', key: 'domain' },
            { title: '次数', dataIndex: 'count', key: 'count' },
          ]}
        />
      )}
    </>
  )
}
