import { Link } from 'react-router-dom'
import { usePageTitle } from '../hooks/usePageTitle'
import { useSiteConfig } from '../context/SiteConfigContext'
import { NAV } from '../config/NAV'

const STEPS: Array<[string, string, string]> = [
  ['填表开店', '店铺名、店铺路径、手机号、密码。这一步完成，店就已经存在了。', '#5b9dff'],
  ['配置品牌与竞品', '填品牌名、官网域名、常用别名，顺手加 1–2 个竞品做对比基准。', '#34e7c4'],
  ['生成或导入问法', '配置一批用户真实会问 AI 的问题，覆盖认知期、比较期、决策期。', '#5b9dff'],
  ['查看首份可见度报告', '系统自动向各引擎发起查询、分析回答，出可见度趋势、引用来源与竞品对比。', '#34e7c4'],
  ['试用到期前决定', '合适就买套餐，数据原样接着用；不合适就放着，不会自动扣费。', '#f6b93b'],
]

export default function Onboarding() {
  const meta = NAV[5]
  usePageTitle(meta?.title ?? '开通流程', meta?.description)
  const { cfg } = useSiteConfig()
  const days = cfg?.trialDays ?? 14

  return (
    <div className="geoOnboarding">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
      />
      <style>{`
        .geoOnboarding{
          --geo-bg:#0b0f16;
          --geo-panel:#121826;
          --geo-border:#232c40;
          --geo-border-soft:#1a2233;
          --geo-text:#eef1f6;
          --geo-text-muted:#98a2b8;
          --geo-text-dim:#6b7690;
          --geo-accent:#5b9dff;
          --geo-accent-2:#34e7c4;
          --geo-warn:#f6b93b;
          background:
            radial-gradient(1100px 560px at 82% -12%, rgba(91,157,255,0.14), transparent 60%),
            radial-gradient(800px 460px at 6% 100%, rgba(52,231,196,0.07), transparent 55%),
            var(--geo-bg);
          color:var(--geo-text);
          font-family:"IBM Plex Sans","Segoe UI",sans-serif;
          margin-top:-1px;
          min-height:calc(100vh - 64px);
          padding-bottom:72px;
        }
        .geoOnboarding h1,.geoOnboarding h2{
          font-family:"Space Grotesk","IBM Plex Sans",sans-serif;
          font-weight:600;margin:0;letter-spacing:-0.01em;text-wrap:pretty;
        }
        .geoOnboarding p{ color:var(--geo-text-muted); text-wrap:pretty; }
        .geoOnboarding a{ color:var(--geo-accent); }
        .geoOnboardingEyebrow{
          font-family:"IBM Plex Mono",monospace;font-size:13px;letter-spacing:0.08em;
          color:var(--geo-accent-2);text-transform:uppercase;
        }
        .geoOnboardingCard{
          background:var(--geo-panel);border:1px solid var(--geo-border);border-radius:14px;
          padding:22px 24px;flex:1;
        }
        .geoOnboardingStepNum{
          width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;
          font-family:"IBM Plex Mono",monospace;font-weight:600;font-size:14px;flex:none;position:relative;z-index:1;
        }
        .geoOnboardingNotice{
          border:1px solid rgba(246,185,59,0.3);background:rgba(246,185,59,0.07);border-radius:12px;
          padding:16px 20px;font-size:13.5px;color:var(--geo-text-muted);line-height:1.65;
        }
        .geoOnboardingBtn{
          display:inline-flex;align-items:center;gap:8px;background:var(--geo-accent);color:#081019;
          padding:14px 30px;border:none;border-radius:10px;font-weight:600;font-size:15.5px;
          font-family:"IBM Plex Sans",sans-serif;cursor:pointer;
        }
        .geoOnboardingBtn:hover{ background:#7bb0ff; }
      `}</style>

      <div className="container" style={{ paddingTop: 24, paddingBottom: 48 }}>
        <div style={{ textAlign: 'center', maxWidth: 600, margin: '0 auto' }}>
          <span className="geoOnboardingEyebrow" style={{ display: 'block', marginBottom: 12 }}>
            开通流程
          </span>
          <h1 style={{ fontSize: 32 }}>五步说清楚，{days} 天试用怎么用</h1>
          <p style={{ marginTop: 12 }}>不用等审核、不用先付款、不需要额外接入。</p>
        </div>

        <div style={{ maxWidth: 640, margin: '48px auto 0', position: 'relative' }}>
          <div style={{ position: 'absolute', left: 16, top: 20, bottom: 20, width: 1, background: 'var(--geo-border)' }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {STEPS.map(([title, desc, color], i) => (
              <div key={title} style={{ display: 'flex', gap: 18, position: 'relative' }}>
                <span className="geoOnboardingStepNum" style={{ background: `${color}24`, color }}>
                  {i + 1}
                </span>
                <div className="geoOnboardingCard">
                  <b style={{ fontSize: 15, color: 'var(--geo-text)' }}>{title}</b>
                  <p style={{ fontSize: 13.5, marginTop: 6 }}>{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="geoOnboardingNotice" style={{ maxWidth: 640, margin: '36px auto 0' }}>
          需要接入自己的引擎 API Key 吗？试用阶段默认使用系统内置的示例引擎出数据；要监测真实的 AI
          引擎（通义千问、文心一言、DeepSeek 等），登录后台在「引擎设置」里配置密钥即可，随时可换。
        </div>

        <div style={{ textAlign: 'center', marginTop: 36 }}>
          <Link className="geoOnboardingBtn" to="/signup">
            开始注册
          </Link>
        </div>
      </div>
    </div>
  )
}
