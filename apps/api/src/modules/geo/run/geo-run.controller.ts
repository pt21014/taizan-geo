/**
 * `/api/admin/geo/runs` —— 跑批的 HTTP 层。
 *
 * ## 三条路由，其中只有一条会写
 *
 * `POST /` 是「立即刷新」按钮。它**只建一条 run 并入队**，一次引擎调用都不发——
 * 技术设计 §10 第 4 条把「HTTP 请求路径里直接调引擎」列为最容易犯的错误之一：
 * 一次跑批是 `问法 × 引擎 × 采样` 次调用，放在请求里必然超时，而超时之后前端会重试，
 * 于是同一批被跑两遍、钱花两份。
 *
 * ## 为什么没有 `@DataScope`
 *
 * 与 `geo-prompt.controller.ts` 同一个判据：跑批的归属是「哪个品牌」，不是「哪个员工建的」
 * （表上有 `createdBy`，但那是审计线索，不是数据范围）。范围已经在品牌那一层收窄过了——
 * 看不到品牌的人拿不到 `brandId`，`POST` 会在 `requireBrand` 那一步就被判 1240300。
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
  CreateGeoRunDto,
  GeoRunDetailView,
  GeoRunView,
  ListGeoRunQueryDto,
} from './dto/geo-run.dto'
import { GeoRunService } from './geo-run.service'

@ApiTags('admin/geo/runs')
@Controller('api/admin/geo/runs')
@Auth('staff')
export class GeoRunController {
  constructor(@Inject(GeoRunService) private readonly runs: GeoRunService) {}

  @Get()
  @ApiOperation({ summary: '跑批列表（按品牌/状态筛，分页）' })
  @ApiOkResponse({ type: GeoRunView, isArray: true })
  @RequirePermission('geo-run:list')
  list(
    @Query(Validate(ListGeoRunQueryDto)) query: ListGeoRunQueryDto,
  ): Promise<PageResult<GeoRunView>> {
    return this.runs.list(query)
  }

  @Get(':id')
  @ApiOperation({ summary: '跑批详情（含按结果状态分的实时计数，前端进度条靠它）' })
  @ApiOkResponse({ type: GeoRunDetailView })
  @RequirePermission('geo-run:list')
  get(@Param('id') id: string): Promise<GeoRunDetailView> {
    return this.runs.get(id)
  }

  @Post()
  @ApiOperation({
    summary: '立即刷新：建一次跑批并入队（同步只建 run，真正的查询在队列里跑）',
  })
  @ApiOkResponse({ type: GeoRunView })
  @RequirePermission('geo-run:trigger')
  @Audit({ action: APP_AUDIT_ACTIONS.GEO_RUN_TRIGGER, targetType: 'GeoQueryRun' })
  async create(@Body(Validate(CreateGeoRunDto)) dto: CreateGeoRunDto): Promise<GeoRunView> {
    const { run } = await this.runs.create(dto, 'MANUAL')
    return run
  }
}
