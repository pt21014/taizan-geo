/**
 * 蓝图 §7 扩展点② **注册隔离**：本应用有哪些表受租户隔离约束。
 *
 * 加一张带 `tenantId` 的表却忘了登记 = **那张表完全没有租户隔离，而且不报错**
 * （xiaodian 2026-08 的真实事故）。所以这里只有三行，而这三行由
 * `test/arch/tenant-models.spec.ts` 与 `prisma/schema/**` 双向比对看着：
 * schema 里带 `tenantId` 却没登记 → 红；登记了但 schema 里查无此列 → 红。
 *
 * @packageDocumentation
 */

import { createBaseRegistry } from '@taizan/prisma-base'

/** 框架 10 张租户表已经预置好，业务只报自己的。 */
export const registry = createBaseRegistry()

// ── 扩展点②：新业务表在这里加名字，一行 ────────────────────────────────
registry.register(['Goods', 'GoodsSku'])

/**
 * GEO 业务的 14 张租户表（`prisma/schema/10-business/20-geo.prisma`）。
 *
 * **不含** `GeoEngine` / `GeoSourcePlatformRule`：那两张在
 * `21-geo-platform.prisma` 里，是平台域（引擎密钥、计价、来源归类规则是平台资产，
 * 全平台一份），它们**没有 tenantId 列**，登记进来 `verifySchema` 会直接判红。
 */
registry.register([
  'GeoBrand',
  'GeoCompetitor',
  'GeoPromptSet',
  'GeoPrompt',
  'GeoQueryRun',
  'GeoQueryResult',
  'GeoMention',
  'GeoCitation',
  'GeoVisibilityDaily',
  'GeoAlertRule',
  'GeoAlertEvent',
  'GeoReport',
  'GeoUsageLedger',
  'GeoEngineCredential',
])

/** 受租户隔离约束的模型全集。传给 `PrismaModule.forRoot({ registered })`。 */
export const TENANT_MODELS = registry.freeze()

/**
 * 有 `deletedAt` 列的模型（软删扩展只碰这些）。
 *
 * **与 `TENANT_MODELS` 是两回事**，不能互相推导：
 * - `AuditLog` 是租户域但**没有**软删（审计不允许被删）；
 * - `PlatformSetting` 之类的平台域表将来也可能有软删。
 *
 * 这份清单同样由 `test/arch/tenant-models.spec.ts` 与 schema 双向比对——
 * 漏登记的表 `delete()` 会真的物理删掉行，而「软删」这件事在读路径上仍然看着正常。
 *
 * process-local: 一份写死在代码里的**不可变**清单，不是运行期状态。
 * 每个进程各建一份是对的（它们逐字节相同），也没有任何东西会往里写。
 */
export const SOFT_DELETE_MODELS: ReadonlySet<string> = new Set([
  // 框架侧
  'TenantCredential',
  'Staff',
  'Member',
  'Role',
  // 业务侧
  'Goods',
  'GoodsSku',
  // GEO：只有"人维护的配置类"表软删（删了还要能按同名重建），
  // 观测流水（GeoQueryRun/Result/Mention/Citation/VisibilityDaily/AlertEvent/Report/
  // UsageLedger）一律硬删——它们要么可由原文重算，要么是审计性质的账，
  // 给流水加软删只会让每张报表都得记得带 `deletedAt IS NULL`。
  'GeoBrand',
  'GeoCompetitor',
  'GeoPromptSet',
  'GeoPrompt',
  'GeoAlertRule',
  'GeoEngineCredential',
])
