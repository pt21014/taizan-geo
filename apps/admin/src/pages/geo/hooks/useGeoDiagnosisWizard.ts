import { useCallback, useState } from 'react'
import type { GeoDiagnosisTriggerResult } from '../../../api/geo-diagnosis'

/** 向导此刻在哪一屏。 */
export type GeoDiagnosisStep = 'entry' | 'progress' | 'report'

/** {@link useGeoDiagnosisWizard} 的返回值。 */
export interface GeoDiagnosisWizardState {
  step: GeoDiagnosisStep
  /** 这次诊断的品牌名，用来在进度屏/报告屏的标题里报一下"在看哪个品牌"。 */
  brandName: string | null
  trigger: GeoDiagnosisTriggerResult | null
  reportId: string | null
  /** 入口表单提交成功后调用：记下品牌名与编排结果，切到「进行中」屏。 */
  startProgress: (brandName: string, result: GeoDiagnosisTriggerResult) => void
  /** 轮询拿到 `diagnosisReportId` 之后调用：切到「报告」屏。 */
  showReport: (reportId: string) => void
  /** 「再诊断一个品牌」：回到入口屏，清空这一轮的状态。 */
  restart: () => void
}

/**
 * 「AI可见度诊断」向导的**屏幕切换**状态——只管"现在在哪一屏、带着哪些上下文
 * 进的下一屏"，不管每一屏内部怎么拉数据（那些各自有自己的 hook：
 * `useGeoDiagnosisEntryForm`/`useGeoDiagnosisRunPoll`/`useGeoDiagnosisReport`）。
 *
 * 单独收一个 hook 而不是让 `GeoDiagnosisPage.tsx` 自己 `useState`，是 admin-ui 那条
 * "页面文件里不出现裸 `useState`"纪律（蓝图 §5.2）——这个仓库里所有 GEO 页面都这么做
 * （`useDrawerState`/`useBrandOptions`/`useGeoEngineOptions`……），这个向导页不该是例外。
 */
export function useGeoDiagnosisWizard(): GeoDiagnosisWizardState {
  const [step, setStep] = useState<GeoDiagnosisStep>('entry')
  const [brandName, setBrandName] = useState<string | null>(null)
  const [trigger, setTrigger] = useState<GeoDiagnosisTriggerResult | null>(null)
  const [reportId, setReportId] = useState<string | null>(null)

  const startProgress = useCallback((name: string, result: GeoDiagnosisTriggerResult) => {
    setBrandName(name)
    setTrigger(result)
    setReportId(null)
    setStep('progress')
  }, [])

  const showReport = useCallback((id: string) => {
    setReportId(id)
    setStep('report')
  }, [])

  const restart = useCallback(() => {
    setStep('entry')
    setBrandName(null)
    setTrigger(null)
    setReportId(null)
  }, [])

  return { step, brandName, trigger, reportId, startProgress, showReport, restart }
}
