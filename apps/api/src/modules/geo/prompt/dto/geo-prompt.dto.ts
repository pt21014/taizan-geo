/**
 * Prompt / PromptSet 接口的 DTO。
 *
 * 与 brand 同一套分层：**DTO 只挡形状**，业务规则（去重指纹、漏斗阶段归一、
 * 批量条数上限）在 `geo-prompt.rules.ts` 的纯函数里。
 *
 * `@ApiProperty` 一律**显式写 `type`**：没有 `emitDecoratorMetadata`，Swagger 推断不出来。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

import {
  GEO_FUNNEL_STAGES,
  GEO_PROMPT_IMPORT_MAX,
  GEO_PROMPT_SOURCES,
  type GeoFunnelStageLike,
  type GeoPromptSourceLike,
} from '../geo-prompt.rules'

/** 新建一条 Prompt。 */
export class CreateGeoPromptDto {
  @ApiProperty({ type: String, description: '所属品牌 id' })
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId!: string

  @ApiPropertyOptional({ type: String, description: 'Prompt 集 id；不传则归入品牌下的「默认」集' })
  @IsOptional()
  @IsString({ message: 'promptSetId 必须是字符串' })
  @MaxLength(26, { message: 'promptSetId 过长' })
  promptSetId?: string

  @ApiProperty({ type: String, description: '问法正文', example: '钛赞 SaaS 好用吗' })
  @IsString({ message: '问法正文必须是字符串' })
  @MaxLength(2000, { message: '问法正文过长' })
  text!: string

  @ApiPropertyOptional({ type: String, description: '主题标签' })
  @IsOptional()
  @IsString({ message: '主题必须是字符串' })
  @MaxLength(200, { message: '主题过长' })
  topic?: string

  @ApiPropertyOptional({ enum: GEO_FUNNEL_STAGES, description: '漏斗阶段', default: 'UNKNOWN' })
  @IsOptional()
  @IsString({ message: '漏斗阶段必须是字符串' })
  @MaxLength(32, { message: '漏斗阶段过长' })
  funnelStage?: string

  @ApiPropertyOptional({ type: Boolean, description: '是否纳入自动跑批', default: true })
  @IsOptional()
  @IsBoolean({ message: '是否追踪必须是布尔值' })
  isTracked?: boolean

  @ApiPropertyOptional({ type: Number, description: '优先级 0–100', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '优先级必须是整数' })
  @Min(0, { message: '优先级不能为负' })
  @Max(100, { message: '优先级上限 100' })
  priority?: number
}

/** 修改一条 Prompt：全部可选，只改传了的字段。**不允许改 `brandId`**。 */
export class UpdateGeoPromptDto {
  @ApiPropertyOptional({ type: String, description: '改挂到另一个 Prompt 集' })
  @IsOptional()
  @IsString({ message: 'promptSetId 必须是字符串' })
  @MaxLength(26, { message: 'promptSetId 过长' })
  promptSetId?: string

  @ApiPropertyOptional({ type: String, description: '问法正文' })
  @IsOptional()
  @IsString({ message: '问法正文必须是字符串' })
  @MaxLength(2000, { message: '问法正文过长' })
  text?: string

  @ApiPropertyOptional({ type: String, description: '主题标签' })
  @IsOptional()
  @IsString({ message: '主题必须是字符串' })
  @MaxLength(200, { message: '主题过长' })
  topic?: string

  @ApiPropertyOptional({ enum: GEO_FUNNEL_STAGES, description: '漏斗阶段' })
  @IsOptional()
  @IsString({ message: '漏斗阶段必须是字符串' })
  @MaxLength(32, { message: '漏斗阶段过长' })
  funnelStage?: string

  @ApiPropertyOptional({ type: Boolean, description: '是否纳入自动跑批' })
  @IsOptional()
  @IsBoolean({ message: '是否追踪必须是布尔值' })
  isTracked?: boolean

