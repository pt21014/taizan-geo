import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 一次跑批（对齐 `apps/api/src/modules/geo/run/dto/geo-run.dto.ts` 的 `GeoRunView`）。 */
export interface GeoRun {
  id: string
  brandId: string
  triggeredBy: 'SCHEDULE' | 'MANUAL'
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'PARTIAL' | 'FAILED'
  engineCodes: string[]
  sampleSize: number
  totalQueries: number
  doneQueries: number
  failedQueries: number
  totalCostCents: number
  startedAt: string | null
  finishedAt: string | null
  /** 按 `errorKind` 分组的失败计数，如 `{ AUTH: 6 }`；没失败时为 `null`。 */
  errorSummary: Record<string, number> | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** 跑批详情：多一份按结果状态分的实时计数（进度条靠它）。 */
export interface GeoRunDetail extends GeoRun {
  resultCounts: Record<string, number>
}

/** 「立即刷新」提交的字段（对齐 `CreateGeoRunDto`）。 */
export interface GeoRunTriggerInput {
  brandId: string
  engineCodes?: string[]
  promptIds?: string[]
  sampleSize?: number
}

/**
 * 状态列的枚举 → Tag 配置。
 *
 * `PARTIAL` 用 warning 而不是 error：一批里有几条失败是**常态**（厂商限流、偶发超时），
 * 报表仍然可用。标成红色会让运营每天都来问「又出错了吗」，而答案永远是「没事」——
 * 那种警报很快就会被忽略，连带真正的 `FAILED` 也一起被忽略。
 */
export const GEO_RUN_STATUS: Record<GeoRun['status'], StatusTagConfig> = {
  PENDING: { text: '排队中' },
  RUNNING: { text: '进行中', color: 'processing' },
  DONE: { text: '已完成', color: 'success' },
  PARTIAL: { text: '部分失败', color: 'warning' },
  FAILED: { text: '全部失败', color: 'error' },
}

/** 触发方式的展示文案。 */
export const GEO_RUN_TRIGGER_TEXT: Record<GeoRun['triggeredBy'], string> = {
  SCHEDULE: '自动',
  MANUAL: '手动',
}

/**
 * 跑批模块的接口层：与 `GeoRunController` 一一对应。
 *
 * **没有 `update` / `remove`**：一次跑批是一条历史记录，改它等于改账
 * （`totalCostCents` 是对账依据）。要"重跑"就再触发一次，那会建一条新的。
 */
export function useGeoRunApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) => req.get<PageResult<GeoRun>>('/api/admin/geo/runs', query),
    get: (id: string) => req.get<GeoRunDetail>(`/api/admin/geo/runs/${id}`),
    /** 立即刷新：只建一条 run 并入队，真正的查询在后台队列里跑。 */
    trigger: (body: GeoRunTriggerInput) => req.post<GeoRun>('/api/admin/geo/runs', body),
  }
}
