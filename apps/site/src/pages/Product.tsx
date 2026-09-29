import { usePageTitle } from '../hooks/usePageTitle'
import { PageHead } from '../components/PageHead'
import { Cta } from '../components/Cta'
import { useSiteConfig } from '../context/SiteConfigContext'
import { NAV } from '../config/NAV'

const STAGES = [
  ['配置', '设定品牌、竞品与自定义问法（覆盖认知期/比较期/决策期），试用期直接用系统内置引擎跑通全流程。'],
  ['查询', '按计划自动向 OpenAI、通义千问、文心一言等 7 个主流 AI 引擎发起真实提问，抓取完整回答。'],
  ['分析', 'LLM 判断品牌是否被提及、提及时的情感倾向，以及回答引用了哪些信息来源。'],
  ['追踪', '每日聚合可见度趋势，竞品对比、来源渠道分布，可见度下降自动告警，一份周报讲清楚变化。'],
]

export default function Product() {
  const meta = NAV[1]
  usePageTitle(meta?.title ?? '产品介绍', meta?.description)
  const { cfg } = useSiteConfig()

  return (
    <>
      <PageHead
        eyebrow="产品介绍"
        title="一套系统，看清品牌在 AI 回答里的可见度"
        desc="不是一堆功能的拼盘，而是从配置品牌到看到第一份可见度报告，跑得通的一条完整链路。"
      />

      <section className="section">
        <div className="container">
          <div className="grid grid--3">
            {STAGES.map(([title, desc], i) => (
              <div className="card" key={title}>
                <span style={{ color: 'var(--taizan-color-primary)', fontWeight: 700 }}>
                  0{i + 1}
                </span>
                <h3 style={{ marginTop: 8 }}>{title}</h3>
                <p style={{ color: '#6b7078', marginTop: 8 }}>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--tint">
        <div className="container">
          <div className="card card--pad-lg">
            <h3>一套后台，看清全链路</h3>
            <p style={{ marginTop: 10, color: '#4d5158' }}>
              从问法配置到查询执行、AI 分析、可见度看板、告警通知、用量成本，都在同一个后台完成，
              不需要在多个工具之间来回倒数据。员工账号可以按权限点分配，只看得到自己该管的那部分。
            </p>
          </div>
        </div>
      </section>

      <Cta trialDays={cfg?.trialDays ?? null} />
    </>
  )
}
