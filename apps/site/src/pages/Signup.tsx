import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PHONE_PATTERN,
  checkPasswordPolicy,
  validateSlug,
  validateTenantName,
} from '../lib/signupRules'
import { usePageTitle } from '../hooks/usePageTitle'
import { useSiteConfig } from '../context/SiteConfigContext'
import { BRAND } from '../config/BRAND'
import { checkSlug, fetchCaptcha, friendlyErrorMessage, signup, type SignupResult } from '../api'

const SLUG_CHECK_DEBOUNCE_MS = 400

/**
 * 验证码 svg 是**自家后端**（`CaptchaService.issue()`）生成的，不是用户输入，
 * 信任边界上不算「不可信内容」；这里仍然剥掉 `<script>`/事件属性两类明显不该出现在
 * 一段 svg 里的东西，作为多一层防御，不依赖额外的 sanitizer 依赖包。
 */
function sanitizeCaptchaSvg(svg: string): string {
  return svg.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '')
}

interface SlugState {
  status: 'idle' | 'invalid' | 'checking' | 'available' | 'taken' | 'unknown'
  message: string
}

/**
 * 口令强度提示。`checkPasswordPolicy` 的逻辑与 `provisionTenant()` 落库前调用的
 * `assertOwnerPasswordPolicy` 一致（`signupRules.spec.ts` 做行为级 diff 盯着），
 * 不在这里另写一套长度/字符类正则——各写一遍的下场是「前端说能用，提交被后端拒」。
 */
function passwordHint(password: string): { ok: boolean; message: string } {
  if (password.length === 0) {
    return {
      ok: false,
      message: `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位，至少包含字母/数字/符号里的两类`,
    }
  }
  return checkPasswordPolicy(password)
}

/** 密码强度条的宽度/颜色只是「弱/一般/达标」三档示意，不假装算出了精确分数。 */
function passwordBar(password: string, ok: boolean): { width: number; color: string } {
  if (password.length === 0) return { width: 0, color: 'var(--geo-border)' }
  if (!ok) return { width: 35, color: 'var(--geo-danger)' }
  return { width: 100, color: 'var(--geo-accent-2)' }
}

const SLUG_CHIP: Record<SlugState['status'], { label: string; color: string; border: string } | null> = {
  idle: null,
  invalid: { label: '格式不对', color: 'var(--geo-danger)', border: 'rgba(239,100,97,0.35)' },
  checking: { label: '查询中…', color: 'var(--geo-text-dim)', border: 'var(--geo-border)' },
  available: { label: '可用', color: 'var(--geo-accent-2)', border: 'rgba(52,231,196,0.35)' },
  taken: { label: '已占用', color: 'var(--geo-danger)', border: 'rgba(239,100,97,0.35)' },
  unknown: { label: '暂时查不到，提交时后端会再核实', color: 'var(--geo-text-dim)', border: 'var(--geo-border)' },
}

