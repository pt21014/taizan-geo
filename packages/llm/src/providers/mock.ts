/**
 * Mock LLM provider：不发任何请求，按 `cfg.scenario` 与 messages 里出现的品牌词
 * 做**确定性字符串匹配**，产出 GEO 分析所需的结构化 JSON。
 *
 * 配置（`MockLlmConfig`）：
 *   - `scenario`        —— 见下表，默认 `mention`
 *   - `brandName`       —— 本品牌名，默认 `示例品牌`
 *   - `competitorNames` —— 竞品名数组，默认 `['竞品甲','竞品乙']`
 *
 * | scenario      | 有 jsonSchema 时产出 |
 * |---------------|----------------------|
 * | `mention`（默认） | 品牌 position 1、isCited false、positive |
 * | `no-mention`  | `{ mentions: [] }` |
 * | `competitor`  | 只有竞品的 mention，位次 1、2 |
 * | `cited`       | 品牌 position 1、**isCited true** |
 * | `negative`    | 品牌 position 1、negative、sentimentScore -60 |
 * | `prompt-gen`  | `{ prompts: [...] }` 固定 5 条 |
 * | `fail`        | 直接抛错，用来测 registry 的主备切换 |
 *
 * **只有在 messages 里真的出现了品牌词时才产出该品牌的 mention**——这条匹配规则
 * 是刻意的：`analysis` 模块的单测拿 mock 当被测对象的上游，如果不管输入是什么都
 * 返回一条"提及"，那测的就不是分析逻辑，而是 mock 自己编的数据。
 *
 * 无 `jsonSchema` 时回显一段固定文本。所有输出确定性：不用 `Math.random()`、
 * 不读时钟，`usage` 固定。
 */
import type { ChatRequest, ChatResponse, LlmChatContext, LlmProvider } from '../types'

/** mock 支持的场景名。 */
export type MockLlmScenario =
  | 'mention'
  | 'no-mention'
  | 'competitor'
  | 'cited'
  | 'negative'
  | 'prompt-gen'
  | 'fail'

/** 全部场景名；平台后台的下拉框与 spec 都用它。 */
export const MOCK_LLM_SCENARIOS: readonly MockLlmScenario[] = [
  'mention',
  'no-mention',
  'competitor',
  'cited',
  'negative',
  'prompt-gen',
  'fail',
]

/** Mock provider 的配置。 */
export interface MockLlmConfig {
  scenario?: MockLlmScenario
  brandName?: string
  competitorNames?: string[]
}

/** 一条提及记录，形状对齐 `GeoMention` 的列。 */
export interface MockMention {
  entityName: string
  /** 在回答里的出现位次，从 1 开始。 */
  position: number
  isCited: boolean
  sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
  /** -100..100 的整数，对齐 `GeoMention.sentimentScore`。 */
  sentimentScore: number
  snippet: string
}

/** 一条生成出来的 Prompt，形状对齐 `GeoPrompt` 的列。 */
export interface MockGeneratedPrompt {
  text: string
  funnelStage: 'TOFU' | 'MOFU' | 'BOFU'
  topic: string
}

const FIXED_USAGE = { inputTokens: 320, outputTokens: 180 } as const
const MOCK_MODEL = 'mock-llm-v1'
const DEFAULT_BRAND = '示例品牌'
const DEFAULT_COMPETITORS = ['竞品甲', '竞品乙']

/** 把 messages 拼成一段可供匹配的文本。纯函数。 */
export function joinMessages(req: ChatRequest): string {
  return (req.messages ?? []).map((m) => m.content).join('\n')
}

/** 固定 5 条 Prompt。导出便于 `prompt` 模块的 spec 直接引用。纯函数。 */
export function buildMockPrompts(brandName: string): MockGeneratedPrompt[] {
  return [
    { text: `${brandName}怎么样？值得买吗`, funnelStage: 'BOFU', topic: '品牌口碑' },
    { text: `${brandName}和竞品比哪个好`, funnelStage: 'BOFU', topic: '竞品对比' },
    { text: `${brandName}多少钱，有优惠吗`, funnelStage: 'MOFU', topic: '价格' },
    { text: `选购这类产品要看哪些指标`, funnelStage: 'TOFU', topic: '选购指南' },
    { text: `新手入门该从哪一步开始`, funnelStage: 'TOFU', topic: '入门科普' },
  ]
}

/**
 * 按场景与 messages 内容产出结构化结果。纯函数，导出供 spec 直接断言。
 */
