/**
 * `/api/admin/geo/brands` —— 监测品牌与竞品的 HTTP 层。
 *
 * ## 这个控制器上有什么，为什么
 *
 * | 装饰器 | 作用 | 谁在看着 |
 * |---|---|---|
 * | `@Auth('staff')` | 只接受商家员工 token；member/platform token 打过来是 1140102 | `guard-default-deny.spec.ts`（spec 5） |
 * | 没有 `@Public()` | 于是被全局守卫默认拒绝——**这才是默认行为** | 同上 |
 * | `@RequirePermission(...)` | 每条路由需要哪个权限点，不满足 1340300 | `permission-registry.spec.ts`（spec 6） |
 * | `@DataScope({ ownerField })` | 列表按当前员工的数据范围收窄 | —— |
 * | `@Audit({...})` | 写操作自动记 `AuditLog` | —— |
 *
 * ## 竞品为什么挂在 `/:id/competitors` 下而不是顶级 `/api/admin/geo/competitors`
 *
 * 竞品是品牌的一部分（份额 SoV 的分母），脱离品牌没有意义。做成子资源之后，
 * 「这条竞品属于哪个品牌」由 URL 表达，service 里的 `requireCompetitor(brandId, id)`
 * 才有东西可校验——顶级资源的话，改一条竞品只能靠它自己的 id，
 * 而那意味着 A 品牌的运营可以改到 B 品牌的竞品（同租户内，隔离扩展拦不住）。
 *
 * ## `@DataScope` 为什么只在列表上
 *
 * 数据范围翻译成的是一段 `where` 片段，只有「查一批」才用得上。单条读与写走的是
 * `requireBrand(id)`，那里已经有租户归属校验；再叠一层数据范围会让
 * 「店主帮运营改一个品牌」失败，而那正是店主该能做的事。
 *
 * @packageDocumentation
 */

import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'
import { DataScope, RequirePermission, ScopeWhere } from '@taizan/nest-rbac'
import type { Request } from 'express'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import {
  CreateGeoBrandDto,
  CreateGeoCompetitorDto,
  GeoBrandView,
  GeoCompetitorView,
  GeoIdResultView,
  ListGeoBrandQueryDto,
  UpdateGeoBrandDto,
  UpdateGeoCompetitorDto,
} from './dto/geo-brand.dto'
import { GeoBrandService } from './geo-brand.service'

/**
 * express 5 的 `params` 值类型是 `string | string[]`（重复参数名时是数组）。
 * 这些路由的 `:id` 不可能重复，但类型上得收窄——`as string` 会把数组也放过去。
 */
function paramOf(req: Request, name: string): string | undefined {
  const value = req.params[name]
  return typeof value === 'string' ? value : undefined
}

@ApiTags('admin/geo/brands')
@Controller('api/admin/geo/brands')
@Auth('staff')
export class GeoBrandController {
  constructor(@Inject(GeoBrandService) private readonly brands: GeoBrandService) {}

  @Get()
  @ApiOperation({ summary: '品牌列表（分页 + keyword 搜索 + 状态筛选，按数据范围收窄）' })
  @ApiOkResponse({ type: GeoBrandView, isArray: true })
  @RequirePermission('geo-brand:list')
  // 归属列是 `createdBy`（`GeoBrand.createdBy`，见 20-geo.prisma）。
  // 不写 `tenantField`：租户隔离由 `prisma.tenant` 句柄独立负责，在这里再写一遍
  // 等于给「禁止手写 tenantId 过滤条件」开了个口子（spec 4 会扫出来）。
  @DataScope({ ownerField: 'createdBy' })
  list(
    @Query(Validate(ListGeoBrandQueryDto)) query: ListGeoBrandQueryDto,
    // `null` 与 `{}` 必须分开：`null` = 不加条件（ALL 范围），`{}` = 一个空对象条件。
    @ScopeWhere() scope: Record<string, unknown> | null,
  ): Promise<PageResult<GeoBrandView>> {
    return this.brands.list(query, scope)
  }

