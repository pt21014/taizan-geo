/**
 * GEO 业务模块的汇总模块（GEO-P0 技术设计 §4）。
 *
 * ## 为什么是一个汇总模块，而不是每个子模块各进 `app.module.ts`
 *
 * GEO 在 P0 之后有 10 个子目录（brand / prompt / engine / run / analysis / aggregate /
 * dashboard / alert / report / usage）。每个各进一次 `AppModule.imports` 的话，
 * 那份清单会被 GEO 的十行占满，而它们是同一块业务；更要紧的是子模块之间要互相注入
 * （prompt 要 brand 的 `requireBrand`，run 要 brand 的配置），分成十个 Nest 模块
 * 就得写十条 `imports` + `exports`，而它们本来就是一起生死的。
 *
 * 所以这一层是**一个** Nest 模块，子目录只是文件组织。`app.module.ts` 里只有
 * `GeoModule` 一行——删掉 GEO = 删一个目录 + 删这一行。
 *
 * ## 七个扩展点在这个目录里各占一处
 *
 * | # | 扩展点 | 在哪 |
 * |---|---|---|
 * | ① | 表 | `prisma/schema/10-business/20-geo.prisma`（T3 已就绪，本任务不改） |
 * | ② | 注册隔离 | `src/tenancy/tenant-models.ts` 里那 13 个模型名（T3 已登记） |
 * | ③ | 注册权限点 | 每个子目录一个 `*.permissions.ts`（brand / prompt / engine / run / dashboard / citation / alert / report / usage） |
 * | ④ | 注册菜单 | `geo.menus.ts` → `src/registry/menus.ts` 汇总 |
 * | ⑤ | 注册套餐功能项 | `src/registry/features.ts` 里那条 `key: 'geo.monitor'` |
 * | ⑥ | 注册审计动作 | `src/registry/audit-actions.ts` + 控制器上的 `@Audit` |
 * | ⑦ | 注册队列任务 | 五条：`run/geo-run-dispatch`、`run/geo-query-execute`、`analysis/geo-result-analyze`、`aggregate/geo-daily-aggregate`、`alert/geo-alert-evaluate`，汇总在 `src/registry/jobs.ts` |
 *
 * T4 期间扩展点⑦是空的，那是刻意的：品牌/问法都是纯 CRUD，没有异步活要干，
 * 而留一个空转的 handler 只会让「这个应用有哪些后台任务」这份清单多一条假的。
 * 真正的队列任务从 T6 的跑批流水线开始。
 *
 * @packageDocumentation
 */

import { Module } from '@nestjs/common'

import { GeoDailyAggregateCron } from './aggregate/geo-daily-aggregate.cron'
import { GeoDailyAggregateHandler } from './aggregate/geo-daily-aggregate.handler'
import { GeoAlertEvaluateHandler } from './alert/geo-alert-evaluate.handler'
import { GeoAlertController, GeoAlertEventController } from './alert/geo-alert.controller'
import { GeoAlertService } from './alert/geo-alert.service'
import { geoLlmProvider } from './analysis/geo-llm.provider'
import { GeoResultAnalyzeHandler } from './analysis/geo-result-analyze.handler'
import { GeoBrandController } from './brand/geo-brand.controller'
import { GeoBrandService } from './brand/geo-brand.service'
import { GeoCitationController } from './citation/geo-citation.controller'
import { GeoCitationService } from './citation/geo-citation.service'
import { GeoDashboardController } from './dashboard/geo-dashboard.controller'
import { GeoDashboardService } from './dashboard/geo-dashboard.service'
import { GeoEnginePublicController } from './engine/geo-engine-public.controller'
import { geoEngineRegistryProvider } from './engine/geo-engine-registry.provider'
import { GeoEngineController } from './engine/geo-engine.controller'
import { GeoEngineService } from './engine/geo-engine.service'
import { GeoPromptController } from './prompt/geo-prompt.controller'
import { GeoPromptService } from './prompt/geo-prompt.service'
import { GeoReportController } from './report/geo-report.controller'
import { GeoReportService } from './report/geo-report.service'
import { GeoWeeklyReportCron } from './report/geo-weekly-report.cron'
import { GeoQuotaMonthResetCron } from './run/geo-quota-month-reset.cron'
import { GeoQueryExecuteHandler } from './run/geo-query-execute.handler'
import { GeoRateLimiter } from './run/geo-rate-limiter'
import { GeoResultController } from './run/geo-result.controller'
import { GeoRunController } from './run/geo-run.controller'
import { GeoRunDispatchHandler } from './run/geo-run-dispatch.handler'
import { GeoRunScheduleCron } from './run/geo-run-schedule.cron'
import { GeoRunSweeperCron } from './run/geo-run-sweeper.cron'
import { GeoRunService } from './run/geo-run.service'
import { GeoPlatformRunController } from './usage/geo-platform-run.controller'
import { GeoPlatformUsageController } from './usage/geo-platform-usage.controller'
import { GeoPlatformUsageService } from './usage/geo-platform-usage.service'
import { GeoUsageController } from './usage/geo-usage.controller'
import { GeoUsageService } from './usage/geo-usage.service'

