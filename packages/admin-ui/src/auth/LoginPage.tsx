import { useState } from 'react'
import { Button, Card, ConfigProvider, Form, Input, Space, theme } from 'antd'
import { LockOutlined, MobileOutlined, SafetyOutlined, UserOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useSession, type ShopChoice } from '../session'
import { ShopChooserPage } from './ShopChooserPage'

/**
 * 深色 GEO 品牌视觉的 token 覆盖，只包一层局部 `ConfigProvider`（antd 支持嵌套，
 * 内层覆盖外层）——不动 `TaizanConfigProvider`，那是给整个商家后台用的浅色主题，
 * 登录页在鉴权之前，视觉上单独处理不影响后台其余页面。
 */
const GEO_DARK_THEME = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#5b9dff',
    // `colorTextBase` 必须显式覆盖：这是 antd v5 用来推导 colorText/colorTextSecondary/
    // colorTextDescription/表单 label 等一整套派生文字色的种子 token。外层
    // `TaizanConfigProvider`（商家后台全局浅色主题）把它设成了 gray[900]（近黑，给白底配的）；
    // 嵌套 `ConfigProvider` 只按 key 覆盖传入的 token，没写的键会从父级继承——这里如果不重新
    // 指定，即使 `algorithm: darkAlgorithm` 生效，派生出来的文字色也是"近黑色系"，糊在深色
    // 背景上（卡片标题、表单 label、输入框占位文字全部肉眼难辨的那个 bug 就是这么来的）。
    colorTextBase: '#f3f5fa',
    colorBgBase: '#0b0f16',
    colorBgContainer: '#121826',
    colorBgElevated: '#121826',
    colorBorder: '#232c40',
    borderRadius: 10,
    fontFamily: '"IBM Plex Sans","Segoe UI",sans-serif',
  },
}

export interface LoginPageConfig {
  title?: string
  /**
   * 登录标识符字段（T3-4）：`'phone'`（默认，商家账密登录，带 11 位手机号校验）或
   * `'username'`（平台超管后台，任意用户名、无选店）。只影响这一屏的表单字段/校验/图标，
   * 真正决定 `login()` 请求体里那个字段叫什么的是 `createSessionStore()` 的
   * `identifierField`——两处要传一致的值，否则表单填的是「用户名」、发出去的 body 却
   * 拼在 `phone` 键上。
   */
  identifierField?: 'phone' | 'username'
  /** 口令输入框的 label，默认「密码」（平台超管后台历史上一直叫「口令」，传 `'口令'`）。 */
  passwordLabel?: string
  /**
   * 显示图形验证码输入框。缺省不出现——它需要业务侧另外接一个「取验证码图片」的接口
   * （`captchaImageUrl`/`onRefreshCaptcha`），这里只留位，不强行造一个假验证码。
   */
  showCaptcha?: boolean
  captchaImageUrl?: string
  /** 当前这张验证码图对应的 id（提交时随 `captchaCode` 一起带给 `login()`）。 */
  captchaId?: string
  onRefreshCaptcha?: () => void
  /** 显示短信验证码位（含「获取验证码」按钮），同样只留位，发送逻辑由业务侧提供 */
  showSms?: boolean
  onSendSms?: (phone: string) => void | Promise<void>
  /** 登录成功后跳转的首页路径，默认 `/` */
  homePath?: string
}

export interface LoginPageProps {
  config?: LoginPageConfig
}

/**
 * 账密登录页（蓝图 §5.2，形状搬自 xiaodian 的登录页 + `BrandChooserPage`）。
 *
 * 名下多店时 `login()` 会返回一份选店列表而不是 token，这里原地切到 `<ShopChooserPage>`，
 * 选中后带着 `tenantId` 再调一次 `login()`——后端只有一个 `/auth/login` 接口，
 * 「选店」不是一个独立接口，只是同一个接口第二次带了 `tenantId`。
 */
