import { Link } from 'react-router-dom'
import { usePageTitle } from '../hooks/usePageTitle'
import { PageHead } from '../components/PageHead'
import { useSiteConfig } from '../context/SiteConfigContext'
import { yuan } from '../api'
import { NAV } from '../config/NAV'

/** 计费周期月数 → 展示文案（12 个月按「年」说，其它按「月」说）。 */
function periodLabel(months: number): string {
  if (months >= 12 && months % 12 === 0) {
    const years = months / 12
    return years === 1 ? '年' : `${years} 年`
  }
  return `${months} 个月`
}

export default function Pricing() {
  const meta = NAV[4]
  usePageTitle(meta?.title ?? '套餐价格', meta?.description)
  const { cfg, loading, failed } = useSiteConfig()

  const plans = cfg?.plans ?? []

  return (
    <>
      <PageHead
        eyebrow="套餐价格"
        title="价格现取自平台后台，不写死在这一页"
        desc="平台后台新增一档套餐，这一页自动多一列；改一次价，官网与商家看到的永远是同一个数字。"
      />

      <section className="section">
        <div className="container">
          {loading && <p style={{ textAlign: 'center', color: '#8a8f98' }}>套餐价格加载中…</p>}

          {!loading && failed && (
            <div
              className="notice notice--bad"
              style={{ textAlign: 'center', maxWidth: 560, margin: '0 auto' }}
            >
              暂时没能取到实时价格，请刷新重试，或直接
              <Link to="/signup" style={{ marginLeft: 4 }}>
                免费注册试用
              </Link>
              ，价格不影响试用期使用。
            </div>
          )}

          {!loading && !failed && plans.length === 0 && (
            <p style={{ textAlign: 'center', color: '#8a8f98' }}>
              正式套餐正在整理中，先开一个免费试用账号，到期前我们会把方案给你。
            </p>
          )}

          {!loading && !failed && plans.length > 0 && (
            <div className="plans" data-testid="plan-list">
              {plans.map((plan, i) => (
                <div
                  className={`plan${i === 0 ? ' plan--hot' : ''}`}
                  key={plan.id}
                  data-testid="plan-card"
                >
                  {i === 0 && <span className="plan__tag">多数商家的选择</span>}
                  <h3>{plan.name}</h3>
                  <div className="plan__price">
                    <b>¥{yuan(plan.firstPriceCents)}</b>
                    <span> / 首期 {periodLabel(plan.periodMonths)}</span>
                  </div>
                  <p style={{ color: '#6b7078', fontSize: 13 }}>
                    续费 ¥{yuan(plan.renewPriceCents)} / {periodLabel(plan.periodMonths)}
                  </p>
                  <ul className="list">
                    <li>试用期即可用系统内置引擎体验全流程</li>
                    <li>到期只读，不丢数据</li>
                    <li>续费从原到期日往后加，提前续不吃亏</li>
                  </ul>
                  <Link className="btn btn--primary btn--block" to="/signup">
                    先试用，再购买
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="section section--tint">
        <div className="container">
          <div className="section__head">
            <h2>除了套餐费，还有什么要花钱的</h2>
            <p>把该说的先说清楚，免得开通之后才发现。</p>
          </div>
          <div className="grid grid--3">
            {[
              ['AI 引擎调用', '正式使用需要在后台配置真实引擎密钥（OpenAI/通义千问等），调用费用由对应引擎服务商收取。'],
              ['短信通知', '登录验证码与告警通知按量计费，新账号送一份试用额度。'],
              ['超出配额', '品牌数/问法数/月查询量超出套餐配额后新增查询会受限，需升级套餐或等下个周期重置。'],
              ['不收的', '不收开户费、不收培训费，不按功能模块单独收费。'],
            ].map(([t, d]) => (
              <div className="card" key={t}>
                <h3>{t}</h3>
                <p style={{ color: '#6b7078', marginTop: 8 }}>{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="card card--pad-lg">
            <h3>到期之后会怎样</h3>
            <p style={{ marginTop: 10, color: '#4d5158' }}>
              套餐到期那一刻，后台变为只读、新的查询会被暂停，但监测数据一直保留，续费之后立刻恢复原样。
              「套餐续费」这一页到期后仍然可写，不会出现「到期 → 只读 → 续不了费 →
              永远到期」的死循环。
            </p>
          </div>
        </div>
      </section>
    </>
  )
}
