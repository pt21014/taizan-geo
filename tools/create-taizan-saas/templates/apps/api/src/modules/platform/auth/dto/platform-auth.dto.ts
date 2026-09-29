import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

/** 平台超管登录。 */
export class PlatformLoginDto {
  @ApiProperty({ type: String, description: '管理员用户名', example: 'admin' })
  @IsString({ message: '用户名必须是字符串' })
  @MinLength(1, { message: '用户名不能为空' })
  @MaxLength(64, { message: '用户名过长' })
  username!: string

  @ApiProperty({ type: String, description: '口令', example: 'admin123' })
  @IsString({ message: '口令必须是字符串' })
  @MinLength(1, { message: '口令不能为空' })
  // 上限存在的意义是挡住「拿一个 10MB 的字符串去打 scrypt」这种廉价 DoS。
  @MaxLength(200, { message: '口令过长' })
  password!: string

  @ApiPropertyOptional({
    type: String,
    description:
      '人机验证 token（螺丝帽验证码组件产出）。LUOSIMAO_CAPTCHA_REQUIRED=false（默认）时不校验',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  captchaToken?: string
}
