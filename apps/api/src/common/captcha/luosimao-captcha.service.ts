/**
 * 螺丝帽人机验证（Captcha）后端校验（生产上线前置能力，与 GEO/example-goods 无关）。
 *
 * ## 只做后端校验，前端还没接
 *
 * 螺丝帽人机验证需要前端引入验证码组件（用 `LUOSIMAO_CAPTCHA_SITE_KEY` 渲染一个挑战，
 * 通过后拿到一个 `response` token）。这部分前端接入（admin/platform 登录页）**还没有做**：
 * 工作量不小（引入螺丝帽 JS SDK、登录页加挑战组件、把 token 塞进登录请求体），
 * 超出"让短信/人机验证在生产环境不再被安全闸门拒启"这个上线前置任务的范围。
 * 本次只把后端校验能力做完整：`@RequireCaptcha()` + `CaptchaGuard` + 本服务。
 *
 * `LUOSIMAO_CAPTCHA_REQUIRED` 默认 `false`，且**部署时不建议打开**——前端不会提交
 * `captchaToken`，打开等于让登录接口对所有人返回 400。等前端接入验证码组件后再打开。
 *
 * ## 接口形状（https://luosimao.com/docs/api/captcha/index）
 *
 * `POST https://captcha.luosimao.com/api/site_verify`，body（form-urlencoded）带
 * `api_key` + `response`，返回 `{ error: number, res: 'success'|'failed', msg?: string }`；
 * `error === 0` 且 `res === 'success'` 才算通过。
 *
 * @packageDocumentation
 */
import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@taizan/nest-core'

import type { AppEnv } from '../../config/env'

const VERIFY_ENDPOINT = 'https://captcha.luosimao.com/api/site_verify'

interface LuosimaoCaptchaResponse {
  error?: number
  res?: string
  msg?: string
}

/**
 * 纯函数版校验调用，不依赖 Nest 容器——`LuosimaoCaptchaService.verify()` 只是它的
 * 一层薄封装（补 `apiKey` 来源），拆开是为了 spec 能直接塞假 `fetch` 而不用起容器
 * （`LuosimaoCaptchaService` 的构造函数只挂 `@Inject(ConfigService)`：本应用构建走
 * esbuild、没有 `emitDecoratorMetadata`，Nest 的隐式构造函数注入解析不出没打
 * `@Inject()` 的参数类型，所以不能像别处的 `createXxxHttpClient` 那样给它塞一个
 * 「默认 `globalThis.fetch`」的裸参数）。
 *
 * @param apiKey - 螺丝帽人机验证 api_key
 * @param token - 前端验证码组件产出的 `response`；空字符串直接判不通过（不发请求）
 * @param fetchImpl - 自定义 fetch，测试里塞假实现用；默认 `globalThis.fetch`
 */
export async function verifyLuosimaoCaptcha(
  apiKey: string,
  token: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  if (!token) return false

  const body = new URLSearchParams({ api_key: apiKey, response: token }).toString()
  const res = await fetchImpl(VERIFY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const parsed = (await res.json().catch(() => ({}) as unknown)) as LuosimaoCaptchaResponse
  return res.ok && parsed.error === 0 && parsed.res === 'success'
}

@Injectable()
export class LuosimaoCaptchaService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<AppEnv>) {}

  /** `LUOSIMAO_CAPTCHA_REQUIRED` 的当前值；`CaptchaGuard` 用它决定要不要真的校验。 */
  get required(): boolean {
    return this.config.get('LUOSIMAO_CAPTCHA_REQUIRED')
  }

  /**
   * 校验一枚人机验证 token。
   *
   * @throws `LUOSIMAO_CAPTCHA_REQUIRED=true` 但 `LUOSIMAO_CAPTCHA_API_KEY` 未配置时抛——
   *   开关开着却没有可用的校验凭据，是装配错误，不该悄悄放行当作"验证通过"
   */
  async verify(token: string): Promise<boolean> {
    const apiKey = this.config.get('LUOSIMAO_CAPTCHA_API_KEY')
    if (!apiKey) {
      throw new Error(
        '[captcha] LUOSIMAO_CAPTCHA_REQUIRED=true 但 LUOSIMAO_CAPTCHA_API_KEY 为空，无法校验',
      )
    }
    return verifyLuosimaoCaptcha(apiKey, token)
  }
}
