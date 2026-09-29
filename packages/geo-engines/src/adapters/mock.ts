/**
 * Mock 引擎：不发任何请求，按 `credentials.scenario` 返回**确定性**的回答。
 *
 * 凭据键名（`EngineAskContext.credentials`）：
 *   - `scenario`         —— 见下表，默认 `mention`
 *   - `brandName`        —— 本品牌名，默认 `示例品牌`
 *   - `brandDomain`      —— 本品牌官网域名，默认 `example.com`
 *   - `competitorNames`  —— 竞品名，逗号分隔，默认 `竞品甲,竞品乙`
 *
 * 八个场景（《GEO-P0技术设计.md》§2.1）：
 *
 * | scenario     | 行为 |
 * |--------------|------|
 * | `mention`    | 回答含品牌名、位次 1、2 条引用（其一是品牌官网） |
 * | `no-mention` | 回答不含品牌名，citations 空 |
 * | `competitor` | 只提竞品，不提本品牌 |
 * | `cited`      | 提及 + 引用本品牌官网（只有官网这一条引用） |
 * | `negative`   | 提及但语气负面 |
 * | `timeout`    | sleep `ctx.timeoutMs ?? 50` 毫秒后抛 TIMEOUT（可重试） |
 * | `rate-limit` | 立即抛 RATE_LIMIT（可重试） |
 * | `auth-fail`  | 立即抛 AUTH（不可重试） |
 *
 * 为什么输出必须确定性：`analysis` 模块的提及/位次/情感判定、以及 e2e 里
 * "跑一次批量、断言聚合数字"这类用例，都是拿 mock 的回答当输入的。回答只要有
 * 一点随机，e2e 就会变成偶发红——那比没有 e2e 更糟。所以 `latencyMs` 固定 12、
 * `usage` 固定，绝不用 `Math.random()`、也不读时钟。
 */
import { dedupeCitations } from '../citation'
import { EngineError } from '../errors'
import type {
  EngineAdapter,
  EngineAskContext,
  EngineAskInput,
  EngineAskOutput,
  EngineCitation,
} from '../types'

/** mock 支持的场景名。 */
export type MockScenario =
  | 'mention'
  | 'no-mention'
  | 'competitor'
  | 'cited'
  | 'negative'
  | 'timeout'
  | 'rate-limit'
  | 'auth-fail'

/** 全部场景名，按技术设计 §2.1 的顺序；spec 与平台后台的下拉框都用它。 */
export const MOCK_SCENARIOS: readonly MockScenario[] = [
  'mention',
  'no-mention',
  'competitor',
  'cited',
  'negative',
  'timeout',
  'rate-limit',
  'auth-fail',
]

/** 固定的耗时与用量，保证同样的入参永远得到同样的输出。 */
const FIXED_LATENCY_MS = 12
const FIXED_USAGE = { inputTokens: 42, outputTokens: 128, searchCalls: 1 } as const
const MOCK_MODEL = 'mock-engine-v1'

/** `buildMockAnswer` 的入参：已归一化的 mock 配置。 */
export interface MockSettings {
  scenario: MockScenario
  brandName: string
  brandDomain: string
  competitorNames: string[]
}

