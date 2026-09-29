import { Form, Input, Select } from 'antd'
import type { GeoEngineOptionsState } from './hooks/useGeoEngineOptions'

/**
 * 品牌表单里「品牌名/域名/别名/行业」四个字段的 `<Form.Item>`。
 *
 * 被两处共用：「品牌管理」的编辑抽屉（`GeoBrandListPage.tsx`，那边还有
 * locale/status/refreshFreq/sampleSize/engineCodes 五个字段）与「AI可见度诊断」
 * 入口表单（`GeoDiagnosisEntryStep.tsx`，那边还有诊断专属的采样次数/问法生成数量）。
 * 抽成一份是因为这四个字段的 label/占位文案/tooltip 只该有一处真源——两页各写一遍的话，
 * 改一个 tooltip 措辞就要记得两个文件都改，迟早会漂。
 *
 * **不含 `engineCodes`**：两个调用点对它的要求不同（品牌管理允许留空——那意味着
 * "先建品牌，回头再配引擎"；诊断入口要求必填并默认全选，否则诊断这一步会直接
 * 400），字段本身的校验规则不共享，各自在自己的表单里定义。
 */
export function GeoBrandCoreFields() {
  return (
    <>
      <Form.Item name="name" label="品牌名" rules={[{ required: true, message: '请填品牌名' }]}>
        <Input placeholder="如：钛赞" />
      </Form.Item>
      <Form.Item
        name="domain"
        label="官网域名"
        tooltip="判断回答里的引用算不算「自有阵地」的依据。协议、www 和路径会自动去掉"
      >
        <Input placeholder="如：example.com" />
      </Form.Item>
      <Form.Item
        name="aliases"
        label="别名"
        tooltip="回车分隔。简称、英文名、常见错写都填上——提及识别时会一起匹配"
      >
        <Select mode="tags" tokenSeparators={[',', '，']} placeholder="钛赞科技、taizan…" />
      </Form.Item>
      <Form.Item name="industry" label="行业" tooltip="AI 生成候选问法时作为上下文">
        <Input placeholder="如：企业服务 / SaaS" />
      </Form.Item>
    </>
  )
}

/** 「监测引擎」多选框——两个调用点都要用，但校验规则不同，只共享渲染。 */
export function GeoEngineCodesField({ engines }: { engines: GeoEngineOptionsState }) {
  return (
    <Select
      mode="multiple"
      options={engines.options}
      loading={engines.loading}
      placeholder={engines.loading ? '正在拉取可选引擎…' : '至少选一个'}
      notFoundContent="平台还没有启用任何引擎"
    />
  )
}
