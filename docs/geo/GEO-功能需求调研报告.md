# GEO 多租户 SaaS 功能需求调研报告

> 调研时间：2026-09。方法：WebSearch/WebFetch 抓取竞品官网 features/pricing/docs 一手页面 + 国内行业资料 + 学术论文核实。标注"待验证"的条目为未拿到一手证据的推断。

## 一、GEO 是什么、与 SEO 的区别、客户为什么付费

GEO（Generative Engine Optimization）指通过优化内容、信源与结构化信号，让品牌更高频、更靠前、更正面地出现在 AI 生成的回答里。与 SEO 的根本差别是优化对象从"链接排名"变成"被合成进一段回答里的概率"。2025 年美国零点击搜索已达 58.5%，出现 AI Overview 时约 83%（https://www.omnibound.ai/blog/ai-search-statistics）。付费动因：(1) 流量结构迁移；(2) AI 来源流量转化率显著高于自然搜索（Semrush 2026 约 4.4 倍；Adobe 2026-04 转化高 42%）；(3) 风险侧：AI 会把品牌说错、说负面、推荐竞品，仅 30% 品牌能稳定出现在 AI 回答中。国内：豆包 3.82 亿 MAU、千问 1.67 亿、DeepSeek 1.30 亿、元宝 4984 万（QuestMobile 2026-06）；爱分析预测 2026 年中国 GEO 市场约 48 亿元（https://www.ifenxi.com/research/content/6828）。

方法论锚点：Aggarwal et al., GEO, KDD 2024（https://arxiv.org/abs/2311.09735）。9 种手法中最有效：Cite Sources +34.4%、Statistics Addition +32.1%、Fluency +31.4%、Quotation +29.7%；Keyword Stuffing 最差。GEO-bench 10,000 条查询。

## 二、功能全景清单（频率：高=5家以上竞品有；中=2–4家；低=1–2家）

### 模块 1 品牌与项目管理
| 功能 | 说明 | 频率 | 要点 |
|---|---|---|---|
| 品牌/项目 | 租户下多品牌，配额按品牌 | 高 | 品牌是计费主体 |
| 品牌别名与实体词典 | 中英文名/简称/子品牌/SKU | 高 | 中文需简繁、空格、"XX科技/集团"归一化 |
| 竞品集 | 3–10 个竞品做 SOV | 高 | 按套餐设上限 |
| 地区/语言/人设 | 同 Prompt 不同答案 | 中 | 国内差异小，P1 |
| 行业/话题树 | 驱动 Prompt 生成 | 中 | LLM 生成 + 人工词库 |

### 模块 2 AI 可见度监测（产品心脏）
| 功能 | 说明 | 频率 | 要点 |
|---|---|---|---|
| 多引擎批量提问 | Prompt 集分发到 N 引擎 | 高 | 队列 + 适配器；必须多次采样（n=7~8 时标准误 <0.10，https://arxiv.org/pdf/2604.07585） |
| 提及率/可见度分 | 提及回答数 ÷ 总数 | 高 | Profound Visibility Score |
| SOV | 本品牌 ÷ 全部品牌提及 | 高 | 需全品牌实体抽取 |
| 排名位置 | 平均位次 | 高 | 可用 position-adjusted word count |
| 情感 | 正/中/负 + 归因 | 高 | LLM 判定 |
| 竞品对比与趋势 | 时间序列 | 高 | 预聚合日/周表 |
| 原始回答快照 | 全文/引用/时间戳 | 高 | 对象存储 + DB 指纹，证据链 |
| 事实准确性/幻觉检测 | AI 对品牌的错误陈述 | 中 | AthenaHQ Oracle、Peec Fact-checking |
| AI 购物/推荐位 | 导购场景 | 中 | P2 |

