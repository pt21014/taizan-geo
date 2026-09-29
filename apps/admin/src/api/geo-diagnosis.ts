import { useSession } from '../session'

/**
 * 「先诊断后付费」编排接口层：与 `GeoDiagnosisController` 一一对应
 * （`POST /api/admin/geo/brands/:id/diagnose`，见 `geo-diagnosis.controller.ts` 文件头）。
 *
 * 只有一条接口：不新增资源，只是把「生成问法 → 导入 → 建跑批」编排到一次调用里。
 * 真正的结果（跑批进度、诊断报表）分别靠 `geo-run.ts`/`geo-report.ts` 现成的接口轮询，
 * 这里不重复定义。
 */

/** `POST /diagnose` 的入参（对齐 `DiagnoseGeoBrandDto`）。 */
export interface DiagnoseGeoBrandInput {
  /** 品牌还没有问法时，自动生成几条候选并导入；不传按后端默认值（10）。 */
  promptCount?: number
}

/** `POST /diagnose` 的响应（对齐 `GeoDiagnosisTriggerResultView`）。 */
export interface GeoDiagnosisTriggerResult {
  /** 这次诊断对应的跑批 id；轮询 `GET /runs/:id` 直到 `diagnosisReportId` 非空。 */
  runId: string
  brandId: string
  /** 这次自动生成并导入了几条候选问法（品牌本来就有问法时恒为 0）。 */
  promptsGenerated: number
  /** 这次跑批规划出的查询总数（问法数 × 引擎数 × 采样数）。 */
  plannedQueries: number
  /** 本次是否复用了品牌已有的问法（true = 没有触发 AI 生成）。 */
  reusedExistingPrompts: boolean
}

/**
 * 诊断编排模块的接口层。
 *
 * 权限点 `geo-diagnosis:trigger`；挂在 `/api/admin/geo/brands` 前缀之下，与品牌接口
 * 共用同一道 `geo.monitor` 功能闸门（发起诊断要花真金白银）。
 */
export function useGeoDiagnosisApi() {
  const req = useSession((s) => s.request)
  return {
    trigger: (brandId: string, values: DiagnoseGeoBrandInput = {}) =>
      req.post<GeoDiagnosisTriggerResult>(`/api/admin/geo/brands/${brandId}/diagnose`, values),
  }
}
