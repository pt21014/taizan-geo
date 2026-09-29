/**
 * `/api/admin/geo/results` —— 回答明细的 HTTP 层（只读）。
 *
 * ## 为什么它是一个**独立的控制器**而不是 `geo-run.controller.ts` 上的几个方法
 *
 * 路由前缀是类级装饰器，一个类上挂不了两个 `@Controller`。把 results 做成
 * `/api/admin/geo/runs/results` 的话，路由树会变成「回答挂在跑批下面」——而回答的
 * 主要查询维度是**品牌 + 引擎 + 问法**，跑批只是其中一个可选筛选项。
 * 前缀独立之后，`GET /geo/results?brandId=…` 才是一条自然的路由。
 *
 * ## 权限点是 `geo-result:view` 而不是 `geo-run:list`
 *
 * 回答原文里有引擎返回的**全文**，包括它引用的第三方内容。「能看跑批进度」与
 * 「能看每一条回答的全文」是两个量级的授权：前者是运营日常，后者更接近数据导出。
 * 拆开之后，「只让外包运营看进度、不给他看原文」才表达得出来。
 *
 * ## 为什么这条前缀**不**进 `features.ts` 的 `geo.monitor`
 *
 * 那条功能项是 `writeOnly: true`（只拦写不拦读），而这个控制器一个写方法都没有——
 * 加进去不会改变任何行为，只会让那份前缀清单看起来管着一些它其实没管的东西。
 * 套餐到期后商家仍然看得到历史回答，这是刻意的降级策略（见 `features.ts`）。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject, Param, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Auth } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'

import { Validate } from '../../../common/validate.pipe'
import { GeoResultDetailView, GeoResultView, ListGeoResultQueryDto } from './dto/geo-run.dto'
import { GeoRunService } from './geo-run.service'

@ApiTags('admin/geo/results')
@Controller('api/admin/geo/results')
@Auth('staff')
export class GeoResultController {
  constructor(@Inject(GeoRunService) private readonly runs: GeoRunService) {}

  @Get()
  @ApiOperation({
    summary: '回答明细列表（按品牌/跑批/引擎/问法/状态筛，分页）。**不含原文**',
  })
  @ApiOkResponse({ type: GeoResultView, isArray: true })
  @RequirePermission('geo-result:view')
  list(
    @Query(Validate(ListGeoResultQueryDto)) query: ListGeoResultQueryDto,
  ): Promise<PageResult<GeoResultView>> {
    return this.runs.listResults(query)
  }

  @Get(':id')
  @ApiOperation({ summary: '回答详情：原文 + 这条回答分析出来的提及与引用' })
  @ApiOkResponse({ type: GeoResultDetailView })
  @RequirePermission('geo-result:view')
  get(@Param('id') id: string): Promise<GeoResultDetailView> {
    return this.runs.getResult(id)
  }
}