### 模块 3 引用来源分析
| 功能 | 说明 | 频率 | 要点 |
|---|---|---|---|
| 被引 URL/域名统计 | 引用了哪些页面 | 高 | 引擎 citations 字段；无引用时正则抽 URL |
| 来源分类 | Owned/Competitor/Earned/Social/百科 | 中 | 国内自建字典：知乎/百家号/公众号/小红书/百度百科/B站 |
| 平台偏好画像 | 各引擎偏爱引用哪类站 | 中 | 文心约 44% 引百度系、元宝约 50% 引公众号、豆包偏字节系（https://www.ithome.com/0/951/304.htm，待验证）—国内最重要的差异化洞察 |
| 内容缺口 | 竞品被引我方缺失 | 中 | Prompt×话题差集 |
| 引用倒查 | 我方内容被哪些 Prompt/引擎引用 | 中 | 反向索引 |

### 模块 4 Prompt/意图发现
| 功能 | 说明 | 频率 | 要点 |
|---|---|---|---|
| Prompt 自动生成 | LLM 批量生成 | 高 | P0 |
| 关键词→Prompt 拓展 | 双维度扩问法 | 高 | 新榜智汇卖点 |
| Prompt 量级估算 | 真实提问量 | 中 | 国内无面板数据；用 5118（¥0.003/次）+ 百度指数做代理，标"估算" |
| 话题聚类/漏斗分层 | 按话题、TOFU/MOFU/BOFU | 中 | Embedding + LLM 打标 |
| Query Fan-out | 引擎拆出的子查询 | 中 | 需引擎暴露搜索轨迹 |

### 模块 5 内容优化与生成
| 功能 | 说明 | 频率 | 要点 |
|---|---|---|---|
| GEO 内容评分 | URL/草稿 AI 友好度 | 中高 | 落地论文 9 项：引用密度、统计密度、引语、流畅度、结构化、实体清晰、时效、可抓取 |
| 优化建议/Action Center | 按影响力排序待办 | 高 | 主流只给建议不代发 |
| AI 生成 FAQ/文章/百科 | 产出 GEO 内容 | 中 | 国内刚需 |
| Schema/JSON-LD 生成 | FAQPage/Product/Organization | 中 | Semrush 实测 Schema 把 GPT-4 提取准确率 16%→54%，证据最充分 |
| llms.txt | AI 爬虫索引文件 | 低 | 主流 bot 基本不读，当赠品 |
| AI 爬虫可抓性审计 | robots 是否放行 40+ bot | 中高 | 国内含 Bytespider、Baiduspider、PetalBot |
| AI 爬虫日志分析 | CDN/Nginx 日志 | 中高 | P2 |

### 模块 6 内容分发与投放（中国市场最大差异化）
海外 SaaS 普遍不做；国内 GEO 主要交付物是知乎/小红书/百家号/公众号/B站/百科铺设。各平台基本无官方发布 API，现有工具靠浏览器插件调私有接口，风控与合规风险高，建议 P2 且只做"任务+人工确认"半自动。合规红线：《人工智能生成合成内容标识办法》2025-09-01 施行（https://www.cac.gov.cn/2025-03/14/c_1743654685899683.htm）；钛媒体报道部分 GEO 公司刷稿投毒（https://www.tmtpost.com/7991081.html）。产品必须内置 AI 内容标识、事实校验、频次限制。

### 模块 7 报表与告警
日/周/月报（高）；可见度下降告警：阈值型+异动型（高），类型：新提及、可见度变化、竞品反超、引用增减；推送渠道国内必须企微/飞书/钉钉+短信+邮件（高）；PDF/可分享白标报告（中高）；BI 连接器（中，国内 Excel 导出 + 帆软/Quick BI）。

### 模块 8 代理商/多客户/API/白标
Agency 多客户工作区（高）；Pitch 临时工作区（中）；白标 logo/域名/客户门户（中，国内需求强，P1）；开放 API/MCP（中高，几乎都放最高档）；客户只读席位（中，复用 RBAC）。

