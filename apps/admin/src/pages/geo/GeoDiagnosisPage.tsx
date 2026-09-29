import GeoDiagnosisEntryStep from './GeoDiagnosisEntryStep'
import GeoDiagnosisProgressStep from './GeoDiagnosisProgressStep'
import GeoDiagnosisReportStep from './GeoDiagnosisReportStep'
import { useGeoDiagnosisWizard } from './hooks/useGeoDiagnosisWizard'

/**
 * 「AI可见度诊断」：新手引导入口，把「建品牌 → 生成问法 → 建跑批 → 等结果 → 看报表」
 * 这条原本要在四五个页面之间跳转的链路，收成一次 `POST /brands/:id/diagnose`
 * 编排调用 + 三屏向导（对齐设计稿
 * `designs/geo-diagnosis-flow/diagnosis-flow.html` 的视觉结构与交互流程，具体取舍
 * 见各屏文件头）。
 *
 * 页面本身只按 `wizard.step` 切屏，不拉任何数据——那些各自在
 * `GeoDiagnosisEntryStep`/`GeoDiagnosisProgressStep`/`GeoDiagnosisReportStep` 里，
 * 各自用一个带名字的 hook（蓝图 §5.2 admin-ui 纪律）。
 */
export default function GeoDiagnosisPage() {
  const wizard = useGeoDiagnosisWizard()

  if (wizard.step === 'progress' && wizard.trigger !== null) {
    return (
      <GeoDiagnosisProgressStep
        brandName={wizard.brandName ?? ''}
        trigger={wizard.trigger}
        onReportReady={wizard.showReport}
      />
    )
  }

  if (wizard.step === 'report' && wizard.reportId !== null) {
    return <GeoDiagnosisReportStep reportId={wizard.reportId} onRestart={wizard.restart} />
  }

  return <GeoDiagnosisEntryStep onTriggered={wizard.startProgress} />
}
