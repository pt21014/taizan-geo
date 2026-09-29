/**
 * 蓝图 §7 扩展点③ **注册权限点**：模块内定义，`src/registry/permissions.ts` 汇总。
 *
 * ## 两档：`list` 与 `write`，没有 `delete`
 *
 * 与品牌那边（读/写/删三档）不同：删一条告警规则**不丢任何历史数据**——
 * `GeoAlertEvent` 是单独一张表且**不软删**（`20-geo.prisma` 里那条「审计性质的流水
 * 不允许被删」），规则删了之后历史触发记录照样查得到。
 *
 * 品牌之所以要单开 `delete`，是因为删一个品牌等于丢掉它半年的趋势，不可逆。
 * 告警规则没有这个性质，为它多开一档只会让角色配置页多一行没人分得清的勾选项。
 *
 * 告警事件（`GET /alert-events`）共用 `geo-alert:list`：能配规则的人当然该看得到
 * 规则触发过几次——那正是判断阈值配得合不合理的唯一依据。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 告警规则与告警事件的权限点。 */
export const GEO_ALERT_PERMISSIONS = definePermissions({
  'geo-alert:list': { module: 'GEO 告警', name: '查看告警规则与触发记录', type: 'API' },
  'geo-alert:write': { module: 'GEO 告警', name: '新增/编辑/删除告警规则', type: 'API' },
})
