import { Checkbox, Form, InputNumber, Select, Space, Tabs, Tag, Typography } from 'antd'
import { CrudDrawerForm, CrudTable, dateTimeColumn, statusTagColumn, useCrudForm } from '@taizan/admin-ui'
import {
  GEO_ALERT_CHANNELS,
  GEO_ALERT_KIND_TAGS,
  GEO_ALERT_KINDS,
  useGeoAlertApi,
  type GeoAlertEvent,
  type GeoAlertRule,
  type GeoAlertRuleInput,
} from '../../api/geo-alert'
import { useBrandOptions } from './hooks/useBrandOptions'
import { useGeoAlertEventTable } from './hooks/useGeoAlertEventTable'
import { useGeoAlertRuleTable } from './hooks/useGeoAlertRuleTable'

const THRESHOLD_HINT: Record<GeoAlertRule['kind'], string> = {
  VISIBILITY_DROP: '提及率较上周期跌超这么多个基点（100 = 1 个百分点）就报',
  COMPETITOR_OVERTAKE: '任一竞品的声量份额反超本品牌超过这么多基点就报',
  NEGATIVE_MENTION: '当天负面提及达到这个条数就报（这里语义是条数，不是基点）',
}

/**
 * 规则 Tab：CrudTable + 新建/编辑抽屉。拆成独立组件（而不是内联在
 * `GeoAlertRuleListPage` 里）只是为了让 `useGeoAlertRuleTable`/`useCrudForm` 这组
 * hook 调用不必和「触发记录」Tab 的 hook 挤在同一个函数体里——两个 Tab 各自独立
 * 拉数据，装进两个组件比一个大组件里塞两套状态更好读。
 */
function RuleTablePane({ brandId }: { brandId: string | undefined }) {
  const api = useGeoAlertApi()
  const brands = useBrandOptions()
  const table = useGeoAlertRuleTable(brandId)

  const form = useCrudForm<GeoAlertRuleInput>({
    get: async (id) => {
      const row = table.rows.find((r) => r.id === id)
      if (row === undefined) throw new Error('这一行不在当前页里，刷新后再试')
      return {
        brandId: row.brandId,
        kind: row.kind,
        thresholdBp: row.thresholdBp,
        channels: row.channels,
        enabled: row.enabled,
      }
    },
    create: api.createRule,
    // 编辑时 brandId/kind 不提交：换品牌或类型等于换一条规则（活跃唯一按
    // (brandId, kind) 判），后端 UpdateDto 本来就没有这两个字段。
    update: (id, values) => {
      const { brandId: _brandId, kind: _kind, ...rest } = values
      return api.updateRule(id, rest)
    },
    onSuccess: table.refresh,
  })

  return (
    <>
      <CrudTable<GeoAlertRule>
        table={table}
        title="告警规则"
        emptyText="还没有配任何告警规则"
        create={{ label: '新建规则', perm: 'geo-alert:write', onClick: () => form.openForm() }}
        actions={[
          {
            key: 'edit',
            label: '编辑',
            perm: 'geo-alert:write',
            onClick: (row) => form.openForm(row.id),
          },
          {
            key: 'remove',
            label: '删除',
            perm: 'geo-alert:write',
            danger: true,
            confirm: (row) => `确定删除「${GEO_ALERT_KIND_TAGS[row.kind].text}」这条规则吗？`,
            onClick: (row) => table.removeRow(row),
          },
        ]}
        columns={[
          { title: '品牌', dataIndex: 'brandName', key: 'brandName', width: 140 },
          statusTagColumn<GeoAlertRule>({ title: '类型', dataIndex: 'kind', map: GEO_ALERT_KIND_TAGS }),
          { title: '阈值', dataIndex: 'thresholdBp', key: 'thresholdBp', width: 90 },
          {
            title: '通道',
            key: 'channels',
            width: 140,
            render: (_v: unknown, row: GeoAlertRule) => row.channels.join('、'),
          },
          {
            title: '启用',
            key: 'enabled',
            width: 80,
            render: (_v: unknown, row: GeoAlertRule) =>
              row.enabled ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>,
          },
          dateTimeColumn({ title: '上次触发', dataIndex: 'lastFiredAt' }),
        ]}
      />

      <CrudDrawerForm form={form} title="告警规则" width={480}>
        <Form.Item name="brandId" label="品牌" rules={[{ required: true, message: '请选一个品牌' }]}>
          <Select options={brands.options} disabled={form.mode === 'edit'} placeholder="选一个品牌" />
        </Form.Item>
        <Form.Item name="kind" label="类型" rules={[{ required: true, message: '请选类型' }]}>
          <Select
            disabled={form.mode === 'edit'}
            options={GEO_ALERT_KINDS.map((k) => ({ label: GEO_ALERT_KIND_TAGS[k].text, value: k }))}
          />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.kind !== cur.kind}>
          {({ getFieldValue }) => {
            const kind = getFieldValue('kind') as GeoAlertRule['kind'] | undefined
            return (
              <Form.Item
                name="thresholdBp"
                label="阈值"
                initialValue={1000}
                tooltip={kind ? THRESHOLD_HINT[kind] : '先选类型再看提示'}
                rules={[{ required: true, message: '请填阈值' }]}
              >
                <InputNumber min={0} max={10000} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            )
          }}
        </Form.Item>
        <Form.Item name="channels" label="通知通道" initialValue={['INBOX']}>
          <Checkbox.Group options={GEO_ALERT_CHANNELS.map((c) => ({ label: c, value: c }))} />
        </Form.Item>
        <Form.Item name="enabled" label="启用" valuePropName="checked" initialValue={true}>
          <Checkbox />
        </Form.Item>
      </CrudDrawerForm>
    </>
  )
}

