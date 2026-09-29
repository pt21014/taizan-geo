/**
 * 监测品牌接口的 DTO。
 *
 * ## 两层校验，各管一件事
 *
 * - **DTO（这里）只挡形状**：类型对不对、必填有没有、长度有没有离谱到该直接 400。
 * - **业务规则在 `geo-brand.rules.ts`**：域名归一、别名去重、采样次数区间、竞品数上限——
 *   那些是纯函数，有单测，不依赖 HTTP 也不依赖装饰器。
 *
 * 分层的理由很实际：DTO 校验依赖 class-validator + 显式 `Validate(Dto)` 管道，
 * 而规则函数在队列任务（T5 的跑批调度要读 `sampleSize`）、导入脚本、seed 里同样要用。
 * 规则只写在 DTO 上，那些非 HTTP 入口就完全没有校验。
 *
 * `@ApiProperty` 一律**显式写 `type`**：没有 `emitDecoratorMetadata`，Swagger 推断不出来。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

import {
  GEO_BRAND_STATUSES,
  GEO_REFRESH_FREQS,
  type GeoBrandStatusLike,
  type GeoRefreshFreqLike,
} from '../geo-brand.rules'

/** 新建品牌。 */
export class CreateGeoBrandDto {
  @ApiProperty({ type: String, description: '品牌名', example: '钛赞' })
  @IsString({ message: '品牌名必须是字符串' })
  @MaxLength(200, { message: '品牌名过长' })
  name!: string

  @ApiPropertyOptional({ type: String, description: '官网域名（会自动去协议/www/路径）' })
  @IsOptional()
  @IsString({ message: '域名必须是字符串' })
  @MaxLength(500, { message: '域名过长' })
  domain?: string

  @ApiPropertyOptional({ type: [String], description: '别名/简称/英文名' })
  @IsOptional()
  @IsArray({ message: '别名必须是数组' })
  @IsString({ each: true, message: '别名的每一项都必须是字符串' })
  aliases?: string[]

  @ApiPropertyOptional({ type: String, description: '所属行业' })
  @IsOptional()
  @IsString({ message: '行业必须是字符串' })
  @MaxLength(200, { message: '行业过长' })
  industry?: string

  @ApiPropertyOptional({ type: String, description: '语言/地区', default: 'zh-CN' })
  @IsOptional()
  @IsString({ message: '语言/地区必须是字符串' })
  @MaxLength(16, { message: '语言/地区过长' })
  locale?: string

  @ApiPropertyOptional({ enum: GEO_BRAND_STATUSES, description: '状态', default: 'ACTIVE' })
  @IsOptional()
  @IsIn(GEO_BRAND_STATUSES as readonly string[], {
    message: `状态只能是 ${GEO_BRAND_STATUSES.join(' / ')}`,
  })
  status?: GeoBrandStatusLike

  @ApiPropertyOptional({ enum: GEO_REFRESH_FREQS, description: '刷新频率', default: 'WEEKLY' })
  @IsOptional()
  @IsIn(GEO_REFRESH_FREQS as readonly string[], {
    message: `刷新频率只能是 ${GEO_REFRESH_FREQS.join(' / ')}`,
  })
  refreshFreq?: GeoRefreshFreqLike

  @ApiPropertyOptional({ type: Number, description: '每个 Prompt × 引擎重复问几次', default: 3 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '采样次数必须是整数' })
  @Min(1, { message: '采样次数至少 1 次' })
  @Max(10, { message: '采样次数最多 10 次' })
  sampleSize?: number

  @ApiPropertyOptional({ type: [String], description: '启用的引擎 code' })
  @IsOptional()
  @IsArray({ message: '引擎必须是数组' })
  @IsString({ each: true, message: '引擎 code 的每一项都必须是字符串' })
  engineCodes?: string[]
}

/** 修改品牌：全部可选，只改传了的字段。 */
export class UpdateGeoBrandDto {
  @ApiPropertyOptional({ type: String, description: '品牌名' })
  @IsOptional()
  @IsString({ message: '品牌名必须是字符串' })
  @MaxLength(200, { message: '品牌名过长' })
  name?: string

  @ApiPropertyOptional({ type: String, description: '官网域名' })
  @IsOptional()
  @IsString({ message: '域名必须是字符串' })
  @MaxLength(500, { message: '域名过长' })
  domain?: string

  @ApiPropertyOptional({ type: [String], description: '别名' })
  @IsOptional()
  @IsArray({ message: '别名必须是数组' })
  @IsString({ each: true, message: '别名的每一项都必须是字符串' })
  aliases?: string[]

  @ApiPropertyOptional({ type: String, description: '所属行业' })
  @IsOptional()
  @IsString({ message: '行业必须是字符串' })
  @MaxLength(200, { message: '行业过长' })
  industry?: string

  @ApiPropertyOptional({ type: String, description: '语言/地区' })
  @IsOptional()
  @IsString({ message: '语言/地区必须是字符串' })
  @MaxLength(16, { message: '语言/地区过长' })
  locale?: string

