import { usePageTitle } from '../hooks/usePageTitle'
import { PageHead } from '../components/PageHead'
import { Cta } from '../components/Cta'
import { useSiteConfig } from '../context/SiteConfigContext'
import { NAV } from '../config/NAV'

const SCENES: Array<[string, string, string[]]> = [
  ['brand', '品牌与消费品', ['多竞品对比追踪', '各渠道来源占比一目了然', '可见度下降第一时间知道']],
  [
    'saas',
    'SaaS / 软件公司',
    ['监测产品名在技术问答场景的曝光', '按引擎拆分对比表现', '周报同步给市场团队'],
  ],
  ['agency', '代理商 / 顾问', ['多客户品牌集中管理', '定期生成可分享的可见度周报', '试用期验证效果再决定']],
  [
    'content',
    '内容 / 公关团队',
    ['跟踪自己发布的内容有没有被 AI 引用', '识别哪些平台类型贡献了曝光', '为下一步内容策略提供数据支撑'],
  ],
]

export default function Solutions() {
  const meta = NAV[3]
  usePageTitle(meta?.title ?? '解决方案', meta?.description)
  const { cfg } = useSiteConfig()

  return (
    <>
      <PageHead
        eyebrow="解决方案"
        title="四类团队，各自关心的看板不一样"
        desc="用同一套系统跑，只是关注的问法、竞品和看板不一样。"
      />

      <section className="section">
        <div className="container">
          <div className="grid grid--2">
            {SCENES.map(([id, title, items]) => (
              <div className="card" id={id} key={id}>
                <h3>{title}</h3>
                <ul className="list" style={{ marginTop: 10 }}>
                  {items.map((it) => (
                    <li key={it}>{it}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Cta trialDays={cfg?.trialDays ?? null} />
    </>
  )
}
