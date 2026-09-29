/**
 * `/api/platform/geo/usage` —— 平台侧全平台用量与成本看板。一条只读路由。
 *
 * 没有 `@RequirePermission`：与 T1-7 那批平台控制器一致，理由见
 * `geo-usage.permissions.ts`。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Auth } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { GeoPlatformUsageQueryDto, GeoPlatformUsageSummaryView } from './dto/geo-platform-usage.dto'
import { GeoPlatformUsageService } from './geo-platform-usage.service'

@ApiTags('platform/geo/usage')
@Controller('api/platform/geo/usage')
@Auth('platform')
export class GeoPlatformUsageController {
  constructor(@Inject(GeoPlatformUsageService) private readonly usage: GeoPlatformUsageService) {}

  @Get()
  @ApiOperation({ summary: '全平台用量与成本（按租户/引擎两个维度汇总）' })
  @ApiOkResponse({ type: GeoPlatformUsageSummaryView })
  summary(
    @Query(Validate(GeoPlatformUsageQueryDto)) query: GeoPlatformUsageQueryDto,
  ): Promise<GeoPlatformUsageSummaryView> {
    return this.usage.summary(query)
  }
}
