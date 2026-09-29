import { useCallback, useState } from 'react'
import { Form, message } from 'antd'
import { ApiError, ErrorCode } from '@taizan/contracts'
import { useGeoReportApi, type GenerateGeoReportInput } from '../../../api/geo-report'

/** {@link useGeoReportGenerateForm} 的返回值。 */
export interface GeoReportGenerateFormState {
  antdForm: ReturnType<typeof Form.useForm<GenerateGeoReportInput>>[0]
  open: boolean
  submitting: boolean
  openForm: () => void
  closeForm: () => void
  submit: () => Promise<void>
}

/**
 * 「手动生成一份报表」的表单状态：不是 `useCrudForm`（那是「新建/编辑一条可回填的
 * 记录」的形状），这里没有编辑态、也不回填——每次打开都是一张空表单。
 *
 * `1540301`（配额超限）在这里不适用（生成报表不花查询配额），但同周期已存在时
 * 后端直接返回那一份而不是报错（见 `GeoReportController.generate` 的注释），
 * 所以这里的错误分流只需要兜底通用错误提示，交给 `session.request` 处理。
 */
export function useGeoReportGenerateForm(onSuccess: (id: string) => void): GeoReportGenerateFormState {
  const api = useGeoReportApi()
  const [antdForm] = Form.useForm<GenerateGeoReportInput>()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const openForm = useCallback(() => {
    antdForm.resetFields()
    setOpen(true)
  }, [antdForm])

  const closeForm = useCallback(() => setOpen(false), [])

  const submit = useCallback(async () => {
    const values = await antdForm.validateFields()
    setSubmitting(true)
    try {
      const report = await api.generate(values)
      message.success(
        report.status === 'READY' ? '报表已生成' : '报表已提交生成，稍后刷新列表查看',
      )
      setOpen(false)
      onSuccess(report.id)
    } catch (err) {
      if (err instanceof ApiError && err.code === ErrorCode.QUOTA_EXCEEDED.code) {
        message.warning('已达到当前套餐的配额上限，请先升级套餐')
      }
      throw err
    } finally {
      setSubmitting(false)
    }
  }, [antdForm, api, onSuccess])

  return { antdForm, open, submitting, openForm, closeForm, submit }
}