### 模块 9 平台侧
引擎适配器管理（统一 `ask(prompt, opts) -> {text, citations[], raw}`，API 型与浏览器型）；浏览器自动化池（Playwright + 代理 + 账号池 + 熔断；单账号 200–500 次/日、6–15 秒间隔）；任务调度与限速（每引擎独立限速，千问联网 15 RPS）；成本核算（每 QueryRun 落 costCents）；采样与刷新策略（Scrunch：新 Prompt 前 14 天每日，之后 72 小时）；配额定义。

## 三、AI 引擎清单及接入可行性
| 引擎 | 官方 API | 联网 | 返回引用 | 成本 | 需 Playwright | 文档 |
|---|---|---|---|---|---|---|
| 豆包/火山方舟 | ✅ | ✅ Web Search 插件（Responses API） | ✅（字段名待验证） | Seed-1.6 入 ¥0.8–2.4/M 出 ¥8–24/M；插件按次计费待验证 | App 真实答案需 | https://www.volcengine.com/docs/82379/1756990 |
| DeepSeek | ✅ | ❌ API 无联网 | — | v4-pro 入 $0.66/M 出 $1.98/M | 是 | https://api-docs.deepseek.com/quick_start/pricing |
| Kimi/Moonshot | ✅ | ✅ `$web_search`，官方标"升级中不建议用" | 待验证 | ¥0.03/次+token | 建议是 | https://platform.kimi.com/docs/guide/use-web-search |
| 通义千问/百炼 | ✅ | ✅ `enable_search`+`search_strategy` | ✅ 最规范：`search_options.enable_source/enable_citation` → `search_info.search_results[url/title/site_name]`（DashScope 协议） | qwen-plus 入 ¥0.8–4.8/M 出 ¥2–48/M | 否 | https://www.alibabacloud.com/help/zh/model-studio/web-search |
| 文心/千帆 | ✅ | ✅ `web_search.enable/enable_trace` | ✅ `search_results[index/url/title]` | ERNIE-4.5 Turbo 入 ¥0.8/M 出 ¥3.2/M；搜索约 ¥0.004/次（待验证） | 否 | https://cloud.baidu.com/doc/qianfan-docs/s/Wm8r4sw29 |
| 腾讯元宝/混元 | ✅ | ✅ `EnableEnhancement` | ✅ `SearchInfo`+`Citation` | a13b 入 ¥0.5/M 出 ¥2/M | 元宝 App 需 | https://cloud.tencent.com/document/product/1729/105701 |
| 智谱 GLM | ✅ | ✅ 独立 `/web_search`：std/pro/pro_sogou/pro_quark | ✅ `link`+`refer` | ¥0.01/0.03/0.05 次 | 否；quark 引擎是拿夸克结果的合法通道 | https://docs.bigmodel.cn/cn/guide/tools/web-search |
| 秘塔 metaso | ✅ 2026-07 Search API | ✅ | ✅（待实测） | ≈¥0.03/次，新用户 5000 点 | 否 | https://metaso.cn/search-api/api-keys |
| 夸克 | ❌ | App 内 | — | — | 是 | — |
| 天工 | 未确认 | 待验证 | 待验证 | 待验证 | 建议是 | — |
| 百川/MiniMax/阶跃 | ✅ | ✅ | 部分 | 阶跃 ¥0.04/次 | 否 | https://platform.stepfun.com/docs/zh/guides/pricing/details |
| ChatGPT | ✅ Responses `web_search` | ✅ | ✅ `annotations.url_citation` | $10–25/1000 次+token | 否 | https://developers.openai.com/api/docs/guides/tools-web-search |
| Gemini | ✅ `google_search` grounding | ✅ | ✅ `groundingMetadata` | 月免费 5000，超 $14/1000 | 否 | https://ai.google.dev/gemini-api/docs/grounding |
| Claude | ✅ `web_search` | ✅ | ✅ url/title/cited_text | $10/1000 次+token | 否 | https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool |
| Perplexity | ✅ Sonar | 内置 | ✅ | $1/M + $5–12/1000 | 否 | https://docs.perplexity.ai/guides/pricing |
| Copilot/Bing | ❌ Bing API 2025-08-11 退役 | 间接 | 间接 | Azure 计价 | 是 | https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement |
| Google AI Overviews | ❌ | — | 第三方 | SerpApi/DataForSEO $1.2–4/1000 | 第三方封装 | https://dataforseo.com/apis/ai-optimization-api |

