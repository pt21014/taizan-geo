/**
 * `/api/admin/geo/reports` —— 报表的 HTTP 层。
 *
 * ## `POST /generate` 为什么可以同步
 *
 * 蓝图 §10 第 4 条禁止的是「HTTP 请求路径里直接调引擎/LLM」。这条路由一次外部调用
 * 都没有——它读 `GeoVisibilityDaily`（一个周期几百行）加一次 `GeoCitation` 的
 * `groupBy`，几十毫秒。理由写在 `geo-report.service.ts` 的文件头。
 *
 * ## 路由顺序
 *
 * `POST /generate` 与 `GET /:id` 不冲突（方法不同），但 `generate` 仍然写在
 * `:id` 前面——以后万一加了 `POST /:id/xxx`，先注册的那条会赢。
 *
 * ## 装饰器
 *
 * `@Auth('staff')`；读用 `geo-report:view`、生成用 `geo-report:generate`（两档的
 * 理由见 `geo-report.permissions.ts`）；`generate` 记审计 `geo-report.generate`。
 * **不进** `geo.monitor` 的 `pathPrefixes`：到期的店仍然该看得到已经出过的报告，
 * 而「再出一份」这件事本身不花钱、也不产生新的监测数据。
 *
 * @packageDocumentation
 */

import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import {
  GenerateGeoReportDto,
  GeoReportDetailView,
  GeoReportView,
  ListGeoReportQueryDto,
} from './dto/geo-report.dto'
import { GeoReportService } from './geo-report.service'

@ApiTags('admin/geo/reports')
@Controller('api/admin/geo/reports')
@Auth('staff')
export class GeoReportController {
  constructor(@Inject(GeoReportService) private readonly reports: GeoReportService) {}

  @Get()
  @ApiOperation({ summary: '报表列表（按品牌/周期类型筛，分页；不含 payload）' })
  @ApiOkResponse({ type: GeoReportView, isArray: true })
  @RequirePermission('geo-report:view')
  list(
    @Query(Validate(ListGeoReportQueryDto)) query: ListGeoReportQueryDto,
  ): Promise<PageResult<GeoReportView>> {
    return this.reports.list(query)
  }

  @Post('generate')
  @ApiOperation({
    summary: '手动生成一份报表（同步；同周期已存在时直接返回那一份，不重算）',
  })
  @ApiOkResponse({ type: GeoReportDetailView })
  @RequirePermission('geo-report:generate')
  @Audit({ action: APP_AUDIT_ACTIONS.GEO_REPORT_GENERATE, targetType: 'GeoReport' })
  generate(
    @Body(Validate(GenerateGeoReportDto)) dto: GenerateGeoReportDto,
  ): Promise<GeoReportDetailView> {
    return this.reports.generate(dto)
  }

  @Get(':id')
  @ApiOperation({ summary: '报表详情（含生成时的完整快照 payload）' })
  @ApiOkResponse({ type: GeoReportDetailView })
  @RequirePermission('geo-report:view')
  get(@Param('id') id: string): Promise<GeoReportDetailView> {
    return this.reports.get(id)
  }
}