/** 触发记录 Tab：纯只读列表，证据用 JSON 摘要展示（形状随 kind 变，见后端 DTO 注释）。 */
function EventTablePane({ brandId }: { brandId: string | undefined }) {
  const table = useGeoAlertEventTable(brandId)

  return (
    <CrudTable<GeoAlertEvent>
      table={table}
      title="触发记录"
      emptyText="还没有触发过任何告警"
      columns={[
        { title: '品牌', dataIndex: 'brandName', key: 'brandName', width: 140 },
        statusTagColumn<GeoAlertEvent>({ title: '类型', dataIndex: 'kind', map: GEO_ALERT_KIND_TAGS }),
        {
          title: '证据',
          key: 'payload',
          ellipsis: true,
          render: (_v: unknown, row: GeoAlertEvent) => (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {JSON.stringify(row.payload)}
            </Typography.Text>
          ),
        },
        {
          title: '通知',
          key: 'notifiedAt',
          width: 90,
          render: (_v: unknown, row: GeoAlertEvent) =>
            row.notifiedAt === null ? <Tag>未发出</Tag> : <Tag color="success">已发出</Tag>,
        },
        dateTimeColumn({ title: '触发时间', dataIndex: 'createdAt' }),
      ]}
    />
  )
}

/**
 * 告警：规则管理（CrudTable + 抽屉）与触发记录（只读 CrudTable）两个 Tab，
 * 共用顶部的品牌筛选（不选 = 看全部品牌，与「监测任务」同一个判据）。
 */
export default function GeoAlertRuleListPage() {
  const brands = useBrandOptions()

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Tabs
        tabBarExtraContent={
          <Select
            style={{ minWidth: 200 }}
            allowClear
            loading={brands.loading}
            value={brands.brandId}
            onChange={brands.setBrandId}
            options={brands.options}
            placeholder="全部品牌"
          />
        }
        items={[
          { key: 'rules', label: '告警规则', children: <RuleTablePane brandId={brands.brandId} /> },
          { key: 'events', label: '触发记录', children: <EventTablePane brandId={brands.brandId} /> },
        ]}
      />
    </Space>
  )
}
