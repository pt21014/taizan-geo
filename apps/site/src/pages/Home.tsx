import { Link } from 'react-router-dom'
import { usePageTitle } from '../hooks/usePageTitle'
import { useSiteConfig } from '../context/SiteConfigContext'
import { NAV } from '../config/NAV'

const PROBLEMS: Array<[string, string, JSX.Element]> = [
  [
    '提问方式变了',
    '用户不再只搜关键词，而是直接向 AI 提一个完整的问题，答案由 AI 一次性给出，不再是十条蓝色链接。',
    <>
      <circle cx="10" cy="10" r="6" />
      <line x1="14.5" y1="14.5" x2="20" y2="20" />
    </>,
  ],
  [
    'AI 的回答是黑盒',
    '你不知道 AI 提没提你的品牌、说得对不对、引用了哪些信息来源——这一切都发生在看不见的地方。',
    <>
      <path d="M2 12c2.5-4.5 6-6.5 10-6.5s7.5 2 10 6.5c-2.5 4.5-6 6.5-10 6.5S4.5 16.5 2 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </>,
  ],
  [
    '看不见就管不了',
    '没有监测，可见度的下降只能等到业务数据下滑之后才被发现，那时候往往已经错过了纠偏的窗口。',
    <>
      <path d="M3 17l6-6 4 4 8-9" />
      <path d="M15 6h6v6" />
    </>,
  ],
]

const PIPELINE = [
  ['01', '配置品牌与问法', '录入品牌与竞品，用真实的提问方式覆盖认知、比较、决策各个阶段。', '#5b9dff'],
  ['02', '自动定时查询', '系统按计划把问法发给多个生成式引擎，拿到它们的真实回答。', '#6fb3ff'],
  ['03', 'AI 结构化分析', '用大模型判断品牌有没有被提及、情感倾向如何、回答引用了哪些信息源。', '#6fd9c9'],
  ['04', '趋势 / 告警 / 周报', '每日聚合可见度趋势，按引擎和竞品对比，骤降自动告警，周报自动生成。', '#34e7c4'],
] as const

const ENGINES = ['OpenAI', '通义千问', '文心一言', '智谱清言', '腾讯混元', '字节豆包', '秘塔 AI 搜索']
const SOURCES = ['知乎', '百度百科', '小红书', '微信公众号', '36 氪', '品牌官网', '其他媒体']

const ENGINE_SHARE: Array<[string, number]> = [
  ['OpenAI', 71],
  ['DeepSeek', 64],
  ['通义千问', 58],
  ['文心一言', 52],
]

