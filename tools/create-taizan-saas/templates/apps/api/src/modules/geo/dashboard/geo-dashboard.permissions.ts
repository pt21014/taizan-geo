/**
 * 蓝图 §7 扩展点③ **注册权限点**：模块内定义，`src/registry/permissions.ts` 汇总。
 *
 * ## 为什么看板只有一档，不分读/写
 *
 * 这个模块**一个写方法都没有**（五条路由全是 `GET`，全部只读 `GeoVisibilityDaily`）。
 * 分不出第二档来——`geo-dashboard:write` 会是一个没有任何路由引用的死权限，
 * 而 `permission-registry.spec.ts`（spec 6）恰好会把死权限判红。
 *
 * ## 为什么它与 `geo-brand:list` 是两档
 *
 * 看板是**全品牌的汇总视角**：谁能看这一页，谁就看得到这家店全部品牌的可见度、
 * 份额与竞品对照。而 `geo-brand:list` 上还挂着 `@DataScope({ ownerField: 'createdBy' })`，
 * 它下发的是"这个员工自己建的那些品牌"。合成一档的话，数据范围在看板这一侧
 * 就被悄悄绕过去了——一个只该看自己那几个品牌的运营，能从看板上读出全店的数字。
 *
 * 所以看板单开一档，默认只给店主与主管角色。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** GEO 看板的权限点。 */
export const GEO_DASHBOARD_PERMISSIONS = definePermissions({
  'geo-dashboard:view': { module: 'GEO 看板', name: '查看 GEO 总览与趋势', type: 'API' },
})
