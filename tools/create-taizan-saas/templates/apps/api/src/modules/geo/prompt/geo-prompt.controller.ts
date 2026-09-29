/**
 * `/api/admin/geo/prompts` —— 问法与 Prompt 集的 HTTP 层。
 *
 * ## 路由声明顺序是有讲究的
 *
 * `@Get('sets')` / `@Post('sets')` 等固定段路由**必须声明在 `@Get(':id')` 之前**：
 * Nest 按声明顺序匹配，反过来写的话 `/sets` 会先命中 `:id`，
 * 表现为「Prompt 集列表返回 1240300 问法不存在」。`@Post('import')` 同理
 * （它与 `@Post()` 不冲突，但放在一起读起来更清楚）。
 *
 * ## `POST /generate` 是本项目**唯一**一处在 HTTP 路径上同步调 LLM 的接口
 *
 * 技术设计 §10 第 4 条把「HTTP 请求路径里直接调引擎/LLM」列为最容易犯的错误之一，
 * 正确写法是一律走 `@JobHandler`。那条约束针对的是**批量**：一次跑批是
 * `问法 × 引擎 × 采样` 次调用，放在请求里必然超时。
 *
 * 这一条是**交互式的单次调用**——运营点一下「AI 生成」，等两三秒看候选好不好，
 * 不好就改一下行业描述再点一次。把它塞进队列的代价是他点完之后要去另一个地方轮询，
 * 而他要的恰恰是当场看到结果。超时压到 20 秒（见 `geo-prompt.service.ts` 的
 * `GENERATE_TIMEOUT_MS`），比引擎默认的 60 秒短得多。
 *
 * 这是**刻意的例外**，与 `engine/geo-engine.service.ts` 的 `test()` 同一个判据。
 * 再有第三处之前，请先问一遍「它是不是也只跑一次、也有人在屏幕前等」。
 *
 * 它**一条都不落库**：返回候选，由人勾选之后走既有的 `POST /import` 落库
 * （那条路径上已经有 textHash 去重与配额扣减）。
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
  CreateGeoPromptDto,
  CreateGeoPromptSetDto,
  GenerateGeoPromptDto,
  GeoPromptGenerateResultView,
  GeoPromptIdResultView,
  GeoPromptImportResultView,
  GeoPromptSetView,
  GeoPromptView,
  ImportGeoPromptDto,
  ListGeoPromptQueryDto,
  ListGeoPromptSetQueryDto,
  UpdateGeoPromptDto,
  UpdateGeoPromptSetDto,
} from './dto/geo-prompt.dto'
import { GeoPromptService } from './geo-prompt.service'

/** express 5 的 `params` 值类型是 `string | string[]`，这里收窄。 */
function paramOf(req: Request, name: string): string | undefined {
  const value = req.params[name]
  return typeof value === 'string' ? value : undefined
}

@ApiTags('admin/geo/prompts')
@Controller('api/admin/geo/prompts')
@Auth('staff')
export class GeoPromptController {
  constructor(@Inject(GeoPromptService) private readonly prompts: GeoPromptService) {}

  // ── Prompt 集（固定段路由，必须排在 `:id` 之前） ─────────────────────────

  @Get('sets')
  @ApiOperation({ summary: '某个品牌下的 Prompt 集列表' })
  @ApiOkResponse({ type: GeoPromptSetView, isArray: true })
  @RequirePermission('geo-prompt:list')
  listSets(
    @Query(Validate(ListGeoPromptSetQueryDto)) query: ListGeoPromptSetQueryDto,
  ): Promise<GeoPromptSetView[]> {
    return this.prompts.listSets(query.brandId)
  }

  @Post('sets')
  @ApiOperation({ summary: '新建 Prompt 集（不占配额）' })
  @ApiOkResponse({ type: GeoPromptSetView })
  @RequirePermission('geo-prompt:write')
  @Audit({ action: APP_AUDIT_ACTIONS.GEO_PROMPT_SET_CREATE, targetType: 'GeoPromptSet' })
  createSet(
    @Body(Validate(CreateGeoPromptSetDto)) dto: CreateGeoPromptSetDto,
  ): Promise<GeoPromptSetView> {
    return this.prompts.createSet(dto)
  }

  @Put('sets/:id')
  @ApiOperation({ summary: '改 Prompt 集的名字' })
  @ApiOkResponse({ type: GeoPromptSetView })
  @RequirePermission('geo-prompt:write')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_PROMPT_SET_UPDATE,
    targetType: 'GeoPromptSet',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  updateSet(
    @Param('id') id: string,
    @Body(Validate(UpdateGeoPromptSetDto)) dto: UpdateGeoPromptSetDto,
  ): Promise<GeoPromptSetView> {
    return this.prompts.updateSet(id, dto)
  }