  @Get(':id')
  @ApiOperation({ summary: '品牌详情' })
  @ApiOkResponse({ type: GeoBrandView })
  @RequirePermission('geo-brand:list')
  get(@Param('id') id: string): Promise<GeoBrandView> {
    return this.brands.get(id)
  }

  @Post()
  @ApiOperation({ summary: '新建品牌（占用一个 GEO_BRAND 配额）' })
  @ApiOkResponse({ type: GeoBrandView })
  @RequirePermission('geo-brand:write')
  @Audit({ action: APP_AUDIT_ACTIONS.GEO_BRAND_CREATE, targetType: 'GeoBrand' })
  create(@Body(Validate(CreateGeoBrandDto)) dto: CreateGeoBrandDto): Promise<GeoBrandView> {
    return this.brands.create(dto)
  }

  @Put(':id')
  @ApiOperation({ summary: '修改品牌' })
  @ApiOkResponse({ type: GeoBrandView })
  @RequirePermission('geo-brand:write')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_BRAND_UPDATE,
    targetType: 'GeoBrand',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  update(
    @Param('id') id: string,
    @Body(Validate(UpdateGeoBrandDto)) dto: UpdateGeoBrandDto,
  ): Promise<GeoBrandView> {
    return this.brands.update(id, dto)
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除品牌（软删，释放一个 GEO_BRAND 配额）' })
  @ApiOkResponse({ type: GeoIdResultView })
  @RequirePermission('geo-brand:delete')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_BRAND_DELETE,
    targetType: 'GeoBrand',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.brands.remove(id)
  }

  // ── 竞品（品牌的子资源，共用 `geo-brand:*` 权限点） ─────────────────────

  @Get(':id/competitors')
  @ApiOperation({ summary: '某个品牌下的竞品列表（不分页，上限 10 条）' })
  @ApiOkResponse({ type: GeoCompetitorView, isArray: true })
  @RequirePermission('geo-brand:list')
  listCompetitors(@Param('id') id: string): Promise<GeoCompetitorView[]> {
    return this.brands.listCompetitors(id)
  }

  @Post(':id/competitors')
  @ApiOperation({ summary: '新建竞品（不占配额，受 MAX_COMPETITORS 常量约束）' })
  @ApiOkResponse({ type: GeoCompetitorView })
  @RequirePermission('geo-brand:write')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_BRAND_COMPETITOR_CREATE,
    targetType: 'GeoCompetitor',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  createCompetitor(
    @Param('id') id: string,
    @Body(Validate(CreateGeoCompetitorDto)) dto: CreateGeoCompetitorDto,
  ): Promise<GeoCompetitorView> {
    return this.brands.createCompetitor(id, dto)
  }

  @Put(':id/competitors/:cid')
  @ApiOperation({ summary: '修改竞品' })
  @ApiOkResponse({ type: GeoCompetitorView })
  @RequirePermission('geo-brand:write')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_BRAND_COMPETITOR_UPDATE,
    targetType: 'GeoCompetitor',
    targetId: (req: Request) => paramOf(req, 'cid'),
  })
  updateCompetitor(
    @Param('id') id: string,
    @Param('cid') cid: string,
    @Body(Validate(UpdateGeoCompetitorDto)) dto: UpdateGeoCompetitorDto,
  ): Promise<GeoCompetitorView> {
    return this.brands.updateCompetitor(id, cid, dto)
  }

  @Delete(':id/competitors/:cid')
  @ApiOperation({ summary: '删除竞品（软删）' })
  @ApiOkResponse({ type: GeoIdResultView })
  // 与「删品牌」不同，竞品的增删改共用 `geo-brand:write`：竞品不是独立实体，
  // 删一条竞品不会丢掉任何历史趋势（品牌的可见度数据不挂在竞品上）。
  @RequirePermission('geo-brand:write')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_BRAND_COMPETITOR_DELETE,
    targetType: 'GeoCompetitor',
    targetId: (req: Request) => paramOf(req, 'cid'),
  })
  removeCompetitor(@Param('id') id: string, @Param('cid') cid: string): Promise<{ id: string }> {
    return this.brands.removeCompetitor(id, cid)
  }
}
