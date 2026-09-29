/**
 * provider 共用的取值助手。
 *
 * 存在的理由与 `@taizan/geo-engines/src/adapters/shared.ts` 相同：模型服务商的
 * 响应不是我们的契约，少一个 `usage` 字段不该让整批分析炸掉，所以每一处取值
 * 都必须能接受"这个字段可能不存在、也可能不是这个类型"。
 */

/** 未知值 → 普通对象；不是对象（含 null、数组）时返回 undefined。 */
export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** 未知值 → 数组；不是数组时返回空数组。 */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** 未知值 → 非空字符串；不是字符串或是空串时返回 undefined。 */
export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** 未知值 → 有限数字；`NaN`/`Infinity`/非数字返回 undefined。 */
export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 顺着一串 key 往下取，中途断了就返回 undefined。 */
export function pick(root: unknown, ...path: string[]): unknown {
  let cur: unknown = root
  for (const key of path) {
    const rec = asRecord(cur)
    if (!rec) return undefined
    cur = rec[key]
  }
  return cur
}

/** 去掉 baseUrl 末尾的斜杠，避免拼出 `https://x.com//v1/chat`。 */
export function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}