结论：(1) 能纯 API 拿"带引用联网回答"的国内引擎：通义、文心、混元、智谱、秘塔、豆包 —— P0 引擎池；字段最规范是通义与文心。(2) 豆包 App/元宝/夸克/DeepSeek 网页"用户真实所见"与 API 有系统性差异，"API + 浏览器双模"是行业标准（Peec、Scrunch 官方承认）。(3) 海外引擎作增值项。(4) 成本：国内一次带联网+引用查询 ≈ ¥0.02–0.05；100 Prompt × 6 引擎 × 3 采样周频 ≈ 7,200 次/月 ≈ ¥220–360；日频 ≈ ¥1,600–2,700 → 默认周频，日频作高档权益。

## 四、MVP 范围建议
P0（8–10 周）：品牌/竞品/Prompt + LLM 生成 Prompt；6 个 API 国内引擎；批量调度 + 3 次采样 + 周频 + 手动刷新；提及率/SOV/位次/情感/竞品/趋势；快照留存 + 引用统计 + 来源分类；周报/月报 + 下降告警；套餐配额 + 平台成本看板。
P1（3–6 月）：浏览器自动化引擎；Prompt 挖掘；话题聚类；GEO 评分 + Action Center；AI 生成内容 + Schema + 合规标识；代理商工作区 + 白标；内容缺口、引用倒查；幻觉检测。
P2（6–12 月）：内容分发与 ROI 闭环；爬虫日志分析；开放 API/MCP；AI 购物监测；多地区；海外引擎包；llms.txt。

## 五、数据模型草案（伪 Prisma）
Brand(tenantId,name,domain,industryId,locale,aliases) / Competitor(brandId,name,domain,aliases) / Industry / PromptSet(brandId,name,source) / Prompt(promptSetId,text,topicId,funnelStage,estVolume,isTracked,priority) / Topic / Engine(code,name,vendor,accessType,supportsSearch,returnsCitation,costPerQueryCents,enabled) / EngineAccount(账号池) / QueryRun(brandId,engineId,status,sampleSize,triggeredBy,totalCostCents) / QueryResult(queryRunId,promptId,engineId,sampleIndex,rawTextRef,latencyMs,tokensIn,tokensOut,costCents,fingerprint) / Mention(queryResultId,brandId?,competitorId?,entityName,position,isCited,sentiment,snippet) / Citation(queryResultId,url,sourceId,rank) / Source(domain,platform,category,authorityScore) / VisibilityDaily(brandId,engineId,promptId?,date,mentionRate,sov,avgPosition,citationRate,sentimentAvg,sampleCount) / ContentAsset(geoScore,scoreDetail) / ContentDraft(status,aiGenerated,aiLabelApplied,schemaJsonLd) / Distribution(P2) / Recommendation / Report / Alert / UsageLedger(metric,amount,costCents)。
要点：VisibilityDaily 由 QueryResult 聚合，报表只查它；rawTextRef 指向对象存储。

## 六、套餐与配额建议
竞品定价：Otterly $29/189/489（Prompt 15/100/400）；Profound $99/399/定制（引擎 1/3/9，Prompt 50/100）；Peec €85/205/425（Prompt 50/150/350）；Semrush AI Visibility $99（25 prompt/日）；Ahrefs Brand Radar +$50；Writesonic $79/199/399；Goodie $399/999；Scrunch $300/500；Evertune $800；国内 AIDSO 个人 798/企业 4464/旗舰 17548 元/年，GEO SaaS 几千到几万/年，中台 5–15 万/年，代运营 2000–8000/月。海外单位经济 $0.20–0.45/Prompt/月。

