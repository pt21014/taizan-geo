/**
 * `/api/admin/geo/dashboard` —— GEO 看板的 HTTP 层。五条路由，**全部只读**。
 *
 * ## 这个控制器上有什么，为什么
 *
 * | 装饰器 | 作用 | 谁在看着 |
 * |---|---|---|
 * | `@Auth('staff')` | 只接受商家员工 token | `guard-default-deny.spec.ts`（spec 5） |
 * | 没有 `@Public()` | 于是被全局守卫默认拒绝——**这才是默认行为** | 同上 |
 * | `@RequirePermission('geo-dashboard:view')` | 五条都要它 | `permission-registry.spec.ts`（spec 6） |
 * | 没有 `@Audit` | 只读，不记审计 | —— |
 * | 没有 `@DataScope` | 见下 | —— |
 *
 * ## 为什么没有 `@DataScope`
 *
 * 数据范围翻译成的是一段 `where` 片段，只有「查一批实体」才用得上；这五条查的是
 * **指定品牌的聚合数字**，入口参数就是一个 `brandId`。归属校验由每个方法第一行的
 * `requireBrand(brandId)` 负责——传一个别人家的品牌 id 进来是 1240300，
 * 与品牌页完全同码（不区分「不存在」与「是别人的」，否则就成了存在性探测器）。
 *
 * 「只能看自己建的品牌」这件事由 `geo-dashboard:view` 这个**单独的权限点**表达：
 * 看板是全品牌视角，默认只给店主与主管，不给按数据范围收窄的一线运营。
 * 理由写在 `geo-dashboard.permissions.ts` 里。
 *
 * ## 为什么没有 `featureKey` 相关的东西
 *
 * `geo.monitor` 是 `writeOnly: true` 的降级闸门，而这里一个写方法都没有。
 * 套餐到期之后商家仍然该看得到历史趋势（不然他会以为半年的数据丢了），
 * 与「回答明细」页同一个判据（见 `geo.menus.ts` 里 `geo.result` 那一条的注释）。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Auth } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'

import { Validate } from '../../../common/validate.pipe'
import {
  GeoDashboardCompetitorsView,
  GeoDashboardEnginesView,
  GeoDashboardEngineQueryDto,
  GeoDashboardOverviewView,
  GeoDashboardPromptQueryDto,
  GeoDashboardQueryDto,
  GeoDashboardTrendView,
  GeoPromptMetricsView,
} from './dto/geo-dashboard.dto'
import { GeoDashboardService } from './geo-dashboard.service'

@ApiTags('admin/geo/dashboard')
@Controller('api/admin/geo/dashboard')
@Auth('staff')
export class GeoDashboardController {
  constructor(@Inject(GeoDashboardService) private readonly dashboard: GeoDashboardService) {}

  @Get('overview')
  @ApiOperation({
    summary: '总览：当前周期与上一等长周期的五项指标 + 环比差值 + 最近一次跑批状态',
  })
  @ApiOkResponse({ type: GeoDashboardOverviewView })
  @RequirePermission('geo-dashboard:view')
  overview(
    @Query(Validate(GeoDashboardQueryDto)) query: GeoDashboardQueryDto,
  ): Promise<GeoDashboardOverviewView> {
    return this.dashboard.overview(query)
  }

  @Get('trend')
  @ApiOperation({ summary: '趋势：按日序列（可按引擎筛；没跑过的那天不出点，不补 0）' })
  @ApiOkResponse({ type: GeoDashboardTrendView })
  @RequirePermission('geo-dashboard:view')
  trend(
    @Query(Validate(GeoDashboardEngineQueryDto)) query: GeoDashboardEngineQueryDto,
  ): Promise<GeoDashboardTrendView> {
    return this.dashboard.trend(query)
  }

  @Get('engines')
  @ApiOperation({ summary: '引擎对比：每个引擎的周期汇总，按提及率降序' })
  @ApiOkResponse({ type: GeoDashboardEnginesView })
  @RequirePermission('geo-dashboard:view')
  engines(
    @Query(Validate(GeoDashboardQueryDto)) query: GeoDashboardQueryDto,
  ): Promise<GeoDashboardEnginesView> {
    return this.dashboard.engines(query)
  }

  @Get('competitors')
  @ApiOperation({ summary: '竞品对比：本品牌（第一行）+ 各竞品的提及率/份额/位次' })
  @ApiOkResponse({ type: GeoDashboardCompetitorsView })
  @RequirePermission('geo-dashboard:view')
  competitors(
    @Query(Validate(GeoDashboardQueryDto)) query: GeoDashboardQueryDto,
  ): Promise<GeoDashboardCompetitorsView> {
    return this.dashboard.competitors(query)
  }

  @Get('prompts')
  @ApiOperation({ summary: 'Prompt 榜：每条问法的周期汇总（附原文），按提及率降序，分页' })
  @ApiOkResponse({ type: GeoPromptMetricsView, isArray: true })
  @RequirePermission('geo-dashboard:view')
  prompts(
    @Query(Validate(GeoDashboardPromptQueryDto)) query: GeoDashboardPromptQueryDto,
  ): Promise<PageResult<GeoPromptMetricsView>> {
    return this.dashboard.prompts(query)
  }
}
