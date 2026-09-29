/**
 * 顶部导航单一真源。`App.tsx` 渲染导航栏、`NAV.spec.ts` 断言路由存在、
 * `sitemap.xml` 生成脚本（`scripts/generate-seo.ts`）都读这同一份表——
 * 三处各写一份路由列表的下场是「导航里有的页面，sitemap 里没有」。
 */
export interface NavItem {
  to: string
  label: string
  /** 页面 `<title>`，`usePageTitle` 与 `generate-seo.ts` 共用。 */
  title: string
  /** `<meta name="description">` 与 sitemap 无关，只给 SEO 用。 */
  description: string
}

/** 顶部导航链接（不含注册页——那是一个突出的 CTA 按钮，不跟普通导航项混排）。 */
export const NAV: NavItem[] = [
  {
    to: '/',
    label: '首页',
    title: '首页',
    description:
      '监测品牌在 ChatGPT、DeepSeek、通义千问等生成式 AI 回答里的提及、情感与引用来源，可见度下降自动告警。',
  },
  {
    to: '/product',
    label: '产品介绍',
    title: '产品介绍',
    description: '配置品牌与问法、自动查询 7 个主流 AI 引擎、LLM 分析可见度——一条完整链路讲清楚。',
  },
  {
    to: '/features',
    label: '功能介绍',
    title: '功能介绍',
    description: '监测配置、查询与分析、可见度看板、告警与周报——按模块说清楚每一块具体能做什么。',
  },
  {
    to: '/solutions',
    label: '解决方案',
    title: '解决方案',
    description: '面向品牌消费品、SaaS 公司、代理商顾问、内容公关团队四类场景的落地方式。',
  },
  {
    to: '/pricing',
    label: '套餐价格',
    title: '套餐价格',
    description: '套餐价格与配额现取自平台后台，新增一档自动多一列，不写死在页面里。',
  },
  {
    to: '/onboarding',
    label: '开通流程',
    title: '开通流程',
    description: '从填表开店到看到第一份可见度报告，五步说清楚开通之后要做什么。',
  },
  {
    to: '/faq',
    label: '常见问题',
    title: '常见问题',
    description: 'GEO 是什么、支持哪些 AI 引擎、数据多久更新、试用期怎么用——开通前最常问的问题集中解答。',
  },
  {
    to: '/about',
    label: '关于',
    title: '关于我们',
    description: '钛赞 GEO 的运营主体、产品定位与联系方式。',
  },
]

/** 服务条款 / 隐私政策：只在页脚与注册页的勾选框里出现，不进顶部导航。 */
export const LEGAL_NAV: NavItem[] = [
  {
    to: '/terms',
    label: '服务条款',
    title: '服务条款',
    description: '使用本平台服务前请阅读的服务条款全文。',
  },
  {
    to: '/privacy',
    label: '隐私政策',
    title: '隐私政策',
    description: '我们如何收集、使用与保护你的个人信息。',
  },
]

/** 注册页单独列出：不在 `NAV`/`LEGAL_NAV` 里，但 sitemap 与路由测试都需要它。 */
export const SIGNUP_NAV: NavItem = {
  to: '/signup',
  label: '免费注册',
  title: '免费注册',
  description: '店铺名、店铺路径、手机号、密码，四项填完试用当场生效。',
}

/** 全部页面（sitemap 生成脚本用），首页在最前，其余按导航/法律/注册顺序拼接。 */
export const ALL_PAGES: NavItem[] = [...NAV, ...LEGAL_NAV, SIGNUP_NAV]