建议四档（年付，1 次查询 = 1 Prompt × 1 引擎 × 1 采样）：
| 维度 | 免费 | 基础 ¥1,980/年 | 专业 ¥9,800/年 | 企业 ¥39,800/年起 |
|---|---|---|---|---|
| 品牌 | 1 | 1 | 3 | 10+ |
| 竞品/品牌 | 2 | 3 | 8 | 不限 |
| Prompt | 10 | 50 | 200 | 500+ |
| 引擎 | 2 | 4 | 8 | 全量+海外 |
| 采样 | 1 | 3 | 5 | ≤10 |
| 刷新 | 月 | 周 | 周(20 条可日) | 日 |
| 月查询 | 200 | 2,000 | 16,000 | 60,000+ |
| 我方成本 | ≈¥8 | ≈¥70 | ≈¥600 | ≈¥2,400+ |
| AI 内容 | — | 5 篇/月 | 30 篇/月 | 定制 |
| 历史 | 30 天 | 6 月 | 24 月 | 不限 |
| 席位 | 1 | 3 | 10 | 不限 |
| 告警 | 站内 | +邮件 | +企微/飞书/钉钉/短信 | +Webhook |
| 白标/代理 | — | — | 白标报告 | 全白标+域名 |
| API | — | — | 只读 | 完整 |
加购：额外品牌 ¥1,500/年、50 Prompt ¥800/年、引擎 ¥1,200/年、查询包 ¥200/万次、AI 内容包 ¥500/20 篇、代理商包 ¥19,800/年。浏览器型引擎做加购或高档权益；周频默认、日频付费是控成本最大杠杆；免费版必须存在（国内有免费监测工具）。

## 七、待验证
1. 豆包方舟联网插件引用字段名与按次单价；混元 EnableEnhancement 是否单独计费。
2. 国内引擎 API 答案与 App 答案实际差异幅度，建议 200 条 Prompt A/B 实测。
3. 国内市场规模数字口径混乱，仅易观、爱分析可用。
4. 国内 SaaS 竞品（新榜智汇、豆智、搜极星）未公开定价。
5. 知乎/百家号/小红书无官方发布 API，自动分发不进首版承诺。

## 参考链接
竞品：https://www.tryprofound.com/pricing ｜ https://docs.tryprofound.com/introduction ｜ https://peec.ai/pricing-agencies ｜ https://docs.peec.ai/intro-to-peec-ai ｜ https://otterly.ai/pricing ｜ https://www.athenahq.ai/pricing ｜ https://scrunch.com/pricing/ ｜ https://www.semrush.com/kb/1626-ai-visibility-features ｜ https://ahrefs.com/brand-radar ｜ https://writesonic.com/pricing ｜ https://higoodie.com/pricing/ ｜ https://www.evertune.ai/pricing ｜ https://www.bluefishai.com/platform
国内与合规：https://www.ifenxi.com/research/content/6828 ｜ https://www.analysys.cn/article/detail/20021395 ｜ https://geo.newrank.cn/ ｜ https://www.cnblogs.com/newjpz/p/21718704 ｜ https://www.tmtpost.com/7991081.html ｜ https://www.cac.gov.cn/2025-03/14/c_1743654685899683.htm ｜ https://www.5118.com/apistore/detail/8cf3d6ed-2b12-ed11-8da8-e43d1a103141
方法论：https://arxiv.org/abs/2311.09735 ｜ https://arxiv.org/pdf/2604.07585 ｜ https://presenc.ai/research/state-of-llms-txt-2026 ｜ https://obsurfable.com/resources/reports/top-domains-cited-by-llms-august-2026