  @ApiPropertyOptional({ enum: GEO_BRAND_STATUSES, description: '状态' })
  @IsOptional()
  @IsIn(GEO_BRAND_STATUSES as readonly string[], {
    message: `状态只能是 ${GEO_BRAND_STATUSES.join(' / ')}`,
  })
  status?: GeoBrandStatusLike

  @ApiPropertyOptional({ enum: GEO_REFRESH_FREQS, description: '刷新频率' })
  @IsOptional()
  @IsIn(GEO_REFRESH_FREQS as readonly string[], {
    message: `刷新频率只能是 ${GEO_REFRESH_FREQS.join(' / ')}`,
  })
  refreshFreq?: GeoRefreshFreqLike

  @ApiPropertyOptional({ type: Number, description: '采样次数' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '采样次数必须是整数' })
  @Min(1, { message: '采样次数至少 1 次' })
  @Max(10, { message: '采样次数最多 10 次' })
  sampleSize?: number

  @ApiPropertyOptional({ type: [String], description: '启用的引擎 code' })
  @IsOptional()
  @IsArray({ message: '引擎必须是数组' })
  @IsString({ each: true, message: '引擎 code 的每一项都必须是字符串' })
  engineCodes?: string[]
}

/** 品牌列表查询。 */
export class ListGeoBrandQueryDto {
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

  @ApiPropertyOptional({ type: String, description: '按品牌名/域名模糊搜索' })
  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @MaxLength(100, { message: 'keyword 过长' })
  keyword?: string

  @ApiPropertyOptional({ enum: GEO_BRAND_STATUSES, description: '按状态筛选' })
  @IsOptional()
  @IsIn(GEO_BRAND_STATUSES as readonly string[], {
    message: `状态只能是 ${GEO_BRAND_STATUSES.join(' / ')}`,
  })
  status?: GeoBrandStatusLike
}

/** 新建竞品。 */
export class CreateGeoCompetitorDto {
  @ApiProperty({ type: String, description: '竞品名' })
  @IsString({ message: '竞品名必须是字符串' })
  @MaxLength(200, { message: '竞品名过长' })
  name!: string

  @ApiPropertyOptional({ type: String, description: '竞品官网域名' })
  @IsOptional()
  @IsString({ message: '域名必须是字符串' })
  @MaxLength(500, { message: '域名过长' })
  domain?: string

  @ApiPropertyOptional({ type: [String], description: '竞品别名' })
  @IsOptional()
  @IsArray({ message: '别名必须是数组' })
  @IsString({ each: true, message: '别名的每一项都必须是字符串' })
  aliases?: string[]
}

/** 修改竞品：全部可选。 */
export class UpdateGeoCompetitorDto {
  @ApiPropertyOptional({ type: String, description: '竞品名' })
  @IsOptional()
  @IsString({ message: '竞品名必须是字符串' })
  @MaxLength(200, { message: '竞品名过长' })
  name?: string

  @ApiPropertyOptional({ type: String, description: '竞品官网域名' })
  @IsOptional()
  @IsString({ message: '域名必须是字符串' })
  @MaxLength(500, { message: '域名过长' })
  domain?: string

  @ApiPropertyOptional({ type: [String], description: '竞品别名' })
  @IsOptional()
  @IsArray({ message: '别名必须是数组' })
  @IsString({ each: true, message: '别名的每一项都必须是字符串' })
  aliases?: string[]
}

/** 下发给前端的品牌。**刻意不含 `tenantId`**——那是服务端的实现细节。 */
export class GeoBrandView {
  @ApiProperty({ type: String }) id!: string
  @ApiProperty({ type: String }) name!: string
  @ApiProperty({ type: String, nullable: true }) domain!: string | null
  @ApiProperty({ type: [String] }) aliases!: string[]
  @ApiProperty({ type: String, nullable: true }) industry!: string | null
  @ApiProperty({ type: String, nullable: true }) locale!: string | null
  @ApiProperty({ enum: GEO_BRAND_STATUSES }) status!: GeoBrandStatusLike
  @ApiProperty({ enum: GEO_REFRESH_FREQS }) refreshFreq!: GeoRefreshFreqLike
  @ApiProperty({ type: Number }) sampleSize!: number
  @ApiProperty({ type: [String] }) engineCodes!: string[]
  @ApiProperty({ type: String, nullable: true }) createdBy!: string | null
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string
}

/** 下发给前端的竞品。 */
export class GeoCompetitorView {
  @ApiProperty({ type: String }) id!: string
  @ApiProperty({ type: String }) brandId!: string
  @ApiProperty({ type: String }) name!: string
  @ApiProperty({ type: String, nullable: true }) domain!: string | null
  @ApiProperty({ type: [String] }) aliases!: string[]
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string
}

/** 删除接口的返回。 */
export class GeoIdResultView {
  @ApiProperty({ type: String }) id!: string
}