export default function Home() {
  usePageTitle(NAV[0]?.title ?? '首页', NAV[0]?.description)
  const { cfg } = useSiteConfig()

  return (
    <div className="geoHome">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
      />
      <style>{`
        .geoHome{
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
          background:
            radial-gradient(1200px 600px at 85% -10%, rgba(91,157,255,0.14), transparent 60%),
            radial-gradient(900px 500px at 8% 18%, rgba(52,231,196,0.08), transparent 55%),
            var(--geo-bg);
          color:var(--geo-text);
          font-family:"IBM Plex Sans","Segoe UI",sans-serif;
          margin-top:-1px;
        }
        .geoHome h1,.geoHome h2,.geoHome h3{
          font-family:"Space Grotesk","IBM Plex Sans",sans-serif;
          font-weight:600;
          margin:0;
          letter-spacing:-0.01em;
          text-wrap:pretty;
        }
        .geoHome p{ color:var(--geo-text-muted); text-wrap:pretty; }
        .geoHome a{ color:var(--geo-accent); }
        .geoMono{ font-family:"IBM Plex Mono","Consolas",monospace; }
        .geoSection{ padding:88px 0; border-top:1px solid var(--geo-border-soft); }
        .geoSection:first-child{ border-top:none; padding-top:72px; }
        .geoCard{
          background:var(--geo-panel);
          border:1px solid var(--geo-border);
          border-radius:14px;
          padding:26px;
        }
        .geoEyebrow{
          font-family:"IBM Plex Mono",monospace;font-size:13px;letter-spacing:0.08em;
          color:var(--geo-accent-2);text-transform:uppercase;
        }
        .geoChip{
          display:inline-flex;align-items:center;gap:6px;
          padding:7px 14px;border-radius:999px;
          background:var(--geo-panel-2);border:1px solid var(--geo-border);
          color:var(--geo-text-muted);font-size:13px;font-family:"IBM Plex Mono",monospace;
        }
        .geoBadgeDemo{
          display:inline-flex;align-items:center;gap:6px;
          padding:4px 10px;border-radius:999px;
          background:rgba(246,185,59,0.12);border:1px solid rgba(246,185,59,0.35);
          color:var(--geo-warn);font-size:12px;font-family:"IBM Plex Mono",monospace;
          letter-spacing:0.02em;white-space:nowrap;
        }
        .geoHome .btn--primary{ background:var(--geo-accent); border-color:var(--geo-accent); color:#081019; }
        .geoHome .btn--ghost{ border-color:var(--geo-border); color:var(--geo-text); }
        .geoHome .btn--ghost:hover{ border-color:var(--geo-accent); color:var(--geo-accent); }
        .geoIconWrap{
          width:42px;height:42px;border-radius:11px;
          background:rgba(91,157,255,0.12);
          display:flex;align-items:center;justify-content:center;
          color:var(--geo-accent);
        }
        .geoHeroGrid{ display:grid;grid-template-columns:1.05fr 1fr;gap:56px;align-items:center; }
        .geoProblemGrid,.geoPipelineGrid{ display:grid;gap:20px;margin-top:20px; }
        .geoProblemGrid{ grid-template-columns:repeat(3,1fr); }
        .geoPipelineGrid{ grid-template-columns:repeat(4,1fr);margin-top:44px; }
        .geoEnginesGrid{ display:grid;grid-template-columns:1fr 1fr;gap:56px; }
        .geoPreviewGrid{ display:grid;grid-template-columns:1.15fr 1fr 1fr;gap:20px;margin-top:44px; }
        @media (max-width:860px){
          .geoHeroGrid,.geoProblemGrid,.geoPipelineGrid,.geoEnginesGrid,.geoPreviewGrid{ grid-template-columns:1fr !important; }
          .geoHeroH1{ font-size:30px !important; }
        }
      `}</style>

      <section className="geoSection">
        <div className="container">
          <div className="geoHeroGrid">
            <div>
              <span className="geoEyebrow">GEO · Generative Engine Optimization</span>
              <h1 className="geoHeroH1" style={{ fontSize: 42, lineHeight: 1.2, marginTop: 16 }}>
                搜索引擎问不到的地方，
                <br />
                AI 正在替你的用户做决定
              </h1>
              <p style={{ fontSize: 16.5, marginTop: 22, maxWidth: 520 }}>
                越来越多用户直接向 ChatGPT、DeepSeek、通义千问这类对话式 AI
                提问，而不再打开搜索引擎。AI 说起你的品牌时提没提、说得对不对、引用了哪些信息来源——这件事正在变得和
                SEO 一样重要，但目前几乎没有品牌在监测它。
              </p>
              <div style={{ display: 'flex', gap: 14, marginTop: 32, flexWrap: 'wrap' }}>
                <Link className="btn btn--primary btn--lg" to="/signup">
                  免费注册 →
                </Link>
                <a className="btn btn--ghost btn--lg" href="#pipeline">
                  看看怎么做的
                </a>
              </div>
              <div style={{ display: 'flex', gap: 28, marginTop: 40, flexWrap: 'wrap' }}>
                <div>
                  <div className="geoMono" style={{ fontSize: 20 }}>
                    7
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--geo-text-dim)', marginTop: 2 }}>生成式引擎接入</div>
                </div>
                <div>
                  <div className="geoMono" style={{ fontSize: 20 }}>
                    15+
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--geo-text-dim)', marginTop: 2 }}>信源站点自动识别</div>
                </div>
                <div>
                  <div className="geoMono" style={{ fontSize: 20 }}>
                    24h
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--geo-text-dim)', marginTop: 2 }}>每日自动聚合</div>
                </div>
              </div>
            </div>

            <div className="geoCard" style={{ position: 'relative', padding: '26px 26px 20px' }}>
              <span className="geoBadgeDemo" style={{ position: 'absolute', top: 20, right: 20 }}>
                示例数据
              </span>
              <div style={{ fontSize: 13, color: 'var(--geo-text-dim)' }}>可见度趋势 · 近 8 周</div>
              <div style={{ display: 'flex', gap: 18, marginTop: 10 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--geo-text-muted)' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: '#5b9dff', display: 'inline-block' }} />
                  本品牌
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--geo-text-muted)' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: '#34e7c4', display: 'inline-block' }} />
                  示例竞品
                </span>
              </div>
              <svg viewBox="0 0 560 260" width="100%" height="auto" style={{ marginTop: 14, overflow: 'visible', display: 'block' }}>
                <line x1="20" y1="40" x2="540" y2="40" stroke="#232c40" strokeWidth="1" />
                <line x1="20" y1="90" x2="540" y2="90" stroke="#232c40" strokeWidth="1" />
                <line x1="20" y1="140" x2="540" y2="140" stroke="#232c40" strokeWidth="1" />
                <line x1="20" y1="190" x2="540" y2="190" stroke="#232c40" strokeWidth="1" />
                <text x="0" y="44" fill="#6b7690" fontSize="11" fontFamily="IBM Plex Mono, monospace">
                  80%
                </text>
                <text x="0" y="194" fill="#6b7690" fontSize="11" fontFamily="IBM Plex Mono, monospace">
                  20%
                </text>
                <defs>
                  <linearGradient id="geoHeroFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#5b9dff" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#5b9dff" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path
                  d="M20,173.3 L94.3,160 L168.6,150 L242.9,156.7 L317.1,130 L391.4,113.3 L465.7,93.3 L540,76.7 L540,220 L20,220 Z"
                  fill="url(#geoHeroFill)"
                />
                <path
                  d="M20,213.3 L94.3,206.7 L168.6,210 L242.9,200 L317.1,203.3 L391.4,196.7 L465.7,200 L540,190"
                  fill="none"
                  stroke="#34e7c4"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity="0.85"
                />
                <path
                  d="M20,173.3 L94.3,160 L168.6,150 L242.9,156.7 L317.1,130 L391.4,113.3 L465.7,93.3 L540,76.7"
                  fill="none"
                  stroke="#5b9dff"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="540" cy="76.7" r="4" fill="#5b9dff" />
                <text x="15" y="238" fill="#6b7690" fontSize="10.5" fontFamily="IBM Plex Mono, monospace">
                  W1
                </text>
                <text x="470" y="238" fill="#6b7690" fontSize="10.5" fontFamily="IBM Plex Mono, monospace">
                  W8
                </text>
              </svg>
              <div style={{ fontSize: 12, color: 'var(--geo-text-dim)', marginTop: 6, borderTop: '1px solid var(--geo-border-soft)', paddingTop: 12 }}>
                * 图表为示意，非真实客户数据
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="geoSection">
        <div className="container">
          <div className="geoProblemGrid">
            {PROBLEMS.map(([title, desc, icon]) => (
              <div className="geoCard" key={title}>
                <div className="geoIconWrap">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    {icon}
                  </svg>
                </div>
                <h3 style={{ fontSize: 17, marginTop: 18 }}>{title}</h3>
                <p style={{ fontSize: 14.5, marginTop: 10 }}>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pipeline" className="geoSection">
        <div className="container">
          <span className="geoEyebrow">核心链路</span>
          <h2 style={{ fontSize: 28, marginTop: 14, maxWidth: 640 }}>从一条问法，到一份可追踪的可见度报告</h2>
          <div className="geoPipelineGrid">
            {PIPELINE.map(([no, title, desc, color]) => (
              <div className="geoCard" style={{ borderTop: `2px solid ${color}` }} key={no}>
                <div className="geoMono" style={{ fontSize: 12, color: 'var(--geo-text-dim)' }}>
                  {no}
                </div>
                <h3 style={{ fontSize: 16, marginTop: 16 }}>{title}</h3>
                <p style={{ fontSize: 14, marginTop: 8 }}>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="engines" className="geoSection">
        <div className="container">
          <div className="geoEnginesGrid">
            <div>
              <span className="geoEyebrow">覆盖引擎</span>
              <h3 style={{ fontSize: 20, marginTop: 12 }}>主流生成式引擎，持续接入中</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 22 }}>
                {ENGINES.map((name) => (
                  <span className="geoChip" key={name}>
                    {name}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <span className="geoEyebrow">识别信源</span>
              <h3 style={{ fontSize: 20, marginTop: 12 }}>自动识别 AI 回答引用了哪里</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 22 }}>
                {SOURCES.map((name) => (
                  <span className="geoChip" key={name}>
                    {name}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="dashboard" className="geoSection">
        <div className="container">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <span className="geoEyebrow">数据看板</span>
              <h2 style={{ fontSize: 28, marginTop: 14, maxWidth: 600 }}>每天自动更新的可见度仪表盘</h2>
            </div>
            <span className="geoBadgeDemo">示例数据 · 非真实客户数据</span>
          </div>

          <div className="geoPreviewGrid">
            <div className="geoCard">
              <div style={{ fontSize: 13, color: 'var(--geo-text-dim)' }}>按引擎对比 · 提及率</div>
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {ENGINE_SHARE.map(([name, pct]) => (
                  <div key={name}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--geo-text-muted)', marginBottom: 5 }}>
                      <span>{name}</span>
                      <span className="geoMono">{pct}%</span>
                    </div>
                    <div style={{ height: 8, borderRadius: 5, background: '#1a2233', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, borderRadius: 5, background: '#5b9dff' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="geoCard" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ fontSize: 13, color: 'var(--geo-text-dim)', alignSelf: 'flex-start' }}>信源分布</div>
              <svg viewBox="0 0 120 120" width="130" height="130" style={{ marginTop: 16 }}>
                <g transform="rotate(-90 60 60)">
                  <circle cx="60" cy="60" r="44" fill="none" stroke="#5b9dff" strokeWidth="16" strokeDasharray="96.76 179.7" strokeDashoffset="0" />
                  <circle cx="60" cy="60" r="44" fill="none" stroke="#34e7c4" strokeWidth="16" strokeDasharray="69.12 207.34" strokeDashoffset="-96.76" />
                  <circle cx="60" cy="60" r="44" fill="none" stroke="#f6b93b" strokeWidth="16" strokeDasharray="55.29 221.17" strokeDashoffset="-165.88" />
                  <circle cx="60" cy="60" r="44" fill="none" stroke="#3a4459" strokeWidth="16" strokeDasharray="55.29 221.17" strokeDashoffset="-221.17" />
                </g>
              </svg>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 16 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--geo-text-muted)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: '#5b9dff', display: 'inline-block' }} />
                  知乎 35%
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--geo-text-muted)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: '#34e7c4', display: 'inline-block' }} />
                  百度百科 25%
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--geo-text-muted)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: '#f6b93b', display: 'inline-block' }} />
                  小红书 20%
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--geo-text-muted)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: '#3a4459', display: 'inline-block' }} />
                  其他 20%
                </span>
              </div>
            </div>

            <div className="geoCard">
              <div style={{ fontSize: 13, color: 'var(--geo-text-dim)' }}>告警 &amp; 周报</div>
              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  marginTop: 18,
                  padding: 14,
                  borderRadius: 10,
                  background: 'rgba(246,185,59,0.08)',
                  border: '1px solid rgba(246,185,59,0.28)',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f6b93b" strokeWidth="1.8" style={{ flexShrink: 0, marginTop: 1 }}>
                  <path d="M12 3l10 18H2L12 3Z" />
                  <line x1="12" y1="10" x2="12" y2="14.5" />
                  <circle cx="12" cy="17.3" r="0.9" fill="#f6b93b" stroke="none" />
                </svg>
                <div>
                  <div style={{ fontSize: 13, color: 'var(--geo-text)' }}>「示例品牌」在 DeepSeek 上的可见度较上周下降 21%</div>
                  <div style={{ fontSize: 11.5, color: 'var(--geo-text-dim)', marginTop: 6 }}>已触发告警规则，通知已发送</div>
                </div>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  marginTop: 12,
                  padding: 14,
                  borderRadius: 10,
                  background: '#161d2e',
                  border: '1px solid #232c40',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34e7c4" strokeWidth="1.8" style={{ flexShrink: 0, marginTop: 1 }}>
                  <rect x="5" y="3" width="14" height="18" rx="2" />
                  <path d="M9 11l2 2 4-4.5" />
                </svg>
                <div>
                  <div style={{ fontSize: 13, color: 'var(--geo-text)' }}>本周周报已生成</div>
                  <div style={{ fontSize: 11.5, color: 'var(--geo-text-dim)', marginTop: 6 }}>覆盖 3 个品牌 · 8 个引擎</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="geoSection" style={{ textAlign: 'center' }}>
        <div className="container">
          <h2 style={{ fontSize: 28, maxWidth: 600, margin: '0 auto' }}>别等业务下滑了，才发现 AI 已经不再提起你</h2>
          <p style={{ marginTop: 16 }}>
            现在就去配置你的第一个品牌和问法，看看 AI 到底是怎么说你的。
            {cfg ? `注册即享 ${cfg.trialDays} 天免费试用。` : ''}
          </p>
          <Link className="btn btn--primary btn--lg" to="/signup" style={{ marginTop: 28, display: 'inline-flex' }}>
            立即免费体验 →
          </Link>
        </div>
      </section>
    </div>
  )
}
