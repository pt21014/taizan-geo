import { useCrudTable, type CrudTableApi } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useGeoEngineCredentialApi, type GeoEngineCredential } from '../../../api/geo-engine-credential'

/** 专属引擎密钥列表的表格状态。不分页字段筛选（店里配的密钥数量顶多个位数）。 */
export function useGeoEngineCredentialTable(): CrudTableApi<GeoEngineCredential> {
  const api = useGeoEngineCredentialApi()

  return useCrudTable<GeoEngineCredential>({
    list: async (query): Promise<PageResult<GeoEngineCredential>> => api.list(query),
    remove: async (row) => {
      await api.remove(row)
    },
    rowKey: 'id',
    syncUrl: true,
  })
}
