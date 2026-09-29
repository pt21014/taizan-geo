/**
 * 蓝图 §7 扩展点③ **注册权限点**：模块内定义，`src/registry/permissions.ts` 汇总。
 *
 * ## 只有一条，而且是给**商家侧**用的
 *
 * 平台侧的 `/api/platform/geo/engines`（CRUD + 密钥 + 测试）**没有权限点**——
 * 与 T1-7 那批平台控制器保持一致：它们全都只有 `@Auth('platform')`，一个
 * `@RequirePermission` 都没挂（理由写在 `modules/platform/platform.permissions.ts`：
 * 平台侧的角色体系还没定下来，空手猜一批权限点出来只会变成死权限）。
 *
 * 这里这一条 `geo-engine:list` 挂的是**商家侧的只读接口**
 * `GET /api/admin/geo/engines`——品牌表单上那个「监测引擎」下拉框的数据源。
 *
 * ## 为什么给一个下拉框的数据源单独开一个权限点
 *
 * 不开的话只有两个选择：挂 `@Public()`（那就是把平台接了哪几家引擎公开出去，
 * 顺带白送一个不限流的探测端点），或者复用 `geo-brand:list`（那么「只能看 Prompt
 * 不能看品牌」的角色会拿不到引擎清单，表单上那个下拉框对他永远是空的，
 * 而他看到的现象是「保存不了」）。
 *
 * 这一条只回 `{ code, name, vendor, accessType }` 四个字段，**没有任何密钥字段**，
 * 也不回单价与限速（那是平台的成本参数，不是商家该看的）。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** GEO 引擎模块的权限点（商家侧只读那一条）。 */
export const GEO_ENGINE_PERMISSIONS = definePermissions({
  'geo-engine:list': { module: 'GEO 引擎', name: '查看可选的监测引擎', type: 'API' },
})
