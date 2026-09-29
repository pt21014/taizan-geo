/**
 * GEO 看板五条只读接口的 DTO。
 *
 * 与 brand / prompt / run 同一套分层：**DTO 只挡形状**，加权口径在
 * `geo-dashboard.rules.ts` 的纯函数里。
 *
 * `@ApiProperty` 一律**显式写 `type`**：本仓没有 `emitDecoratorMetadata`，
 * Swagger 推断不出来（蓝图 §10 第 8 条）。
 *
 * ## `days` 为什么是枚举而不是 `@Min/@Max`
 *
 * 允许任意天数的话，`days=3650` 会让一次请求扫十年的日聚合行——这个模块的全部
 * 卖点就是"只查预聚合表、不扫明细"，而一次十年的扫描把那个卖点抵消掉了。
 * 三档固定值（7 / 30 / 90）同时也让前端的时间选择器只有三个按钮，
 * 不用处理"用户输了 11 天"这种没人会看的区间。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

/** 允许的周期长度（天）。三档，见文件头。 */
export const GEO_DASHBOARD_DAYS = [7, 30, 90] as const
/** {@link GEO_DASHBOARD_DAYS} 的联合类型。 */
export type GeoDashboardDays = (typeof GEO_DASHBOARD_DAYS)[number]

/** 默认周期：7 天。 */
export const GEO_DASHBOARD_DEFAULT_DAYS: GeoDashboardDays = 7

/** 看板类接口的公共查询参数：必须指定品牌 + 周期长度。 */
export class GeoDashboardQueryDto {
  @ApiProperty({ type: String, description: '看哪个品牌' })
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId!: string

