import { usePageTitle } from '../hooks/usePageTitle'
import { PageHead } from '../components/PageHead'
import { Cta } from '../components/Cta'
import { useSiteConfig } from '../context/SiteConfigContext'
import { NAV } from '../config/NAV'

const MODULES: Array<[string, string[]]> = [
  ['监测配置', ['品牌与竞品管理', '自定义问法（Prompt）', '问法批量生成/导入']],
  ['查询与分析', ['7 个主流 AI 引擎接入', 'AI 回答提及/情感分析', '引用来源识别（站点+平台类型）']],
  ['可见度看板', ['每日趋势聚合', '按引擎拆分表现', '竞品对比']],
  ['运营支撑', ['可见度下降自动告警', '自动周报', '用量与成本记账']],
]

/**
 * 如实列出还没做的，硬做出来就是配了也不生效的壳——这条比列一堆已完成的功能更重要，
 * 商家发现「文档说有、点开是空的」之后不会再信这份文档。
 */
const NOT_YET = [
  '商家自助配置专属查询引擎密钥（目前引擎由平台统一配置管理，试用期使用系统内置示例引擎）',
  '登录/注册页的人机验证组件（后端校验能力已就绪，前端交互还没接上）',
]

export default function Features() {
  const meta = NAV[2]
  usePageTitle(meta?.title ?? '功能介绍', meta?.description)
  const { cfg } = useSiteConfig()

  return (
    <>
      <PageHead
        eyebrow="功能介绍"
        title="按模块说清楚，不堆形容词"
        desc="核心监测能力两档套餐都有，差别主要在配额（品牌数/问法数/引擎数/月查询量）和部分权益，不会为了一个功能逼你升级。"
      />

      <section className="section">
        <div className="container">
          <div className="grid grid--2">
            {MODULES.map(([title, items]) => (
              <div className="card" key={title}>
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

      <section className="section section--tint">
        <div className="container">
          <div className="card card--pad-lg">
            <h3>目前还没做的</h3>
            <p style={{ color: '#6b7078', marginTop: 8 }}>
              下面这些是真实缺口，不是「以后再说」的客套话——写在这里，是让你在决定要不要用之前先知道。
            </p>
            <ul className="list" style={{ marginTop: 14, columns: 2, gap: 24 }}>
              {NOT_YET.map((it) => (
                <li key={it}>{it}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <Cta trialDays={cfg?.trialDays ?? null} />
    </>
  )
}
