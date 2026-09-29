/**
 * 跑批（`GeoQueryRun`）与回答明细（`GeoQueryResult`）接口的 DTO。
 *
 * 与 brand / prompt 同一套分层：**DTO 只挡形状**，业务规则（查询计划展开、状态机收口、
 * 成本公式）在 `geo-run.rules.ts` 的纯函数里。
 *
 * `@ApiProperty` 一律**显式写 `type`**：没有 `emitDecoratorMetadata`，Swagger 推断不出来。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

/** `GeoRunStatus` 的取值。写成常量数组是给 `@IsIn` 与 Swagger 的 `enum` 共用一份。 */
export const GEO_RUN_STATUSES = ['PENDING', 'RUNNING', 'DONE', 'PARTIAL', 'FAILED'] as const
/** {@link GEO_RUN_STATUSES} 的联合类型。 */
export type GeoRunStatusLike = (typeof GEO_RUN_STATUSES)[number]

/** `GeoRunTrigger` 的取值。 */
export const GEO_RUN_TRIGGERS = ['SCHEDULE', 'MANUAL'] as const
/** {@link GEO_RUN_TRIGGERS} 的联合类型。 */
export type GeoRunTriggerLike = (typeof GEO_RUN_TRIGGERS)[number]

/** `GeoResultStatus` 的取值。 */
export const GEO_RESULT_STATUSES = ['PENDING', 'OK', 'FAILED'] as const
/** {@link GEO_RESULT_STATUSES} 的联合类型。 */
export type GeoResultStatusLike = (typeof GEO_RESULT_STATUSES)[number]

/**
 * 一次手动触发的入参。
 *
 * 三个可选项都是**缩小范围**用的：不传就按品牌配置全量跑（全部启用引擎 ×
 * 全部 `isTracked` 的问法 × 品牌的 `sampleSize`）。传了就只跑指定的那部分——
 * 运营改完一条问法想立刻看效果时，不该被迫把整批重跑一遍（那是真金白银）。
 */
export class CreateGeoRunDto {
  @ApiProperty({ type: String, description: '要跑哪个品牌' })
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId!: string

  @ApiPropertyOptional({
    type: [String],
    description: '只跑这几个引擎；不传 = 品牌 engineCodes 里当前仍然启用的全部',
  })
  @IsOptional()
  @IsArray({ message: 'engineCodes 必须是数组' })
  @ArrayMaxSize(20, { message: '引擎最多 20 个' })
  @IsString({ each: true, message: '引擎 code 必须是字符串' })
  engineCodes?: string[]

  @ApiPropertyOptional({
    type: [String],
    description: '只跑这几条问法；不传 = 该品牌下全部 isTracked 的问法',
  })
  @IsOptional()
  @IsArray({ message: 'promptIds 必须是数组' })
  @ArrayMaxSize(500, { message: '一次最多指定 500 条问法' })
  @IsString({ each: true, message: 'promptId 必须是字符串' })
  promptIds?: string[]

  @ApiPropertyOptional({ type: Number, description: '每个「问法 × 引擎」采样几次；不传用品牌配置' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'sampleSize 必须是整数' })
  @Min(1, { message: 'sampleSize 至少 1' })
  @Max(10, { message: 'sampleSize 上限 10' })
  sampleSize?: number
}

/** 跑批列表查询。 */
export class ListGeoRunQueryDto {
  @ApiPropertyOptional({ type: String, description: '只看这个品牌的' })
  @IsOptional()
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId?: string

  @ApiPropertyOptional({ enum: GEO_RUN_STATUSES, description: '按状态筛' })
  @IsOptional()
  @IsIn(GEO_RUN_STATUSES, { message: '状态不在取值范围内' })
  status?: GeoRunStatusLike

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

/** 回答明细列表查询。五个筛选维度都是可选的。 */
export class ListGeoResultQueryDto {
  @ApiPropertyOptional({ type: String, description: '按品牌筛' })
  @IsOptional()
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId?: string

  @ApiPropertyOptional({ type: String, description: '按跑批筛' })
  @IsOptional()
  @IsString({ message: 'runId 必须是字符串' })
  @MaxLength(26, { message: 'runId 过长' })
  runId?: string

  @ApiPropertyOptional({ type: String, description: '按引擎筛' })
  @IsOptional()
  @IsString({ message: 'engineCode 必须是字符串' })
  @MaxLength(64, { message: 'engineCode 过长' })
  engineCode?: string

  @ApiPropertyOptional({ type: String, description: '按问法筛' })
  @IsOptional()
  @IsString({ message: 'promptId 必须是字符串' })
  @MaxLength(26, { message: 'promptId 过长' })
  promptId?: string

