/**
 * 蓝图 §7 扩展点③ **注册权限点**：模块内定义，`src/registry/permissions.ts` 汇总。
 *
 * ## 为什么与 `geo-result:view` 是两档
 *
 * 引用来源页看的是「**哪些站点在喂 AI**」：域名、平台、归类、次数。它不含任何
 * 回答正文——正文在 `geo-result:view` 那一档下（那是引擎返回的全文，授权量级不同）。
 *
 * 拆开之后，「让内容/公关团队看得到引用来源榜去做投放」这件事不必连带
 * 「让他们看得到每一条 AI 回答的全文」。这个模块的用户与回答明细页的用户
 * 在真实的公司里往往就不是同一批人。
 *
 * 只有一档（没有 `:write`）：引用行是 `geo.result.analyze` 解析出来的派生数据，
 * 人改不了也不该改——要改就重跑分析。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 引用来源的权限点。 */
export const GEO_CITATION_PERMISSIONS = definePermissions({
  'geo-citation:view': { module: 'GEO 引用', name: '查看引用来源与域名榜', type: 'API' },
})
