import type { CrudListQuery } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 一条商家自带引擎密钥配置（对齐 `GeoEngineCredentialView`）。 */
export interface GeoEngineCredential {
  id: string
  engineCode: string
  engineName: string
  enabled: boolean
  credentialMasked: Record<string, string>
  hasCredentials: boolean
  createdAt: string
  updatedAt: string
}

/** 新建：一次把 engineCode + 整包凭据都填了（对齐 `CreateGeoEngineCredentialDto`）。 */
export interface CreateGeoEngineCredentialInput {
  engineCode: string
  credentials: Record<string, string>
  enabled?: boolean
}

/** 换密钥：整包替换（对齐 `UpdateGeoEngineCredentialDto`）。 */
export interface UpdateGeoEngineCredentialInput {
  credentials: Record<string, string>
}

/** 专属引擎密钥模块的接口层：`/api/admin/geo/engine-credentials`。 */
export function useGeoEngineCredentialApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) =>
      req.get<PageResult<GeoEngineCredential>>('/api/admin/geo/engine-credentials', query),
    create: (values: CreateGeoEngineCredentialInput) =>
      req.post<GeoEngineCredential>('/api/admin/geo/engine-credentials', values),
    update: (id: string, values: UpdateGeoEngineCredentialInput) =>
      req.put<GeoEngineCredential>(`/api/admin/geo/engine-credentials/${id}`, values),
    setEnabled: (id: string, enabled: boolean) =>
      req.patch<GeoEngineCredential>(`/api/admin/geo/engine-credentials/${id}/enabled`, { enabled }),
    remove: (row: GeoEngineCredential) =>
      req.delete<{ id: string }>(`/api/admin/geo/engine-credentials/${row.id}`),
  }
}