export function buildMockJson(req: ChatRequest, cfg: MockLlmConfig): unknown {
  const scenario = cfg?.scenario ?? 'mention'
  const brandName = cfg?.brandName ?? DEFAULT_BRAND
  const competitors =
    cfg?.competitorNames && cfg.competitorNames.length > 0
      ? cfg.competitorNames
      : DEFAULT_COMPETITORS
  const haystack = joinMessages(req)
  const first = competitors[0] ?? DEFAULT_COMPETITORS[0]!
  const second = competitors[1] ?? DEFAULT_COMPETITORS[1]!

  if (scenario === 'prompt-gen') {
    return { prompts: buildMockPrompts(brandName) }
  }
  if (scenario === 'no-mention') {
    return { mentions: [] }
  }

  const mentions: MockMention[] = []

  if (scenario === 'competitor') {
    // 只提竞品；仍然要求竞品词真的出现在 messages 里
    for (const [i, name] of [first, second].entries()) {
      if (!haystack.includes(name)) continue
      mentions.push({
        entityName: name,
        position: i + 1,
        isCited: false,
        sentiment: 'POSITIVE',
        sentimentScore: 60,
        snippet: `比较多人推荐的是 ${name}`,
      })
    }
    return { mentions }
  }

  if (haystack.includes(brandName)) {
    const negative = scenario === 'negative'
    mentions.push({
      entityName: brandName,
      position: 1,
      isCited: scenario === 'cited',
      sentiment: negative ? 'NEGATIVE' : 'POSITIVE',
      sentimentScore: negative ? -60 : 80,
      snippet: negative
        ? `${brandName} 的投诉不少，上手成本高、售后响应慢`
        : `比较推荐的是 ${brandName}，完成度最高`,
    })
  }
  // 竞品词出现时一并给一条，位次排在品牌之后
  if (haystack.includes(first)) {
    mentions.push({
      entityName: first,
      position: mentions.length + 1,
      isCited: false,
      sentiment: 'NEUTRAL',
      sentimentScore: 10,
      snippet: `其次可以看看 ${first}`,
    })
  }
  return { mentions }
}

/** Mock LLM provider。 */
export class MockLlmProvider implements LlmProvider<MockLlmConfig> {
  readonly name = 'mock'

  // process-local: 只在单个测试/开发进程里累积，重启即清空，不是持久记录。
  readonly calls: ChatRequest[] = []

  async chat(req: ChatRequest, cfg: MockLlmConfig = {}, _ctx?: LlmChatContext): Promise<ChatResponse> {
    this.calls.push(req)
    if (cfg?.scenario === 'fail') {
      throw new Error('[@taizan/llm] mock scenario=fail：模拟 LLM 调用失败')
    }

    if (!req.jsonSchema) {
      return {
        text: '这是 mock LLM 的固定回复，用于本地开发与 CI。',
        usage: { ...FIXED_USAGE },
        model: req.model ?? MOCK_MODEL,
        finishReason: 'stop',
      }
    }

    const json = buildMockJson(req, cfg ?? {})
    return {
      text: JSON.stringify(json),
      json,
      usage: { ...FIXED_USAGE },
      model: req.model ?? MOCK_MODEL,
      finishReason: 'stop',
    }
  }

  /** 清空调用记录，测试之间复用同一个实例时用。 */
  reset(): void {
    this.calls.length = 0
  }
}

/** 判定"是不是生产环境"用得到的最小环境形状。 */
export interface ProdCheckEnv {
  NODE_ENV?: string
}

/**
 * 生产环境启用 mock LLM 直接拒启。
 *
 * 后果与 `@taizan/geo-engines` 的 mock 引擎一样隐蔽：分析结果会变成一整套编好的
 * "提及率 100%"，报表看起来完全正常，没有任何报错。
 *
 * @param env - 一般传 `process.env` 或框架的 `ConfigService` 快照
 * @param enabledProviderNames - 当前启用的 provider 名列表（含主与备）；不传表示
 *   "调用方正要用 mock"，等价于传 `['mock']`
 * @throws `NODE_ENV === 'production'` 且启用列表里出现 `'mock'` 时抛
 */
export function assertMockNotInProd(
  env: ProdCheckEnv,
  enabledProviderNames: readonly string[] = ['mock'],
): void {
  if (env?.NODE_ENV === 'production' && enabledProviderNames.includes('mock')) {
    throw new Error(
      '[@taizan/llm] 生产环境（NODE_ENV=production）检测到启用了 mock LLM provider，' +
        '分析结果会被编造且不报错——拒绝启动。请检查 LLM_PRIMARY_PROVIDER / ' +
        'LLM_FALLBACK_PROVIDERS 等配置。',
    )
  }
}