  @ApiPropertyOptional({ type: Number, description: '优先级 0–100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '优先级必须是整数' })
  @Min(0, { message: '优先级不能为负' })
  @Max(100, { message: '优先级上限 100' })
  priority?: number
}

/**
 * Prompt 列表查询。
 *
 * `brandId` **必填**：Prompt 永远属于某个品牌，不带品牌的"全部问法"列表在业务上
 * 没有意义（两个品牌的问法混在一张表里，运营分不出哪条属于谁）。
 */
export class ListGeoPromptQueryDto {
  @ApiProperty({ type: String, description: '所属品牌 id（必填）' })
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId!: string

  @ApiPropertyOptional({ type: Number, description: '页码，从 1 开始', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 从 1 开始' })
  page?: number

  @ApiPropertyOptional({ type: Number, description: '每页条数，上限 200', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 至少为 1' })
  @Max(200, { message: 'pageSize 上限 200' })
  pageSize?: number

  @ApiPropertyOptional({ type: String, description: '按 Prompt 集筛选' })
  @IsOptional()
  @IsString({ message: 'promptSetId 必须是字符串' })
  @MaxLength(26, { message: 'promptSetId 过长' })
  promptSetId?: string

  @ApiPropertyOptional({ enum: GEO_FUNNEL_STAGES, description: '按漏斗阶段筛选' })
  @IsOptional()
  @IsIn(GEO_FUNNEL_STAGES as readonly string[], {
    message: `漏斗阶段只能是 ${GEO_FUNNEL_STAGES.join(' / ')}`,
  })
  funnelStage?: GeoFunnelStageLike

  @ApiPropertyOptional({ type: Boolean, description: '按是否追踪筛选' })
  @IsOptional()
  // query string 里布尔值到达时是 `'true'` / `'false'`，`@Type(() => Boolean)` 会把
  // 非空字符串一律当成 true（`Boolean('false') === true`），所以这里手写转换。
  @Type(() => String)
  @IsIn(['true', 'false'], { message: 'isTracked 只能是 true / false' })
  isTracked?: string

  @ApiPropertyOptional({ type: String, description: '按正文/主题模糊搜索' })
  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @MaxLength(100, { message: 'keyword 过长' })
  keyword?: string
}

/** 批量导入。 */
export class ImportGeoPromptDto {
  @ApiProperty({ type: String, description: '所属品牌 id' })
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId!: string

  @ApiPropertyOptional({ type: String, description: 'Prompt 集 id；不传则归入「默认」集' })
  @IsOptional()
  @IsString({ message: 'promptSetId 必须是字符串' })
  @MaxLength(26, { message: 'promptSetId 过长' })
  promptSetId?: string

  @ApiProperty({ type: [String], description: '问法正文数组（每行一条）' })
  @IsArray({ message: 'texts 必须是数组' })
  @ArrayMinSize(1, { message: '至少导入一条' })
  @ArrayMaxSize(GEO_PROMPT_IMPORT_MAX, { message: `一次最多导入 ${GEO_PROMPT_IMPORT_MAX} 条` })
  @IsString({ each: true, message: 'texts 的每一项都必须是字符串' })
  texts!: string[]
}

/** 新建 Prompt 集。 */
export class CreateGeoPromptSetDto {
  @ApiProperty({ type: String, description: '所属品牌 id' })
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId!: string

  @ApiProperty({ type: String, description: 'Prompt 集名称' })
  @IsString({ message: '名称必须是字符串' })
  @MaxLength(200, { message: '名称过长' })
  name!: string

  @ApiPropertyOptional({ enum: GEO_PROMPT_SOURCES, description: '来源', default: 'MANUAL' })
  @IsOptional()
  @IsIn(GEO_PROMPT_SOURCES as readonly string[], {
    message: `来源只能是 ${GEO_PROMPT_SOURCES.join(' / ')}`,
  })
  source?: GeoPromptSourceLike
}

/** 修改 Prompt 集（只能改名字；来源是"它怎么来的"，改不了历史）。 */
export class UpdateGeoPromptSetDto {
  @ApiProperty({ type: String, description: 'Prompt 集名称' })
  @IsString({ message: '名称必须是字符串' })
  @MaxLength(200, { message: '名称过长' })
  name!: string
}

/** Prompt 集列表查询。 */
export class ListGeoPromptSetQueryDto {
  @ApiProperty({ type: String, description: '所属品牌 id（必填）' })
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId!: string
}

/** 下发给前端的 Prompt。 */
export class GeoPromptView {
  @ApiProperty({ type: String }) id!: string
  @ApiProperty({ type: String }) brandId!: string
  @ApiProperty({ type: String }) promptSetId!: string
  @ApiProperty({ type: String }) text!: string
  @ApiProperty({ type: String }) textHash!: string
  @ApiProperty({ type: String, nullable: true }) topic!: string | null
  @ApiProperty({ enum: GEO_FUNNEL_STAGES }) funnelStage!: GeoFunnelStageLike
  @ApiProperty({ type: Boolean }) isTracked!: boolean
  @ApiProperty({ type: Number }) priority!: number
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string
}

/** 下发给前端的 Prompt 集。 */
export class GeoPromptSetView {
  @ApiProperty({ type: String }) id!: string
  @ApiProperty({ type: String }) brandId!: string
  @ApiProperty({ type: String }) name!: string
  @ApiProperty({ enum: GEO_PROMPT_SOURCES }) source!: GeoPromptSourceLike
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string
}

/** 批量导入的结果。 */
export class GeoPromptImportResultView {
  @ApiProperty({ type: Number, description: '真的建进去了几条' }) created!: number
  @ApiProperty({ type: Number, description: '因重复被跳过了几条' }) skipped!: number
  @ApiProperty({ type: String, description: '落进了哪个 Prompt 集' }) promptSetId!: string
}

/** 删除接口的返回。 */
export class GeoPromptIdResultView {
  @ApiProperty({ type: String }) id!: string
}

// ─────────────────────────────────────────────────────────────────────────────
// AI 生成候选问法（T6）
// ─────────────────────────────────────────────────────────────────────────────

/** 一次生成最多要几条。上限不是技术限制，是成本与可用性的折中，见 `geo-prompt.service.ts`。 */
export const GEO_PROMPT_GENERATE_MAX = 30

/** 一次生成默认要几条。 */
export const GEO_PROMPT_GENERATE_DEFAULT = 10

/** `POST /api/admin/geo/prompts/generate` 的入参。 */
export class GenerateGeoPromptDto {
  @ApiProperty({ type: String, description: '给哪个品牌生成（品牌名/行业/竞品是生成的上下文）' })
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId!: string

  @ApiPropertyOptional({
    type: Number,
    description: `要几条，默认 ${GEO_PROMPT_GENERATE_DEFAULT}，上限 ${GEO_PROMPT_GENERATE_MAX}`,
    default: GEO_PROMPT_GENERATE_DEFAULT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'count 必须是整数' })
  @Min(1, { message: 'count 至少 1' })
  @Max(GEO_PROMPT_GENERATE_MAX, { message: `count 上限 ${GEO_PROMPT_GENERATE_MAX}` })
  count?: number

  @ApiPropertyOptional({ enum: GEO_FUNNEL_STAGES, description: '只要这个漏斗阶段的；不传则各阶段都来一些' })
  @IsOptional()
  @IsString({ message: '漏斗阶段必须是字符串' })
  @MaxLength(32, { message: '漏斗阶段过长' })
  funnelStage?: string
}

/** 一条 AI 生成出来的候选问法。**没有 id**——它还没落库。 */
export class GeoPromptCandidateView {
  @ApiProperty({ type: String }) text!: string
  @ApiProperty({ enum: GEO_FUNNEL_STAGES }) funnelStage!: GeoFunnelStageLike
  @ApiProperty({ type: String, nullable: true }) topic!: string | null
  @ApiProperty({
    type: Boolean,
    description: '这条正文在库里已经有了（按 textHash 判）。前端据它默认不勾选',
  })
  duplicated!: boolean
}

/** 生成接口的返回。 */
export class GeoPromptGenerateResultView {
  @ApiProperty({ type: GeoPromptCandidateView, isArray: true })
  candidates!: GeoPromptCandidateView[]
  @ApiProperty({ type: String, description: '生效的 LLM 供应商名，排障用' })
  provider!: string
}
