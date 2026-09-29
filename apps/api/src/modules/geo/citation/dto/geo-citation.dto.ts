/**
 * 引用来源三条只读接口的 DTO。
 *
 * `@ApiProperty` 一律**显式写 `type`**（本仓没有 `emitDecoratorMetadata`）。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

import { GEO_DASHBOARD_DAYS, type GeoDashboardDays } from '../../dashboard/dto/geo-dashboard.dto'

/**
 * 来源归类的取值（`GeoSourceCategory`）。
 *
 * 写成常量数组给 `@IsIn` 与 Swagger 的 `enum` 共用一份，与 `GEO_RUN_STATUSES`
 * 同一套写法。值本身必须与 `20-geo.prisma` 的 enum 逐字一致——不一致的表现是
 * 筛选框里选一个永远查不到东西的值。
 */
export const GEO_SOURCE_CATEGORIES = [
  'OWNED',
  'COMPETITOR',
  'EARNED',
  'SOCIAL',
  'ENCYCLOPEDIA',
  'PR',
  'OTHER',
] as const
/** {@link GEO_SOURCE_CATEGORIES} 的联合类型。 */
export type GeoSourceCategoryLike = (typeof GEO_SOURCE_CATEGORIES)[number]

/** 引用类接口的公共查询参数。周期口径与看板共用同一份三档枚举。 */
export class GeoCitationRangeQueryDto {
  @ApiProperty({ type: String, description: '看哪个品牌' })
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId!: string

