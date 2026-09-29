/**
 * 蓝图 §7 扩展点③ **注册权限点**：模块内定义，`src/registry/permissions.ts` 汇总。
 *
 * ## 为什么「看列表」与「触发一次」是两档
 *
 * `geo-run:trigger` 是这个模块里唯一一个**会花钱**的动作：点一下等于
 * `问法数 × 引擎数 × 采样数` 次真实的引擎调用，直接计入平台的厂商账单、
 * 也直接扣商家的 `GEO_QUERY_MONTHLY`。
 *
 * 合成一档 `geo-run:manage` 的话，「让新来的运营能看跑批进度」就必然连带
 * 「能把这个月的额度一次点光」。而那个动作没有撤销键——钱花出去了。
 *
 * ## 为什么回答明细单开 `geo-result:view`
 *
 * 见 `geo-result.controller.ts` 的文件头：回答原文是引擎返回的全文，
 * 「能看进度」与「能看每一条全文」是两个量级的授权。
 *
 * ## 平台侧的跑批监控（`/api/platform/geo/runs`）不在这里
 *
 * 那是 T7 的事，而且与 T1-7 那批平台控制器一致：平台侧只有 `@Auth('platform')`，
 * 一个 `@RequirePermission` 都不挂（理由见 `modules/platform/platform.permissions.ts`）。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 跑批与回答明细的权限点。 */
export const GEO_RUN_PERMISSIONS = definePermissions({
  'geo-run:list': { module: 'GEO 跑批', name: '查看监测任务与进度', type: 'API' },
  'geo-run:trigger': { module: 'GEO 跑批', name: '【会花钱】立即刷新一次监测', type: 'API' },
  'geo-result:view': { module: 'GEO 跑批', name: '查看回答明细与原文', type: 'API' },
})
