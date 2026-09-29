/**
 * `@taizan/sms` 的 {@link HttpClient} 在 apps/api 侧的落地实现。
 *
 * `@taizan/sms` 只认 `post(url, body, headers): Promise<{status, body}>`——比
 * `@taizan/geo-engines`/`@taizan/llm` 那套 `request(req, opts)` 更窄（没有超时/取消入口，
 * 短信发送是一次性调用，不像引擎请求那样需要跑批 worker 的取消信号）。三个包各自
 * 声明自己的 `HttpClient` 是刻意的（见 `modules/geo/engine/http-client.ts` 文件头），
 * 接口适配统一发生在应用侧，这里是第三份。
 *
 * @packageDocumentation
 */
import type { HttpClient, HttpResponse } from '@taizan/sms'

/**
 * 造一个短信 provider 用的 HTTP 客户端。
 *
 * @param fetchImpl - 自定义 fetch，测试里塞假实现用；默认 `globalThis.fetch`
 */
export function createSmsHttpClient(fetchImpl: typeof globalThis.fetch = globalThis.fetch): HttpClient {
  return {
    async post(url: string, body: string, headers: Record<string, string>): Promise<HttpResponse> {
      const res = await fetchImpl(url, { method: 'POST', headers, body })
      return { status: res.status, body: await res.text() }
    },
  }
}
