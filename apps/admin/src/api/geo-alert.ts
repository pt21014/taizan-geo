import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 告警类型，对齐 `GEO_ALERT_KINDS`。 */
export const GEO_ALERT_KINDS = ['VISIBILITY_DROP', 'COMPETITOR_OVERTAKE', 'NEGATIVE_MENTION'] as const
export type GeoAlertKind = (typeof GEO_ALERT_KINDS)[number]

/** 告警类型的展示配置。 */
export const GEO_ALERT_KIND_TAGS: Record<GeoAlertKind, StatusTagConfig> = {
  VISIBILITY_DROP: { text: '可见度下跌', color: 'error' },
  COMPETITOR_OVERTAKE: { text: '被竞品反超', color: 'warning' },
  NEGATIVE_MENTION: { text: '负面提及', color: 'volcano' },
}

/** 通知通道，对齐 `GEO_ALERT_CHANNELS`。 */
export const GEO_ALERT_CHANNELS = ['INBOX', 'SMS'] as const
export type GeoAlertChannel = (typeof GEO_ALERT_CHANNELS)[number]

/** 一条告警规则（对齐 `GeoAlertRuleView`）。 */
export interface GeoAlertRule {
  id: string
  brandId: string
  brandName: string
  kind: GeoAlertKind
  thresholdBp: number
  channels: GeoAlertChannel[]
  enabled: boolean
  lastFiredAt: string | null
  createdAt: string
  updatedAt: string
}

/** 新建/编辑告警规则提交的字段（对齐 `CreateGeoAlertRuleDto` / `UpdateGeoAlertRuleDto`）。 */
export interface GeoAlertRuleInput {
  brandId: string
  kind: GeoAlertKind
  thresholdBp: number
  channels?: GeoAlertChannel[]
  enabled?: boolean
}

/** 一条告警触发记录（对齐 `GeoAlertEventView`）。 */
export interface GeoAlertEvent {
  id: string
  ruleId: string
  brandId: string
  brandName: string
  kind: GeoAlertKind
  payload: Record<string, unknown>
  notifiedAt: string | null
  createdAt: string
}

/**
 * 告警模块的接口层：规则 CRUD 走 `GeoAlertController`，事件只读走 `GeoAlertEventController`。
 * 两个控制器共用同一套权限点（`geo-alert:list` / `geo-alert:write`），这里合并成一层接口。
 */
export function useGeoAlertApi() {
  const req = useSession((s) => s.request)
  return {
    listRules: (query: CrudListQuery & { brandId?: string; kind?: GeoAlertKind }) =>
      req.get<PageResult<GeoAlertRule>>('/api/admin/geo/alert-rules', query),
    createRule: (values: GeoAlertRuleInput) =>
      req.post<GeoAlertRule>('/api/admin/geo/alert-rules', values),
    updateRule: (id: string, values: Omit<GeoAlertRuleInput, 'brandId' | 'kind'>) =>
      req.put<GeoAlertRule>(`/api/admin/geo/alert-rules/${id}`, values),
    removeRule: (row: GeoAlertRule) =>
      req.delete<{ id: string }>(`/api/admin/geo/alert-rules/${row.id}`),
    listEvents: (query: CrudListQuery & { brandId?: string; kind?: GeoAlertKind }) =>
      req.get<PageResult<GeoAlertEvent>>('/api/admin/geo/alert-events', query),
  }
}