  @Delete('sets/:id')
  @ApiOperation({ summary: '删除 Prompt 集（软删；里面还有问法时拒绝）' })
  @ApiOkResponse({ type: GeoPromptIdResultView })
  @RequirePermission('geo-prompt:delete')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_PROMPT_SET_DELETE,
    targetType: 'GeoPromptSet',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  removeSet(@Param('id') id: string): Promise<{ id: string }> {
    return this.prompts.removeSet(id)
  }

  // ── 批量导入（固定段路由） ──────────────────────────────────────────────

  @Post('import')
  @ApiOperation({ summary: '批量导入问法（按 textHash 去重后建，返回 created / skipped）' })
  @ApiOkResponse({ type: GeoPromptImportResultView })
  @RequirePermission('geo-prompt:write')
  @Audit({ action: APP_AUDIT_ACTIONS.GEO_PROMPT_IMPORT, targetType: 'GeoPrompt' })
  importMany(
    @Body(Validate(ImportGeoPromptDto)) dto: ImportGeoPromptDto,
  ): Promise<GeoPromptImportResultView> {
    return this.prompts.importMany(dto)
  }

  // ── AI 生成候选（固定段路由，必须排在 `:id` 之前） ──────────────────────

  @Post('generate')
  @ApiOperation({
    summary: 'AI 生成候选问法（**不落库**，勾选后走 POST /import）。本项目唯一同步调 LLM 的接口',
  })
  @ApiOkResponse({ type: GeoPromptGenerateResultView })
  @RequirePermission('geo-prompt:generate')
  @Audit({ action: APP_AUDIT_ACTIONS.GEO_PROMPT_GENERATE, targetType: 'GeoBrand' })
  generate(
    @Body(Validate(GenerateGeoPromptDto)) dto: GenerateGeoPromptDto,
  ): Promise<GeoPromptGenerateResultView> {
    return this.prompts.generate(dto)
  }

  // ── Prompt ──────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: '问法列表（brandId 必填，分页 + 多条件筛选）' })
  @ApiOkResponse({ type: GeoPromptView, isArray: true })
  // 刻意**没有** `@DataScope`：Prompt 的归属是"哪个品牌"，不是"哪个员工建的"
  // （表上根本没有 `createdBy` 列）。数据范围已经在品牌那一层收窄过了——
  // 看不到品牌的人拿不到 brandId，也就调不通这条路由。
  @RequirePermission('geo-prompt:list')
  list(
    @Query(Validate(ListGeoPromptQueryDto)) query: ListGeoPromptQueryDto,
  ): Promise<PageResult<GeoPromptView>> {
    return this.prompts.list(query)
  }

  @Get(':id')
  @ApiOperation({ summary: '问法详情' })
  @ApiOkResponse({ type: GeoPromptView })
  @RequirePermission('geo-prompt:list')
  get(@Param('id') id: string): Promise<GeoPromptView> {
    return this.prompts.get(id)
  }

  @Post()
  @ApiOperation({ summary: '新建问法（占用一个 GEO_PROMPT 配额）' })
  @ApiOkResponse({ type: GeoPromptView })
  @RequirePermission('geo-prompt:write')
  @Audit({ action: APP_AUDIT_ACTIONS.GEO_PROMPT_CREATE, targetType: 'GeoPrompt' })
  create(@Body(Validate(CreateGeoPromptDto)) dto: CreateGeoPromptDto): Promise<GeoPromptView> {
    return this.prompts.create(dto)
  }

  @Put(':id')
  @ApiOperation({ summary: '修改问法' })
  @ApiOkResponse({ type: GeoPromptView })
  @RequirePermission('geo-prompt:write')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_PROMPT_UPDATE,
    targetType: 'GeoPrompt',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  update(
    @Param('id') id: string,
    @Body(Validate(UpdateGeoPromptDto)) dto: UpdateGeoPromptDto,
  ): Promise<GeoPromptView> {
    return this.prompts.update(id, dto)
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除问法（软删，释放一个 GEO_PROMPT 配额）' })
  @ApiOkResponse({ type: GeoPromptIdResultView })
  @RequirePermission('geo-prompt:delete')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_PROMPT_DELETE,
    targetType: 'GeoPrompt',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.prompts.remove(id)
  }
}
