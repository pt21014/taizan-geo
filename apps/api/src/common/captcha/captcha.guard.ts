/**
 * `@RequireCaptcha()` 的执行者。
 *
 * ## 它在守卫链里的位置：**RateLimitGuard 之后、GlobalAuthGuard 之前**
 *
 * 挂 `@RequireCaptcha()` 的都是 `@Public()` 的登录接口（还没有 `req.principal`），
 * 放在认证之前没有意义上的冲突；放在限流之后是因为人机验证要打一次外部 HTTP
 * （螺丝帽 `site_verify`），比限流的一次 Redis 往返贵，让限流先把明显的爆破流量挡掉。
 *
 * 顺序由 `apps/api/src/bootstrap/global-providers.ts` 的 `GLOBAL_GUARDS` 数组决定，
 * 改动它必须同步改 `GUARD_ORDER`（`test/arch/guard-order.spec.ts` 静态断言两者一致）。
 *
 * @packageDocumentation
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ErrorCode } from '@taizan/contracts'
import { BizException } from '@taizan/nest-core'

import { REQUIRE_CAPTCHA_KEY } from './captcha.decorator'
import { LuosimaoCaptchaService } from './luosimao-captcha.service'

/** `Reflector.getAllAndOverride` 的第二个参数类型（handler + class）。 */
type ReflectorTargets = Parameters<Reflector['getAllAndOverride']>[1]

@Injectable()
export class CaptchaGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(LuosimaoCaptchaService) private readonly captcha: LuosimaoCaptchaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 只管 HTTP。队列消费者、cron tick 没有请求体这个概念。
    if (context.getType() !== 'http') return true

    const targets: ReflectorTargets = [context.getHandler(), context.getClass()]
    const declared = this.reflector.getAllAndOverride<boolean>(REQUIRE_CAPTCHA_KEY, targets)
    if (!declared) return true

    // 总开关关着（默认状态，前端还没接验证码组件）直接放行——见 `LuosimaoCaptchaService` 文件头。
    if (!this.captcha.required) return true

    const req = context.switchToHttp().getRequest<{ body?: Record<string, unknown> }>()
    const token = req.body?.['captchaToken']
    const ok = await this.captcha.verify(typeof token === 'string' ? token : '')
    if (!ok) {
      throw new BizException(ErrorCode.BAD_REQUEST, '人机验证未通过，请重试')
    }
    return true
  }
}