  @ApiPropertyOptional({
    enum: GEO_DASHBOARD_DAYS,
    description: '周期长度（天），只允许 7 / 30 / 90；不传按 7',
    default: GEO_DASHBOARD_DEFAULT_DAYS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(GEO_DASHBOARD_DAYS, { message: '周期只能是 7、30 或 90 天' })
  days?: GeoDashboardDays
}

/** 趋势 / Prompt 明细多一个可选的引擎筛选。 */
export class GeoDashboardEngineQueryDto extends GeoDashboardQueryDto {
  @ApiPropertyOptional({
    type: String,
    description: '只看这个引擎；不传 = 跨引擎汇总（engineCode = \'\' 那一档）',
  })
  @IsOptional()
  @IsString({ message: 'engineCode 必须是字符串' })
  @MaxLength(64, { message: 'engineCode 过长' })
  engineCode?: string
}

/** Prompt 明细还要分页。 */
export class GeoDashboardPromptQueryDto extends GeoDashboardEngineQueryDto {
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

// ─────────────────────────────────────────────────────────────────────────────
// 出参视图
//
// 全部是 `class` 而不是 `interface`：`@ApiOkResponse({ type: X })` 要的是一个
// 运行时存在的构造器。前端那份同名类型手写在 `apps/admin/src/api/geo-dashboard.ts`，
// 两边的字段由 T8 的页面接线时对齐（这一批接口的形状写在任务报告里给 T8 用）。
// ─────────────────────────────────────────────────────────────────────────────

/** 一个周期的合计指标。字段与 `GeoVisibilityDaily` 的度量列同名。 */
export class GeoRollupView {
  @ApiProperty({ type: String, description: '周期起（含），YYYY-MM-DD' })
  start!: string

  @ApiProperty({ type: String, description: '周期止（含），YYYY-MM-DD' })
  end!: string

  @ApiProperty({ type: Number, description: '周期内真的跑过的天数' })
  days!: number

  @ApiProperty({ type: Number, description: '回答总数（分母）' })
  answers!: number

  @ApiProperty({ type: Number, description: '提及本品牌的回答数' })
  mentions!: number

  @ApiProperty({ type: Number, description: '提及率，基点（10000 = 100%）' })
  mentionRateBp!: number

  @ApiProperty({ type: Number, description: '声量份额，基点' })
  sovBp!: number

  @ApiProperty({ type: Number, description: '平均位次 ×100（150 = 1.5 位），越小越好；0 = 无提及' })
  avgPositionX100!: number

  @ApiProperty({ type: Number, description: '引用率，基点' })
  citationRateBp!: number

  @ApiProperty({ type: Number, description: '平均情感分 ×100，值域 −100..100' })
  sentimentAvgX100!: number
}

/** 环比差值（当前周期 − 上一周期），逐字段绝对差。 */
export class GeoRollupDeltaView {
  @ApiProperty({ type: Number })
  answers!: number

  @ApiProperty({ type: Number })
  mentionRateBp!: number

  @ApiProperty({ type: Number })
  sovBp!: number

  @ApiProperty({ type: Number, description: '注意：变小是变好（位次越靠前越好）' })
  avgPositionX100!: number

  @ApiProperty({ type: Number })
  citationRateBp!: number

  @ApiProperty({ type: Number })
  sentimentAvgX100!: number
}

/** 最近一次跑批的状态，给总览页右上角那块"上次更新"用。 */
export class GeoLastRunView {
  @ApiProperty({ type: String })
  id!: string

  @ApiProperty({ type: String, description: 'PENDING | RUNNING | DONE | PARTIAL | FAILED' })
  status!: string

  @ApiProperty({ type: String, description: 'SCHEDULE | MANUAL' })
  triggeredBy!: string

  @ApiProperty({ type: Number })
  totalQueries!: number

  @ApiProperty({ type: Number })
  doneQueries!: number

  @ApiProperty({ type: Number })
  failedQueries!: number

  @ApiProperty({ type: String, nullable: true })
  startedAt!: string | null

  @ApiProperty({ type: String, nullable: true })
  finishedAt!: string | null

  @ApiProperty({ type: String })
  createdAt!: string
}

/** `GET /dashboard/overview` 的返回。 */
export class GeoDashboardOverviewView {
  @ApiProperty({ type: String })
  brandId!: string

  @ApiProperty({ type: String })
  brandName!: string

  @ApiProperty({ type: Number, description: '周期长度（天）' })
  days!: number

  @ApiProperty({ type: GeoRollupView, description: '当前周期' })
  current!: GeoRollupView

  @ApiProperty({ type: GeoRollupView, description: '上一周期（等长、紧邻）' })
  previous!: GeoRollupView

  @ApiProperty({ type: GeoRollupDeltaView, description: '当前 − 上一周期' })
  delta!: GeoRollupDeltaView

  @ApiProperty({ type: GeoLastRunView, nullable: true, description: '最近一次跑批；从没跑过时为 null' })
  lastRun!: GeoLastRunView | null
}

/**
 * 一组度量列。趋势点、引擎行、Prompt 行都继承它——三处的度量字段本来就是
 * `GeoVisibilityDaily` 的同一组列，各写一遍只会让某天加一个指标时漏改其中一处。
 */
export class GeoMetricsFieldsView {
  @ApiProperty({ type: Number })
  answers!: number

  @ApiProperty({ type: Number })
  mentions!: number

  @ApiProperty({ type: Number })
  mentionRateBp!: number

  @ApiProperty({ type: Number })
  sovBp!: number

  @ApiProperty({ type: Number })
  avgPositionX100!: number

  @ApiProperty({ type: Number })
  citationRateBp!: number

  @ApiProperty({ type: Number })
  sentimentAvgX100!: number
}

/** 趋势里的一天 = 度量列 + 日期。 */
export class GeoTrendPointView extends GeoMetricsFieldsView {
  @ApiProperty({ type: String, description: 'YYYY-MM-DD' })
  date!: string
}

/** `GET /dashboard/trend` 的返回。 */
export class GeoDashboardTrendView {
  @ApiProperty({ type: String })
  brandId!: string

  @ApiProperty({ type: Number })
  days!: number

  @ApiProperty({ type: String, description: '筛的引擎；`\'\'` 表示跨引擎汇总' })
  engineCode!: string

  @ApiProperty({
    type: GeoTrendPointView,
    isArray: true,
    description: '按日期升序；**只有真的跑过的那些天**有点，没跑的那天不补 0',
  })
  points!: GeoTrendPointView[]
}

/** 每引擎一行（周期合计，没有 `date`）。 */
export class GeoEngineMetricsView extends GeoMetricsFieldsView {
  @ApiProperty({ type: String })
  engineCode!: string

  @ApiProperty({ type: String, description: '引擎展示名；平台侧已删掉该引擎时回 code 本身' })
  engineName!: string
}

/** `GET /dashboard/engines` 的返回。 */
export class GeoDashboardEnginesView {
  @ApiProperty({ type: String })
  brandId!: string

  @ApiProperty({ type: Number })
  days!: number

  @ApiProperty({ type: GeoEngineMetricsView, isArray: true, description: '按 mentionRateBp 降序' })
  items!: GeoEngineMetricsView[]
}

/** 品牌或某个竞品的一行对照数据。 */
export class GeoCompetitorMetricsView {
  @ApiProperty({ type: String, description: '竞品 id；本品牌那一行是空串' })
  competitorId!: string

  @ApiProperty({ type: String, description: '展示名（品牌名或竞品名）' })
  name!: string

  @ApiProperty({ type: Boolean, description: 'true = 这一行是本品牌自己' })
  isBrand!: boolean

  @ApiProperty({ type: Number })
  mentions!: number

  @ApiProperty({ type: Number })
  mentionRateBp!: number

  @ApiProperty({ type: Number })
  sovBp!: number

  @ApiProperty({ type: Number })
  avgPositionX100!: number
}

/** `GET /dashboard/competitors` 的返回。 */
export class GeoDashboardCompetitorsView {
  @ApiProperty({ type: String })
  brandId!: string

  @ApiProperty({ type: Number })
  days!: number

  @ApiProperty({
    type: GeoCompetitorMetricsView,
    isArray: true,
    description: '**第一行永远是本品牌**（isBrand = true），其余竞品按 sovBp 降序',
  })
  items!: GeoCompetitorMetricsView[]
}

/** 每条 Prompt 一行（周期合计，没有 `date`）。 */
export class GeoPromptMetricsView extends GeoMetricsFieldsView {
  @ApiProperty({ type: String })
  promptId!: string

  @ApiProperty({ type: String, description: '问法原文；问法被软删后回空串' })
  text!: string

  @ApiProperty({ type: String, nullable: true })
  topic!: string | null

  @ApiProperty({ type: String, description: 'TOFU | MOFU | BOFU | UNKNOWN' })
  funnelStage!: string
}
