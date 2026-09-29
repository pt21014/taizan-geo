/**
 * 这个应用真的在用的配额维度（蓝图 §4.5）。
 *
 * ## 为什么需要这么一份清单
 *
 * `QuotaKind` 是框架 schema（`02-plan.prisma`）里的枚举，它列的是**平台一共可能卖
 * 哪些额度**（员工数 / 门店数 / 会员数 / 存储 / 流量 / 自定义）。但一个具体的应用
 * 通常只用其中两三档，其余的计数行根本不存在。
 *
 * bootstrap 下发 `quotas` 时如果按枚举全量下发，前端顶栏会出现一排「0 / 不限量」的
 * 空条目；反过来如果按 `QuotaCounter` 表里**已有的行**下发，那么「还没用过的那一档」
 * 在用满之前都不会出现——顶栏会突然多出一条，看着像 bug。
 *
 * 所以由应用显式列一份：**这几档，永远下发，哪怕计数是 0。**
 *
 * @packageDocumentation
 */

/**
 * bootstrap 下发的配额维度。
 *
 * 值必须是 `QuotaKind` 枚举里的字面量（写错的表现是那一项恒为 `0 / 不限量`，
 * 因为 `QuotaCounter` 里永远查不到那个 kind 的行——不报错，只是永远显示对不上）。
 *
 * - `STAFF`：员工数。框架侧的邀请/加人流程（T1-6）会扣它。
 * - `GEO_BRAND` / `GEO_PROMPT` / `GEO_ENGINE`：GEO 的三档**存量型**配额
 *   （建一个 +1、删一个 −1，与 STAFF 同形）。
 * - `GEO_QUERY_MONTHLY`：**月度型**，只 consume 不 release，由 leader cron
 *   `geo-quota-month-reset` 每月 1 日归零。顶栏要能看见"这个月还剩多少次"。
 * - `CUSTOM`：示例业务模块（商品）借用的那一档，见 `goods.service.ts` 的
 *   `GOODS_QUOTA_KIND`。example-goods 删掉时它一起删。
 *
 * **`GEO_CONTENT_MONTHLY` 刻意不在这里**：AI 内容生成是二级功能，顶栏那一排位置
 * 有限，每多一条都让真正要盯的那几条更难看见。它在计费页与用量页仍然查得到
 * （`quota.usage('GEO_CONTENT_MONTHLY')`），只是不占顶栏。
 */
export const BOOTSTRAP_QUOTA_KINDS: readonly string[] = [
  'STAFF',
  'GEO_BRAND',
  'GEO_PROMPT',
  'GEO_ENGINE',
  'GEO_QUERY_MONTHLY',
  'CUSTOM',
]
