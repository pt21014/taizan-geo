/**
 * `/api/platform/geo/engines` —— 平台侧的引擎接入点管理（GEO P0 技术设计 §4.1）。
 *
 * ## 这个控制器上有什么，为什么
 *
 * | 装饰器 | 作用 | 谁在看着 |
 * |---|---|---|
 * | `@Auth('platform')` | 只接受平台管理员 token；staff/member token 打过来是 1140102 | `guard-default-deny.spec.ts`（spec 5） |
 * | 没有 `@Public()` | 于是被全局守卫默认拒绝——**这才是默认行为** | 同上 |
 * | 没有 `@RequirePermission` | 与 T1-7 那批平台控制器一致，理由见 `platform.permissions.ts` | —— |
 * | `@Audit({...})` | 六个写操作全部记 `AuditLog` | —— |
 *
 * ## 为什么每一个写操作都有审计，一个都不省
 *
 * 这张表控制的是**平台花多少钱、跑不跑得动**：单价决定账单、限速决定跑批会不会
 * 把厂商的额度打穿、密钥决定所有租户的查询能不能成。而它们都是"改一个数字"
 * 这种在 diff 里毫不起眼的操作。
 *
 * 尤其是 `enabled`：它没有走 `PATCH /:id`，而是单独一条 `PATCH /:id/enabled`，
 * 就是为了让审计里 `geo-engine.enable` 与 `geo-engine.disable` 是两条**能被单独
 * `where action = ...` 捞出来**的记录。混在 `geo-engine.update` 里的话，
 * 「上周五是谁把通义停掉的、为什么全平台的数据断了三天」这个问题只能靠翻 payload。
 *
 * ## `PUT` 而不是 `PATCH` 改凭据
 *
 * 凭据是**整包替换**语义（见 `UpdateGeoEngineCredentialsDto` 的说明），
 * 而 `PATCH` 在 HTTP 语义上是局部更新。用错动词的代价不是接口不能用，
 * 而是调用方会按局部更新去理解它，然后某天只提交了 `{apiKey}` 就把
 * `secretKey` 弄丢了。
 *
 * @packageDocumentation
 */

import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit, AuditService } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'
import { currentContext } from '@taizan/nest-core'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import {
  CreateGeoEngineDto,
  GeoEngineTestResultView,
  GeoEngineView,
  ListGeoEngineQueryDto,
  SetGeoEngineEnabledDto,
  TestGeoEngineDto,
  UpdateGeoEngineCredentialsDto,
  UpdateGeoEngineDto,
} from './dto/geo-engine.dto'
import { GeoEngineService } from './geo-engine.service'

/** `@Audit` 的 `targetId` 取数：从路由参数里拿 `:id`。 */
function targetIdFromParam(req: { params: Record<string, unknown> }): string | undefined {
  return typeof req.params.id === 'string' ? req.params.id : undefined
}