function readSettings(credentials: Record<string, string>): MockSettings {
  const raw = credentials?.['scenario'] ?? 'mention'
  const scenario = (MOCK_SCENARIOS as readonly string[]).includes(raw)
    ? (raw as MockScenario)
    : 'mention'
  const competitorNames = (credentials?.['competitorNames'] ?? '竞品甲,竞品乙')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  return {
    scenario,
    brandName: credentials?.['brandName'] ?? '示例品牌',
    brandDomain: credentials?.['brandDomain'] ?? 'example.com',
    competitorNames: competitorNames.length > 0 ? competitorNames : ['竞品甲'],
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 按场景生成回答与引用。导出是为了让 `analysis` 模块的 spec 能直接拿这份文本
 * 当输入，而不用先起一个假 HttpClient。纯函数。
 */
export function buildMockAnswer(
  input: EngineAskInput,
  settings: MockSettings,
): { text: string; citations: EngineCitation[] } {
  const { scenario, brandName, brandDomain, competitorNames } = settings
  const first = competitorNames[0] ?? '竞品甲'
  const second = competitorNames[1] ?? '竞品乙'
  const q = input.prompt

  switch (scenario) {
    case 'no-mention':
      return {
        text: `关于「${q}」，目前市场上比较常见的做法是先看需求再选型，没有哪一家是绝对最优的。`,
        citations: [],
      }
    case 'competitor':
      return {
        text: `关于「${q}」，比较多人推荐的是 ${first}，其次是 ${second}。${first} 的覆盖面更广，${second} 胜在价格。`,
        citations: [
          { url: `https://zhihu.com/question/mock-${first}`, title: `${first} 用得怎么样`, siteName: '知乎' },
          { url: `https://36kr.com/p/mock-${second}`, title: `${second} 产品测评`, siteName: '36氪' },
        ],
      }
    case 'cited':
      return {
        text: `关于「${q}」，${brandName} 是目前比较主流的选择，官方资料里对适用场景写得很清楚。`,
        citations: [
          { url: `https://${brandDomain}/docs/intro`, title: `${brandName} 官方介绍`, siteName: brandName },
        ],
      }
    case 'negative':
      return {
        text: `关于「${q}」，${brandName} 也有人用，但反馈里投诉不少：上手成本高、售后响应慢，不太推荐新手直接选。相比之下 ${first} 的口碑更稳。`,
        citations: [
          { url: 'https://zhihu.com/question/mock-negative', title: `${brandName} 踩坑记录`, siteName: '知乎' },
        ],
      }
    case 'mention':
    default:
      return {
        text: `关于「${q}」，比较推荐的是 ${brandName}，它在这个场景下的完成度最高；其次可以看看 ${first}。`,
        citations: [
          { url: `https://${brandDomain}/product`, title: `${brandName} 产品页`, siteName: brandName },
          { url: 'https://zhihu.com/question/mock-mention', title: '大家都在用什么', siteName: '知乎' },
        ],
      }
  }
}

/** Mock 引擎适配器。 */
export class MockEngineAdapter implements EngineAdapter {
  readonly code = 'mock' as const

  async ask(input: EngineAskInput, ctx: EngineAskContext): Promise<EngineAskOutput> {
    const settings = readSettings(ctx.credentials ?? {})

    switch (settings.scenario) {
      case 'timeout': {
        // 真的等一下再抛：上层的超时/退避逻辑要能在 e2e 里被触发到，
        // 立即抛的话连"超时发生在请求中途"这件事都模拟不出来。
        await sleep(input.timeoutMs ?? ctx.timeoutMs ?? 50)
        throw new EngineError('TIMEOUT', '[mock] scenario=timeout：模拟引擎超时')
      }
      case 'rate-limit':
        throw new EngineError('RATE_LIMIT', '[mock] scenario=rate-limit：模拟引擎限流')
      case 'auth-fail':
        throw new EngineError('AUTH', '[mock] scenario=auth-fail：模拟引擎鉴权失败')
      default:
        break
    }

    const { text, citations } = buildMockAnswer(input, settings)
    return {
      text,
      citations: dedupeCitations(citations),
      usage: { ...FIXED_USAGE, searchCalls: citations.length > 0 ? 1 : 0 },
      model: ctx.model ?? MOCK_MODEL,
      latencyMs: FIXED_LATENCY_MS,
      raw: { mock: true, scenario: settings.scenario, prompt: input.prompt },
      finishReason: 'stop',
    }
  }
}

/** 判定"是不是生产环境"用得到的最小环境形状。 */
export interface ProdCheckEnv {
  NODE_ENV?: string
}

/**
 * 生产环境启用 mock 引擎直接拒启。
 *
 * mock 在生产跑起来的后果比短信那边还隐蔽：`GeoVisibilityDaily` 会被灌进一整
 * 套编好的"提及率 100%"，客户看到的是一份完全假的可见度报表，而且没有任何
 * 报错——等有人发现时，历史数据已经脏了几周。所以这条检查放在装配期。
 *
 * @param env - 一般传 `process.env` 或框架的 `ConfigService` 快照
 * @param enabledEngineCodes - 当前启用的引擎 code 列表；不传表示"调用方正要用
 *   mock"，等价于传 `['mock']`
 * @throws `NODE_ENV === 'production'` 且启用列表里出现 `'mock'` 时抛
 */
export function assertMockNotInProd(
  env: ProdCheckEnv,
  enabledEngineCodes: readonly string[] = ['mock'],
): void {
  if (env?.NODE_ENV === 'production' && enabledEngineCodes.includes('mock')) {
    throw new Error(
      '[@taizan/geo-engines] 生产环境（NODE_ENV=production）检测到启用了 mock 引擎，' +
        '可见度报表会被灌入编造的数据且不会报错——拒绝启动。请在平台后台把 GeoEngine ' +
        'code=mock 的记录停用。',
    )
  }
}
