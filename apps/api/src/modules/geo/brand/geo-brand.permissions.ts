/**
 * 蓝图 §7 扩展点③ **注册权限点**：模块内定义，`src/registry/permissions.ts` 汇总。
 *
 * 权限点定义在模块目录里而不是集中在注册表文件里，是为了「删掉一个模块 = 删一个目录」。
 * 集中定义的话，删模块时总会留下几个没人再引用的死权限，而死权限在角色配置页上
 * 看起来和活的一模一样。
 *
 * 读 / 写 / 删分三档而不是一个 `geo-brand:manage`：合成一个之后，
 * 「让新来的运营能改品牌配置但不能删掉一个跑了半年的监测对象」就没法表达，
 * 而删掉一个品牌等于丢掉它全部的历史趋势——这是本模块里最不可逆的一个动作。
 *
 * **竞品的增删改共用 `geo-brand:write`**，不单开一档：竞品不是独立实体，
 * 它是品牌配置的一部分（份额 SoV 的分母），能改品牌就该能改它的对照组。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 监测品牌模块的权限点。 */
export const GEO_BRAND_PERMISSIONS = definePermissions({
  'geo-brand:list': { module: 'GEO 品牌', name: '查看监测品牌与竞品', type: 'API' },
  'geo-brand:write': { module: 'GEO 品牌', name: '新增/编辑品牌与竞品', type: 'API' },
  'geo-brand:delete': { module: 'GEO 品牌', name: '删除监测品牌', type: 'API' },
})
