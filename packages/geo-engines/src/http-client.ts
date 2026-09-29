/**
 * 本包不 import axios，也不直接用全局 `fetch`——让调用方决定用什么发请求
 * （Node 内置 fetch、axios、还是测试里的假实现）。
 *
 * 这样 `buildXxxRequest` / `parseXxxResponse` 这些纯函数可以在裸 node 环境里
 * 跑单测，不需要真的把请求发到引擎厂商那边去（一次请求要真金白银）。
 */

/** 一次 HTTP 请求的完整描述，`buildXxxRequest` 的返回值。 */
export interface HttpRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  /** 已序列化好的请求体；GET 请求没有。 */
  body?: string
}

/** 一次 HTTP 响应。 */
export interface HttpResponse {
  status: number
  body: string
  /** 响应头，key 建议小写；本包只在少数引擎里读它，缺省也能工作。 */
  headers?: Record<string, string>
}

/** `HttpClient.request` 的可选项：超时与取消都交给调用方的实现去落地。 */
export interface HttpRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/** 极简 HTTP 客户端接口。 */
export interface HttpClient {
  request(req: HttpRequest, opts?: HttpRequestOptions): Promise<HttpResponse>
}
