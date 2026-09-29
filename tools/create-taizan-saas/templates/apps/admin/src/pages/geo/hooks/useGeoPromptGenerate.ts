import { useCallback, useState } from 'react'
import { useGeoPromptApi, type GeoPromptCandidate } from '../../../api/geo-prompt'

/** {@link useGeoPromptGenerate} 的返回值。 */
export interface GeoPromptGenerateState {
  /** 生成中（LLM 调用最长 20 秒）。 */
  generating: boolean
  /** 当前这一批候选；还没生成过时是空数组。 */
  candidates: GeoPromptCandidate[]
  /** 勾中的那几条在 `candidates` 里的下标。 */
  selected: number[]
  setSelected: (keys: number[]) => void
  /** 生成一批。成功后自动勾上所有**不重复**的候选。 */
  generate: (params: { brandId: string; count?: number; funnelStage?: string }) => Promise<void>
  /** 清空（关抽屉时用）。 */
  reset: () => void
}

/**
 * 「AI 生成候选问法」抽屉的状态。
 *
 * ## 为什么生成与落库是**两步**
 *
 * 接口只回候选、一条都不落库（见后端 `geo-prompt.service.ts` 的 `generate()`）：
 * 模型很容易写出三条其实是同一条的近义句，直接落库会把商家的 `GEO_PROMPT` 配额
 * 吃掉，而每一条都会在下一次跑批里真的花钱去问。
 *
 * 所以这里只管候选与勾选，落库复用既有的 `POST /prompts/import`——那条路径上
 * 已经有 `textHash` 去重与配额扣减，一行都不用重写。
 *
 * ## 默认勾选规则
 *
 * 生成回来时自动勾上**所有 `duplicated === false`** 的条目。重复的那几条留着显示
 * （让运营知道「这条我已经有了」是一个有信息量的结果），但默认不勾——勾了也只是被
 * 后端 `skipped` 掉，白让人以为导进去了。
 */
export function useGeoPromptGenerate(): GeoPromptGenerateState {
  const api = useGeoPromptApi()
  const [generating, setGenerating] = useState(false)
  const [candidates, setCandidates] = useState<GeoPromptCandidate[]>([])
  const [selected, setSelected] = useState<number[]>([])

  const generate = useCallback(
    async (params: { brandId: string; count?: number; funnelStage?: string }) => {
      setGenerating(true)
      try {
        const res = await api.generate(params)
        setCandidates(res.candidates)
        setSelected(
          res.candidates.map((c, i) => (c.duplicated ? -1 : i)).filter((i) => i >= 0),
        )
      } finally {
        setGenerating(false)
      }
    },
    // `api` 每次渲染现造，放进依赖会让这个回调每次都变。
    [],
  )

  const reset = useCallback(() => {
    setCandidates([])
    setSelected([])
  }, [])

  return { generating, candidates, selected, setSelected, generate, reset }
}
