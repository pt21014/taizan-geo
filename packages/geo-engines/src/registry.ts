/**
 * `EngineRegistry`：按 `EngineCode` 登记适配器。
 *
 * 与 `@taizan/sms` 的 registry 有一处刻意的差别：**重复登记直接抛错，不覆盖**。
 * 短信那边覆盖是为了测试方便；这边 registry 是进程启动时装配一次的平台级单例，
 * 同一个 code 被登记两次一定是装配代码写重了，静默覆盖会让"到底跑的是哪个
 * 适配器"变成运行时才能发现的问题——而引擎适配器之间的差别是花钱的。
 */
import type { EngineAdapter, EngineCode } from './types'

export class EngineRegistry {
  private readonly adapters = new Map<EngineCode, EngineAdapter>()

  /**
   * 登记一个适配器。
   *
   * @throws 同一个 `code` 重复登记时抛
   */
  register(adapter: EngineAdapter): this {
    if (this.adapters.has(adapter.code)) {
      throw new Error(`[@taizan/geo-engines] 引擎 "${adapter.code}" 重复登记，装配代码写重了`)
    }
    this.adapters.set(adapter.code, adapter)
    return this
  }

  /**
   * 取一个已登记的适配器。
   *
   * @throws code 未登记时抛（调用方通常是拿 DB 里的 `GeoEngine.code` 来取，
   *   取不到说明平台后台启用了一个代码里还没实现的引擎，必须立刻炸出来）
   */
  get(code: EngineCode): EngineAdapter {
    const adapter = this.adapters.get(code)
    if (!adapter) {
      throw new Error(`[@taizan/geo-engines] 未登记的引擎："${code}"`)
    }
    return adapter
  }

  /** code 是否已登记。 */
  has(code: EngineCode): boolean {
    return this.adapters.has(code)
  }

  /** 已登记的 code 列表，按登记顺序。 */
  codes(): EngineCode[] {
    return [...this.adapters.keys()]
  }
}