export default function Signup() {
  usePageTitle('免费注册', '店铺名、店铺路径、手机号、密码，四项填完试用当场生效。')
  const { cfg } = useSiteConfig()
  const days = cfg?.trialDays ?? 14
  const signupEnabled = cfg?.signupEnabled ?? true

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [existingPassword, setExistingPassword] = useState('')
  const [agree, setAgree] = useState(false)
  const [captcha, setCaptcha] = useState<{ id: string; svg: string } | null>(null)
  const [captchaCode, setCaptchaCode] = useState('')
  const [captchaFailed, setCaptchaFailed] = useState(false)
  const [slugState, setSlugState] = useState<SlugState>({ status: 'idle', message: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<SignupResult | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const loadCaptcha = () => {
    setCaptchaFailed(false)
    fetchCaptcha()
      .then((c) => setCaptcha(c))
      .catch(() => setCaptchaFailed(true))
  }

  useEffect(() => {
    loadCaptcha()
  }, [])

  // slug：先在**本地**用 provision 的同一个 validateSlug 做形状 + 保留字判定，
  // 不合法（含保留字）时不发请求、即时给出提示；只有形状合法时才防抖查库里是否被占用。
  useEffect(() => {
    window.clearTimeout(debounceRef.current)
    const raw = slug.trim()
    if (!raw) {
      setSlugState({ status: 'idle', message: '' })
      return
    }
    const local = validateSlug(raw)
    if (!local.ok) {
      setSlugState({ status: 'invalid', message: local.message })
      return
    }
    setSlugState({ status: 'checking', message: '正在查这个路径有没有被占用…' })
    debounceRef.current = setTimeout(() => {
      checkSlug(local.value)
        .then((res) => {
          setSlugState(
            res.available
              ? { status: 'available', message: '这个路径可以用' }
              : { status: 'taken', message: res.reason ?? '这个路径已经被占用了' },
          )
        })
        .catch(() => {
          // 查不通就不表态：说「可以用」是骗人，说「不能用」会把人挡在门外。
          setSlugState({ status: 'unknown', message: '' })
        })
    }, SLUG_CHECK_DEBOUNCE_MS)
    return () => window.clearTimeout(debounceRef.current)
  }, [slug])

  const nameCheck = validateTenantName(name || '')
  const phoneOk = PHONE_PATTERN.test(phone.trim())
  const pwd = passwordHint(password)
  const pwdBar = passwordBar(password, pwd.ok)
  // slug 选填：留空视为「让系统按店铺名称自动生成」，不参与本地形状校验；
  // 填了就仍然按 validateSlug 的规则挡，行为与之前一致。
  const slugLocalOk = slug.trim().length === 0 || validateSlug(slug).ok
  const slugChip = SLUG_CHIP[slugState.status]
  const canSubmit =
    agree &&
    nameCheck.ok &&
    slugLocalOk &&
    slugState.status !== 'taken' &&
    phoneOk &&
    pwd.ok &&
    signupEnabled &&
    !submitting

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError('')
    try {
      const trimmedSlug = slug.trim()
      const normalizedSlug = trimmedSlug ? validateSlug(trimmedSlug) : null
      const payload = {
        // 留空就不传这个字段（而不是传 ''），让后端按店铺名称自动生成；
        // 填了就按之前的逻辑归一化。
        ...(trimmedSlug
          ? { slug: normalizedSlug?.ok ? normalizedSlug.value : trimmedSlug.toLowerCase() }
          : {}),
        name: name.trim(),
        phone: phone.trim(),
        password,
        ...(existingPassword ? { existingPassword } : {}),
        ...(captcha && captchaCode ? { captchaId: captcha.id, captchaCode } : {}),
      }
      const res = await signup(payload)
      setResult(res)
      window.scrollTo(0, 0)
    } catch (e2) {
      setError(friendlyErrorMessage(e2))
      loadCaptcha()
      setCaptchaCode('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="geoSignup">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
      />
      <style>{`
        .geoSignup{
          --geo-bg:#0b0f16;
          --geo-panel:#121826;
          --geo-panel-2:#161d2e;
          --geo-border:#232c40;
          --geo-border-soft:#1a2233;
          --geo-text:#eef1f6;
          --geo-text-muted:#98a2b8;
          --geo-text-dim:#6b7690;
          --geo-accent:#5b9dff;
          --geo-accent-2:#34e7c4;
          --geo-warn:#f6b93b;
          --geo-danger:#ef6461;
          background:
            radial-gradient(1100px 560px at 82% -12%, rgba(91,157,255,0.14), transparent 60%),
            radial-gradient(800px 460px at 6% 100%, rgba(52,231,196,0.07), transparent 55%),
            var(--geo-bg);
          color:var(--geo-text);
          font-family:"IBM Plex Sans","Segoe UI",sans-serif;
          margin-top:-1px;
          min-height:calc(100vh - 64px);
        }
        .geoSignup h1,.geoSignup h2{
          font-family:"Space Grotesk","IBM Plex Sans",sans-serif;
          font-weight:600;margin:0;letter-spacing:-0.01em;text-wrap:pretty;
        }
        .geoSignup p{ color:var(--geo-text-muted); text-wrap:pretty; }
        .geoSignup a{ color:var(--geo-accent); }
        .geoSignupMono{ font-family:"IBM Plex Mono","Consolas",monospace; }
        .geoSignupEyebrow{
          font-family:"IBM Plex Mono",monospace;font-size:13px;letter-spacing:0.08em;
          color:var(--geo-accent-2);text-transform:uppercase;
        }
        .geoSignupCard{
          background:var(--geo-panel);border:1px solid var(--geo-border);
          border-radius:14px;padding:30px;
        }
        .geoSignupGrid{ display:grid;grid-template-columns:1fr 460px;gap:56px;align-items:start; }
        .geoSignupField{ margin-bottom:18px; }
        .geoSignupField label{
          display:block;font-size:13px;color:var(--geo-text-muted);margin-bottom:7px;font-weight:500;
        }
        .geoSignupField input{
          width:100%;background:var(--geo-panel-2);border:1px solid var(--geo-border);
          border-radius:9px;padding:12px 14px;color:var(--geo-text);font-size:14.5px;
          font-family:inherit;outline:none;
        }
        .geoSignupField input::placeholder{ color:var(--geo-text-dim); }
        .geoSignupField input:focus{ border-color:var(--geo-accent); }
        .geoSignupField input[aria-invalid='true']{ border-color:var(--geo-danger); }
        .geoSignupHint{ font-size:12.5px;color:var(--geo-text-dim);margin-top:6px; }
        .geoSignupHint--ok{ color:var(--geo-accent-2); }
        .geoSignupHint--bad{ color:var(--geo-danger); }
        .geoSignupChip{
          display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;
          font-size:11px;font-family:"IBM Plex Mono",monospace;border:1px solid var(--geo-border);
          margin-top:8px;
        }
        .geoSignupCaptcha{ display:flex;gap:10px;align-items:center; }
        .geoSignupCaptcha svg{ border-radius:8px;flex:none;cursor:pointer; }
        .geoSignupCheck{
          display:flex;align-items:flex-start;gap:9px;font-size:12.5px;color:var(--geo-text-muted);
          margin-bottom:20px;cursor:pointer;
        }
        .geoSignupBtn{
          display:flex;align-items:center;justify-content:center;gap:8px;width:100%;
          background:var(--geo-accent);color:#081019;padding:14px 22px;border:none;border-radius:10px;
          font-weight:600;font-size:15.5px;font-family:"IBM Plex Sans",sans-serif;cursor:pointer;
        }
        .geoSignupBtn:disabled{ opacity:0.5;cursor:not-allowed; }
        .geoSignupBtn:not(:disabled):hover{ background:#7bb0ff; }
        .geoSignupNoticeBad{
          border:1px solid rgba(239,100,97,0.35);background:rgba(239,100,97,0.08);
          border-radius:10px;padding:12px 14px;font-size:13px;color:#ffb3af;margin-bottom:16px;
        }
        .geoSignupNoticeWarn{
          border:1px solid rgba(246,185,59,0.35);background:rgba(246,185,59,0.08);
          border-radius:10px;padding:12px 14px;font-size:13px;color:var(--geo-warn);margin-bottom:20px;
        }
        @media (max-width:860px){ .geoSignupGrid{ grid-template-columns:1fr !important; } }
      `}</style>

      {result ? (
        <div className="container" style={{ maxWidth: 560, paddingTop: 64, paddingBottom: 72 }}>
          <div className="geoSignupCard" style={{ textAlign: 'center' }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: 'rgba(52,231,196,0.14)',
                color: 'var(--geo-accent-2)',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 16px',
                fontSize: 28,
              }}
            >
              ✓
            </div>
            <h2 style={{ fontSize: 24 }}>店铺开好了</h2>
            <p style={{ marginTop: 10 }}>
              {result.accountCreated ? (
                <>{result.trialDays} 天试用已经生效。请用刚才设置的密码，到商家后台登录后台。</>
              ) : (
                <>
                  {result.trialDays} 天试用已经生效。这家新店挂在你原有的账号下——登录还是用同一个
                  手机号和原来的密码，进去之后在右上角切换店铺。
                </>
              )}
            </p>
            <div
              style={{
                textAlign: 'left',
                margin: '20px 0',
                fontSize: 14,
                color: 'var(--geo-text-muted)',
                background: 'var(--geo-panel-2)',
                border: '1px solid var(--geo-border-soft)',
                borderRadius: 10,
                padding: 16,
              }}
            >
              <div>
                <b style={{ color: 'var(--geo-text)' }}>店铺名称：</b>
                {result.name}
              </div>
              <div style={{ marginTop: 6 }}>
                <b style={{ color: 'var(--geo-text)' }}>店铺路径：</b>
                <span className="geoSignupMono">{result.slug}</span>
              </div>
              <div style={{ marginTop: 6 }}>
                <b style={{ color: 'var(--geo-text)' }}>试用到期：</b>
                {result.trialEndAt ? new Date(result.trialEndAt).toLocaleString('zh-CN') : '—'}
              </div>
            </div>
            <a className="geoSignupBtn" href={BRAND.adminUrl} target="_blank" rel="noreferrer">
              去商家后台登录
            </a>
            <p style={{ fontSize: 13, marginTop: 16 }}>把店铺路径收藏起来，它以后不能改——会出现在你发出去的每一个链接里。</p>
          </div>
        </div>
      ) : (
        <div className="container" style={{ paddingTop: 24, paddingBottom: 56 }}>
          <div className="geoSignupGrid">
            <div style={{ paddingTop: 20 }}>
              <span className="geoSignupEyebrow" style={{ display: 'block', marginBottom: 12 }}>
                自助注册
              </span>
              <h1 style={{ fontSize: 34, maxWidth: 420 }}>填四项，{days} 天试用当场生效</h1>
              <p style={{ fontSize: 15, marginTop: 14, maxWidth: 400 }}>不用等审核、不用先付款。填完直接开始监测你的第一个品牌。</p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 36, maxWidth: 380 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--geo-accent)', marginTop: 8, flex: 'none' }} />
                  <span style={{ fontSize: 13.5, color: 'var(--geo-text-muted)' }}>店铺路径可以不填，系统会按店铺名称自动生成；它开通后不能改，会出现在你之后收到的每一个链接里</span>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--geo-accent-2)', marginTop: 8, flex: 'none' }} />
                  <span style={{ fontSize: 13.5, color: 'var(--geo-text-muted)' }}>手机号已经开过店？填「原密码」即可把新店并到同一账号下</span>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--geo-warn)', marginTop: 8, flex: 'none' }} />
                  <span style={{ fontSize: 13.5, color: 'var(--geo-text-muted)' }}>不绑卡、不自动续费，到期只是暂停，数据一直留着</span>
                </div>
              </div>
            </div>

            <div className="geoSignupCard">
              {!signupEnabled && <div className="geoSignupNoticeWarn">自助注册暂时关闭了，请联系平台开通。</div>}

              <form onSubmit={submit} noValidate>
                <div className="geoSignupField">
                  <label htmlFor="signup-name">店铺名称</label>
                  <input
                    id="signup-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：钛赞科技"
                    maxLength={30}
                    aria-invalid={name.length > 0 && !nameCheck.ok}
                  />
                  <div className={`geoSignupHint${name && !nameCheck.ok ? ' geoSignupHint--bad' : ''}`}>
                    {name && !nameCheck.ok ? nameCheck.message : '监测报告与后台里显示的名字，以后可以改。'}
                  </div>
                </div>

                <div className="geoSignupField">
                  <label htmlFor="signup-slug">店铺路径（选填）</label>
                  <input
                    id="signup-slug"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value.toLowerCase())}
                    placeholder="不填将根据店铺名称自动生成，例如 my-brand"
                    maxLength={32}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={slugState.status === 'invalid' || slugState.status === 'taken'}
                  />
                  <div
                    className={`geoSignupHint${
                      slugState.status === 'invalid' || slugState.status === 'taken'
                        ? ' geoSignupHint--bad'
                        : slugState.status === 'available'
                          ? ' geoSignupHint--ok'
                          : ''
                    }`}
                  >
                    {slugState.message ||
                      '不填会根据店铺名称自动生成一个可用路径；要自己指定的话，小写字母、数字、连字符，3–32 位。开通后不能改，它会出现在你发出去的每个链接里。'}
                  </div>
                  {slugChip && (
                    <span className="geoSignupChip" style={{ color: slugChip.color, borderColor: slugChip.border }}>
                      {slugChip.label}
                    </span>
                  )}
                </div>

                <div className="geoSignupField">
                  <label htmlFor="signup-phone">店主手机号</label>
                  <input
                    id="signup-phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="用来登录商家后台"
                    inputMode="numeric"
                    maxLength={11}
                    aria-invalid={phone.length > 0 && !phoneOk}
                  />
                  <div className={`geoSignupHint${phone && !phoneOk ? ' geoSignupHint--bad' : ''}`}>
                    {phone && !phoneOk ? '手机号填错了，要 11 位' : '同时是登录名，注册后不建议更换。'}
                  </div>
                </div>

                <div className="geoSignupField">
                  <label htmlFor="signup-password">登录密码</label>
                  <input
                    id="signup-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={`${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位`}
                    maxLength={PASSWORD_MAX_LENGTH}
                    aria-invalid={password.length > 0 && !pwd.ok}
                  />
                  {password.length > 0 && (
                    <div style={{ height: 6, borderRadius: 4, background: 'var(--geo-border-soft)', overflow: 'hidden', marginTop: 9 }}>
                      <div style={{ height: '100%', width: `${pwdBar.width}%`, borderRadius: 4, background: pwdBar.color, transition: 'width .15s ease' }} />
                    </div>
                  )}
                  <div className={`geoSignupHint${password && !pwd.ok ? ' geoSignupHint--bad' : password ? ' geoSignupHint--ok' : ''}`}>{pwd.message}</div>
                </div>

                <div className="geoSignupField">
                  <label htmlFor="signup-existing-password">原密码（可选）</label>
                  <input
                    id="signup-existing-password"
                    type="password"
                    value={existingPassword}
                    onChange={(e) => setExistingPassword(e.target.value)}
                    placeholder="如果这个手机号已经开过店，填它现有的登录密码"
                    maxLength={PASSWORD_MAX_LENGTH}
                  />
                  <div className="geoSignupHint">
                    这个手机号如果已经开过店，请在这里填写它现有的登录密码，新店会开在同一个账号下、登录后可以切换；如果这是第一次注册，留空即可。
                  </div>
                </div>

                {captcha && !captchaFailed && (
                  <div className="geoSignupField">
                    <label htmlFor="signup-captcha">图形验证码</label>
                    <div className="geoSignupCaptcha">
                      <div
                        role="img"
                        aria-label="图形验证码，点击可刷新"
                        onClick={loadCaptcha}
                        // 后端直接给一段 svg 字符串，不是图片地址；点击刷新换一张。
                        dangerouslySetInnerHTML={{ __html: sanitizeCaptchaSvg(captcha.svg) }}
                      />
                      <input
                        id="signup-captcha"
                        value={captchaCode}
                        onChange={(e) => setCaptchaCode(e.target.value)}
                        placeholder="看图填写"
                        maxLength={16}
                        style={{ flex: 1 }}
                      />
                    </div>
                    <div className="geoSignupHint">看不清楚点一下图片换一张。</div>
                  </div>
                )}

                <label className="geoSignupCheck">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 2 }} />
                  <span>
                    我已阅读并同意 <Link to="/terms">《服务条款》</Link> 与 <Link to="/privacy">《隐私政策》</Link>
                  </span>
                </label>

                {error && <div className="geoSignupNoticeBad">{error}</div>}

                <button className="geoSignupBtn" type="submit" disabled={!canSubmit}>
                  {submitting ? '正在开通…' : `免费开通（${days} 天）`}
                </button>
                <p style={{ fontSize: 12.5, textAlign: 'center', marginTop: 12 }}>不绑卡、不自动续费。到期只是暂停营业，数据一直留着。</p>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
