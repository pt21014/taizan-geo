import { useState } from 'react'
import { Alert, Button, Descriptions, Drawer, Input, Select, Space, Tag, Typography } from 'antd'
import { CrudTable, dateTimeColumn } from '@taizan/admin-ui'
import {
  useGeoEngineCredentialApi,
  type GeoEngineCredential,
} from '../../api/geo-engine-credential'
import { useGeoEngineOptions } from './hooks/useGeoEngineOptions'
import { useGeoEngineCredentialTable } from './hooks/useGeoEngineCredentialTable'

/**
 * 造一对空的键值输入行。`id` 只当 React key，不提交给后端。
 * 与 `apps/platform` 的 `PlatformGeoEngineList` 同一份写法（那个页面文件头有更完整的说明）。
 */
let pairSeq = 0
function newPair(): { id: string; key: string; value: string } {
  pairSeq += 1
  return { id: `pair-${pairSeq}`, key: '', value: '' }
}

type DrawerState =
  | { mode: 'create' }
  | { mode: 'rotate'; row: GeoEngineCredential }
  | null

/**
 * 商家自助配置专属查询引擎密钥。
 *
 * 与平台侧「GEO 引擎」管理页同一条设计（`PlatformGeoEngineList.tsx` 文件头）：
 * 密钥**不进** `CrudDrawerForm` 那种"回填 → 改字段 → 提交全量"的表单，因为凭据
 * 回填不了（后端只给脱敏值）——新建（选引擎 + 填密钥）与换密钥（只填密钥）
 * 各自一个独立 `Drawer`，提交即整包替换。
 *
 * 跑批时这把密钥优先于平台共享密钥生效（见后端 `geo-query-execute.handler.ts`
 * 的 `pickCredentials`），用它跑出来的查询平台侧成本记 0——这两句话直接写进了
 * 页面顶部的提示条，不指望商家去翻文档才搞懂这个开关的含义。
 */
