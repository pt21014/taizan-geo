/**
 * 本包不 import axios，也不直接用全局 `fetch`——让调用方决定用什么发请求。
 *
 * 与 `@taizan/geo-engines` 的 `HttpClient` 是同一个形状（刻意的：apps 侧装配时
 * 可以只写一个实现同时喂给两个包），但两个包各自声明一份，不互相依赖——
 * 一个零框架依赖包为了一个 4 行的接口去依赖另一个包是不划算的。
 */

/** 一次 HTTP 请求的完整描述。 */
export interface HttpRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

/** 一次 HTTP 响应。 */
export interface HttpResponse {
  status: number
  body: string
  headers?: Record<string, string>
}

/** `HttpClient.request` 的可选项。 */
export interface HttpRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/** 极简 HTTP 客户端接口。 */
export interface HttpClient {
  request(req: HttpRequest, opts?: HttpRequestOptions): Promise<HttpResponse>
}
