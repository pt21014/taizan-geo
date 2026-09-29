import { Form, Input, InputNumber, Select } from 'antd'
import {
  CrudDrawerForm,
  CrudTable,
  dateTimeColumn,
  statusTagColumn,
  textColumn,
  useCrudForm,
  useCrudTable,
} from '@taizan/admin-ui'
import {
  GEO_BRAND_STATUS,
  GEO_REFRESH_FREQ_OPTIONS,
  useGeoBrandApi,
  type GeoBrand,
  type GeoBrandInput,
} from '../../api/geo-brand'
import { GeoBrandCoreFields, GeoEngineCodesField } from './GeoBrandCoreFields'
import { GeoCompetitorDrawer } from './GeoCompetitorDrawer'
import { useDrawerState } from './hooks/useDrawerState'
import { useGeoEngineOptions } from './hooks/useGeoEngineOptions'

/**
 * 监测品牌列表：CrudTable + 编辑抽屉 + 竞品子抽屉。
 *
 * 页面里**没有裸的 `useState` / `useEffect`**（蓝图 §5.2 的 admin-ui 纪律）：
 * 列表与表单状态归 `useCrudTable` / `useCrudForm`，竞品抽屉的开关归
 * `hooks/useDrawerState.ts`——那个文件里写清了为什么视图状态可以留在本地。
 */
export default function GeoBrandListPage() {
  const api = useGeoBrandApi()
  const table = useCrudTable<GeoBrand>({
    list: api.list,
    remove: api.remove,
    rowKey: 'id',
    syncUrl: true,
    searchSchema: [
      { name: 'keyword', label: '品牌/域名' },
      {
        name: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '监测中', value: 'ACTIVE' },
          { label: '已暂停', value: 'PAUSED' },
        ],
      },
    ],
  })

  const form = useCrudForm<GeoBrandInput>({
    get: api.get,
    create: api.create,
    update: api.update,
    onSuccess: table.refresh,
    quotaMessage: '监测品牌数已达套餐上限，去「账单与续费」升一档再来',
  })

  const competitors = useDrawerState<GeoBrand>()
  // 引擎清单来自 `GET /api/admin/geo/engines`（只有平台**已启用**的那几个）。
  // T4 那份写死在前端的常量已经删掉——平台停用一个引擎之后，下拉框里必须
  // 同步消失，否则商家会选中一个跑批时被静默跳过的引擎。
  const engines = useGeoEngineOptions()

  return (
    <>
      <CrudTable<GeoBrand>
        table={table}
        title="监测品牌"
        create={{ label: '新增品牌', perm: 'geo-brand:write', onClick: () => form.openForm() }}
        columns={[
          { title: '品牌', dataIndex: 'name', key: 'name' },
          textColumn({ title: '官网域名', dataIndex: 'domain', width: 200 }),
          {
            title: '引擎',
            key: 'engineCodes',
            width: 200,
            render: (_value: unknown, row: GeoBrand) =>
              row.engineCodes.length === 0 ? '未选' : row.engineCodes.join('、'),
          },
          {
            title: '刷新',
            key: 'refreshFreq',
            width: 120,
            render: (_value: unknown, row: GeoBrand) =>
              `${row.refreshFreq === 'DAILY' ? '每日' : '每周'} × ${row.sampleSize}`,
          },
          statusTagColumn({ title: '状态', dataIndex: 'status', map: GEO_BRAND_STATUS }),
          dateTimeColumn({ title: '创建时间', dataIndex: 'createdAt' }),
        ]}
        actions={[
          {
            key: 'competitors',
            label: '竞品',
            // 用 `list` 而不是 `write`：只看得到列表的人也该能看竞品——
            // 抽屉里的「新增/编辑/删除」各自还有自己的 `perm`，会被 `<Perm>` 藏掉。
            perm: 'geo-brand:list',
            onClick: (row) => competitors.openWith(row),
          },
          {
            key: 'edit',
            label: '编辑',
            perm: 'geo-brand:write',
            onClick: (row) => form.openForm(row.id),
          },
          {
            key: 'del',
            label: '删除',
            perm: 'geo-brand:delete',
            danger: true,
            confirm: (row) =>
              `确定删除「${row.name}」？历史数据会保留，但它从此不再跑批——趋势图会停在今天。`,
            onClick: (row) => void table.removeRow(row),
          },
        ]}
      />

      <CrudDrawerForm form={form} title="监测品牌" width={560}>
        <GeoBrandCoreFields />
        <Form.Item name="locale" label="语言/地区" initialValue="zh-CN">
          <Input placeholder="zh-CN" />
        </Form.Item>
        <Form.Item name="status" label="状态" initialValue="ACTIVE">
          <Select
            options={[
              { label: '监测中', value: 'ACTIVE' },
              { label: '已暂停（不再跑批）', value: 'PAUSED' },
            ]}
          />
        </Form.Item>
        <Form.Item name="refreshFreq" label="刷新频率" initialValue="WEEKLY">
          <Select options={[...GEO_REFRESH_FREQ_OPTIONS]} />
        </Form.Item>
        <Form.Item
          name="sampleSize"
          label="采样次数"
          initialValue={3}
          tooltip="每个问法 × 每个引擎重复问几次。生成式回答有随机性，单次采样的结论不可信"
        >
          <InputNumber min={1} max={10} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="engineCodes"
          label="监测引擎"
          tooltip="选哪些引擎去问。每多一个引擎，一次跑批的查询次数就翻一倍"
        >
          <GeoEngineCodesField engines={engines} />
        </Form.Item>
      </CrudDrawerForm>

      <GeoCompetitorDrawer
        brand={competitors.context}
        open={competitors.open}
        onClose={competitors.close}
      />
    </>
  )
}
