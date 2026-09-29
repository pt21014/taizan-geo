/**
 * 告警规则 CRUD 与告警事件列表的 DTO。
 *
 * **DTO 只挡形状**：通道白名单（只允许 `['INBOX']` 或 `['INBOX','SMS']`）由
 * `geo-alert.rules.ts` 的 `validateChannels` 判，同品牌同 kind 的活跃唯一由
 * service 的 `assertRuleAvailable` 兜（唯一索引带 `deletedAt`，MySQL 把 NULL
 * 视为互不相同，硬约束保证不了活跃唯一——蓝图 §10 第 9 条）。
 *
 * `@ApiProperty` 一律**显式写 `type`**（本仓没有 `emitDecoratorMetadata`）。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
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

/** `GeoAlertKind` 的取值。 */
export const GEO_ALERT_KINDS = [
  'VISIBILITY_DROP',
  'COMPETITOR_OVERTAKE',
  'NEGATIVE_MENTION',
] as const
/** {@link GEO_ALERT_KINDS} 的联合类型。 */
export type GeoAlertKindLike = (typeof GEO_ALERT_KINDS)[number]

/** 允许的通道值。白名单本身在 `validateChannels` 里，这里只挡「是不是这四个字之一」。 */
export const GEO_ALERT_CHANNELS = ['INBOX', 'SMS'] as const
/** {@link GEO_ALERT_CHANNELS} 的联合类型。 */
export type GeoAlertChannelLike = (typeof GEO_ALERT_CHANNELS)[number]

/** 新建告警规则。 */
export class CreateGeoAlertRuleDto {
  @ApiProperty({ type: String, description: '给哪个品牌配' })
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId!: string

  @ApiProperty({ enum: GEO_ALERT_KINDS, description: '告警类型（同品牌同类型只能有一条活跃规则）' })
  @IsIn(GEO_ALERT_KINDS, { message: '告警类型不在取值范围内' })
  kind!: GeoAlertKindLike

  @ApiProperty({
    type: Number,
    description:
      '阈值。VISIBILITY_DROP / COMPETITOR_OVERTAKE 语义是基点（1000 = 提及率跌 10 个百分点），' +
      'NEGATIVE_MENTION 语义是**条数**（当天负面提及达到这个数就报）。三种共用一列是表结构定的。',
  })
  @Type(() => Number)
  @IsInt({ message: 'thresholdBp 必须是整数' })
  @Min(0, { message: 'thresholdBp 不能是负数' })
  @Max(10000, { message: 'thresholdBp 上限 10000' })
  thresholdBp!: number

  @ApiPropertyOptional({
    enum: GEO_ALERT_CHANNELS,
    isArray: true,
    description: '通知通道，只允许 ["INBOX"] 或 ["INBOX","SMS"]；不传按 ["INBOX"]',
  })
  @IsOptional()
  @IsArray({ message: 'channels 必须是数组' })
  @ArrayMaxSize(2, { message: '通道最多 2 个' })
  @IsIn(GEO_ALERT_CHANNELS, { each: true, message: '通道只能是 INBOX 或 SMS' })
  channels?: GeoAlertChannelLike[]

  @ApiPropertyOptional({ type: Boolean, description: '是否启用；不传按 true' })
  @IsOptional()
  @IsBoolean({ message: 'enabled 必须是布尔值' })
  enabled?: boolean
}

/**
 * 修改告警规则。
 *
 * **没有 `brandId`**：换品牌等于换一条规则（活跃唯一是按 `(brandId, kind)` 判的），
 * 允许改的话「把 A 品牌的规则改成 B 品牌的」会绕过唯一性校验的那一半。
 * `kind` 同理。要换就删了重建。
 */
export class UpdateGeoAlertRuleDto {
  @ApiPropertyOptional({ type: Number, description: '阈值，语义见新建' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'thresholdBp 必须是整数' })
  @Min(0, { message: 'thresholdBp 不能是负数' })
  @Max(10000, { message: 'thresholdBp 上限 10000' })
  thresholdBp?: number

  @ApiPropertyOptional({ enum: GEO_ALERT_CHANNELS, isArray: true })
  @IsOptional()
  @IsArray({ message: 'channels 必须是数组' })
  @ArrayMaxSize(2, { message: '通道最多 2 个' })
  @IsIn(GEO_ALERT_CHANNELS, { each: true, message: '通道只能是 INBOX 或 SMS' })
  channels?: GeoAlertChannelLike[]

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean({ message: 'enabled 必须是布尔值' })
  enabled?: boolean
}

/** 规则列表查询。 */
export class ListGeoAlertRuleQueryDto {
  @ApiPropertyOptional({ type: String, description: '只看这个品牌的' })
  @IsOptional()
  @IsString({ message: 'brandId 必须是字符串' })
  @MaxLength(26, { message: 'brandId 过长' })
  brandId?: string

  @ApiPropertyOptional({ enum: GEO_ALERT_KINDS, description: '按类型筛' })
  @IsOptional()
  @IsIn(GEO_ALERT_KINDS, { message: '告警类型不在取值范围内' })
  kind?: GeoAlertKindLike

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

/** 告警事件列表查询。 */
export class ListGeoAlertEventQueryDto extends ListGeoAlertRuleQueryDto {}

// ── 出参 ─────────────────────────────────────────────────────────────────

/** 一条告警规则。 */
export class GeoAlertRuleView {
  @ApiProperty({ type: String })
  id!: string

  @ApiProperty({ type: String })
  brandId!: string

  @ApiProperty({ type: String, description: '品牌名；品牌被软删后回空串' })
  brandName!: string

  @ApiProperty({ enum: GEO_ALERT_KINDS })
  kind!: GeoAlertKindLike

  @ApiProperty({ type: Number })
  thresholdBp!: number

  @ApiProperty({ enum: GEO_ALERT_CHANNELS, isArray: true })
  channels!: GeoAlertChannelLike[]

  @ApiProperty({ type: Boolean })
  enabled!: boolean

  @ApiProperty({ type: String, nullable: true, description: '上次触发时刻（冷却期从它起算）' })
  lastFiredAt!: string | null

  @ApiProperty({ type: String })
  createdAt!: string

  @ApiProperty({ type: String })
  updatedAt!: string
}

/** 一条告警触发记录。 */
export class GeoAlertEventView {
  @ApiProperty({ type: String })
  id!: string

  @ApiProperty({ type: String, description: '规则 id；规则删了之后这个值仍然保留' })
  ruleId!: string

  @ApiProperty({ type: String })
  brandId!: string

  @ApiProperty({ type: String, description: '品牌名；品牌被软删后回空串' })
  brandName!: string

  @ApiProperty({ enum: GEO_ALERT_KINDS })
  kind!: GeoAlertKindLike

  @ApiProperty({
    type: Object,
    description: '触发时的证据快照（阈值、实际值、对比窗口、涉及的竞品等），形状随 kind 变',
  })
  payload!: Record<string, unknown>

  @ApiProperty({ type: String, nullable: true, description: '通知发出的时刻；为空 = 还没发或发失败' })
  notifiedAt!: string | null

  @ApiProperty({ type: String })
  createdAt!: string
}

/** 删除类接口的返回。 */
export class GeoAlertIdResultView {
  @ApiProperty({ type: String })
  id!: string
}
