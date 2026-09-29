/**
 * 平台域「GEO 引擎接入点」的 DTO。
 *
 * ## 两层校验，各管一件事（与 `brand/dto/geo-brand.dto.ts` 同一条约定）
 *
 * - **DTO（这里）只挡形状**：类型对不对、必填有没有、长度有没有离谱到该直接 400；
 * - **业务规则在 `geo-engine.rules.ts`**：code 正则、单价非负、限速与超时区间——
 *   那些是纯函数，有单测，seed 与将来的导入脚本也要用。
 *
 * `@ApiProperty` 一律**显式写 `type`**：没有 `emitDecoratorMetadata`，Swagger 推断不出来。
 *
 * ## 凭据为什么单独一个 DTO、走单独一个 `PUT`
 *
 * 密钥不跟着 `PATCH /:id` 一起改，是为了让「改了名字」与「换了密钥」在审计日志上
 * 是两条不同的记录（`geo-engine.update` 与 `geo-engine.credential-update`）。
 * 合成一条之后，「上周五谁把生产的 key 换掉了」这个问题只能靠翻 diff 猜。
 *
 * 另外：`UpdateGeoEngineDto` 里**根本没有凭据字段**，于是「改个排序顺手把密钥
 * 覆盖成空」在类型层面就不可能发生。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

import {
  GEO_ACCESS_TYPES,
  GEO_RATE_LIMIT_MAX,
  GEO_RATE_LIMIT_MIN,
  GEO_TIMEOUT_MS_MAX,
  GEO_TIMEOUT_MS_MIN,
  type GeoAccessTypeLike,
} from '../geo-engine.rules'

/** 新建引擎。 */
export class CreateGeoEngineDto {
  @ApiProperty({ type: String, description: '稳定标识，建后不可改', example: 'qwen' })
  @IsString({ message: '引擎 code 必须是字符串' })
  @MaxLength(64, { message: '引擎 code 过长' })
  code!: string

  @ApiProperty({ type: String, description: '展示名', example: '通义千问' })
  @IsString({ message: '引擎名必须是字符串' })
  @MaxLength(200, { message: '引擎名过长' })
  name!: string

  @ApiProperty({ type: String, description: '厂商标识', example: 'aliyun' })
  @IsString({ message: '厂商必须是字符串' })
  @MaxLength(64, { message: '厂商过长' })
  vendor!: string

  @ApiPropertyOptional({ enum: GEO_ACCESS_TYPES, description: '接入方式', default: 'API' })
  @IsOptional()
  @IsIn(GEO_ACCESS_TYPES as readonly string[], {
    message: `接入方式只能是 ${GEO_ACCESS_TYPES.join(' / ')}`,
  })
  accessType?: GeoAccessTypeLike

  @ApiPropertyOptional({ type: Boolean, description: '是否启用', default: false })
  @IsOptional()
  @IsBoolean({ message: 'enabled 必须是布尔' })
  enabled?: boolean

  @ApiPropertyOptional({ type: String, description: '默认模型名', example: 'qwen-plus' })
  @IsOptional()
  @IsString({ message: '模型名必须是字符串' })
  @MaxLength(128, { message: '模型名过长' })
  model?: string

  @ApiPropertyOptional({ type: String, description: 'API 基址（自建网关/代理时覆盖）' })
  @IsOptional()
  @IsString({ message: '接口地址必须是字符串' })
  @MaxLength(500, { message: '接口地址过长' })
  baseUrl?: string

  @ApiPropertyOptional({ type: Number, description: '按次单价（分/次）', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '按次单价必须是整数' })
  @Min(0, { message: '按次单价不能是负数' })
  pricePerQueryCents?: number

