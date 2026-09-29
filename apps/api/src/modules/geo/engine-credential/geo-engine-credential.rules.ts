/**
 * 商家自带引擎密钥的**业务规则纯函数**。
 *
 * 与 `engine/geo-engine.rules.ts` 同一条判据：不碰数据库、不读时钟、不 import
 * `@nestjs/*` 或 `@prisma/client`，让「跑批时到底用谁的密钥」这条判定能被逐条边界
 * 单测钉住——这是**唯一一处真的花钱**的代码路径上的分支点，写错的后果是
 * 商家的 key 被悄悄忽略（多花了平台的钱）或者平台的 key 被悄悄忽略（商家的
 * 查询全部 AUTH 失败）。
 *
 * @packageDocumentation
 */

/** 一条商家自带密钥的取用视角（只看跑批 handler 关心的两件事）。 */
export interface TenantCredentialCandidate {
  enabled: boolean
  credentials: Record<string, string>
}

/**
 * 这次查询该不该用商家自带的密钥。
 *
 * 规则只有一条：**商家配了且启用中的，就用商家的；否则 fallback 到平台**——不存在
 * 「部分字段取商家、部分取平台」这种合并语义（同 `UpdateGeoEngineCredentialsDto`
 * 「整包替换不合并」的既有约定，两边保持一致，调用方不用记两套心智模型）。
 *
 * `candidate` 传 `null` 表示「本店没有为这个 engineCode 配过任何行」；传了对象但
 * `enabled: false`（商家自己停用了）同样 fallback——「配置了但没启用」与
 * 「压根没配置」对这个函数来说是同一件事，都回 `false`。
 *
 * **刻意回布尔而不是直接回凭据**：调用方只有在这里回 `true` 时才需要解出商家的
 * 明文（`candidate.credentials`），回 `false` 时才去解平台的——两条解密路径本来就
 * 互斥，让纯函数直接把两包明文都摆出来反而逼着调用方在不需要的分支上也解一次。
 *
 * @param candidate - 本店为这个 engineCode 配的凭据；查不到时传 `null`
 */
export function shouldUseTenantCredential(candidate: TenantCredentialCandidate | null): boolean {
  return candidate !== null && candidate.enabled
}