@Module({
  controllers: [
    GeoBrandController,
    GeoPromptController,
    // 平台侧的引擎管理与商家侧的只读清单是**两个控制器**：身份（`@Auth`）与路由
    // 前缀都是类级装饰器，一个类上挂不了两种。见 `geo-engine-public.controller.ts`。
    GeoEngineController,
    GeoEnginePublicController,
    // T6：跑批与回答明细。两个类而不是一个，是因为路由前缀与权限点都不同——
    // 见 `geo-result.controller.ts` 的文件头。
    GeoRunController,
    GeoResultController,
    // ── T7：聚合之后的五个只读/告警面 ──────────────────────────────────
    // 看板、引用来源、告警规则、报表都是商家侧（`@Auth('staff')` + 权限点）；
    // 用量有两个控制器——商家侧看自己的账，平台侧跨租户看全平台的成本，
    // 身份（`@Auth`）与路由前缀都是类级装饰器，一个类上挂不了两种。
    GeoDashboardController,
    GeoCitationController,
    GeoAlertController,
    GeoAlertEventController,
    GeoReportController,
    GeoUsageController,
    GeoPlatformUsageController,
    GeoPlatformRunController,
  ],
  providers: [
    GeoBrandService,
    GeoPromptService,
    GeoEngineService,
    // 适配器 registry：进程级单例，装配时把 7 家真实引擎（+ 非生产的 mock）登记进去。
    geoEngineRegistryProvider,
    // 限速器：`geo-query-execute.handler.ts` 在 `adapter.ask()` 之前调 `acquire()`。
    GeoRateLimiter,

    // ── T6：跑批与分析流水线 ──────────────────────────────────────────
    GeoRunService,
    // 分析用 LLM 的装配点（按 `GEO_LLM_PROVIDER` 挑一个 `@taizan/llm` 的 provider）。
    geoLlmProvider,
    // 五个 `@JobHandler`。**必须进 providers**：`ProcessorFactory` 用 `DiscoveryService`
    // 扫 Nest 容器里的 provider 找 `@JobHandler`，没进容器的类它扫不到——
    // 表现是消息入队之后永远没人消费，而队列本身一点错都不报。
    GeoRunDispatchHandler,
    GeoQueryExecuteHandler,
    GeoResultAnalyzeHandler,
    GeoDailyAggregateHandler,
    GeoAlertEvaluateHandler,
    // 五个 `@LeaderCron`。同样必须进 providers，理由同上。
    GeoRunScheduleCron,
    GeoQuotaMonthResetCron,
    // T7：跑批兜底清扫（卡在 RUNNING 超过 6 小时的）、每日聚合兜底重算、周报生成。
    GeoRunSweeperCron,
    GeoDailyAggregateCron,
    GeoWeeklyReportCron,

    // ── T7：五个只读/告警面的 service ─────────────────────────────────
    GeoDashboardService,
    GeoCitationService,
    GeoAlertService,
    GeoReportService,
    GeoUsageService,
    GeoPlatformUsageService,
  ],
  // 导出五个。子目录之间互相注入不需要 `exports`（它们在**同一个** Nest 模块里，
  // 这正是 GEO 收成一个模块的理由，见文件头）——这份清单是给**模块之外**看的：
  // `app.module.ts` 里别的模块要用 GEO 的能力时，能拿到的就是这五个。
  exports: [
    GeoBrandService,
    GeoPromptService,
    GeoEngineService,
    GeoRateLimiter,
    GeoRunService,
  ],
})
export class GeoModule {}
