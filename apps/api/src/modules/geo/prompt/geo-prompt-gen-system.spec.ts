import { describe, expect, it } from 'vitest'

import { buildPromptGenSystem, GEO_PROMPT_GEN_BRANDED_MAX } from './geo-prompt.service'

describe('buildPromptGenSystem（诊断编排要求的品牌名配比）', () => {
  it('提示词里明确写出"最多 N 条可以带品牌名"，N 不超过配置的上限', () => {
    const system = buildPromptGenSystem(10, undefined)
    expect(system).toContain(`最多 ${GEO_PROMPT_GEN_BRANDED_MAX} 条可以包含品牌名`)
  })

  it('要求的条数低于上限时，带品牌名的配额跟着降低，不会出现"10 条里最多 5 条带品牌名"' +
    '这种在只生成 3 条时依然允许全部带品牌名的表述', () => {
    const system = buildPromptGenSystem(3, undefined)
    expect(system).toContain('最多 3 条可以包含品牌名')
  })

  it('明确要求其余问法不出现品牌名、写成行业通用问题', () => {
    const system = buildPromptGenSystem(10, undefined)
    expect(system).toContain('必须不出现品牌名')
    expect(system).toContain('行业通用问题')
  })

  it('依然保留"要求生成 N 条"与漏斗阶段覆盖的既有要求（没有因为加配比而丢字段）', () => {
    const system = buildPromptGenSystem(8, undefined)
    expect(system).toContain('要求生成 8 条')
    expect(system).toContain('TOFU/MOFU/BOFU')
  })

  it('指定了漏斗阶段时仍然带配比要求', () => {
    const system = buildPromptGenSystem(6, 'BOFU')
    expect(system).toContain('全部生成 BOFU 阶段的问法')
    expect(system).toContain('最多')
    expect(system).toContain('包含品牌名')
  })
})
