/**
 * 登录页图形验证码——复用官网注册页同一套后端能力（`GET /api/public/signup/captcha`，
 * `CaptchaService.issue()`/`verify()`）。这个接口名字带 `signup` 只是历史路径，
 * 验证码本身与注册无关，平台超管登录页直接复用，不新起一套后端逻辑。
 *
 * 免登录、跨域，不走 `useSession().request`，写法照抄 `apps/admin/src/api/captcha.ts`。
 */

const BASE_URL = import.meta.env.VITE_API_BASE || ''

interface Envelope<T> {
  code: number
  message: string
  data: T
}

export interface Captcha {
  id: string
  svg: string
}

export async function fetchCaptcha(): Promise<Captcha> {
  const res = await fetch(`${BASE_URL}/api/public/signup/captcha`)
  const envelope = (await res.json()) as Partial<Envelope<Captcha>>
  if (typeof envelope.code !== 'number' || envelope.code !== 0) {
    throw new Error(envelope.message ?? `HTTP ${res.status}`)
  }
  return envelope.data as Captcha
}

/** 自家后端生成的 SVG，仍剥掉 `<script>`/事件属性两类明显不该出现的东西，多一层防御。 */
function sanitizeCaptchaSvg(svg: string): string {
  return svg.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '')
}

/** `LoginPageConfig.captchaImageUrl` 要一个 URL，把 SVG 转成 data: URI 给 `<img src>` 用。 */
export function captchaSvgToDataUrl(svg: string): string {
  const clean = sanitizeCaptchaSvg(svg)
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(clean)))}`
}
