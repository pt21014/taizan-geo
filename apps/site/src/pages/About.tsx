import { usePageTitle } from '../hooks/usePageTitle'
import { PageHead } from '../components/PageHead'
import { BRAND, CONTACT_PHONE_PLAIN } from '../config/BRAND'
import { NAV } from '../config/NAV'

export default function About() {
  const meta = NAV[7]
  usePageTitle(meta?.title ?? '关于我们', meta?.description)

  return (
    <>
      <PageHead eyebrow="关于" title={`关于 ${BRAND.productName}`} />

      <section className="section">
        <div className="container" style={{ maxWidth: 760 }}>
          <div className="card card--pad-lg">
            <h3>我们在做什么</h3>
            <p style={{ marginTop: 10, color: '#4d5158' }}>
              {BRAND.productName} 帮助品牌监测自己在 ChatGPT、DeepSeek、通义千问等生成式 AI
              回答里的表现——配置品牌和竞品、设置真实用户会问的问法，系统自动向多个 AI
              引擎发起查询，分析回答里的提及、情感倾向与引用来源，汇总成每日趋势、竞品对比和自动周报。
              {BRAND.slogan}。
            </p>
          </div>

          <div className="card card--pad-lg" style={{ marginTop: 16 }}>
            <h3>运营主体</h3>
            <p style={{ marginTop: 10, color: '#4d5158' }}>{BRAND.companyName}</p>
          </div>

          <div className="card card--pad-lg" style={{ marginTop: 16 }}>
            <h3>联系方式</h3>
            <p style={{ marginTop: 10, color: '#4d5158' }}>
              咨询电话：
              <a href={`tel:${CONTACT_PHONE_PLAIN}`} style={{ fontWeight: 600 }}>
                {BRAND.contactPhone}
              </a>
              <br />
              邮箱：
              <a href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a>
            </p>
          </div>
        </div>
      </section>
    </>
  )
}
