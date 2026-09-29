/**
 * 引擎适配器 registry 的**装配点**（GEO P0 技术设计 §2.1）。
 *
 * 形状照抄 `src/notify/channels.ts` 里短信通道的装配：
 * 一个工厂函数把 provider 一个个 `register()` 进去，mock 那一条在装配期就调
 * `assertMockNotInProd`——`NODE_ENV=production` 还挂着 mock 直接拒启，而不是等到
 * 某天有人发现报表是编的。
 *
 * ## 为什么是 provider 而不是 service
 *
 * `EngineRegistry` 是 `@taizan/geo-engines` 的**普通类**，零框架依赖、没有
 * `@Injectable()`。给它套一个 Nest service 外壳只是为了能注入，而那层外壳除了
 * 转发 `get()` 什么也不做。用 `{ provide: GEO_ENGINE_REGISTRY, useFactory }`
 * 之后，注入点写 `@Inject(GEO_ENGINE_REGISTRY) registry: EngineRegistry`，
 * 拿到的就是包里那个类本身——**跑批 handler 直接对着包的 API 写**，不隔一层。
 *
 * ## `openai` 这个 code 注册的是 Responses 版本
 *
 * `OpenAiCompatibleEngineAdapter`（`/chat/completions`）与
 * `OpenAiResponsesEngineAdapter`（`/responses` + `web_search`）的 `code` **都是
 * `'openai'`**，而 `EngineRegistry.register()` 对重复 code 是直接抛错、不覆盖。
 * 所以这里只能二选一，选的是 **Responses 版**：GEO 要的是「引擎自己联网之后会引谁」，
 * 而 chat/completions 那条协议上根本没有 `web_search` 工具——用它接 openai.com
 * 拿回来的是一段没有引用的纯生成文本，`citations` 恒为空数组，可见度报表里
 * 「引用率」那一列会永远是 0 且不报错。
 *
 * 要接 DeepSeek / Kimi / vLLM / 自建网关（只实现了 chat/completions）时，
 * 换成 `new OpenAiCompatibleEngineAdapter()` 即可——两者的 `ask()` 签名完全一样，
 * 换一行、重启，`GeoEngine` 表一个字都不用改。**刻意不做成"按 baseUrl 猜"**：
 * 猜错的后果是引用静默消失，而那正是这个产品的核心指标。
 *
 * ## 为什么七家全部注册，而不是「按库里 enabled 的行动态注册」
 *
 * registry 是进程级单例，装配发生在启动时；而 `GeoEngine.enabled` 是运行时会变的
 * 一列（平台运营在后台点一下开关）。按库装配的话，运营启用一个引擎要重启进程才
 * 生效——而他不会知道这件事，表现是「开了但没用」。
 *
 * 正确的分工是：**registry 回答"代码里有没有这个引擎的实现"，DB 回答"平台此刻
 * 想不想用它"**。跑批时两者都要过：`GeoEngine.enabled = true` 且
 * `registry.has(code)`。后者不成立说明后台启用了一个代码里还没实现的 code，
 * `registry.get()` 会立刻抛——这正是该发生的事。
 *
 * @packageDocumentation
 */

import type { Provider } from '@nestjs/common'
import {
  assertMockNotInProd,
  DoubaoEngineAdapter,
  EngineRegistry,
  ErnieEngineAdapter,
  HunyuanEngineAdapter,
  MetasoEngineAdapter,
  MockEngineAdapter,
  OpenAiResponsesEngineAdapter,
  QwenEngineAdapter,
  ZhipuEngineAdapter,
  type ProdCheckEnv,
} from '@taizan/geo-engines'

/**
 * 注入令牌。
 *
 * 用 `Symbol` 而不是字符串：字符串令牌在两个模块各写一遍时会静默指向同一个
 * provider，而 `Symbol` 必须 import，撞不了。
 */
export const GEO_ENGINE_REGISTRY = Symbol('GEO_ENGINE_REGISTRY')

/**
 * 建一个装好全部适配器的 registry。
 *
 * 导出成普通函数（而不是只有 provider）是为了让 spec 与 seed 能直接用它，
 * 不必起一个 Nest 容器。
 *
 * @param env - 用来判定「是不是生产环境」，一般传 `process.env`
 * @returns 已登记 7 家真实引擎（+ 非生产环境下的 mock）的 registry
 * @throws `NODE_ENV === 'production'` 时……不会抛：生产环境**根本不注册** mock，
 *   见下面的说明。真正会抛的是「跑批时库里 enabled 了 mock」那条路径。
 */
export function createGeoEngineRegistry(env: ProdCheckEnv): EngineRegistry {
  const registry = new EngineRegistry()
    .register(new QwenEngineAdapter())
    .register(new ErnieEngineAdapter())
    .register(new HunyuanEngineAdapter())
    .register(new ZhipuEngineAdapter())
    .register(new MetasoEngineAdapter())
    .register(new DoubaoEngineAdapter())
    // `code: 'openai'`——理由见文件头。
    .register(new OpenAiResponsesEngineAdapter())

  // ── mock：只在非生产注册 ──────────────────────────────────────────────
  //
  // 与 `notify/channels.ts` 那边的写法有一处刻意的差别：短信那边是「无条件注册
  // mock，再调 assertMockNotInProd 拒启」，这边是「生产环境干脆不注册」。
  //
  // 差别的来源是两种 mock 的后果不同。mock 短信发不出去，业务上是「验证码收不到」，
  // 用户立刻就会喊。mock 引擎则会**编造出一整套看起来完全正常的可见度数据**——
  // 提及率、位次、引用全都有，客户拿它开了三周会才发现是假的。所以生产环境里
  // 它连"能被 registry.get('mock') 取到"这件事都不该成立。
  //
  // `assertMockNotInProd` 仍然调一次：它守的是"有人把下面这行 if 删了"。两道
  // 防线各守一侧——if 守装配，assert 守那个 if 本身。
  assertMockNotInProd(env, isProd(env) ? [] : ['mock'])
  if (!isProd(env)) {
    registry.register(new MockEngineAdapter())
  }

  return registry
}

/** 生产环境判定。只看 `NODE_ENV`，与 `assertMockNotInProd` 的判据保持一致。 */
function isProd(env: ProdCheckEnv): boolean {
  return env?.NODE_ENV === 'production'
}

/**
 * Nest provider。`GeoModule` 的 `providers` 里挂上它，注入点用
 * `@Inject(GEO_ENGINE_REGISTRY) private readonly engines: EngineRegistry`。
 */
export const geoEngineRegistryProvider: Provider = {
  provide: GEO_ENGINE_REGISTRY,
  useFactory: (): EngineRegistry => createGeoEngineRegistry(process.env),
}
