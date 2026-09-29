/**
 * 平台侧「全平台用量与成本看板」的 DTO（`/api/platform/geo/usage`，
 * 技术设计 §4.1 usage(平台) 一行）。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator'

import { GEO_USAGE_MONTH_PATTERN } from './geo-usage.dto'

/** 平台侧用量查询：不传 `month` 时服务层用当月，不传 `tenantId` 时看全平台。 */
export class GeoPlatformUsageQueryDto {
  @ApiPropertyOptional({ type: String, description: '月份 YYYY-MM；不传 = 当月', example: '2026-09' })
  @IsOptional()
  @Matches(GEO_USAGE_MONTH_PATTERN, { message: 'month 格式必须是 YYYY-MM' })
  month?: string

  @ApiPropertyOptional({ type: String, description: '只看这一个租户的；不传 = 全平台' })
  @IsOptional()
  @IsString({ message: 'tenantId 必须是字符串' })
  @MaxLength(26, { message: 'tenantId 过长' })
  tenantId?: string
}

/** 按租户拆的一行。 */
export class GeoPlatformUsageTenantView {
  @ApiProperty({ type: String }) tenantId!: string
  @ApiProperty({ type: String }) tenantName!: string
  @ApiProperty({ type: Number }) quantity!: number
  @ApiProperty({ type: Number }) costCents!: number
}

/** 按引擎拆的一行。 */
export class GeoPlatformUsageEngineView {
  @ApiProperty({ type: String, description: '引擎 code；空串 = 与引擎无关的用量' })
  engineCode!: string
  @ApiProperty({ type: Number }) quantity!: number
  @ApiProperty({ type: Number }) costCents!: number
}

/** 下发给平台运营的用量汇总。 */
export class GeoPlatformUsageSummaryView {
  @ApiProperty({ type: String, description: '这份汇总所属的月份 YYYY-MM' }) month!: string
  @ApiProperty({ type: Number, description: '这个月全平台（或指定租户）的总成本（分）' })
  totalCostCents!: number
  @ApiProperty({ type: GeoPlatformUsageTenantView, isArray: true })
  byTenant!: GeoPlatformUsageTenantView[]
  @ApiProperty({ type: GeoPlatformUsageEngineView, isArray: true })
  byEngine!: GeoPlatformUsageEngineView[]
}
