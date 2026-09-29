/**
 * 商家侧「用量与成本」的 DTO（`/api/admin/geo/usage`，技术设计 §4.1 usage 一行）。
 *
 * 与 `dashboard/dto/geo-dashboard.dto.ts` 同一套分层：**DTO 只挡形状**。
 *
 * `@ApiProperty` 一律**显式写 `type`**：没有 `emitDecoratorMetadata`，Swagger 推断不出来。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator'

/** `GeoUsageMetric` 的取值。 */
export const GEO_USAGE_METRICS = ['QUERY', 'LLM_TOKEN', 'CONTENT_GEN'] as const
/** {@link GEO_USAGE_METRICS} 的联合类型。 */
export type GeoUsageMetricLike = (typeof GEO_USAGE_METRICS)[number]

/** `GeoUsageLedger.month` 的格式：`YYYY-MM`。 */
export const GEO_USAGE_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

/** 用量查询：不传 `month` 时服务层用当月，不传 `brandId` 时汇总本店全部品牌。 */
export class GeoUsageQueryDto {
  @ApiPropertyOptional({ type: String, description: '只看这个品牌的；不传 = 本店全部品牌汇总' })
  @IsOptional()
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId?: string

  @ApiPropertyOptional({ type: String, description: '月份 YYYY-MM；不传 = 当月', example: '2026-09' })
  @IsOptional()
  @Matches(GEO_USAGE_MONTH_PATTERN, { message: 'month 格式必须是 YYYY-MM' })
  month?: string
}

/** 按计量指标（QUERY / LLM_TOKEN / CONTENT_GEN）拆的一行。 */
export class GeoUsageMetricBreakdownView {
  @ApiProperty({ enum: GEO_USAGE_METRICS }) metric!: GeoUsageMetricLike
  @ApiProperty({ type: Number, description: '计量数量：口径随 metric 变（次数/token 数/篇数）' })
  quantity!: number
  @ApiProperty({ type: Number }) costCents!: number
}

/** 按引擎拆的一行。 */
export class GeoUsageEngineBreakdownView {
  @ApiProperty({ type: String, description: '引擎 code；空串 = 与引擎无关的用量（如 LLM 分析）' })
  engineCode!: string
  @ApiProperty({ type: Number }) quantity!: number
  @ApiProperty({ type: Number }) costCents!: number
}

/** 下发给前端的用量汇总。 */
export class GeoUsageSummaryView {
  @ApiProperty({ type: String, description: '这份汇总所属的月份 YYYY-MM' }) month!: string
  @ApiProperty({ type: String, description: '为空串表示本店全部品牌汇总' }) brandId!: string
  @ApiProperty({ type: Number, description: '这个月的总成本（分）' }) totalCostCents!: number
  @ApiProperty({ type: GeoUsageMetricBreakdownView, isArray: true })
  byMetric!: GeoUsageMetricBreakdownView[]
  @ApiProperty({ type: GeoUsageEngineBreakdownView, isArray: true })
  byEngine!: GeoUsageEngineBreakdownView[]
}