  @ApiPropertyOptional({ enum: GEO_RESULT_STATUSES, description: '按结果状态筛' })
  @IsOptional()
  @IsIn(GEO_RESULT_STATUSES, { message: '状态不在取值范围内' })
  status?: GeoResultStatusLike

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

/** 下发给前端的一次跑批。 */
export class GeoRunView {
  @ApiProperty({ type: String }) id!: string
  @ApiProperty({ type: String }) brandId!: string
  @ApiProperty({ enum: GEO_RUN_TRIGGERS }) triggeredBy!: GeoRunTriggerLike
  @ApiProperty({ enum: GEO_RUN_STATUSES }) status!: GeoRunStatusLike
  @ApiProperty({ type: [String] }) engineCodes!: string[]
  @ApiProperty({ type: Number }) sampleSize!: number
  @ApiProperty({ type: Number }) totalQueries!: number
  @ApiProperty({ type: Number }) doneQueries!: number
  @ApiProperty({ type: Number }) failedQueries!: number
  @ApiProperty({ type: Number, description: '这一批花了多少分（引擎侧成本）' })
  totalCostCents!: number
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) startedAt!: string | null
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) finishedAt!: string | null
  @ApiProperty({
    type: Object,
    nullable: true,
    description: '按 errorKind 分组的失败计数，如 `{ "AUTH": 6 }`；没失败时为 null',
  })
  errorSummary!: Record<string, number> | null
  @ApiProperty({ type: String, nullable: true }) createdBy!: string | null
  @ApiProperty({
    type: Boolean,
    description: '是否由「先诊断后付费」编排接口（POST /brands/:id/diagnose）触发',
  })
  isDiagnosis!: boolean
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      '诊断报表（GeoReport，period=ONE_SHOT）的 id；仅 isDiagnosis 为 true 时可能有值，' +
      '为 null 表示还没生成（跑批未到终态，或聚合/生成还在进行中，轮询本接口直到非 null）',
  })
  diagnosisReportId!: string | null
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string
}

/** 跑批详情：在列表那一份之上附一份按结果状态分的计数。 */
export class GeoRunDetailView extends GeoRunView {
  @ApiProperty({
    type: Object,
    description: '这一批的 GeoQueryResult 按 status 分的实时计数，如 `{ PENDING: 2, OK: 4, FAILED: 0 }`',
  })
  resultCounts!: Record<string, number>
}

/** 下发给前端的一条回答明细（**列表用，不含原文**）。 */
export class GeoResultView {
  @ApiProperty({ type: String }) id!: string
  @ApiProperty({ type: String }) runId!: string
  @ApiProperty({ type: String }) brandId!: string
  @ApiProperty({ type: String }) promptId!: string
  @ApiProperty({ type: String }) engineCode!: string
  @ApiProperty({ type: Number }) sampleIndex!: number
  @ApiProperty({ enum: GEO_RESULT_STATUSES }) status!: GeoResultStatusLike
  @ApiProperty({ type: String, description: '回答正文的前 500 字' }) preview!: string
  @ApiProperty({ type: Boolean, description: '原文是否被截断过' }) rawTruncated!: boolean
  @ApiProperty({ type: String }) model!: string
  @ApiProperty({ type: Number }) latencyMs!: number
  @ApiProperty({ type: Number }) inputTokens!: number
  @ApiProperty({ type: Number }) outputTokens!: number
  @ApiProperty({ type: Number }) searchCalls!: number
  @ApiProperty({ type: Number }) costCents!: number
  @ApiProperty({ type: String, nullable: true }) errorKind!: string | null
  @ApiProperty({ type: String, nullable: true }) errorMessage!: string | null
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) answeredAt!: string | null
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) analyzedAt!: string | null
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string
}

/** 详情里的一条提及。 */
export class GeoMentionView {
  @ApiProperty({ type: String }) id!: string
  @ApiProperty({ enum: ['BRAND', 'COMPETITOR'] }) entityKind!: string
  @ApiProperty({ type: String, nullable: true }) competitorId!: string | null
  @ApiProperty({ type: String }) entityName!: string
  @ApiProperty({ type: Number }) position!: number
  @ApiProperty({ type: Boolean }) isCited!: boolean
  @ApiProperty({ enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] }) sentiment!: string
  @ApiProperty({ type: Number }) sentimentScore!: number
  @ApiProperty({ type: String }) snippet!: string
}

/** 详情里的一条引用。 */
export class GeoCitationView {
  @ApiProperty({ type: String }) id!: string
  @ApiProperty({ type: String }) url!: string
  @ApiProperty({ type: String }) domain!: string
  @ApiProperty({ type: String }) platform!: string
  @ApiProperty({ type: String }) category!: string
  @ApiProperty({ type: Number }) rank!: number
  @ApiProperty({ type: String, nullable: true }) title!: string | null
}

/**
 * 回答明细的详情：列表那一份 + **原文** + 这条回答分析出来的提及与引用。
 *
 * 原文只在详情里下发，不进列表：`rawText` 是 `@db.Text`，一页 20 条就是几百 KB，
 * 而列表页上没有任何地方会显示它。
 */
export class GeoResultDetailView extends GeoResultView {
  @ApiProperty({ type: String, nullable: true, description: '回答原文（可能被截断，见 rawTruncated）' })
  rawText!: string | null
  @ApiProperty({ type: GeoMentionView, isArray: true }) mentions!: GeoMentionView[]
  @ApiProperty({ type: GeoCitationView, isArray: true }) citations!: GeoCitationView[]
}
