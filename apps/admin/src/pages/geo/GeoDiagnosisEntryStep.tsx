import { Alert, Button, Card, Form, InputNumber, Typography } from 'antd'
import { RightOutlined } from '@ant-design/icons'
import type { GeoDiagnosisTriggerResult } from '../../api/geo-diagnosis'
import { GeoBrandCoreFields, GeoEngineCodesField } from './GeoBrandCoreFields'
import { useGeoDiagnosisEntryForm } from './hooks/useGeoDiagnosisEntryForm'

/** {@link GeoDiagnosisEntryStep} 的入参。 */
export interface GeoDiagnosisEntryStepProps {
  onTriggered: (brandName: string, result: GeoDiagnosisTriggerResult) => void
}

/**
 * 「AI可见度诊断」向导 · 屏 1：新建品牌 + 立即发起诊断。
 *
 * 对齐设计稿 `designs/geo-diagnosis-flow/screen-entry.jsx` 的结构（标题/副标题/一张卡片
 * 表单/底部大按钮），但字段按真实接口收窄了：
 * - 设计稿有「主营地域」，`CreateGeoBrandDto` 没有这个字段，去掉了；
 * - 设计稿没有「监测引擎」，但 `POST /diagnose` 在品牌没有监测引擎时会直接 400，
 *   补上了（默认全选，字段仍可见可改，理由见 `useGeoDiagnosisEntryForm.ts`）；
 * - 设计稿的按钮文案是「生成测试问法」，对应它下一屏「确认问法」的人工干预步骤——
 *   真实接口是「生成问法 + 导入 + 建跑批」一次性编排，没有那个人工确认步骤
 *   （见 `geo-diagnosis.service.ts` 文件头），按钮文案改成「开始诊断」更准确。
 */
export default function GeoDiagnosisEntryStep({ onTriggered }: GeoDiagnosisEntryStepProps) {
  const form = useGeoDiagnosisEntryForm(onTriggered)

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <Typography.Title level={3}>新建品牌诊断</Typography.Title>
      <Typography.Paragraph type="secondary">
        告诉我们你的品牌基本情况，AI 会据此自动生成测试问法并跑一轮诊断——免费摘要立即可看，
        完整报告（竞品对比、引用来源、优化建议）需要「AI 可见度监测」功能。
      </Typography.Paragraph>

      <Card>
        <Form form={form.antdForm} layout="vertical">
          <GeoBrandCoreFields />
          <Form.Item
            name="engineCodes"
            label="监测引擎"
            tooltip="这次诊断会真的去问这些引擎。默认全选平台已启用的引擎，也可以取消一部分"
            rules={[{ required: true, message: '至少选一个引擎' }]}
          >
            <GeoEngineCodesField engines={form.engines} />
          </Form.Item>
          <Form.Item
            name="sampleSize"
            label="采样次数"
            initialValue={1}
            tooltip="每个问法 × 每个引擎重复问几次。首次诊断建议用 1 次，先获得一个方向性结论；后续要持续监测，可以在「品牌管理」里把这个品牌调到更高的采样次数"
          >
            <InputNumber min={1} max={10} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="promptCount"
            label="生成问法数量"
            initialValue={10}
            tooltip="品牌还没有问法时，AI 会按这个数量自动生成候选并导入（3-30 条）"
          >
            <InputNumber min={3} max={30} precision={0} style={{ width: '100%' }} />
          </Form.Item>

          {!form.engines.loading && form.engines.options.length === 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="平台还没有启用任何引擎，暂时没法发起诊断，请联系平台管理员"
            />
          )}

          <Button
            type="primary"
            size="large"
            block
            loading={form.submitting}
            onClick={() => void form.submit()}
          >
            开始诊断
            <RightOutlined />
          </Button>
        </Form>
      </Card>
    </div>
  )
}
