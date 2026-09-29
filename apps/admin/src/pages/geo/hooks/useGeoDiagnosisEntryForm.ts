import { useCallback, useEffect, useRef, useState } from 'react'
import { Form, message } from 'antd'
import { ApiError, ErrorCode } from '@taizan/contracts'
import { useGeoBrandApi, type GeoBrandInput } from '../../../api/geo-brand'
import { useGeoDiagnosisApi, type GeoDiagnosisTriggerResult } from '../../../api/geo-diagnosis'
import { useGeoEngineOptions, type GeoEngineOptionsState } from './useGeoEngineOptions'

/** 「AI可见度诊断」入口表单提交的字段：品牌基本信息 + 诊断专属的两个参数。 */
export interface GeoDiagnosisEntryValues
  extends Pick<GeoBrandInput, 'name' | 'domain' | 'aliases' | 'industry' | 'engineCodes'> {
  /** 每个问法 × 每个引擎重复问几次。默认 1——这是「先免费看一眼方向」，不是持续监测，
   * 持续监测的采样次数在「品牌管理」里可以随时调高。 */
  sampleSize: number
  /** 品牌零问法时自动生成几条候选（对齐 `DiagnoseGeoBrandDto.promptCount`，3-30）。 */
  promptCount: number
}

/** {@link useGeoDiagnosisEntryForm} 的返回值。 */
export interface GeoDiagnosisEntryFormState {
  antdForm: ReturnType<typeof Form.useForm<GeoDiagnosisEntryValues>>[0]
  engines: GeoEngineOptionsState
  submitting: boolean
  submit: () => Promise<void>
}

/**
 * 「新建品牌 → 立即发起诊断」的表单状态：创建品牌与触发诊断是**一次提交里的两步**——
 * 产品意图是「填完信息就自动进入诊断进度屏」，不是先建品牌再让商家自己去找「诊断」按钮
 * （那条路径已经在「品牌管理」+「监测任务」里存在了，不需要再做一遍）。
 *
 * 不是 `useCrudForm`：那是「新建/编辑一条可回填的记录」的形状（抽屉开关、编辑态回填），
 * 这里永远是「新建」且提交成功后不留在原地，与 `useGeoReportGenerateForm` 同一个判据。
 *
 * ## 引擎默认全选
 *
 * 品牌创建时 `engineCodes` 不传 = 空数组；而 `POST /diagnose` 在品牌没有监测引擎时会
 * 直接 400（"还没有选监测引擎"，见 `geo-run.service.ts` 的 `resolveEngineCodes`）。
 * 「诊断」这一步的产品意图是「填完基本信息就能一键跑」，让商家在这里手动想清楚
 * 「引擎」这个偏运维的概念不符合这个意图，所以引擎清单一到位就默认全选——
 * 字段仍然可见可改（诊断毕竟要花真金白银，不能完全瞒着），只是不需要用户主动选。
 */
export function useGeoDiagnosisEntryForm(
  onSuccess: (brandName: string, result: GeoDiagnosisTriggerResult) => void,
): GeoDiagnosisEntryFormState {
  const brandApi = useGeoBrandApi()
  const diagnosisApi = useGeoDiagnosisApi()
  const engines = useGeoEngineOptions()
  const [antdForm] = Form.useForm<GeoDiagnosisEntryValues>()
  const [submitting, setSubmitting] = useState(false)

  // 只在引擎清单第一次拉到、且用户还没碰过这个字段时，把它填成"全选"——
  // 用 ref 记录"填过一次"，避免运营手动清空之后又被这个 effect 悄悄填回去。
  const filledRef = useRef(false)
  useEffect(() => {
    if (filledRef.current) return
    if (engines.loading) return
    if (engines.options.length === 0) return
    filledRef.current = true
    const current = antdForm.getFieldValue('engineCodes') as string[] | undefined
    if (current === undefined || current.length === 0) {
      antdForm.setFieldValue(
        'engineCodes',
        engines.options.map((o) => o.value),
      )
    }
  }, [engines.loading, engines.options, antdForm])

  const submit = useCallback(async () => {
    let values: GeoDiagnosisEntryValues
    try {
      values = await antdForm.validateFields()
    } catch {
      // antd 已经在表单上就地标红了没通过的字段，这里不需要再做什么——也不能把这个
      // 拒绝原样往外抛：`<Button onClick={() => void form.submit()}>` 不会 catch 它，
      // 抛出去就是一条测试/浏览器控制台都会看到的未处理 rejection。
      return
    }
    setSubmitting(true)
    try {
      const { sampleSize, promptCount, ...brandFields } = values
      // `status`/`locale`/`refreshFreq` 不在这张表单里（诊断入口只收「够跑一次」的字段），
      // 显式给后端默认值——`GeoBrandInput` 的类型把它们标成必填（`GeoBrandListPage.tsx`
      // 那边靠 `Form.Item` 的 `initialValue` 满足，这里没有对应的表单项，只能直接给值）。
      const brand = await brandApi.create({
        ...brandFields,
        sampleSize,
        status: 'ACTIVE',
        locale: 'zh-CN',
        refreshFreq: 'WEEKLY',
      })
      const result = await diagnosisApi.trigger(brand.id, { promptCount })
      onSuccess(brand.name, result)
    } catch (err) {
      // `session.request` 已经会弹一条通用的 `message.error(后端原话)`；配额超限时
      // 那句话干巴巴（"已达到套餐配额上限"），不知道下一步该点哪儿，这里叠加一条
      // 明确的行动指引——与 `GeoBrandListPage.tsx` 里 `useCrudForm` 的 `quotaMessage`
      // 用同一句文案，两条路径最终撞的是同一个配额（`GEO_BRAND`）。
      if (err instanceof ApiError && err.code === ErrorCode.QUOTA_EXCEEDED.code) {
        message.warning('监测品牌数已达套餐上限，去「账单与续费」升一档再来')
      }
      throw err
    } finally {
      setSubmitting(false)
    }
  }, [antdForm, brandApi, diagnosisApi, onSuccess])

  return { antdForm, engines, submitting, submit }
}
