import { Button, Popconfirm, Progress, Select, Space, Tooltip, Typography, message } from 'antd'
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import {
  CrudTable,
  Perm,
  dateTimeColumn,
  enumColumn,
  statusTagColumn,
} from '@taizan/admin-ui'
import {
  GEO_RUN_STATUS,
  GEO_RUN_TRIGGER_TEXT,
  useGeoRunApi,
  type GeoRun,
} from '../../api/geo-run'
import { useBrandOptions } from './hooks/useBrandOptions'
import { useGeoRunTable } from './hooks/useGeoRunTable'
import { useSubmitState } from './hooks/useSubmitState'

/**
 * 「监测任务」列表：顶部品牌选择器 + 只读 CrudTable + 「立即刷新」按钮。
 *
 * ## 这一页是 T6 的**占位页**
 *
 * 它证明的是接线通了：菜单 → componentKey → 路由 → 接口 → 权限点。
 * T8 会把它做成设计文档 §6.1 里那个带进度列与引擎分布的样子。
 *
 * ## 为什么没有「编辑」「删除」
 *
 * 一次跑批是一条历史记录，`totalCostCents` 是对账依据。改它等于改账，删它等于
 * 让这个月的用量对不上。要重跑就再触发一次——那会建一条新的，两条都留着。
 *
 * ## 「立即刷新」为什么要二次确认
 *
 * 它是这个后台里唯一一个**按一下就花钱**的按钮：一次等于
 * `问法数 × 引擎数 × 采样数` 次真实的引擎调用，直接扣本月的查询配额。
 * 不确认的话，误点一下就是几十次查询，而且撤不回来。
 *
 * 页面里**没有裸的 `useState` / `useEffect`**（蓝图 §5.2 的 admin-ui 纪律）：
 * 品牌清单归 `hooks/useBrandOptions.ts`，表格归 `hooks/useGeoRunTable.ts`，
 * 提交中状态归 `hooks/useSubmitState.ts`。
 */
export default function GeoRunListPage() {
  const api = useGeoRunApi()
  const brands = useBrandOptions()
  const table = useGeoRunTable(brands.brandId)
  const trigger = useSubmitState()

  const handleTrigger = async () => {
    if (brands.brandId === undefined) {
      message.warning('先选一个品牌')
      return
    }
    await trigger.run(async () => {
      const run = await api.trigger({ brandId: brands.brandId as string })
      message.success(`已提交，共 ${run.totalQueries || '若干'} 条查询在后台排队`)
      table.refresh()
    })
  }

  return (
    <CrudTable<GeoRun>
      table={table}
      title="监测任务"
      emptyText={
        brands.loading
          ? '加载中…'
          : brands.options.length === 0
            ? '这家店还没有监测品牌。先去「品牌管理」建一个。'
            : '还没有跑过。点「立即刷新」手动跑一次，或者等每天凌晨的自动任务。'
      }
      toolbar={
        <Space>
          {/* 品牌选择器放工具栏而不是搜索表单：它会被「重置」清空，而这一页
              不带品牌也查得出来（全店的跑批），清空之后的表现应该是「看全部」，
              放进搜索表单会让这个语义变得含混。 */}
          <Select
            style={{ minWidth: 200 }}
            allowClear
            loading={brands.loading}
            value={brands.brandId}
            onChange={brands.setBrandId}
            options={brands.options}
            placeholder="全部品牌"
          />
          <Button icon={<ReloadOutlined />} onClick={table.refresh}>
            刷新列表
          </Button>
          <Perm code="geo-run:trigger">
            <Popconfirm
              title="现在跑一次？"
              description="会真的去问一次 AI，按「问法 × 引擎 × 采样」扣本月查询配额，撤不回来。"
              okText="跑"
              cancelText="再想想"
              onConfirm={() => void handleTrigger()}
            >
              <Button type="primary" icon={<ThunderboltOutlined />} loading={trigger.submitting}>
                立即刷新
              </Button>
            </Popconfirm>
          </Perm>
        </Space>
      }
      columns={[
        {
          title: '进度',
          key: 'progress',
          width: 160,
          render: (_value: unknown, row: GeoRun) => {
            const total = row.totalQueries
            const done = row.doneQueries + row.failedQueries
            return (
              <Progress
                percent={total === 0 ? 0 : Math.round((done / total) * 100)}
                size="small"
                status={row.status === 'FAILED' ? 'exception' : undefined}
                format={() => `${done}/${total}`}
              />
            )
          },
        },
        statusTagColumn({ title: '状态', dataIndex: 'status', map: GEO_RUN_STATUS }),
        enumColumn({
          title: '触发',
          dataIndex: 'triggeredBy',
          map: GEO_RUN_TRIGGER_TEXT,
          width: 80,
        }),
        {
          title: '引擎',
          key: 'engineCodes',
          width: 180,
          render: (_value: unknown, row: GeoRun) =>
            row.engineCodes.length === 0 ? '-' : row.engineCodes.join('、'),
        },
        { title: '采样', dataIndex: 'sampleSize', key: 'sampleSize', width: 70 },
        {
          title: '失败',
          key: 'failedQueries',
          width: 140,
          render: (_value: unknown, row: GeoRun) =>
            row.failedQueries === 0 ? (
              '0'
            ) : (
              // 失败分布直接显示出来：运营要判断的是「是不是密钥过期了」，
              // 而 `{"AUTH": 6}` 一眼就回答了这个问题。
              <Tooltip title={JSON.stringify(row.errorSummary ?? {})}>
                <Typography.Text type="warning">
                  {row.failedQueries} 条
                  {row.errorSummary ? `（${Object.keys(row.errorSummary).join('、')}）` : ''}
                </Typography.Text>
              </Tooltip>
            ),
        },
        {
          title: '成本',
          key: 'totalCostCents',
          width: 90,
          render: (_value: unknown, row: GeoRun) => `¥${(row.totalCostCents / 100).toFixed(2)}`,
        },
        dateTimeColumn({ title: '触发时间', dataIndex: 'createdAt' }),
      ]}
    />
  )
}
