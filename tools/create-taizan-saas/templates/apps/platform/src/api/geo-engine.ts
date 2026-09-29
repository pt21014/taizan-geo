import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 接入方式，对齐 `apps/api/.../geo-engine.rules.ts` 的 `GEO_ACCESS_TYPES`。 */
export const GEO_ACCESS_TYPES = ['API', 'BROWSER'] as const
export type GeoAccessType = (typeof GEO_ACCESS_TYPES)[number]

/** 接入方式的展示配置。 */
export const GEO_ACCESS_TYPE_TAGS: Record<GeoAccessType, StatusTagConfig> = {
  API: { text: '官方 API', color: 'blue' },
  // 浏览器自动化比 API 慢一个数量级、也更容易被风控挡掉，给它一个显眼的颜色，
  // 免得排查「为什么这家引擎老超时」时还要先翻配置。
  BROWSER: { text: '浏览器抓取', color: 'orange' },
}

/** 启用状态的展示配置。 */
export const GEO_ENGINE_ENABLED_TAGS: Record<'true' | 'false', StatusTagConfig> = {
  true: { text: '已启用', color: 'success' },
  false: { text: '已停用' },
}

/**
 * 一行引擎（对齐 `apps/api/src/modules/geo/engine/dto/geo-engine.dto.ts` 的 `GeoEngineView`）。
 *
 * **没有 `credentialEnc` / `credentialKeyId`**——后端根本不下发它们。
 * 前端能拿到的只有 `credentialMasked`（脱敏提示）与 `hasCredentials`（配没配）。
 */
export interface GeoEngineView {
  id: string
  code: string
  name: string
  vendor: string
  accessType: GeoAccessType
  enabled: boolean
  model: string
  baseUrl: string | null
  /** 脱敏后的整包凭据：键名保留，值只留前 3 后 2。没配过时是 `{}`。 */
  credentialMasked: Record<string, string>
  hasCredentials: boolean
  pricePerQueryCents: number
  priceInPerMTokenCents: number
  priceOutPerMTokenCents: number
  rateLimitPerMin: number
  timeoutMs: number
  config: Record<string, unknown>
  sort: number
  createdAt: string
  updatedAt: string
}

/** 新建引擎时提交的字段（对齐 `CreateGeoEngineDto`）。 */
export interface CreateGeoEngineInput {
  code: string
  name: string
  vendor: string
  accessType?: GeoAccessType
  enabled?: boolean
  model?: string
  baseUrl?: string
  pricePerQueryCents?: number
  priceInPerMTokenCents?: number
  priceOutPerMTokenCents?: number
  rateLimitPerMin?: number
  timeoutMs?: number
  sort?: number
}

/**
 * 修改引擎时提交的字段（对齐 `UpdateGeoEngineDto`）。
 *
 * **没有 `code`**（建后不可改：历史查询结果按 code 存快照）、
 * **没有 `enabled`**（走 `setEnabled`）、**没有凭据**（走 `updateCredentials`）。
 * 三处刻意的缺席，见后端 DTO 文件头。
 */
export type UpdateGeoEngineInput = Omit<CreateGeoEngineInput, 'code' | 'enabled'>

/** `POST /:id/test` 的结果（对齐 `GeoEngineTestResultView`）。 */
export interface GeoEngineTestResult {
  ok: boolean
  latencyMs: number
  preview: string
  citationCount: number
  error: string | null
  errorKind: string | null
  model: string
}

/**
 * 引擎模块的接口层：与 `GeoEngineController` 一一对应。
 *
 * 页面里不直接拼 URL，是为了让业务页面只剩下「长什么样」这一件事。
 */
export function useGeoEngineApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) =>
      req.get<PageResult<GeoEngineView>>('/api/platform/geo/engines', query),
    get: (id: string) => req.get<GeoEngineView>(`/api/platform/geo/engines/${id}`),
    create: (values: CreateGeoEngineInput) =>
      req.post<GeoEngineView>('/api/platform/geo/engines', values),
    update: (id: string, values: UpdateGeoEngineInput) =>
      req.patch<GeoEngineView>(`/api/platform/geo/engines/${id}`, values),
    setEnabled: (id: string, enabled: boolean) =>
      req.patch<GeoEngineView>(`/api/platform/geo/engines/${id}/enabled`, { enabled }),
    /**
     * 整包**替换**凭据（不是合并）。传 `{}` 等于清空。
     *
     * 明文只在这一次请求的 body 里出现，之后再也拿不回来——后端不回显明文，
     * 页面上那个键值对编辑器每次打开都是空的（只显示 masked 作为参照）。
     */
    updateCredentials: (id: string, credentials: Record<string, string>) =>
      req.put<GeoEngineView>(`/api/platform/geo/engines/${id}/credentials`, { credentials }),
    test: (id: string, prompt?: string) =>
      req.post<GeoEngineTestResult>(`/api/platform/geo/engines/${id}/test`, { prompt }),
  }
}