export function LoginPage({ config = {} }: LoginPageProps) {
  const identifierField = config.identifierField ?? 'phone'
  const login = useSession((s) => s.login)
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [shops, setShops] = useState<ShopChoice[] | null>(null)
  const [pending, setPending] = useState<{ identifier: string; password: string } | null>(null)

  const goHome = () => navigate(config.homePath ?? '/', { replace: true })

  const onFinish = async (values: Record<string, string>) => {
    const identifier = values[identifierField] ?? ''
    const password = values.password ?? ''
    // 后端每一次带密码的登录调用都强制要求验证码（见 `AdminAuthService.login()` 的
    // TSDoc）——这里不做「两者都不给就跳过」的宽松处理，`config.captchaId` 缺失
    // （图还没加载出来）时原样传 undefined，让后端给出「请填写图形验证码」的诚实拒绝，
    // 而不是在前端悄悄放行一次没有验证码的提交。
    const captcha =
      config.captchaId && values.captchaCode
        ? { id: config.captchaId, code: values.captchaCode }
        : undefined
    setLoading(true)
    try {
      const chooser = await login(identifier, password, undefined, captcha)
      // 验证码一次性核销，不管这次登录成功与否，用过的那张图都已经作废——
      // 成功且要选店时，下一屏（`<ShopChooserPage>`）需要一张新的；失败重试也需要。
      config.onRefreshCaptcha?.()
      if (chooser) {
        setShops(chooser)
        setPending({ identifier, password })
        return
      }
      goHome()
    } catch {
      // 错误提示已由 session 的 request 钩子（onUnauthorized/onForbidden/onBizError）弹出，
      // 这里不用再弹一次——弹两次商家会以为出了两个错
      config.onRefreshCaptcha?.()
    } finally {
      setLoading(false)
    }
  }

  const onChooseShop = async (shop: ShopChoice, captchaCode: string) => {
    if (!pending || !config.captchaId) return
    const chooser = await login(pending.identifier, pending.password, shop.tenantId, {
      id: config.captchaId,
      code: captchaCode,
    })
    if (!chooser) goHome()
  }

  if (shops) {
    return (
      <ShopChooserPage
        shops={shops}
        onChoose={onChooseShop}
        captchaImageUrl={config.captchaImageUrl}
        onRefreshCaptcha={config.onRefreshCaptcha}
        onBack={() => {
          setShops(null)
          setPending(null)
        }}
      />
    )
  }

  const brandPoints = [
    '覆盖 OpenAI/Qwen/Ernie 等 7 个主流生成式引擎',
    '自动分析提及、情感倾向与引用来源',
    '可见度下降实时告警，周报自动生成',
  ]

  return (
    <ConfigProvider theme={GEO_DARK_THEME}>
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap"
      />
      <style>{`
        .geo-login-shell {
          min-height: 100vh;
          display: flex;
        }
        .geo-login-brand {
          flex: 1 1 46%;
          display: flex;
          flex-direction: column;
          justify-content: center;
          padding: 56px 64px;
          background:
            radial-gradient(900px 520px at 15% -10%, rgba(91,157,255,0.16), transparent 60%),
            radial-gradient(700px 460px at 90% 110%, rgba(52,231,196,0.08), transparent 55%),
            #0b0f16;
          position: relative;
          overflow: hidden;
        }
        .geo-login-form-pane {
          flex: 1 1 54%;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 40px 24px;
          background: #0d1220;
        }
        .geo-login-points {
          list-style: none;
          margin: 28px 0 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .geo-login-points li {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          color: #c3cadb;
          font-size: 14px;
          line-height: 1.5;
        }
        .geo-login-points li::before {
          content: '';
          width: 6px;
          height: 6px;
          margin-top: 7px;
          border-radius: 50%;
          background: #34e7c4;
          flex: none;
        }
        .geo-login-chart {
          margin-top: 40px;
          opacity: 0.85;
        }
        @media (max-width: 900px) {
          .geo-login-shell { flex-direction: column; }
          .geo-login-brand { padding: 40px 28px 32px; flex: 0 0 auto; }
          .geo-login-points, .geo-login-chart { display: none; }
          .geo-login-form-pane { padding: 32px 20px 56px; }
        }
      `}</style>

      <div className="geo-login-shell">
        <div className="geo-login-brand">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
              <circle cx="14" cy="14" r="3" fill="#5b9dff" />
              <path d="M8 14a6 6 0 0 1 12 0" stroke="#5b9dff" strokeWidth="1.6" strokeLinecap="round" opacity="0.75" />
              <path d="M4 14a10 10 0 0 1 20 0" stroke="#5b9dff" strokeWidth="1.6" strokeLinecap="round" opacity="0.4" />
            </svg>
            <span style={{ fontFamily: '"Space Grotesk",sans-serif', fontWeight: 700, fontSize: 19, color: '#f3f5fa' }}>
              钛赞 GEO
            </span>
          </span>

          {identifierField !== 'username' && (
            <>
              <h1
                style={{
                  fontFamily: '"Space Grotesk",sans-serif',
                  fontWeight: 700,
                  fontSize: 30,
                  lineHeight: 1.3,
                  color: '#f3f5fa',
                  margin: '32px 0 0',
                  maxWidth: 380,
                }}
              >
                监测你的品牌在 AI 回答里的可见度
              </h1>
              <ul className="geo-login-points">
                {brandPoints.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <svg className="geo-login-chart" width="320" height="80" viewBox="0 0 320 80" fill="none">
                <path
                  d="M4 60 L48 44 L92 52 L136 28 L180 34 L224 14 L268 20 L316 6"
                  stroke="#34e7c4"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="316" cy="6" r="4" fill="#34e7c4" />
              </svg>
            </>
          )}
        </div>

        <div className="geo-login-form-pane">
          <div style={{ width: '100%', maxWidth: 380 }}>
            <div
              style={{
                fontFamily: '"IBM Plex Mono",monospace',
                fontSize: 13,
                letterSpacing: '0.08em',
                color: '#34e7c4',
                textTransform: 'uppercase',
                marginBottom: 16,
              }}
            >
              {identifierField === 'username' ? '平台登录' : '商家登录'}
            </div>

            <Card title={config.title ?? '登录'} style={{ width: '100%' }}>
              <Form layout="vertical" onFinish={(v) => void onFinish(v)}>
                {identifierField === 'username' ? (
                  <Form.Item
                    name="username"
                    label="用户名"
                    rules={[{ required: true, message: '请输入用户名' }]}
                  >
                    <Input prefix={<UserOutlined />} autoComplete="username" />
                  </Form.Item>
                ) : (
                  <Form.Item
                    name="phone"
                    label="手机号"
                    rules={[
                      { required: true, message: '请输入手机号' },
                      { pattern: /^1\d{10}$/, message: '请输入正确的 11 位手机号' },
                    ]}
                  >
                    <Input prefix={<MobileOutlined />} maxLength={11} autoComplete="username" />
                  </Form.Item>
                )}
                <Form.Item
                  name="password"
                  label={config.passwordLabel ?? '密码'}
                  rules={[{ required: true, message: '请输入密码' }]}
                >
                  <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
                </Form.Item>
                {config.showCaptcha && (
                  <Form.Item label="图形验证码">
                    <Space.Compact style={{ width: '100%' }}>
                      <Form.Item
                        name="captchaCode"
                        noStyle
                        rules={[{ required: true, message: '请输入验证码' }]}
                      >
                        <Input
                          prefix={<SafetyOutlined />}
                          placeholder="请输入验证码"
                          style={{ flex: 1 }}
                        />
                      </Form.Item>
                      {config.captchaImageUrl && (
                        <img
                          src={config.captchaImageUrl}
                          onClick={config.onRefreshCaptcha}
                          style={{ height: 32, cursor: 'pointer' }}
                          alt="图形验证码"
                        />
                      )}
                    </Space.Compact>
                  </Form.Item>
                )}
                {config.showSms && (
                  <Form.Item label="短信验证码">
                    <Space.Compact style={{ width: '100%' }}>
                      <Form.Item
                        name="smsCode"
                        noStyle
                        rules={[{ required: true, message: '请输入短信验证码' }]}
                      >
                        <Input style={{ flex: 1 }} />
                      </Form.Item>
                      <Button onClick={() => config.onSendSms?.('')}>获取验证码</Button>
                    </Space.Compact>
                  </Form.Item>
                )}
                <Form.Item style={{ marginBottom: 0 }}>
                  <Button type="primary" htmlType="submit" block loading={loading}>
                    登录
                  </Button>
                </Form.Item>
              </Form>
            </Card>

            {identifierField !== 'username' && (
              <div style={{ textAlign: 'center', marginTop: 20, fontSize: 13.5, color: '#98a2b8' }}>
                同一手机号名下有多家店铺？登录后可以切换
              </div>
            )}
          </div>
        </div>
      </div>
    </ConfigProvider>
  )
}