  @ApiPropertyOptional({
    enum: GEO_DASHBOARD_DAYS,
    description: '回溯多少天，只允许 7 / 30 / 90；不传按 7',
    default: 7,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(GEO_DASHBOARD_DAYS, { message: '周期只能是 7、30 或 90 天' })
  days?: GeoDashboardDays
}

/** 引用明细列表：多三个筛选维度 + 分页。 */
export class ListGeoCitationQueryDto extends GeoCitationRangeQueryDto {
  @ApiPropertyOptional({ type: String, description: '按引擎筛' })
  @IsOptional()
  @IsString({ message: 'engineCode 必须是字符串' })
  @MaxLength(64, { message: 'engineCode 过长' })
  engineCode?: string

  @ApiPropertyOptional({ enum: GEO_SOURCE_CATEGORIES, description: '按来源归类筛' })
  @IsOptional()
  @IsIn(GEO_SOURCE_CATEGORIES, { message: '来源归类不在取值范围内' })
  category?: GeoSourceCategoryLike

  @ApiPropertyOptional({ type: String, description: '按域名精确筛（已去 www.，与列表里显示的一致）' })
  @IsOptional()
  @IsString({ message: 'domain 必须是字符串' })
  @MaxLength(255, { message: 'domain 过长' })
  domain?: string

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
  @Min(1, { message: 'pageSize 至少 1' })
  @Max(200, { message: 'pageSize 上限 200' })
  pageSize?: number
}

// ── 出参 ─────────────────────────────────────────────────────────────────

/** 一条引用明细。 */
export class GeoCitationView {
  @ApiProperty({ type: String })
  id!: string

  @ApiProperty({ type: String, description: '产生这条引用的回答 id（可跳回答明细页）' })
  resultId!: string

  @ApiProperty({ type: String })
  promptId!: string

  @ApiProperty({ type: String, description: '问法原文；问法被软删后回空串' })
  promptText!: string

  @ApiProperty({ type: String })
  engineCode!: string

  @ApiProperty({ type: String, description: '引用 URL 原文' })
  url!: string

  @ApiProperty({ type: String, description: '主机名（已去 www.）' })
  domain!: string

  @ApiProperty({ type: String, description: '平台标识（zhihu / xiaohongshu…）；未命中规则时是空串' })
  platform!: string

  @ApiProperty({ enum: GEO_SOURCE_CATEGORIES })
  category!: GeoSourceCategoryLike

  @ApiProperty({ type: Number, description: '在该回答引用列表里的次序，1 起' })
  rank!: number

  @ApiProperty({ type: String, nullable: true })
  title!: string | null

  @ApiProperty({ type: String, description: '回答产生的时刻（ISO）' })
  answeredAt!: string
}

/** 域名榜里的一行。 */
export class GeoCitationDomainView {
  @ApiProperty({ type: String })
  domain!: string

  @ApiProperty({ type: Number, description: '这个周期里被引用的次数' })
  count!: number

  @ApiProperty({ type: String, description: '平台标识；未命中规则时是空串' })
  platform!: string

  @ApiProperty({ enum: GEO_SOURCE_CATEGORIES })
  category!: GeoSourceCategoryLike

  @ApiProperty({ type: Boolean, description: '是不是自有阵地（category === OWNED）' })
  owned!: boolean
}

/** `GET /citations/domains` 的返回。 */
export class GeoCitationDomainsView {
  @ApiProperty({ type: String })
  brandId!: string

  @ApiProperty({ type: Number })
  days!: number

  @ApiProperty({ type: Number, description: '周期内引用总条数（**不是** items 的条数和）' })
  total!: number

  @ApiProperty({
    type: GeoCitationDomainView,
    isArray: true,
    description: '按次数降序，**最多 50 条**',
  })
  items!: GeoCitationDomainView[]
}

/** 平台占比里的一行。 */
export class GeoCitationCategoryView {
  @ApiProperty({ enum: GEO_SOURCE_CATEGORIES })
  category!: GeoSourceCategoryLike

  @ApiProperty({ type: Number })
  count!: number

  @ApiProperty({ type: Number, description: '占比，基点（10000 = 100%）' })
  shareBp!: number
}

/** `GET /citations/platforms` 的返回。 */
export class GeoCitationPlatformsView {
  @ApiProperty({ type: String })
  brandId!: string

  @ApiProperty({ type: Number })
  days!: number

  @ApiProperty({ type: Number, description: '周期内引用总条数（占比的分母）' })
  total!: number

  @ApiProperty({
    type: GeoCitationCategoryView,
    isArray: true,
    description: '按次数降序；**只含真的出现过的归类**，没出现的不补 0 行',
  })
  items!: GeoCitationCategoryView[]
}

/** 缺口榜只关心第三方来源，不含 OWNED/COMPETITOR（那两档是"自己人"，不是缺口）。 */
export const GEO_CITATION_GAP_CATEGORIES = GEO_SOURCE_CATEGORIES.filter(
  (c): c is Exclude<GeoSourceCategoryLike, 'OWNED' | 'COMPETITOR'> => c !== 'OWNED' && c !== 'COMPETITOR',
)

/** 一条引用缺口：某个第三方来源在"竞品被提及、本品牌完全没被提及"的回答里出现过。 */
export class GeoCitationGapItemView {
  @ApiProperty({ type: String, description: '来源域名' })
  domain!: string

  @ApiProperty({ type: Number, description: '这个周期内，这个来源在"缺口回答"里被引用的次数' })
  count!: number

  @ApiProperty({ type: String, description: '平台标识；未命中规则时是空串' })
  platform!: string

  @ApiProperty({ enum: GEO_CITATION_GAP_CATEGORIES })
  category!: (typeof GEO_CITATION_GAP_CATEGORIES)[number]

  @ApiProperty({ type: String, description: '模板化的内容优化建议' })
  suggestion!: string
}

/** `GET /citations/gaps` 的返回。 */
export class GeoCitationGapsView {
  @ApiProperty({ type: String })
  brandId!: string

  @ApiProperty({ type: Number })
  days!: number

  @ApiProperty({
    type: String,
    isArray: true,
    description: '这个周期里"赢了本品牌"（被提及、本品牌未被提及）的竞品名字，去重',
  })
  competitorNames!: string[]

  @ApiProperty({
    type: GeoCitationGapItemView,
    isArray: true,
    description: '按被引用次数降序，最多 50 条；为空说明本品牌在这个周期没有明显的引用缺口',
  })
  items!: GeoCitationGapItemView[]
}
