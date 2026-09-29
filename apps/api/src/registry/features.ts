/**
 * 五张注册表之三：**套餐功能项**（蓝图 §4.5、§7 扩展点⑤）。
 *
 * 功能项 = 平台在套餐里能勾掉的一个能力。`Plan.features` 是三态：
 * `null` 全部可用 / `[]` 一个都不给 / 非空数组只给列出的这些。
 *
 * 两条硬约束（由 `billing-routes.spec.ts`，spec 8，T1-5 守）：
 * 1. `pathPrefixes` 必须与真实 `@Controller` 前缀对得上——写错等于闸门静默失效，
 *    接口照常通，而平台以为自己锁住了；
 * 2. **不许盖住 {@link ALWAYS_WRITABLE_PREFIXES}**（`/api/admin/auth`、`/api/admin/billing`、
 *    `/api/admin/bootstrap`）。盖住了就是「到期 → 后台只读 → 续不了费 → 永远到期」的死循环，
 *    而平台恰恰是想收钱的那一方。
 *
 * @packageDocumentation
 */

import {
  ALWAYS_WRITABLE_PREFIXES,
  assertFeatureNotShadowingRenewal,
  type FeatureDef,
} from '@taizan/billing-rules'

/** 全应用功能项表。 */
export const FEATURES: readonly FeatureDef[] = [
  {
    key: 'goods',
    name: '商品模块',
    // 只拦写不拦读：套餐没含商品模块时，已有商品仍然看得见（不然商家会以为数据丢了），
    // 只是新增/改/删被拦。这是「降级」而不是「删功能」。
    writeOnly: true,
    pathPrefixes: ['/api/admin/goods'],
  },
  {
    key: 'geo.monitor',
    name: 'GEO 监测',
    // 只拦写不拦读：套餐没含 GEO 时，已有品牌与历史趋势仍然看得见
    // （不然商家会以为半年的数据丢了），只是新增/改/删被拦。
    // 这是「降级」而不是「删功能」。
    writeOnly: true,
    // `billing-routes.spec.ts`（spec 8）会检查每一条前缀都有真实控制器兑现，
    // 所以**先写前缀后建控制器**会直接判红，顺序不能反。
    //
    // T6 追加了 `/api/admin/geo/runs`——「立即刷新」是这个模块里唯一一个
    // 按一下就花钱的写操作，套餐到期之后第一个该拦的就是它。
    //
    // `/api/admin/geo/results` **刻意不加**：那个控制器一个写方法都没有，而本功能项是
    // `writeOnly: true`，加进去不改变任何行为，只会让这份清单看起来管着它其实没管的东西。
    pathPrefixes: [
      '/api/admin/geo/brands',
      '/api/admin/geo/prompts',
      '/api/admin/geo/runs',
    ],
  },
  // ── 关于 `geo.daily_refresh`（技术设计 §4.1 提过的「日频刷新」权益位） ──
  //
  // **本任务刻意没有注册它。** 原因是 spec 8 有两条硬约束：每个功能项的
  // `pathPrefixes` 必须非空，且每条前缀都要有一个真实的 `@Controller` 前缀兑现。
  // 而「日频刷新」根本不是一条路由——它是 `geo-run-schedule` cron 里的一个判断。
  // 为了凑一条前缀去造一个 `/api/admin/geo/runs/daily` 控制器，等于为了让注册表好看
  // 而在路由表上留一条没人调的假路由，那比不注册更糟。
  //
  // T6 的做法是在 cron 里直接按 `GeoBrand.refreshFreq` 放行，TODO 写在
  // `modules/geo/run/geo-run-schedule.cron.ts` 的文件头。
]

/** 续费白名单前缀（框架常量，re-export 便于本应用侧查阅）。 */
export { ALWAYS_WRITABLE_PREFIXES }

// 加载期就把「功能项盖住了续费路径」这件事炸出来，而不是等到某个商家到期那天。
assertFeatureNotShadowingRenewal(FEATURES)
