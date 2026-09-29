import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator'

/** 商家员工登录。 */
export class AdminLoginDto {
  @ApiProperty({ type: String, description: '手机号（登录名）', example: '13900000001' })
  @IsString({ message: '手机号必须是字符串' })
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone!: string

  @ApiProperty({ type: String, description: '口令' })
  @IsString({ message: '口令必须是字符串' })
  @MinLength(1, { message: '口令不能为空' })
  @MaxLength(200, { message: '口令过长' })
  password!: string

  @ApiPropertyOptional({
    type: String,
    description: '要进哪家店。不给时：名下只有一家就直接登录，多家则回一张选店列表（不发 token）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(26)
  tenantId?: string

  @ApiPropertyOptional({
    type: String,
    description:
      '人机验证 token（螺丝帽验证码组件产出）。LUOSIMAO_CAPTCHA_REQUIRED=false（默认）时不校验',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  captchaToken?: string

  @ApiProperty({
    type: String,
    description:
      '图形验证码 id（`GET /api/public/signup/captcha` 拿到的，登录页复用同一套能力）。' +
      '**必须给**——不同于 `/api/public/signup` 的「不给就跳过」联调期后门，登录接口每一次' +
      '带密码的调用（含一号多店选店那第二次提交）都强制要求验证码，缺失直接 400。',
  })
  @IsNotEmpty({ message: '请填写图形验证码' })
  @IsString()
  @MaxLength(64)
  captchaId!: string

  @ApiProperty({ type: String, description: '图形验证码内容' })
  @IsNotEmpty({ message: '请填写图形验证码' })
  @IsString()
  @MaxLength(20)
  captchaCode!: string
}

/** 换店。 */
export class SwitchTenantDto {
  @ApiProperty({ type: String, description: '目标店铺 id（必须在自己名下）' })
  @IsString({ message: 'tenantId 必须是字符串' })
  @MinLength(1, { message: 'tenantId 不能为空' })
  @MaxLength(26)
  tenantId!: string
}