@ApiTags('platform/geo/engines')
@Controller('api/platform/geo/engines')
@Auth('platform')
export class GeoEngineController {
  constructor(
    @Inject(GeoEngineService) private readonly engines: GeoEngineService,
    // 只有 `setEnabled` 用得上——那一条路由要按 body 决定动作码，而 `@Audit` 的
    // `action` 是个静态字符串。理由写在那个方法头上。
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: '引擎列表（分页 + keyword + 启用状态筛选）' })
  @ApiOkResponse({ type: GeoEngineView, isArray: true })
  list(
    @Query(Validate(ListGeoEngineQueryDto)) query: ListGeoEngineQueryDto,
  ): Promise<PageResult<GeoEngineView>> {
    return this.engines.list(query)
  }

  @Get(':id')
  @ApiOperation({ summary: '引擎详情（凭据只回脱敏值）' })
  @ApiOkResponse({ type: GeoEngineView })
  get(@Param('id') id: string): Promise<GeoEngineView> {
    return this.engines.get(id)
  }

  @Post()
  @ApiOperation({ summary: '新接一个引擎（默认停用，密钥另外配）' })
  @ApiOkResponse({ type: GeoEngineView })
  @Audit({ action: APP_AUDIT_ACTIONS.GEO_ENGINE_CREATE, targetType: 'GeoEngine' })
  create(@Body(Validate(CreateGeoEngineDto)) dto: CreateGeoEngineDto): Promise<GeoEngineView> {
    return this.engines.create(dto)
  }

  @Patch(':id')
  @ApiOperation({ summary: '改引擎配置（名称 / 模型 / 单价 / 限速 / 超时），code 与密钥不走这里' })
  @ApiOkResponse({ type: GeoEngineView })
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_ENGINE_UPDATE,
    targetType: 'GeoEngine',
    targetId: targetIdFromParam,
  })
  update(
    @Param('id') id: string,
    @Body(Validate(UpdateGeoEngineDto)) dto: UpdateGeoEngineDto,
  ): Promise<GeoEngineView> {
    return this.engines.update(id, dto)
  }

  /**
   * 启用 / 停用。
   *
   * ## 为什么是一条路由 + body 里的布尔
   *
   * 前端那个 `<Switch>` 的 `onChange` 拿到的就是一个布尔。做成 `/enable` 与
   * `/disable` 两条路由的话，页面里要写一个 `enabled ? api.enable() : api.disable()`
   * 的三元式，而它在每一个用到开关的页面都要重写一遍。
   *
   * ## 为什么审计是**手写**的，而不是 `@Audit`
   *
   * `AuditOptions.action` 的类型是 `string`，一条路由只能对应一个固定动作码。
   * 但审计必须把「启用」和「停用」分成两条——「上周五是谁把通义停掉的、
   * 为什么全平台的数据断了三天」这个问题要能 `where action = 'geo-engine.disable'`
   * 一句话捞出来；混进同一个 `geo-engine.set-enabled` 里的话只能翻 payload 猜。
   *
   * 于是这一处用 {@link AuditService.recordPlatform} 手写，形状照抄
   * `AuditInterceptor.finalize()` 的平台分支（actor / ip / traceId 都从
   * `currentContext()` 取）。**写失败不连累主响应**——这条纪律也照抄那边：
   * 审计是主业务的旁路观察者。
   *
   * 代价是失败路径不记审计（`@Audit` 会记一条 `result: 'FAIL'`）。这里可以接受：
   * 这条路由唯一的失败分支是「引擎不存在」，那不构成一次需要被追溯的变更。
   */
  @Patch(':id/enabled')
  @ApiOperation({ summary: '启用 / 停用（立刻影响下一次跑批）' })
  @ApiOkResponse({ type: GeoEngineView })
  async setEnabled(
    @Param('id') id: string,
    @Body(Validate(SetGeoEngineEnabledDto)) dto: SetGeoEngineEnabledDto,
  ): Promise<GeoEngineView> {
    const view = await this.engines.setEnabled(id, dto.enabled)

    const ctx = currentContext()
    const identity = ctx?.identity
    try {
      await this.audit.recordPlatform({
        action: dto.enabled
          ? APP_AUDIT_ACTIONS.GEO_ENGINE_ENABLE
          : APP_AUDIT_ACTIONS.GEO_ENGINE_DISABLE,
        actorType: identity?.kind === 'platform' ? 'PLATFORM_ADMIN' : 'SYSTEM',
        actorId: identity?.id ?? 'anonymous',
        actorName: identity?.id ?? 'unknown',
        targetType: 'GeoEngine',
        targetId: id,
        before: null,
        after: { code: view.code, enabled: view.enabled },
        ip: ctx?.ip.client ?? '',
        traceId: ctx?.traceId ?? '',
        result: 'SUCCESS',
      })
    } catch {
      // 审计写失败不回滚也不抛：引擎确实已经被启用/停用了，把一次成功的操作
      // 报成失败，只会让运营再点一次、于是状态来回翻。
    }

    return view
  }

  @Put(':id/credentials')
  @ApiOperation({ summary: '整包替换凭据（加密落库；响应里只有脱敏值）' })
  @ApiOkResponse({ type: GeoEngineView })
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_ENGINE_CREDENTIAL_UPDATE,
    targetType: 'GeoEngine',
    targetId: targetIdFromParam,
  })
  updateCredentials(
    @Param('id') id: string,
    @Body(Validate(UpdateGeoEngineCredentialsDto)) dto: UpdateGeoEngineCredentialsDto,
  ): Promise<GeoEngineView> {
    return this.engines.updateCredentials(id, dto)
  }

  /**
   * 手动测一次。
   *
   * 记审计是因为它**会真的花钱**（一次真实的引擎调用），也因为「这把 key 是什么
   * 时候被验证过的」在事后会被追问。
   */
  @Post(':id/test')
  @ApiOperation({ summary: '用当前配置实测一次（同步，最长等 timeoutMs）' })
  @ApiOkResponse({ type: GeoEngineTestResultView })
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_ENGINE_TEST,
    targetType: 'GeoEngine',
    targetId: targetIdFromParam,
  })
  test(
    @Param('id') id: string,
    @Body(Validate(TestGeoEngineDto)) dto: TestGeoEngineDto,
  ): Promise<GeoEngineTestResultView> {
    return this.engines.test(id, dto.prompt)
  }
}
