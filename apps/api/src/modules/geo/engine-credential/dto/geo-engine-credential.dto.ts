/**
 * 商家自带引擎密钥的 DTO。
 *
 * 两层校验，与 `engine/dto/geo-engine.dto.ts` 同一条约定：这里只挡形状，
 * `engineCode` 的格式/存在性、凭据包的形状校验都在 service 里复用
 * `engine/geo-engine.rules.ts` 已经写好的纯函数（`parseCredentialsJson` 等）——
 * 两套凭据（平台的、商家的）共用同一份格式规则，不另起一份。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

/**
 * 新建：一次把 `engineCode` + 整包凭据都填了。
 *
 * 与平台侧 `CreateGeoEngineDto`/`UpdateGeoEngineCredentialsDto` 分成两步不同，
 * 这里合成一步——平台侧那么做是为了让「改名字」与「换密钥」在审计上分开，
 * 而商家这张表**除了 `enabled` 之外没有别的可改字段**，新建这个动作本身
 * 就是「配一把密钥」，没有中间态。
 */
export class CreateGeoEngineCredentialDto {
  @ApiProperty({ type: String, description: '平台域 GeoEngine.code', example: 'openai' })
  @IsString({ message: 'engineCode 必须是字符串' })
  @MaxLength(64, { message: 'engineCode 过长' })
  engineCode!: string

  @ApiProperty({
    type: Object,
    description: '整包凭据，键名见各适配器文件头（如 { "apiKey": "sk-xxx" }）',
  })
  @IsObject({ message: '凭据必须是一个对象' })
  credentials!: Record<string, string>

  @ApiPropertyOptional({ type: Boolean, description: '是否启用', default: true })
  @IsOptional()
  @IsBoolean({ message: 'enabled 必须是布尔' })
  enabled?: boolean
}

/**
 * 换密钥：整包替换，语义同 `UpdateGeoEngineCredentialsDto`。
 *
 * `engineCode` 不在这里——换 code 等于配另一个引擎，走「删掉旧的、新建一条」，
 * 不是「改这一条」（同 `GeoEngine.code` 不可改的既有约定）。
 */
export class UpdateGeoEngineCredentialDto {
  @ApiProperty({ type: Object, description: '整包凭据（替换，不合并）' })
  @IsObject({ message: '凭据必须是一个对象' })
  credentials!: Record<string, string>
}

/** 启用 / 停用。 */
export class SetGeoEngineCredentialEnabledDto {
  @ApiProperty({ type: Boolean, description: 'true = 启用，false = 停用' })
  @IsBoolean({ message: 'enabled 必须是布尔' })
  enabled!: boolean
}

/** 列表查询。 */
export class ListGeoEngineCredentialQueryDto {
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
}

/**
 * 下发给前端的行。
 *
 * 与 `GeoEngineView` 同一条底线：**没有 `credentialEnc` 也没有 `credentialKeyId`**，
 * 只有脱敏提示与 `hasCredentials`。
 */
export class GeoEngineCredentialView {
  @ApiProperty({ type: String }) id!: string
  @ApiProperty({ type: String }) engineCode!: string
  /** 引擎展示名，从 `GeoEngine.name` 关联查出来（引擎被平台删了时为空串）。 */
  @ApiProperty({ type: String }) engineName!: string
  @ApiProperty({ type: Boolean }) enabled!: boolean
  @ApiProperty({ type: Object }) credentialMasked!: Record<string, string>
  @ApiProperty({ type: Boolean }) hasCredentials!: boolean
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string
}
