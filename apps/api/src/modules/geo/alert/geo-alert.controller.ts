/**
 * 告警的 HTTP 层：`/api/admin/geo/alert-rules`（CRUD）与
 * `/api/admin/geo/alert-events`（只读流水）。
 *
 * ## 为什么是两个控制器类
 *
 * `@Controller` 的前缀是**类级**装饰器，一个类只能有一个前缀。两条资源路径就得两个类
 * （与 `geo-result.controller.ts`、`geo-engine-public.controller.ts` 是同一个理由）。
 *
 * 把类前缀退到 `api/admin/geo` 再在方法上写 `alert-rules` / `alert-events` 是行不通的：
 * `billing-routes.spec.ts`（spec 8）要求 `features.ts` 里每条 `pathPrefixes`
 * 都有一个真实的 `@Controller` **前缀**兑现（相等，或以「功能前缀 + `/`」开头），
 * 而 `api/admin/geo` 比 `/api/admin/geo/alert-rules` 短，匹配不上——
 * 表现是套餐闸门静默失效，接口照常通，而平台以为自己锁住了。
 *
 * 两个类共用一个 `GeoAlertService` 与同一套权限点，所以它们在同一个文件里。
 *
 * @packageDocumentation
 */

import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'
import type { Request } from 'express'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import {
  CreateGeoAlertRuleDto,
  GeoAlertEventView,
  GeoAlertIdResultView,
  GeoAlertRuleView,
  ListGeoAlertEventQueryDto,
  ListGeoAlertRuleQueryDto,
  UpdateGeoAlertRuleDto,
} from './dto/geo-alert.dto'
import { GeoAlertService } from './geo-alert.service'

/**
 * express 5 的 `params` 值类型是 `string | string[]`（重复参数名时是数组）。
 * 这些路由的 `:id` 不可能重复，但类型上得收窄——`as string` 会把数组也放过去。
 */
function paramOf(req: Request, name: string): string | undefined {
  const value = req.params[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * `/api/admin/geo/alert-rules` —— 规则 CRUD。
 *
 * | 装饰器 | 作用 | 谁在看着 |
 * |---|---|---|
 * | `@Auth('staff')` | 只接受商家员工 token | `guard-default-deny.spec.ts`（spec 5） |
 * | `@RequirePermission` | `list` 读、`write` 增改删 | `permission-registry.spec.ts`（spec 6） |
 * | `@Audit` | 三个写操作各一条动作码 | —— |
 *
 * 类前缀就是完整资源路径（与 brand / prompt / run 一致），这样
 * `features.ts` 里 `geo.monitor` 那条 `/api/admin/geo/alert-rules` 才能被
 * `billing-routes.spec.ts`（spec 8）匹配到——它要求功能项前缀有一个真实的
 * `@Controller` 前缀兑现（相等或以 `功能前缀 + '/'` 开头）。
 *
 * 告警规则进 `geo.monitor` 的写闸门是对的：套餐到期之后不该还能新配告警
 * （配了也没数据可比），但**已有的规则与历史事件仍然看得见**——
 * 那个功能项是 `writeOnly: true`。
 */
@ApiTags('admin/geo/alert-rules')
@Controller('api/admin/geo/alert-rules')
@Auth('staff')
export class GeoAlertController {
  constructor(@Inject(GeoAlertService) private readonly alerts: GeoAlertService) {}

  @Get()
  @ApiOperation({ summary: '告警规则列表（按品牌/类型筛，分页，附品牌名）' })
  @ApiOkResponse({ type: GeoAlertRuleView, isArray: true })
  @RequirePermission('geo-alert:list')
  list(
    @Query(Validate(ListGeoAlertRuleQueryDto)) query: ListGeoAlertRuleQueryDto,
  ): Promise<PageResult<GeoAlertRuleView>> {
    return this.alerts.listRules(query)
  }

  @Post()
  @ApiOperation({ summary: '新建告警规则（同品牌同类型只能有一条活跃的）' })
  @ApiOkResponse({ type: GeoAlertRuleView })
  @RequirePermission('geo-alert:write')
  @Audit({ action: APP_AUDIT_ACTIONS.GEO_ALERT_RULE_CREATE, targetType: 'GeoAlertRule' })
  create(
    @Body(Validate(CreateGeoAlertRuleDto)) dto: CreateGeoAlertRuleDto,
  ): Promise<GeoAlertRuleView> {
    return this.alerts.createRule(dto)
  }

  @Put(':id')
  @ApiOperation({ summary: '修改告警规则（brandId / kind 不可改，换了就是另一条规则）' })
  @ApiOkResponse({ type: GeoAlertRuleView })
  @RequirePermission('geo-alert:write')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_ALERT_RULE_UPDATE,
    targetType: 'GeoAlertRule',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  update(
    @Param('id') id: string,
    @Body(Validate(UpdateGeoAlertRuleDto)) dto: UpdateGeoAlertRuleDto,
  ): Promise<GeoAlertRuleView> {
    return this.alerts.updateRule(id, dto)
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除告警规则（软删；历史触发记录不受影响）' })
  @ApiOkResponse({ type: GeoAlertIdResultView })
  // 与品牌不同，删规则共用 `:write`：它不丢任何历史数据，
  // 理由见 `geo-alert.permissions.ts`。
  @RequirePermission('geo-alert:write')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_ALERT_RULE_DELETE,
    targetType: 'GeoAlertRule',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.alerts.removeRule(id)
  }
}

/**
 * `/api/admin/geo/alert-events` —— 触发记录（只读）。
 *
 * 单独一个类**只是因为路由前缀是类级装饰器**（与 `geo-result.controller.ts`
 * 和 `geo-engine-public.controller.ts` 是同一个理由），不是因为它们是两块业务。
 * 权限点共用 `geo-alert:list`。
 *
 * **不进** `geo.monitor` 的 `pathPrefixes`：它一个写方法都没有，
 * 而那个功能项是 `writeOnly: true`，加进去不改变任何行为，
 * 只会让那份清单看起来管着它其实没管的东西。
 */
@ApiTags('admin/geo/alert-events')
@Controller('api/admin/geo/alert-events')
@Auth('staff')
export class GeoAlertEventController {
  constructor(@Inject(GeoAlertService) private readonly alerts: GeoAlertService) {}

  @Get()
  @ApiOperation({ summary: '告警触发记录（按品牌/类型筛，分页；不软删，历史永久可查）' })
  @ApiOkResponse({ type: GeoAlertEventView, isArray: true })
  @RequirePermission('geo-alert:list')
  list(
    @Query(Validate(ListGeoAlertEventQueryDto)) query: ListGeoAlertEventQueryDto,
  ): Promise<PageResult<GeoAlertEventView>> {
    return this.alerts.listEvents(query)
  }
}
