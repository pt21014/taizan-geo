/**
 * `/api/admin/geo/citations` —— 引用来源的 HTTP 层。三条路由，**全部只读**。
 *
 * ## 路由顺序要紧
 *
 * `GET /domains` 与 `GET /platforms` 写在前面。这个控制器上目前**没有** `GET /:id`，
 * 所以现在顺序其实无所谓；写成这样是留给以后——一旦加了 `:id`，
 * express 会用先注册的那条匹配，`/domains` 落到 `:id` 上就变成
 * 「查一条 id 叫 domains 的引用」，返回 1240300，而路由本身看起来完全正常。
 *
 * ## 装饰器与判据
 *
 * `@Auth('staff')` + `@RequirePermission('geo-citation:view')`，没有 `@Audit`（只读）、
 * 没有 `@DataScope`（归属校验由 service 第一行的 `requireBrand` 负责，与看板同理）。
 * 也没有进 `geo.monitor` 的 `pathPrefixes`：那个功能项是 `writeOnly: true` 的降级闸门，
 * 而这里一个写方法都没有。
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
  GeoCitationDomainsView,
  GeoCitationGapsView,
  GeoCitationPlatformsView,
  GeoCitationRangeQueryDto,
  GeoCitationView,
  ListGeoCitationQueryDto,
} from './dto/geo-citation.dto'
import { GeoCitationService } from './geo-citation.service'

@ApiTags('admin/geo/citations')
@Controller('api/admin/geo/citations')
@Auth('staff')
export class GeoCitationController {
  constructor(@Inject(GeoCitationService) private readonly citations: GeoCitationService) {}

  @Get('domains')
  @ApiOperation({ summary: '域名榜：按被引用次数降序 top 50，附平台标识、归类与是否自有阵地' })
  @ApiOkResponse({ type: GeoCitationDomainsView })
  @RequirePermission('geo-citation:view')
  domains(
    @Query(Validate(GeoCitationRangeQueryDto)) query: GeoCitationRangeQueryDto,
  ): Promise<GeoCitationDomainsView> {
    return this.citations.domains(query)
  }

  @Get('platforms')
  @ApiOperation({ summary: '来源归类占比（OWNED / SOCIAL / ENCYCLOPEDIA…），饼图数据源' })
  @ApiOkResponse({ type: GeoCitationPlatformsView })
  @RequirePermission('geo-citation:view')
  platforms(
    @Query(Validate(GeoCitationRangeQueryDto)) query: GeoCitationRangeQueryDto,
  ): Promise<GeoCitationPlatformsView> {
    return this.citations.platforms(query)
  }

  @Get('gaps')
  @ApiOperation({
    summary: '引用缺口：竞品被提及、本品牌完全没被提及的回答里 AI 实际引用了哪些第三方来源，附内容优化建议',
  })
  @ApiOkResponse({ type: GeoCitationGapsView })
  @RequirePermission('geo-citation:view')
  gaps(@Query(Validate(GeoCitationRangeQueryDto)) query: GeoCitationRangeQueryDto): Promise<GeoCitationGapsView> {
    return this.citations.gaps(query)
  }

  @Get()
  @ApiOperation({ summary: '引用明细（按引擎/归类/域名筛，分页，附问法原文）' })
  @ApiOkResponse({ type: GeoCitationView, isArray: true })
  @RequirePermission('geo-citation:view')
  list(
    @Query(Validate(ListGeoCitationQueryDto)) query: ListGeoCitationQueryDto,
  ): Promise<PageResult<GeoCitationView>> {
    return this.citations.list(query)
  }
}
