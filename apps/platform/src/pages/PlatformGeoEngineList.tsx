import { useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd'
import {
  CrudDrawerForm,
  CrudTable,
  moneyColumn,
  statusTagColumn,
  useCrudForm,
  useCrudTable,
} from '@taizan/admin-ui'
import {
  GEO_ACCESS_TYPES,
  GEO_ACCESS_TYPE_TAGS,
  useGeoEngineApi,
  type CreateGeoEngineInput,
  type GeoEngineTestResult,
  type GeoEngineView,
} from '../api/geo-engine'

/**
 * 造一对空的键值输入行。
 *
 * `id` 只用来当 React key，不会提交给后端——所以用一个自增计数器就够了，
 * 不必拉 `crypto.randomUUID`（那在非 https 的本地开发环境上不一定有）。
 */
let pairSeq = 0
function newPair(): { id: string; key: string; value: string } {
  pairSeq += 1
  return { id: `pair-${pairSeq}`, key: '', value: '' }
}

/**
 * 平台侧的「GEO 引擎」管理页。
 *
 * ## 三个抽屉/弹窗，各管一件事
 *
 * | 入口 | 形态 | 为什么不合并 |
 * |---|---|---|
 * | 新建 / 编辑 | `CrudDrawerForm` | 配置项（名称、模型、单价、限速）是**可以回显**的 |
 * | 密钥 | 独立 `Drawer` | 凭据**不回显明文**，表单语义完全不同：打开时是空的，提交等于整包替换 |
 * | 测试 | `Modal` | 一次性的诊断结果，没有"编辑"语义 |
 *
 * 把密钥塞进编辑表单的代价很实际：那个表单是"回填 → 改一两个字段 → 提交全量"，
 * 而凭据字段回填不了（后端只给脱敏值）。混在一起的结果必然是某天有人改了排序，
 * 顺手把 `sk-***abc` 这个**脱敏串**当成明文提交了回去，于是真密钥被一串星号覆盖。
 *
 * ## 为什么这个页面里有 `useState`
 *
 * admin-ui 的纪律（"页面里不出现 useState/useEffect"）针对的是**数据获取与业务
 * 状态**。这里的三处 `useState` 全是视图状态（哪个抽屉开着、正在测哪一行、
 * 测出来的结果是什么），没有第二个真源可漂。`apps/platform` 的既有页面
 * （`PlatformPlanList` 的排序弹窗、`PlatformTenantList`）是同一种写法。
 */
export default function PlatformGeoEngineList() {
  const api = useGeoEngineApi()

  /** 正在编辑密钥的那一行；`null` = 密钥抽屉关着。 */
  const [credentialTarget, setCredentialTarget] = useState<GeoEngineView | null>(null)
  /**
   * 密钥抽屉里那组键值对（明文只在这里活到提交为止）。
   *
   * 每一对带一个 `id`：这组输入框可增可删，而「键名」本身会在用户敲字的过程中
   * 反复变。拿键名或数组下标当 React key 的话，删掉中间一行会让后面所有行的
   * key 全部错位，表现是输入框里的内容串到了别的行上。
   */
  const [credentialPairs, setCredentialPairs] = useState<
    { id: string; key: string; value: string }[]
  >([])
  /** 测试结果弹窗：`null` = 关着，`'pending'` = 正在测。 */
  const [testState, setTestState] = useState<
    { engine: GeoEngineView; result: GeoEngineTestResult | 'pending' } | null
  >(null)

  const table = useCrudTable<GeoEngineView>({
    list: api.list,
    rowKey: 'id',
    syncUrl: true,
    searchSchema: [
      { name: 'keyword', label: 'code/名称/厂商' },
      {
        name: 'enabled',
        label: '状态',
        type: 'select',
        options: [
          { label: '已启用', value: 'true' },
          { label: '已停用', value: 'false' },
        ],
      },
    ],
  })

  const form = useCrudForm<CreateGeoEngineInput>({
    // `GeoEngineView` 比表单类型宽（多了 id/enabled/masked/时间戳，且 `baseUrl` 是
    // `string | null` 而表单里是 `string | undefined`）。这里显式挑出表单认识的那几个
    // 字段，而不是把整行强转过去——强转的话，某天给 view 加一个字段就会悄悄
    // 进到表单的提交体里。
    get: async (id) => {
      const row = await api.get(id)
      return {
        code: row.code,
        name: row.name,
        vendor: row.vendor,
        accessType: row.accessType,
        model: row.model,
        baseUrl: row.baseUrl ?? undefined,
        pricePerQueryCents: row.pricePerQueryCents,
        priceInPerMTokenCents: row.priceInPerMTokenCents,
        priceOutPerMTokenCents: row.priceOutPerMTokenCents,
        rateLimitPerMin: row.rateLimitPerMin,
        timeoutMs: row.timeoutMs,
        sort: row.sort,
      }
    },
    create: api.create,
    // 编辑时 `code` 与 `enabled` 不提交：前者建后不可改（后端会直接拒），
    // 后者走行内的开关。这里把它们剔掉而不是让后端忽略——后端**拒绝**改 code，
    // 不忽略，带上去会变成一条 400。
    update: (id, values) => {
      const { code: _code, enabled: _enabled, ...rest } = values
      return api.update(id, rest)
    },
    onSuccess: table.refresh,
  })

  const openCredentials = (row: GeoEngineView) => {
    setCredentialTarget(row)
    // **刻意从空开始**：后端不回显明文，把 masked 值填进输入框会让人以为那是
    // 可提交的内容。参照值在抽屉顶部的 Descriptions 里只读地显示。
    setCredentialPairs([newPair()])
  }

  const submitCredentials = async () => {
    if (!credentialTarget) return
    const credentials: Record<string, string> = {}
    for (const pair of credentialPairs) {
      const key = pair.key.trim()
      if (key === '') continue
      credentials[key] = pair.value
    }
    await api.updateCredentials(credentialTarget.id, credentials)
    setCredentialTarget(null)
    table.refresh()
  }

  const runTest = async (row: GeoEngineView) => {
    setTestState({ engine: row, result: 'pending' })
    try {
      const result = await api.test(row.id)
      setTestState({ engine: row, result })
    } catch (error) {
      // 接口层失败（引擎不存在、registry 里没有这个 code）不是"没测通"，
      // 是一次真的请求错误。包成同一种形状显示，省得弹两种不同的东西。
      setTestState({
        engine: row,
        result: {
          ok: false,
          latencyMs: 0,
          preview: '',
          citationCount: 0,
          error: error instanceof Error ? error.message : String(error),
          errorKind: null,
          model: row.model,
        },
      })
    }
  }

  return (
    <>
      <CrudTable<GeoEngineView>
        table={table}
        title="GEO 引擎"
        emptyText="还没有接入任何引擎。新建之后先配密钥、点一次「测试」，再打开启用开关。"
        create={{ label: '接入新引擎', onClick: () => form.openForm() }}
        columns={[
          { title: 'code', dataIndex: 'code', key: 'code', width: 120 },
          { title: '名称', dataIndex: 'name', key: 'name' },
          { title: '厂商', dataIndex: 'vendor', key: 'vendor', width: 110 },
          statusTagColumn<GeoEngineView>({
            title: '接入方式',
            dataIndex: 'accessType',
            map: GEO_ACCESS_TYPE_TAGS,
          }),
          {
            title: '启用',
            key: 'enabled',
            width: 90,
            render: (_value: unknown, row: GeoEngineView) => (
              <Switch
                size="small"
                checked={row.enabled}
                onChange={(next) => void api.setEnabled(row.id, next).then(table.refresh)}
              />
            ),
          },
          {
            title: '密钥',
            key: 'hasCredentials',
            width: 90,
            render: (_value: unknown, row: GeoEngineView) =>
              row.hasCredentials ? <Tag color="success">已配</Tag> : <Tag>未配</Tag>,
          },
          moneyColumn<GeoEngineView>({ title: '按次单价', dataIndex: 'pricePerQueryCents' }),
          {
            title: '限速',
            key: 'rateLimitPerMin',
            width: 110,
            render: (_value: unknown, row: GeoEngineView) => `${row.rateLimitPerMin} 次/分`,
          },
        ]}
        actionsWidth={220}
        actions={[
          { key: 'edit', label: '编辑', onClick: (row) => form.openForm(row.id) },
          { key: 'cred', label: '密钥', onClick: (row) => openCredentials(row) },
          { key: 'test', label: '测试', onClick: (row) => void runTest(row) },
        ]}
      />

      {/* ── 新建 / 编辑 ─────────────────────────────────────────────── */}
      <CrudDrawerForm form={form} title="引擎" width={560}>
        <Form.Item
          name="code"
          label="code"
          tooltip="建后不可改：历史查询结果按 code 存快照，改了会指向一个不存在的引擎"
          rules={[
            { required: true, message: '请填 code' },
            {
              pattern: /^[a-z][a-z0-9-]{1,31}$/,
              message: '小写字母开头，之后是 1–31 个小写字母/数字/连字符',
            },
          ]}
        >
          <Input placeholder="如 qwen、baidu-ernie" disabled={form.id !== null} />
        </Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请填名称' }]}>
          <Input placeholder="如：通义千问" />
        </Form.Item>
        <Form.Item name="vendor" label="厂商" rules={[{ required: true, message: '请填厂商' }]}>
          <Input placeholder="如：aliyun" />
        </Form.Item>
        <Form.Item name="accessType" label="接入方式" initialValue="API">
          <Select
            options={GEO_ACCESS_TYPES.map((t) => ({
              label: GEO_ACCESS_TYPE_TAGS[t].text,
              value: t,
            }))}
          />
        </Form.Item>
        <Form.Item name="model" label="默认模型名" tooltip="落到每条查询结果上做快照">
          <Input placeholder="如：qwen-plus" />
        </Form.Item>
        <Form.Item name="baseUrl" label="接口地址" tooltip="留空则用适配器内置的默认地址">
          <Input placeholder="https://..." />
        </Form.Item>
        <Form.Item name="pricePerQueryCents" label="按次单价（分/次）" initialValue={0}>
          <InputNumber min={0} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="priceInPerMTokenCents"
          label="输入单价（分 / 百万 token）"
          initialValue={0}
        >
          <InputNumber min={0} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="priceOutPerMTokenCents"
          label="输出单价（分 / 百万 token）"
          initialValue={0}
        >
          <InputNumber min={0} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="rateLimitPerMin"
          label="限速（次/分钟）"
          tooltip="平台级，不是每租户；跑批按它排队"
          initialValue={60}
        >
          <InputNumber min={1} max={600} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="timeoutMs" label="单次超时（毫秒）" initialValue={60000}>
          <InputNumber min={1000} max={120000} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="sort" label="展示排序" initialValue={0}>
          <InputNumber precision={0} style={{ width: '100%' }} />
        </Form.Item>
      </CrudDrawerForm>

      {/* ── 密钥 ────────────────────────────────────────────────────── */}
      <Drawer
        title={`密钥 · ${credentialTarget?.name ?? ''}`}
        width={560}
        open={credentialTarget !== null}
        onClose={() => setCredentialTarget(null)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setCredentialTarget(null)}>取消</Button>
            <Button type="primary" onClick={() => void submitCredentials()}>
              保存
            </Button>
          </Space>
        }
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="整包替换，不是合并"
          description="保存之后，库里的凭据就是下面这几对。没填的键会被删掉；全部留空 = 清空凭据。明文不会回显，保存后这个表单再打开还是空的。"
        />

        {credentialTarget !== null && (
          <Descriptions
            size="small"
            column={1}
            bordered
            style={{ marginBottom: 16 }}
            title="当前库里的（脱敏）"
          >
            {Object.keys(credentialTarget.credentialMasked).length === 0 ? (
              <Descriptions.Item label="（空）">还没有配过凭据</Descriptions.Item>
            ) : (
              Object.entries(credentialTarget.credentialMasked).map(([key, masked]) => (
                <Descriptions.Item key={key} label={key}>
                  <Typography.Text code>{masked}</Typography.Text>
                </Descriptions.Item>
              ))
            )}
          </Descriptions>
        )}

        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {credentialPairs.map((pair) => (
            <Space key={pair.id} align="start" style={{ width: '100%' }}>
              <Input
                placeholder="键名，如 apiKey"
                value={pair.key}
                style={{ width: 180 }}
                onChange={(e) =>
                  setCredentialPairs((prev) =>
                    prev.map((p) => (p.id === pair.id ? { ...p, key: e.target.value } : p)),
                  )
                }
              />
              <Input.Password
                placeholder="值（明文，只在这次提交里出现）"
                value={pair.value}
                style={{ width: 240 }}
                onChange={(e) =>
                  setCredentialPairs((prev) =>
                    prev.map((p) => (p.id === pair.id ? { ...p, value: e.target.value } : p)),
                  )
                }
              />
              <Button
                danger
                onClick={() => setCredentialPairs((prev) => prev.filter((p) => p.id !== pair.id))}
              >
                删除
              </Button>
            </Space>
          ))}
          <Button
            type="dashed"
            block
            onClick={() => setCredentialPairs((prev) => [...prev, newPair()])}
          >
            + 加一对
          </Button>
        </Space>
      </Drawer>

      {/* ── 测试结果 ────────────────────────────────────────────────── */}
      <Modal
        title={`测试 · ${testState?.engine.name ?? ''}`}
        open={testState !== null}
        onCancel={() => setTestState(null)}
        onOk={() => setTestState(null)}
        okText="知道了"
        cancelButtonProps={{ style: { display: 'none' } }}
        confirmLoading={testState?.result === 'pending'}
      >
        {testState?.result === 'pending' ? (
          <Typography.Text type="secondary">
            正在用当前配置真的问一次，最长等 {testState.engine.timeoutMs / 1000} 秒…
          </Typography.Text>
        ) : testState !== null ? (
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="结果">
              {testState.result.ok ? (
                <Tag color="success">通了</Tag>
              ) : (
                <Tag color="error">没通{testState.result.errorKind ? `（${testState.result.errorKind}）` : ''}</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="耗时">{testState.result.latencyMs} ms</Descriptions.Item>
            <Descriptions.Item label="模型">{testState.result.model || '—'}</Descriptions.Item>
            <Descriptions.Item label="引用条数">
              {testState.result.citationCount}
              {testState.result.ok && testState.result.citationCount === 0 ? (
                <Typography.Text type="warning" style={{ marginLeft: 8 }}>
                  回答里一条引用都没有——这家引擎的联网开关可能没打开
                </Typography.Text>
              ) : null}
            </Descriptions.Item>
            <Descriptions.Item label={testState.result.ok ? '回答开头' : '失败原因'}>
              <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                {testState.result.ok ? testState.result.preview : testState.result.error}
              </Typography.Paragraph>
            </Descriptions.Item>
          </Descriptions>
        ) : null}
      </Modal>
    </>
  )
}
