/**
 * 螺丝帽（Luosimao）短信 provider。
 *
 * ## 和阿里云/腾讯云的关键差异：没有"厂商侧预注册模板"
 *
 * 阿里云 `SendSms` / 腾讯云 `SendSms` 都要求内容提前在厂商控制台注册成模板，
 * 调用时只传 `TemplateCode`/`TemplateId` + 参数数组，内容渲染发生在厂商那一侧
 * （见 `providers/aliyun-rpc.ts`、`providers/tencent-tc3.ts`）。螺丝帽相反：
 * 发送接口收的就是一段纯文本，没有"模板 id"的概念。
 *
 * 于是本 provider 不走 `templates.ts` 的 `SmsTemplateRegistry`（那是给"厂商模板 id"
 * 准备的），而是直接用 {@link SmsSendRequest.content}——调用方（`@taizan/nest-notify`
 * 的 `NotifyService`）已经用 `{{var}}` 把模板渲染成一段文本，原样转发即可。
 *
 * ## 签名规则
 *
 * 官方要求"短信内容末尾必须包含签名"（`【签名】`）。调用方的模板文本如果已经带了签名
 * （末尾或任意位置出现过一次），就不重复拼接；没带的话在**末尾**补一次
 * （不是开头——签名拼在开头会被判定为"内容与签名位置不符"）。
 *
 * ## 认证
 *
 * HTTP Basic Auth，用户名固定 `api`，密码是 API Key
 * （`curl -u api:$API_KEY https://sms-api.luosimao.com/v1/send.json`）。
 *
 * @packageDocumentation
 */
import type { HttpClient } from '../http-client'
import type { SmsProvider, SmsResult, SmsSendRequest } from '../provider'

/** 螺丝帽短信 provider 的配置。 */
export interface LuosimaoSmsConfig {
  /** 螺丝帽后台「短信 API → 短信 API」页面的 API Key。 */
  apiKey: string
  /** 签名（不带【】）。正文里已经出现过 `【签名】` 时不重复拼接。 */
  signName?: string
  /** 覆盖默认 endpoint，便于测试打向假服务器。 */
  endpoint?: string
}

const DEFAULT_ENDPOINT = 'https://sms-api.luosimao.com/v1/send.json'

interface LuosimaoSendResponse {
  error?: number
  msg?: string
  batch_id?: string
  /** 命中的敏感词，仅 `error === -31` 时出现。 */
  hit?: string
}

/**
 * 签名去重 + 末尾补签。
 *
 * @param content - 已渲染的正文
 * @param signName - 签名（不带【】）；不传则原样返回 `content`
 */
export function withLuosimaoSign(content: string, signName?: string): string {
  if (!signName) return content
  const bracketed = `【${signName}】`
  return content.includes(bracketed) ? content : `${content}${bracketed}`
}

/** 螺丝帽 `POST /v1/send.json` provider。HTTP 走注入的 {@link HttpClient}，不直接依赖任何网络库。 */
export class LuosimaoSmsProvider implements SmsProvider<LuosimaoSmsConfig> {
  readonly name = 'luosimao'

  constructor(private readonly http: HttpClient) {}

  async send(req: SmsSendRequest, cfg: LuosimaoSmsConfig): Promise<SmsResult> {
    const content = req.content?.trim()
    if (!content) {
      // 螺丝帽没有厂商侧模板，必须由调用方提供已渲染的正文——缺了就是装配错误，
      // 不该悄悄发一条空短信出去。
      return {
        ok: false,
        provider: this.name,
        error: '[@taizan/sms] 螺丝帽 provider 需要已渲染的短信正文（SmsSendRequest.content 为空）',
      }
    }

    const message = withLuosimaoSign(content, req.signName ?? cfg.signName)
    const auth = Buffer.from(`api:${cfg.apiKey}`).toString('base64')
    const body = new URLSearchParams({ mobile: req.phone, message }).toString()

    try {
      const res = await this.http.post(cfg.endpoint ?? DEFAULT_ENDPOINT, body, {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
      })
      const parsed = safeParseJson(res.body) as LuosimaoSendResponse
      if (res.status !== 200 || parsed.error !== 0) {
        return {
          ok: false,
          provider: this.name,
          error: parsed.msg ?? `HTTP ${res.status}`,
          raw: parsed,
        }
      }
      return { ok: true, provider: this.name, vendorRef: parsed.batch_id, raw: parsed }
    } catch (err) {
      return { ok: false, provider: this.name, error: messageOf(err) }
    }
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
