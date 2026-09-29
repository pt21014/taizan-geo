/**
 * `@taizan/geo-engines` 的 {@link HttpClient} 在 apps/api 侧的落地实现。
 *
 * ## 为什么在这里现写一个，而不是复用别处的
 *
 * 仓里已经有一个 `createFetchHttpClient`（`@taizan/wechatpay/src/types.ts`），但它的
 * `HttpClient` 是**另一个接口**：请求体允许 `Uint8Array`（微信要按字节验签）、
 * 响应头必填、超时是**建客户端时定死**的一个常量、没有 `AbortSignal` 入口。
 * 引擎这边三条都不一样——超时是**每个引擎一个值**（`GeoEngine.timeoutMs`，从
 * 5 秒到 2 分钟都有）、要能被上层的取消信号中断（跑批 worker 被 kill 时），
 * 而请求体永远是 JSON 字符串。硬套的话得在调用点为每个引擎现 new 一个客户端，
 * 那比这 40 行贵。
 *
 * 两个包各自定义自己的 `HttpClient` 是刻意的（见两边文件头）：它们都是零框架依赖的
 * 协议层，谁也不该 import 对方。**接口的适配发生在应用侧**，也就是本文件。
 *
 * ## 为什么用全局 `fetch` 而不是 axios / undici
 *
 * Node 22 的全局 `fetch` 够用，且 `AbortSignal.any` / `AbortSignal.timeout` 是标准 API。
 * 引入 axios 要多一个依赖 + 一次 `pnpm install`；undici 虽然是 Node 内部实现，
 * 但显式依赖它等于把 Node 的内部版本写进 lock。
 *
 * ## 超时与取消是两件事，这里合成一个信号
 *
 * - **超时**（`opts.timeoutMs`）来自引擎配置，到点自动中断；
 * - **取消**（`opts.signal`）来自上层（worker 关停、平台后台的测试接口被放弃）。
 *
 * 两者用 `AbortSignal.any([...])` 合并：只写超时的话，进程关停时在途请求会把
 * 关停拖满两分钟；只写取消的话，一个不回包的引擎会永远占住一个 worker 槽位。
 *
 * @packageDocumentation
 */

import type { HttpClient, HttpRequest, HttpRequestOptions, HttpResponse } from '@taizan/geo-engines'

/**
 * 没传 `timeoutMs` 时的兜底超时。
 *
 * 存在的理由不是「有个合理默认值」，而是**绝不允许出现没有超时的请求**：
 * 一条永不返回的 HTTP 请求会占住一个队列 worker 直到进程重启，而队列的表现是
 * 「跑批卡在 60% 不动」，日志里一行错误都没有。正常路径上每次调用都会带着
 * `GeoEngine.timeoutMs` 进来，这个常量只在调用方漏传时生效。
 */
export const DEFAULT_ENGINE_TIMEOUT_MS = 60_000

/**
 * 造一个引擎用的 HTTP 客户端。
 *
 * 无状态、可以全进程共用一个实例——超时与取消都从每次 `request` 的 `opts` 进来，
 * 不藏在闭包里。
 *
 * @param fetchImpl - 自定义 fetch，测试里塞假实现用；默认 `globalThis.fetch`
 */
export function createEngineHttpClient(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): HttpClient {
  return {
    async request(req: HttpRequest, opts?: HttpRequestOptions): Promise<HttpResponse> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const signal =
        opts?.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([timeoutSignal, opts.signal])

      const res = await fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body === undefined ? {} : { body: req.body }),
        signal,
      })

      // 响应头统一小写：`HttpResponse.headers` 的契约写着「key 建议小写」，
      // 而少数适配器会去读 `retry-after`。大小写不一致时读不到，表现是
      // 「限流退避永远用兜底秒数」——不报错，只是退避策略静默失效。
      const headers: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })

      return { status: res.status, body: await res.text(), headers }
    },
  }
}
