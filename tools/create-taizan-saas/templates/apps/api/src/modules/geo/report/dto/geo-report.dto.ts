/**
 * 报表接口的 DTO。
 *
 * `@ApiProperty` 一律**显式写 `type`**（本仓没有 `emitDecoratorMetadata`）。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator'

/** `GeoReportPeriod` 的取值。 */
export const GEO_REPORT_PERIODS = ['WEEKLY', 'MONTHLY'] as const
/** {@link GEO_REPORT_PERIODS} 的联合类型。 */
export type GeoReportPeriodLike = (typeof GEO_REPORT_PERIODS)[number]

/** `GeoReportStatus` 的取值。 */
export const GEO_REPORT_STATUSES = ['PENDING', 'READY', 'FAILED'] as const
/** {@link GEO_REPORT_STATUSES} 的联合类型。 */
export type GeoReportStatusLike = (typeof GEO_REPORT_STATUSES)[number]

/** 报表列表查询。 */
export class ListGeoReportQueryDto {
  @ApiPropertyOptional({ type: String, description: '只看这个品牌的' })
  @IsOptional()
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId?: string

  @ApiPropertyOptional({ enum: GEO_REPORT_PERIODS, description: '按周期类型筛' })
  @IsOptional()
  @IsIn(GEO_REPORT_PERIODS, { message: '周期类型不在取值范围内' })
  period?: GeoReportPeriodLike

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

/**
 * 手动生成一份报表。
 *
 * `periodStart` 是 `YYYY-MM-DD`，**周期的第一天**。`periodEnd` 不让传：
 * 它由 `period` 推出来（WEEKLY = +6 天，MONTHLY = 当月最后一天）。
 * 让调用方自己给结束日的话，「生成一份 3 天的周报」就成立了，
 * 而 `@@unique([tenantId, brandId, period, periodStart])` 挡不住它——
 * 同一个 `periodStart` 的那份已经存在，于是新的那份直接被判重复，
 * 表现是"点了生成没反应"。
 */
export class GenerateGeoReportDto {
  @ApiProperty({ type: String, description: '给哪个品牌生成' })
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId!: string

  @ApiProperty({ enum: GEO_REPORT_PERIODS, description: 'WEEKLY = 7 天；MONTHLY = 自然月' })
  @IsIn(GEO_REPORT_PERIODS, { message: '周期类型不在取值范围内' })
  period!: GeoReportPeriodLike

  @ApiProperty({
    type: String,
    description: '周期第一天，YYYY-MM-DD。WEEKLY 建议传周一，MONTHLY 建议传当月 1 号',
  })
  @IsString({ message: 'periodStart 必须是字符串' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'periodStart 必须是 YYYY-MM-DD' })
  periodStart!: string
}

// ── 出参 ─────────────────────────────────────────────────────────────────

/** 报表列表里的一行（**不含 payload**——它可能有几十 KB，列表页用不上）。 */
export class GeoReportView {
  @ApiProperty({ type: String })
  id!: string

  @ApiProperty({ type: String })
  brandId!: string

  @ApiProperty({ type: String, description: '品牌名；品牌被软删后回空串' })
  brandName!: string

  @ApiProperty({ enum: GEO_REPORT_PERIODS })
  period!: GeoReportPeriodLike

  @ApiProperty({ type: String, description: '周期起（含），YYYY-MM-DD' })
  periodStart!: string

  @ApiProperty({ type: String, description: '周期止（含），YYYY-MM-DD' })
  periodEnd!: string

  @ApiProperty({ enum: GEO_REPORT_STATUSES })
  status!: GeoReportStatusLike

  @ApiProperty({ type: String })
  createdAt!: string
}

/**
 * 报表详情 = 列表行 + `payload` 快照。
 *
 * `payload` 的形状由 `geo-report.service.ts` 的 `buildPayload` 定：
 * `{ version, brandId, brandName, period, periodStart, periodEnd, generatedAt,
 *    overview, trend, engines, competitors, topCitations }`。
 * 带 `version` 是为了让 T8 的前端能按版本分支渲染——快照是**历史数据**，
 * 口径改了之后老报告不会跟着变（那正是它存在的理由），所以渲染器迟早要面对
 * 两代形状。
 */
export class GeoReportDetailView extends GeoReportView {
  @ApiProperty({ type: Object, description: '生成时的完整快照，形状见 buildPayload' })
  payload!: Record<string, unknown>
}
