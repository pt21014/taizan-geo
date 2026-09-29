/**
 * `schemas.ts` 的单测。
 *
 * 断言的重点不是"这个对象长什么样"（那是重抄一遍常量，没有价值），而是
 * **schema 与本包其它两处的耦合真的成立**：
 * 1. `buildJsonSchemaHint()` 能把它渲染成提示词（渲染不出来 = provider 侧白给）；
 * 2. `MockLlmProvider` 的 `mention` 场景产出的 JSON 满足它的 `required`
 *    （对不齐 = e2e 里"LLM 明明答了但库里没有"）。
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest'

import { buildJsonSchemaHint, parseJsonLoose } from './json-schema'
import { MockLlmProvider } from './providers/mock'
import { MENTION_SCHEMA } from './schemas'

describe('MENTION_SCHEMA', () => {
  it('顶层要求 mentions 数组', () => {
    expect(MENTION_SCHEMA.type).toBe('object')
    expect(MENTION_SCHEMA.required).toEqual(['mentions'])
    expect(MENTION_SCHEMA.properties?.['mentions']?.type).toBe('array')
  })

  it('每条 mention 的必填字段与 mergeLlmMentions 认识的字段对齐', () => {
    const item = MENTION_SCHEMA.properties?.['mentions']?.items
    expect(item?.required).toEqual(['entityName', 'position', 'isCited', 'sentiment'])
    // snippet 刻意不必填：见 schemas.ts 的说明。
    expect(item?.properties?.['snippet']).toBeDefined()
    expect(item?.required).not.toContain('snippet')
  })

  it('sentiment 的枚举就是 GeoSentiment 的三档', () => {
    const item = MENTION_SCHEMA.properties?.['mentions']?.items
    expect(item?.properties?.['sentiment']?.enum).toEqual(['POSITIVE', 'NEUTRAL', 'NEGATIVE'])
  })

  it('能被 buildJsonSchemaHint 渲染成非空提示词', () => {
    const hint = buildJsonSchemaHint(MENTION_SCHEMA)
    expect(hint).toContain('mentions')
    expect(hint).toContain('entityName')
    expect(hint.length).toBeGreaterThan(50)
  })

  it('mock 的 mention 场景产出的 JSON 满足这份 schema 的 required', async () => {
    const provider = new MockLlmProvider()
    const res = await provider.chat(
      {
        messages: [{ role: 'user', content: '回答原文里出现了 示例品牌 这个名字' }],
        jsonSchema: MENTION_SCHEMA,
      },
      {},
    )
    const json = (res.json ?? parseJsonLoose(res.text)) as { mentions?: unknown[] } | undefined
    expect(Array.isArray(json?.mentions)).toBe(true)
    const first = json?.mentions?.[0] as Record<string, unknown> | undefined
    for (const key of ['entityName', 'position', 'isCited', 'sentiment']) {
      expect(first?.[key], `mock 少了必填字段 ${key}`).toBeDefined()
    }
  })
})
