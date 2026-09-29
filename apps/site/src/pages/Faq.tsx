import { Link } from 'react-router-dom'
import { usePageTitle } from '../hooks/usePageTitle'
import { PageHead } from '../components/PageHead'
import { useSiteConfig } from '../context/SiteConfigContext'
import { NAV } from '../config/NAV'

export default function Faq() {
  const meta = NAV[6]
  usePageTitle(meta?.title ?? '常见问题', meta?.description)
  const { cfg } = useSiteConfig()
  const days = cfg?.trialDays ?? 14

  const items: Array<[string, string]> = [
    [
      'GEO 是什么？和传统 SEO 有什么区别？',
      'GEO（Generative Engine Optimization，生成式引擎优化）监测的是品牌在 ChatGPT、DeepSeek、通义千问、文心一言这类 AI 直接给出的回答里表现如何——用户越来越多直接问 AI 而不是搜索。SEO 优化的是搜索结果排名，GEO 关心的是"AI 回答里有没有提到你、怎么提到你、提到的信息来自哪里"。',
    ],
    [
      '支持哪些 AI 引擎？',
      '目前接入 OpenAI、通义千问、文心一言、智谱、混元、豆包、秘塔共 7 个查询引擎，可以按需只开启其中几个，也可以同时对比多个引擎的表现。',
    ],
    [
      '可见度数据多久更新一次？',
      '按你配置的问法自动定时查询多个引擎，查询和分析结果每日汇总成可见度趋势；也可以在后台手动触发一次查询立刻看结果。',
    ],
    [
      '竞品怎么配置？',
      '在品牌管理里添加竞品名称即可，之后每一次可见度分析都会同步统计竞品的提及情况，趋势图里直接对比。',
    ],
    [
      '可见度下降告警是怎么触发的？',
      '给品牌设一个下降阈值，跌破后会通过站内消息/短信通知你；同一条规则有冷却期，不会连续刷屏。',
    ],
    [
      '周报能看到什么？',
      '可见度趋势、竞品对比、引用来源分布会自动汇总成一份周报，在后台随时可以查看，也可以手动重新生成。',
    ],
    [
      `${days} 天试用期需要自己准备 AI 引擎的 API Key 吗？`,
      '不需要，试用期默认用系统内置的示例引擎。正式使用时可以在后台配置自己的真实引擎密钥（支持的 7 个引擎都可以配），用量按你自己配置的引擎单独计费。',
    ],
    [
      `${days} 天试用到期后会怎样？`,
      '后台变为只读，但历史数据一直保留；续费之后立刻恢复，不需要重新配置品牌和问法。',
    ],
  ]

  return (
    <>
      <PageHead eyebrow="常见问题" title="用 GEO 监测品牌可见度，你可能想先知道这些" />

      <section className="section">
        <div className="container" style={{ maxWidth: 760 }}>
          <div style={{ display: 'grid', gap: 16 }}>
            {items.map(([q, a]) => (
              <div className="card" key={q}>
                <h3 style={{ fontSize: 16 }}>{q}</h3>
                <p style={{ color: '#6b7078', marginTop: 8 }}>{a}</p>
              </div>
            ))}
          </div>

          <p style={{ textAlign: 'center', marginTop: 32, color: '#6b7078' }}>
            没找到答案？<Link to="/about">联系我们</Link>，或直接
            <Link to="/signup" style={{ marginLeft: 4 }}>
              免费注册
            </Link>
            试试看。
          </p>
        </div>
      </section>
    </>
  )
}
