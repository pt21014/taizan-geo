/**
 * `LlmProviderRegistry`：按 name 登记 provider，`chatWithFallback` 按给定顺序
 * 依次尝试，主 provider 失败自动切备用。照 `@taizan/sms` 的 registry 写。
 *
 * 每次尝试都记下来（{@link ChatAttempt}），不管最终成不成功——一次 GEO 分析
 * 如果切换过 provider，两次尝试都要能在排障时看到（第一次失败在哪、花了多久），
 * 只留最后一次等于把"主模型一直在超时"这件事藏起来。
 *
 * 与 sms 的一处差别：那边 provider 用返回值表达失败（`{ ok: false }`），这边
 * `chat()` 失败是**抛异常**（各家 SDK 与 HTTP 客户端的失败形态本来就是异常），
 * 所以 fallback 是 try/catch 驱动的，`ChatAttempt.error` 记的是异常消息。
 */
import type { ChatRequest, ChatResponse, LlmChatContext, LlmProvider } from './types'

/** 一次尝试的记录。 */
export interface ChatAttempt {
  provider: string
  ok: boolean
  /** 失败时的异常消息；成功时不该有。 */
  error?: string
  /** 这次尝试耗时（毫秒）。 */
  elapsedMs: number
}

/** `chatWithFallback` 的返回值。 */
export interface ChatOutcome {
  /** 最终生效的那次响应。 */
  response: ChatResponse
  /** 实际产出结果的 provider 名。 */
  provider: string
  /** 按尝试顺序排列的全部记录，长度 ≥ 1。 */
  attempts: ChatAttempt[]
}

export class LlmProviderRegistry {
  private readonly providers = new Map<string, LlmProvider>()

  /** 登记一个 provider。同名重复登记会覆盖前一个——通常只在测试里这么用。 */
  register(provider: LlmProvider): this {
    this.providers.set(provider.name, provider)
    return this
  }

  /** 取一个已登记的 provider。 */
  get(name: string): LlmProvider {
    const provider = this.providers.get(name)
    if (!provider) {
      throw new Error(`[@taizan/llm] 未登记的 LLM provider："${name}"`)
    }
    return provider
  }

  /** 已登记的 provider 名列表。 */
  names(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * 按 `order` 依次尝试，第一个成功的即返回。
   *
   * @param cfgByProvider - 每个 provider 名对应的配置对象（各家形状不同，见 `providers/*`）
   * @param order - 尝试顺序，`order[0]` 是主 provider
   * @throws `order` 为空、出现未登记的 provider 名、某个 provider 缺配置，
   *   以及**全部尝试都失败**时抛（最后一个异常原样往上抛，并在 message 里
   *   带上每一次的失败原因）
   */
  async chatWithFallback(
    req: ChatRequest,
    cfgByProvider: Record<string, unknown>,
    order: string[],
    ctx: LlmChatContext,
  ): Promise<ChatOutcome> {
    if (!order || order.length === 0) {
      throw new Error('[@taizan/llm] chatWithFallback 至少需要一个 provider')
    }

    const attempts: ChatAttempt[] = []
    let lastError: unknown
    for (const name of order) {
      const provider = this.get(name)
      if (!(name in cfgByProvider)) {
        throw new Error(`[@taizan/llm] provider "${name}" 缺少配置（cfgByProvider 里没有这一项）`)
      }
      const startedAt = Date.now()
      try {
        const response = await provider.chat(req, cfgByProvider[name], ctx)
        attempts.push({ provider: name, ok: true, elapsedMs: Date.now() - startedAt })
        return { response, provider: name, attempts }
      } catch (e) {
        lastError = e
        attempts.push({
          provider: name,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          elapsedMs: Date.now() - startedAt,
        })
      }
    }

    const summary = attempts.map((a) => `${a.provider}: ${a.error}`).join('; ')
    const err = new Error(`[@taizan/llm] 所有 LLM provider 都失败了 —— ${summary}`)
    // 保留最后一个原始异常，排障时还能看到栈
    ;(err as Error & { cause?: unknown }).cause = lastError
    throw err
  }
}
