import type { CrudListQuery } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 一行问法（对齐 `apps/api/src/modules/geo/prompt/dto/geo-prompt.dto.ts` 的 `GeoPromptView`）。 */
export interface GeoPrompt {
  id: string
  brandId: string
  promptSetId: string
  text: string
  textHash: string
  topic: string | null
  funnelStage: 'TOFU' | 'MOFU' | 'BOFU' | 'UNKNOWN'
  isTracked: boolean
  priority: number
  createdAt: string
  updatedAt: string
}

/** 新建时提交的字段（对齐 `CreateGeoPromptDto`）。 */
export interface GeoPromptInput {
  brandId: string
  promptSetId?: string
  text: string
  topic?: string | null
  funnelStage?: GeoPrompt['funnelStage']
  isTracked?: boolean
  priority?: number
}

/** 一个 Prompt 集（对齐 `GeoPromptSetView`）。 */
export interface GeoPromptSet {
  id: string
  brandId: string
  name: string
  source: 'MANUAL' | 'AI_GEN' | 'IMPORT'
  createdAt: string
  updatedAt: string
}

/** 一条 AI 生成出来的候选问法（对齐 `GeoPromptCandidateView`）。**没有 id**——它还没落库。 */
export interface GeoPromptCandidate {
  text: string
  funnelStage: GeoPrompt['funnelStage']
  topic: string | null
  /** 这条正文库里已经有了（按 textHash 判）。前端据它默认不勾选。 */
  duplicated: boolean
}

/** AI 生成接口的返回（对齐 `GeoPromptGenerateResultView`）。 */
export interface GeoPromptGenerateResult {
  candidates: GeoPromptCandidate[]
  /** 生效的 LLM 供应商名，排障用。 */
  provider: string
}

/** 批量导入的结果（对齐 `GeoPromptImportResultView`）。 */
export interface GeoPromptImportResult {
  created: number
  skipped: number
  promptSetId: string
}

/**
 * 漏斗阶段的展示文案。
 *
 * `UNKNOWN` 留着是刻意的：后端 `normalizeFunnelStage` 认不出来的标签一律判成它，
 * 报表里会单独成一组。前端把它藏起来的话，运营看到的是「这条问法没有阶段」，
 * 而实际上它有一个明确的、待人回来补的状态。
 */
export const GEO_FUNNEL_STAGE_OPTIONS = [
  { label: '认知（TOFU）', value: 'TOFU' },
  { label: '考虑（MOFU）', value: 'MOFU' },
  { label: '决策（BOFU）', value: 'BOFU' },
  { label: '未分类', value: 'UNKNOWN' },
] as const

/** `funnelStage` → 中文，给表格列用。 */
export const GEO_FUNNEL_STAGE_TEXT: Record<GeoPrompt['funnelStage'], string> = {
  TOFU: '认知',
  MOFU: '考虑',
  BOFU: '决策',
  UNKNOWN: '未分类',
}

/** Prompt 集来源的展示文案。 */
export const GEO_PROMPT_SOURCE_TEXT: Record<GeoPromptSet['source'], string> = {
  MANUAL: '手工维护',
  AI_GEN: 'AI 生成',
  IMPORT: '批量导入',
}

/**
 * Prompt 模块的接口层：与 `GeoPromptController` 一一对应。
 *
 * `generate` 是全后台**唯一**一条会让服务端同步调 LLM 的请求，所以它可能要等
 * 十几秒（服务端超时 20 秒）。调用点必须给出加载态，否则运营会以为页面卡住并重复点击，
 * 而每一次点击都是一次真实的 LLM 调用。
 */
export function useGeoPromptApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) => req.get<PageResult<GeoPrompt>>('/api/admin/geo/prompts', query),
    get: (id: string) => req.get<GeoPrompt>(`/api/admin/geo/prompts/${id}`),
    create: (values: GeoPromptInput) => req.post<GeoPrompt>('/api/admin/geo/prompts', values),
    update: (id: string, values: Partial<GeoPromptInput>) =>
      req.put<GeoPrompt>(`/api/admin/geo/prompts/${id}`, values),
    remove: (row: GeoPrompt) => req.delete<void>(`/api/admin/geo/prompts/${row.id}`),
    /** AI 生成候选问法。**不落库**，勾选之后走下面的 `importMany` 才会保存。 */
    generate: (body: { brandId: string; count?: number; funnelStage?: string }) =>
      req.post<GeoPromptGenerateResult>('/api/admin/geo/prompts/generate', body),
    /** 批量导入：每行一条，后端按 `textHash` 去重，返回 `{ created, skipped }`。 */
    importMany: (body: { brandId: string; promptSetId?: string; texts: string[] }) =>
      req.post<GeoPromptImportResult>('/api/admin/geo/prompts/import', body),

    // ── Prompt 集 ────────────────────────────────────────────────────────
    listSets: (brandId: string) =>
      req.get<GeoPromptSet[]>('/api/admin/geo/prompts/sets', { brandId }),
    createSet: (body: { brandId: string; name: string; source?: GeoPromptSet['source'] }) =>
      req.post<GeoPromptSet>('/api/admin/geo/prompts/sets', body),
    updateSet: (id: string, body: { name: string }) =>
      req.put<GeoPromptSet>(`/api/admin/geo/prompts/sets/${id}`, body),
    removeSet: (id: string) => req.delete<void>(`/api/admin/geo/prompts/sets/${id}`),
  }
}
