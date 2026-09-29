/**
 * 分析任务用的 JSON Schema 常量。
 *
 * ## 为什么在包里，而不是在调用它的 handler 里
 *
 * `MENTION_SCHEMA` 原来写在 `apps/api/src/modules/geo/analysis/geo-result-analyze.handler.ts`
 * 里。它待在那里有一个说不通的地方：**它是 provider 侧的契约**——
 * `buildJsonSchemaHint()`（`json-schema.ts`）要把它渲染成提示词、
 * `parseJsonLoose()` 要按它的形状去解析脏输出，而这两件事都发生在本包内。
 * schema 留在应用侧的话，本包的单测就没法对着"真实会用到的那一份 schema"跑
 * （只能对着一份手抄的简化版跑，而手抄版和真版哪天不一致了没有任何信号）。
 *
 * 另一面是 mock：`MockLlmProvider` 的 `mention` 场景编出来的 JSON 必须与这份
 * schema 逐字段对齐，否则 e2e 里"LLM 明明答了但库里没有"。两者现在同在一个包里，
 * 改一个会在同一次 `pnpm -F @taizan/llm test` 里被另一个照出来。
 *
 * ## 这份 schema 的字段为什么是这几个
 *
 * 与 `apps/api` 的 `mergeLlmMentions(json, entities, fallback)` 认识的字段**逐个对齐**。
 * 那个纯函数会**静默丢掉**认不出来的条目（它拿不到 schema，只能按字段名取值），
 * 所以 schema 与它之间任何一点分歧的表现都是"抽取率莫名其妙地低"，而不是一个错误。
 * 改这里的任何一个字段名，都要同步改 `analysis/geo-mention.rules.ts`。
 *
 * @packageDocumentation
 */

import type { JsonSchema } from './types'

/**
 * 品牌/竞品提及抽取的结构化输出 schema（GEO 分析流水线 `geo.result.analyze`）。
 *
 * `required` 里**刻意没有 `snippet`**：片段是给人核对识别质量用的，模型偶尔不给
 * 是可以接受的；把它列为必填只会让模型为了满足 schema 去编一段原文里没有的话。
 *
 * `sentimentScore` 的值域是 `-100..100` 的整数——它**本身就是"情感均值 ×100"**
 * （产品定义 §2 的"情感均值 ∈ [-1,1]"乘以 100 之后的整数形式）。下游
 * `GeoVisibilityDaily.sentimentAvgX100` 直接取这一列的均值，不再乘一次 100。
 */
export const MENTION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    mentions: {
      type: 'array',
      description: '回答里提到的品牌/竞品，按出现先后排列；没提到的实体不要编',
      items: {
        type: 'object',
        properties: {
          entityName: { type: 'string', description: '实体名，必须**逐字**用给定清单里的名字' },
          position: { type: 'integer', description: '在回答里第几个出现，从 1 开始' },
          isCited: { type: 'boolean', description: '这个实体是否有对应的引用链接' },
          sentiment: { type: 'string', enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] },
          sentimentScore: { type: 'integer', description: '-100（极负面）到 100（极正面）' },
          snippet: { type: 'string', description: '提到它的那一小段原文，不超过 200 字' },
        },
        required: ['entityName', 'position', 'isCited', 'sentiment'],
      },
    },
  },
  required: ['mentions'],
}
