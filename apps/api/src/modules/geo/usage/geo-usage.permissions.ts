/**
 * 蓝图 §7 扩展点③ **注册权限点**：模块内定义，`src/registry/permissions.ts` 汇总。
 *
 * ## 只有商家侧那一档
 *
 * 平台侧的两个控制器（`/api/platform/geo/usage`、`/api/platform/geo/runs`）
 * **没有权限点**，与 T1-7 那批平台控制器一致（理由见
 * `modules/platform/platform.permissions.ts`：平台侧的角色体系还没定下来，
 * 挂一个接口上不存在的权限点只会让 `pruneMenus` 把菜单永远裁掉）。
 *
 * ## 为什么与 `billing:view` 是两档
 *
 * `billing:view` 看的是**套餐与配额**（还剩多少次）。这一档看的是**成本明细**
 * （这个月在哪个引擎上花了多少分钱）。两者的读者不一样：前者是所有人都该看得到
 * 的"还能不能用"，后者是"这门生意划不划算"。合成一档的话，
 * 「让运营看得到还剩多少额度」会连带把成本结构给他。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 商家侧用量与成本的权限点。 */
export const GEO_USAGE_PERMISSIONS = definePermissions({
  'geo-usage:view': { module: 'GEO 用量', name: '查看本店 GEO 用量与成本', type: 'API' },
})
