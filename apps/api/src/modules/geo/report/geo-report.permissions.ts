/**
 * 蓝图 §7 扩展点③ **注册权限点**：模块内定义，`src/registry/permissions.ts` 汇总。
 *
 * ## 「看」与「生成」为什么是两档
 *
 * 看一份报表是零成本的（读一行 Json）。生成一份要把一个周期的日聚合全读一遍再
 * 算一次快照——对一个跑了 90 天、几十条问法的品牌，那是几千行的扫描。
 * 它不会花厂商的钱，但一个连点十次「生成」的人可以让数据库难受一阵子。
 *
 * 更要紧的是语义：`GeoReport.payload` 是**生成那一刻的快照**，同一个周期生成两次
 * 可能得到两份不同的数字（中间补跑过、重算过）。谁能制造这种"官方数字"
 * 应该是一个可以单独授予的权限，而不是"只要看得到报表就能重出一份"。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 报表的权限点。 */
export const GEO_REPORT_PERMISSIONS = definePermissions({
  'geo-report:view': { module: 'GEO 报表', name: '查看周报/月报', type: 'API' },
  'geo-report:generate': { module: 'GEO 报表', name: '手动生成报表快照', type: 'API' },
})
