/**
 * `/api/admin/geo/usage` —— 商家侧用量与成本。一条只读路由。
 *
 * `@Auth('staff')` + `@RequirePermission('geo-usage:view')`（理由见
 * `geo-usage.permissions.ts`）。没有 `@Audit`（只读）、没有 `@DataScope`——归属校验由
 * `GeoUsageService.summary` 第一行的 `requireBrand` 负责（不传 `brandId` 时是本店汇总，
 * 本来就不需要归属校验）。也不进 `geo.monitor` 的 `pathPrefixes`：套餐到期之后商家
 * 仍然该看得到已经花掉的钱，一个写方法都没有。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Auth } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'

import { Validate } from '../../../common/validate.pipe'
import { GeoUsageQueryDto, GeoUsageSummaryView } from './dto/geo-usage.dto'
import { GeoUsageService } from './geo-usage.service'

@ApiTags('admin/geo/usage')
@Controller('api/admin/geo/usage')
@Auth('staff')
export class GeoUsageController {
  constructor(@Inject(GeoUsageService) private readonly usage: GeoUsageService) {}

  @Get('summary')
  @ApiOperation({ summary: '本店（或指定品牌）某个月的用量与成本汇总，按指标/引擎两个维度拆' })
  @ApiOkResponse({ type: GeoUsageSummaryView })
  @RequirePermission('geo-usage:view')
  summary(
    @Query(Validate(GeoUsageQueryDto)) query: GeoUsageQueryDto,
  ): Promise<GeoUsageSummaryView> {
    return this.usage.summary(query)
  }
}