  @ApiPropertyOptional({ type: Number, description: '输入 token 单价（分/百万 token）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '输入单价必须是整数' })
  @Min(0, { message: '输入单价不能是负数' })
  priceInPerMTokenCents?: number

  @ApiPropertyOptional({ type: Number, description: '输出 token 单价（分/百万 token）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '输出单价必须是整数' })
  @Min(0, { message: '输出单价不能是负数' })
  priceOutPerMTokenCents?: number

  @ApiPropertyOptional({ type: Number, description: '平台侧限速（次/分钟）', default: 60 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '限速必须是整数' })
  @Min(GEO_RATE_LIMIT_MIN, { message: `限速至少 ${GEO_RATE_LIMIT_MIN} 次/分钟` })
  @Max(GEO_RATE_LIMIT_MAX, { message: `限速最多 ${GEO_RATE_LIMIT_MAX} 次/分钟` })
  rateLimitPerMin?: number

  @ApiPropertyOptional({ type: Number, description: '单次请求超时（毫秒）', default: 60000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '超时必须是整数' })
  @Min(GEO_TIMEOUT_MS_MIN, { message: `超时至少 ${GEO_TIMEOUT_MS_MIN} 毫秒` })
  @Max(GEO_TIMEOUT_MS_MAX, { message: `超时最多 ${GEO_TIMEOUT_MS_MAX} 毫秒` })
  timeoutMs?: number

  /**
   * 适配器的额外参数（temperature、是否联网、region…）。
   *
   * 与 `credentials` 分开：这里的东西**不是秘密**，明文落 `GeoEngine.config`，
   * 接口照常回显。把非秘密塞进密文包的代价是它从此在后台上看不见了。
   */
  @ApiPropertyOptional({ type: Object, description: '适配器额外参数（非密钥）' })
  @IsOptional()
  @IsObject({ message: 'config 必须是一个对象' })
  config?: Record<string, unknown>

  @ApiPropertyOptional({ type: Number, description: '展示排序', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '排序必须是整数' })
  sort?: number
}

/**
 * 修改引擎：全部可选，只改传了的字段。
 *
 * **没有 `code`**（建后不可改，历史结果按 code 存快照）、**没有 `enabled`**
 * （走 `PATCH /:id/enabled`，为的是审计里 enable/disable 是两条独立动作）、
 * **没有凭据字段**（走 `PUT /:id/credentials`）。
 */
export class UpdateGeoEngineDto {
  @ApiPropertyOptional({ type: String, description: '展示名' })
  @IsOptional()
  @IsString({ message: '引擎名必须是字符串' })
  @MaxLength(200, { message: '引擎名过长' })
  name?: string

  @ApiPropertyOptional({ type: String, description: '厂商标识' })
  @IsOptional()
  @IsString({ message: '厂商必须是字符串' })
  @MaxLength(64, { message: '厂商过长' })
  vendor?: string

  @ApiPropertyOptional({ enum: GEO_ACCESS_TYPES, description: '接入方式' })
  @IsOptional()
  @IsIn(GEO_ACCESS_TYPES as readonly string[], {
    message: `接入方式只能是 ${GEO_ACCESS_TYPES.join(' / ')}`,
  })
  accessType?: GeoAccessTypeLike

  @ApiPropertyOptional({ type: String, description: '默认模型名' })
  @IsOptional()
  @IsString({ message: '模型名必须是字符串' })
  @MaxLength(128, { message: '模型名过长' })
  model?: string

  @ApiPropertyOptional({ type: String, description: 'API 基址' })
  @IsOptional()
  @IsString({ message: '接口地址必须是字符串' })
  @MaxLength(500, { message: '接口地址过长' })
  baseUrl?: string

  @ApiPropertyOptional({ type: Number, description: '按次单价（分/次）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '按次单价必须是整数' })
  @Min(0, { message: '按次单价不能是负数' })
  pricePerQueryCents?: number

  @ApiPropertyOptional({ type: Number, description: '输入 token 单价（分/百万 token）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '输入单价必须是整数' })
  @Min(0, { message: '输入单价不能是负数' })
  priceInPerMTokenCents?: number

  @ApiPropertyOptional({ type: Number, description: '输出 token 单价（分/百万 token）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '输出单价必须是整数' })
  @Min(0, { message: '输出单价不能是负数' })
  priceOutPerMTokenCents?: number

  @ApiPropertyOptional({ type: Number, description: '平台侧限速（次/分钟）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '限速必须是整数' })
  @Min(GEO_RATE_LIMIT_MIN, { message: `限速至少 ${GEO_RATE_LIMIT_MIN} 次/分钟` })
  @Max(GEO_RATE_LIMIT_MAX, { message: `限速最多 ${GEO_RATE_LIMIT_MAX} 次/分钟` })
  rateLimitPerMin?: number

  @ApiPropertyOptional({ type: Number, description: '单次请求超时（毫秒）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '超时必须是整数' })
  @Min(GEO_TIMEOUT_MS_MIN, { message: `超时至少 ${GEO_TIMEOUT_MS_MIN} 毫秒` })
  @Max(GEO_TIMEOUT_MS_MAX, { message: `超时最多 ${GEO_TIMEOUT_MS_MAX} 毫秒` })
  timeoutMs?: number

  @ApiPropertyOptional({ type: Object, description: '适配器额外参数（非密钥）' })
  @IsOptional()
  @IsObject({ message: 'config 必须是一个对象' })
  config?: Record<string, unknown>

  @ApiPropertyOptional({ type: Number, description: '展示排序' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '排序必须是整数' })
  sort?: number
}

/** 启用 / 停用。 */
export class SetGeoEngineEnabledDto {
  @ApiProperty({ type: Boolean, description: 'true = 启用，false = 停用' })
  @IsBoolean({ message: 'enabled 必须是布尔' })
  enabled!: boolean
}

/**
 * 整包替换凭据。
 *
 * **是替换不是合并**：合并语义下「删掉一个用不上的键」这件事没法表达，而多留
 * 一个过期的 `secretKey` 会让适配器走错分支（有些适配器是「给了 secretKey 就用
 * 签名模式」）。前端那个键值对编辑器每次都提交完整的一包。
 */
export class UpdateGeoEngineCredentialsDto {
  @ApiProperty({
    type: Object,
    description: '整包凭据，键名见各适配器文件头（如 { "apiKey": "sk-xxx" }）',
  })
  @IsObject({ message: '凭据必须是一个对象' })
  credentials!: Record<string, string>
}

/** 手动测一次。 */
export class TestGeoEngineDto {
  @ApiPropertyOptional({ type: String, description: '测试用的问题；不传用内置的那一条' })
  @IsOptional()
  @IsString({ message: 'prompt 必须是字符串' })
  @MaxLength(500, { message: 'prompt 过长' })
  prompt?: string
}

/** 引擎列表查询。 */
export class ListGeoEngineQueryDto {
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

  @ApiPropertyOptional({ type: String, description: '按 code / 名称 / 厂商模糊搜索' })
  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @MaxLength(100, { message: 'keyword 过长' })
  keyword?: string

  @ApiPropertyOptional({ type: Boolean, description: '只看启用 / 只看停用' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean({ message: 'enabled 必须是布尔' })
  enabled?: boolean
}

/**
 * 下发给平台后台的引擎行。
 *
 * **没有 `credentialEnc` 也没有 `credentialKeyId`**——密文与密钥版本号一个字节都
 * 不出这台机器。给前端的只有 `credentialMasked`（脱敏提示）与 `hasCredentials`
 * （配没配）。
 */
export class GeoEngineView {
  @ApiProperty({ type: String }) id!: string
  @ApiProperty({ type: String }) code!: string
  @ApiProperty({ type: String }) name!: string
  @ApiProperty({ type: String }) vendor!: string
  @ApiProperty({ enum: GEO_ACCESS_TYPES }) accessType!: GeoAccessTypeLike
  @ApiProperty({ type: Boolean }) enabled!: boolean
  @ApiProperty({ type: String }) model!: string
  @ApiProperty({ type: String, nullable: true }) baseUrl!: string | null
  /** 脱敏后的整包凭据（键名保留、值只留前 3 后 2）。没配过凭据时是 `{}`。 */
  @ApiProperty({ type: Object }) credentialMasked!: Record<string, string>
  /** 配没配凭据。前端据它决定「密钥」按钮上画不画那个小红点。 */
  @ApiProperty({ type: Boolean }) hasCredentials!: boolean
  @ApiProperty({ type: Number }) pricePerQueryCents!: number
  @ApiProperty({ type: Number }) priceInPerMTokenCents!: number
  @ApiProperty({ type: Number }) priceOutPerMTokenCents!: number
  @ApiProperty({ type: Number }) rateLimitPerMin!: number
  @ApiProperty({ type: Number }) timeoutMs!: number
  @ApiProperty({ type: Object }) config!: Record<string, unknown>
  @ApiProperty({ type: Number }) sort!: number
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string
}

/**
 * 下发给**商家侧**的引擎行（`GET /api/admin/geo/engines`）。
 *
 * 四个字段，一个都不多：品牌表单上那个下拉框要「显示什么」（name）、
 * 「提交什么」（code）、「按厂商分组」（vendor）、「标一下这是浏览器抓取类
 * （更慢、可能不稳）」（accessType）。单价、限速、超时、凭据一律不下发——
 * 那是平台的成本与商务参数。
 */
export class GeoEngineOptionView {
  @ApiProperty({ type: String }) code!: string
  @ApiProperty({ type: String }) name!: string
  @ApiProperty({ type: String }) vendor!: string
  @ApiProperty({ enum: GEO_ACCESS_TYPES }) accessType!: GeoAccessTypeLike
}

/** `POST /:id/test` 的结果。 */
export class GeoEngineTestResultView {
  @ApiProperty({ type: Boolean, description: '这一次有没有真的问通' }) ok!: boolean
  @ApiProperty({ type: Number, description: '端到端耗时（毫秒）' }) latencyMs!: number
  /** 回答正文的前 200 个字。**不回全文**：诊断要的是「通没通」，不是内容。 */
  @ApiProperty({ type: String }) preview!: string
  @ApiProperty({ type: Number, description: '这次回答带出来几条引用' }) citationCount!: number
  @ApiProperty({ type: String, nullable: true, description: '失败原因；成功时为 null' })
  error!: string | null
  /** 失败分类（`AUTH` / `RATE_LIMIT` / `TIMEOUT` / …）；成功时为 `null`。 */
  @ApiProperty({ type: String, nullable: true }) errorKind!: string | null
  @ApiProperty({ type: String, description: '实际生效的模型名' }) model!: string
}
