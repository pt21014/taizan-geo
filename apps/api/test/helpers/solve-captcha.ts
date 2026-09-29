/**
 * e2e 专用：真的解一张图形验证码，不是绕过校验。
 *
 * `AdminAuthService.login()`/`PlatformAuthService.login()` 现在每一次带密码的调用
 * 都强制要求 `captchaId`/`captchaCode`（见两处 service 的 TSDoc——这是一处修复过的
 * 安全漏洞：之前「不传这两个字段就跳过校验」，攻击者只要附带一个随便什么 `tenantId`
 * 就能绕开验证码去撞密码）。e2e 测试因此也必须像一个看得懂图的真实用户一样，
 * 先出一张验证码、读出答案、再把 `{captchaId, captchaCode}` 带进登录请求体。
 *
 * 直接调 `CaptchaService.issue()` + 读 Redis 拿答案（`GET` 不是 `GETDEL`，不消费掉它——
 * `verify()` 走真实登录流程时才核销），比起「注册页那样接一个 OCR 去读 SVG」这种
 * 真实但笨重的路径便宜得多，而且测的是同一段后端代码路径（`CaptchaService`），
 * 不是在验证码这件事上抄近道。
 */
import type { INestApplication } from '@nestjs/common'
import { AUTH_REDIS, CaptchaService, captchaKey } from '@taizan/nest-auth'

export async function solveCaptcha(
  app: INestApplication,
): Promise<{ captchaId: string; captchaCode: string }> {
  const captcha = app.get(CaptchaService)
  const redis = app.get(AUTH_REDIS)
  const { id } = await captcha.issue()
  const answer = await redis.get(captchaKey(id))
  if (!answer) {
    throw new Error(`e2e: 验证码 ${id} 在 Redis 里没找到答案，CaptchaService.issue() 是不是没存住`)
  }
  return { captchaId: id, captchaCode: answer }
}