export default function GeoEngineCredentialListPage() {
  const api = useGeoEngineCredentialApi()
  const table = useGeoEngineCredentialTable()
  const engines = useGeoEngineOptions()

  const [drawer, setDrawer] = useState<DrawerState>(null)
  const [engineCode, setEngineCode] = useState<string | undefined>(undefined)
  const [pairs, setPairs] = useState<{ id: string; key: string; value: string }[]>([])

  const openCreate = () => {
    setDrawer({ mode: 'create' })
    setEngineCode(undefined)
    setPairs([newPair()])
  }
  const openRotate = (row: GeoEngineCredential) => {
    setDrawer({ mode: 'rotate', row })
    setEngineCode(row.engineCode)
    setPairs([newPair()])
  }
  const close = () => setDrawer(null)

  const submit = async () => {
    if (!drawer) return
    const credentials: Record<string, string> = {}
    for (const pair of pairs) {
      const key = pair.key.trim()
      if (key === '' || pair.value === '') continue
      credentials[key] = pair.value
    }
    if (drawer.mode === 'create') {
      if (!engineCode) return
      await api.create({ engineCode, credentials })
    } else {
      await api.update(drawer.row.id, { credentials })
    }
    close()
    table.refresh()
  }

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="用自己的账号，还是平台的账号"
        description="这里配的密钥只对当前这家店生效，跑批时会优先用它（而不是平台共享的密钥）；用它跑出来的查询不计入平台成本，但依然占用套餐里「可启用引擎数」的配额——没在这里配的引擎，照常走平台共享密钥、正常计费。"
      />

      <CrudTable<GeoEngineCredential>
        table={table}
        title="专属引擎密钥"
        emptyText="还没有配任何专属密钥，跑批时用的都是平台共享密钥"
        create={{ label: '新建密钥', perm: 'geo-engine-credential:manage', onClick: openCreate }}
        actions={[
          {
            key: 'rotate',
            label: '换密钥',
            perm: 'geo-engine-credential:manage',
            onClick: openRotate,
          },
          {
            key: 'disable',
            label: '停用',
            perm: 'geo-engine-credential:manage',
            hidden: (row) => !row.enabled,
            onClick: async (row) => {
              await api.setEnabled(row.id, false)
              table.refresh()
            },
          },
          {
            key: 'enable',
            label: '启用',
            perm: 'geo-engine-credential:manage',
            hidden: (row) => row.enabled,
            onClick: async (row) => {
              await api.setEnabled(row.id, true)
              table.refresh()
            },
          },
          {
            key: 'remove',
            label: '删除',
            perm: 'geo-engine-credential:manage',
            danger: true,
            confirm: (row) => `确定删除引擎「${row.engineName || row.engineCode}」的专属密钥吗？删除后这个引擎会改用平台共享密钥。`,
            onClick: (row) => table.removeRow(row),
          },
        ]}
        columns={[
          { title: '引擎', key: 'engineName', width: 160, render: (_v, row) => row.engineName || row.engineCode },
          {
            title: '状态',
            key: 'enabled',
            width: 90,
            render: (_v, row) => (row.enabled ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>),
          },
          {
            title: '密钥',
            key: 'hasCredentials',
            width: 90,
            render: (_v, row) => (row.hasCredentials ? <Tag color="success">已配</Tag> : <Tag>未配</Tag>),
          },
          dateTimeColumn({ title: '创建时间', dataIndex: 'createdAt' }),
          dateTimeColumn({ title: '最近更新', dataIndex: 'updatedAt' }),
        ]}
      />

      <Drawer
        title={drawer?.mode === 'create' ? '新建专属密钥' : `换密钥 · ${drawer?.row.engineName ?? ''}`}
        width={520}
        open={drawer !== null}
        onClose={close}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={close}>取消</Button>
            <Button type="primary" onClick={() => void submit()}>
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
          description="保存之后，库里的凭据就是下面这几对。明文不会回显，保存后这个表单再打开还是空的。"
        />

        {drawer?.mode === 'create' ? (
          <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 16 }}>
            <Typography.Text>引擎</Typography.Text>
            <Select
              style={{ width: '100%' }}
              placeholder="选一个已启用的引擎"
              loading={engines.loading}
              value={engineCode}
              onChange={setEngineCode}
              options={engines.options}
            />
          </Space>
        ) : (
          drawer !== null && (
            <Descriptions
              size="small"
              column={1}
              bordered
              style={{ marginBottom: 16 }}
              title="当前库里的（脱敏）"
            >
              {Object.keys(drawer.row.credentialMasked).length === 0 ? (
                <Descriptions.Item label="（空）">还没有配过凭据</Descriptions.Item>
              ) : (
                Object.entries(drawer.row.credentialMasked).map(([key, masked]) => (
                  <Descriptions.Item key={key} label={key}>
                    <Typography.Text code>{masked}</Typography.Text>
                  </Descriptions.Item>
                ))
              )}
            </Descriptions>
          )
        )}

        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {pairs.map((pair) => (
            <Space key={pair.id} align="start" style={{ width: '100%' }}>
              <Input
                placeholder="键名，如 apiKey"
                value={pair.key}
                style={{ width: 180 }}
                onChange={(e) =>
                  setPairs((prev) => prev.map((p) => (p.id === pair.id ? { ...p, key: e.target.value } : p)))
                }
              />
              <Input.Password
                placeholder="值（明文，只在这次提交里出现）"
                value={pair.value}
                style={{ width: 220 }}
                onChange={(e) =>
                  setPairs((prev) => prev.map((p) => (p.id === pair.id ? { ...p, value: e.target.value } : p)))
                }
              />
              <Button danger onClick={() => setPairs((prev) => prev.filter((p) => p.id !== pair.id))}>
                删除
              </Button>
            </Space>
          ))}
          <Button type="dashed" block onClick={() => setPairs((prev) => [...prev, newPair()])}>
            + 加一对
          </Button>
        </Space>
      </Drawer>
    </>
  )
}
