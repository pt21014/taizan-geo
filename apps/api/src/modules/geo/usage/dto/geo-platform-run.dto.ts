/**
 * 平台侧「跑批监控与重跑」的 DTO（`/api/platform/geo/runs`，
 * 技术设计 §4.1 usage(平台) 一行）。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

/** `GeoRunStatus` 的取值。与 `run/dto/geo-run.dto.ts` 的 `GEO_RUN_STATUSES` 同形——
 * 不复用那份导出是为了不让平台目录反向依赖商家侧 dto 文件。 */
export const GEO_PLATFORM_RUN_STATUSES = ['PENDING', 'RUNNING', 'DONE', 'PARTIAL', 'FAILED'] as const
/** {@link GEO_PLATFORM_RUN_STATUSES} 的联合类型。 */
export type GeoPlatformRunStatusLike = (typeof GEO_PLATFORM_RUN_STATUSES)[number]

/** 全平台跑批列表查询。 */
export class ListGeoPlatformRunQueryDto {
  @ApiPropertyOptional({ type: String, description: '只看这一个租户的' })
  @IsOptional()
  @IsString({ message: 'tenantId 必须是字符串' })
  @MaxLength(26, { message: 'tenantId 过长' })
  tenantId?: string

  @ApiPropertyOptional({ enum: GEO_PLATFORM_RUN_STATUSES, description: '按状态筛' })
  @IsOptional()
  @IsIn(GEO_PLATFORM_RUN_STATUSES, { message: '状态不在取值范围内' })
  status?: GeoPlatformRunStatusLike

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

/** 下发给平台运营的一次跑批（附店名，不含引擎/成本以外的商家侧细节）。 */
export class GeoPlatformRunView {
  @ApiProperty({ type: String }) id!: string
  @ApiProperty({ type: String }) tenantId!: string
  @ApiProperty({ type: String }) tenantName!: string
  @ApiProperty({ type: String }) brandId!: string
  @ApiProperty({ enum: GEO_PLATFORM_RUN_STATUSES }) status!: GeoPlatformRunStatusLike
  @ApiProperty({ type: Number }) totalQueries!: number
  @ApiProperty({ type: Number }) doneQueries!: number
  @ApiProperty({ type: Number }) failedQueries!: number
  @ApiProperty({ type: Number, description: '这一批花了多少分（引擎侧成本）' })
  totalCostCents!: number
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) startedAt!: string | null
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) finishedAt!: string | null
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string
}

/** 重跑的结果。 */
export class GeoPlatformRunRetryResultView {
  @ApiProperty({ type: String }) id!: string
  @ApiProperty({ type: Number, description: '这次重置并重新入队的失败查询条数' })
  retriedCount!: number
}
