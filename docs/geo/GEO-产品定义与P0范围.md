# taizan-geo 产品定义与 P0 范围（决策稿）

日期：2026-09-12。依据：GEO 竞品/引擎/国内市场调研报告 + taizan-saas 基座调研。本文是实现任务的需求真源，技术设计以此为准。

## 1. 一句话定位
面向中国品牌方与代理商的多租户 GEO（生成式引擎优化）SaaS：监测品牌在豆包/通义/文心/元宝/智谱/秘塔/DeepSeek/Kimi 等 AI 回答中的可见度、引用来源与情感，给出优化建议并生成 GEO 内容。租户 = 企业客户；平台方 = 我们。

## 2. 核心概念与口径
- **品牌 Brand**：租户下的监测主体，带别名列表、行业、官网域名。
- **竞品 Competitor**：品牌下的对比对象，带别名。
- **Prompt**：用户会向 AI 提出的问题。归属 PromptSet（人工/AI 生成/挖掘）。带话题、漏斗阶段。
- **引擎 Engine**：平台级注册的 AI 回答来源，`accessType = API | BROWSER`。P0 只做 API 型。
- **查询 Query**：**1 次查询 = 1 Prompt × 1 引擎 × 1 次采样**。这是配额与成本的统一计量单位。
- **QueryRun**：一次批量执行任务（品牌 × 引擎集 × Prompt 集 × 采样数），BullMQ 驱动。
- **QueryResult**：单次回答，原文存对象存储，DB 存元数据、指纹、token、成本。
- **Mention**：从回答中抽取的品牌/竞品提及（位次、是否被引用、情感、上下文片段）。
- **Citation / Source**：回答引用的 URL 与其归一化域名、平台分类（OWNED/COMPETITOR/EARNED/SOCIAL/ENCYCLOPEDIA/PR/OTHER）。
- **VisibilityDaily**：按 品牌×引擎×(Prompt?)×日 预聚合的指标表，报表只读它。
- 指标定义：提及率 = 提及的回答数 ÷ 回答总数；SOV = 本品牌提及数 ÷ (本品牌+竞品提及数)；平均位次 = 提及时位次均值；引用率 = 引用了本品牌域名的回答数 ÷ 回答总数；情感均值 ∈ [-1,1]。

## 3. P0 范围（首版必做）
1. **品牌/竞品/Prompt 管理**：CRUD、别名、行业；PromptSet 支持人工录入、批量导入、**LLM 自动生成 Prompt**（按品牌+行业+漏斗阶段生成 N 条供勾选）。
2. **引擎池（API 型）**：通义千问（DashScope，带 search_options 引用）、文心（千帆 web_search）、腾讯混元（EnableEnhancement）、智谱 GLM（web_search 工具）、秘塔（Search API）、豆包（火山方舟 Responses API + 联网插件）、**Mock 引擎**（开发/测试/演示必备，可配置返回固定或随机含品牌的回答）。海外引擎（OpenAI/Claude/Gemini/Perplexity）做成同一接口，P0 可先只落 OpenAI-compatible 通用适配器。
3. **查询调度**：手动"立即刷新"+ 周频自动刷新（LeaderCron 生成 QueryRun → BullMQ 分发 → 按引擎独立限速）；默认采样 3 次；失败重试、死信。
4. **分析流水线**：回答 → LLM 提及抽取（品牌/竞品实体、位次、情感）→ 引用抽取与 Source 归一化 → 写 Mention/Citation → 聚合 VisibilityDaily。
5. **仪表盘与报表**：品牌总览（提及率/SOV/位次/引用率/情感，环比）、趋势图、引擎对比、竞品对比、Prompt 明细（每条回答可查看原文与引用）、引用来源榜（域名/平台分类）。
6. **告警与周报**：规则（可见度下降 X%、竞品反超、负面提及）→ 站内信 + 邮件/短信（复用 nest-notify）；周报生成（先做站内可查看的 HTML/JSON 报表，PDF 为 P1）。
7. **套餐与配额**：品牌数、Prompt 数、引擎数、月查询次数、AI 内容生成篇数；平台侧成本核算（每 QueryResult 落 costCents，按租户/引擎汇总看板）。
8. **平台后台**：引擎管理（启停、平台级密钥、单价、限速）、租户用量与成本看板、QueryRun 监控与重跑。

## 4. P1 / P2（本轮不做，但数据模型要留位）
- P1：浏览器自动化引擎（豆包 App/元宝/夸克/DeepSeek 网页）、Prompt 挖掘（5118/百度指数）、话题聚类、GEO 内容评分（论文 9 维）、优化建议 Action Center、AI 生成 FAQ/文章 + Schema JSON-LD + AI 内容标识合规、代理商多客户工作区、白标报告、引用倒查、幻觉检测、PDF 报告。
- P2：内容分发任务与 ROI 闭环、AI 爬虫日志分析、开放 API/MCP、AI 购物监测、多地区多语言、llms.txt。

## 5. 关键架构决策（已拍板）
| # | 决策 | 结论 |
|---|---|---|
| D1 | 项目形态 | 整仓复制 taizan-saas 就地改造，`@taizan/*` 包名不改，workspace:* |
| D2 | LLM/引擎能力层 | 新建零框架依赖包 `packages/geo-engines`（照 `packages/sms` 形状）：`EngineAdapter` 接口 `ask(prompt, opts) → { text, citations[], usage, raw }`、registry、Mock 实现、纯函数解析器 + spec。**再新建 `packages/llm`** 承担"分析用 LLM"（提及抽取/情感/Prompt 生成）的通用 chat 接口（OpenAI-compatible + DashScope），同样零框架依赖 |
| D3 | 密钥 | 平台级引擎密钥存平台域加密表（`*Enc` + keyId，走 `@taizan/crypto`）；P0 不做租户自带密钥（BYOK）留字段 |
| D4 | 配额 | 扩展框架 `QuotaKind` 枚举（改 `packages/prisma-base/schema/02-plan.prisma` 并重新 schema-sync 生成 lock）：新增 `GEO_BRAND`、`GEO_PROMPT`、`GEO_ENGINE`、`GEO_QUERY_MONTHLY`、`GEO_CONTENT_MONTHLY`。若框架 QuotaCounter 不支持月度重置，则月度类配额由 GEO 自建 `UsageLedger` + 月计数表实现，并在 `quota-kinds.ts` 登记用于顶栏展示。实现 agent 需先核实 nest-billing 的配额语义再定 |
| D5 | 长任务 | 所有引擎调用与 LLM 分析走 BullMQ `@JobHandler`，绝不在 HTTP 请求路径内调用引擎 |
| D6 | 回答原文 | 存对象存储（`@taizan/storage`，租户前缀），本地开发用 storage 的本地/mock provider；DB 存 `rawTextRef` + `fingerprint` + 截断预览 `preview`（前 500 字） |
| D7 | 图表 | admin 引入 `@ant-design/plots` |
| D8 | 计量 | 成本 `costCents Int`；token/次数为普通 Int；每引擎 `pricePerQueryCents`、`priceInPerMTokenCents`、`priceOutPerMTokenCents` |
| D9 | 无 relation | 全部 `xxxId String` + 应用层 join，遵守基座红线 |
| D10 | 示例模块 | `example-goods` 在第一个 GEO 模块跑通并通过 arch spec 后删除 |
| D11 | 刷新策略 | 默认周频；采样默认 3；"日频"作为套餐权益字段 `refreshCron` 存在 Plan 的功能项里（P0 先做 WEEKLY/DAILY 两档功能开关） |
| D12 | 分析 LLM | 提及抽取/情感用结构化输出（JSON schema），模型可配；开发期用 Mock LLM 返回确定性结果，保证 e2e 不依赖外网 |

## 6. 引擎适配器契约（packages/geo-engines）
```ts
interface EngineAskInput { prompt: string; locale?: string; systemPrompt?: string; timeoutMs?: number }
interface EngineCitation { url: string; title?: string; siteName?: string; index?: number; snippet?: string }
interface EngineAskOutput {
  text: string; citations: EngineCitation[];
  usage: { inputTokens: number; outputTokens: number; searchCalls: number };
  model: string; latencyMs: number; raw: unknown; finishReason?: string
}
interface EngineAdapter {
  readonly code: EngineCode            // 'qwen' | 'ernie' | 'hunyuan' | 'zhipu' | 'metaso' | 'doubao' | 'openai' | 'mock'
  ask(input: EngineAskInput, ctx: { credentials: Record<string,string>; fetch?: typeof fetch; signal?: AbortSignal }): Promise<EngineAskOutput>
}
// 错误分类：EngineError { kind: 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'CONTENT_FILTER' | 'UPSTREAM' | 'PARSE' ; retryable: boolean }
```
每个适配器：请求构造与响应解析拆成纯函数并写 spec（用官方文档样例响应做 fixture）；不 import 任何 nest/prisma。

## 7. 数据模型（P0 实际落表，10-business 下）
租户域（全部 tenantId NOT NULL，`@@index([tenantId, id])`）：
- `GeoBrand`(name, domain, aliases Json, industry, locale, status enum ACTIVE|PAUSED, refreshFreq enum WEEKLY|DAILY, sampleSize Int, engineCodes Json, createdBy, deletedAt)
- `GeoCompetitor`(brandId, name, domain, aliases Json, deletedAt)
- `GeoPromptSet`(brandId, name, source enum MANUAL|AI_GEN|IMPORT, deletedAt)
- `GeoPrompt`(brandId, promptSetId, text, topic, funnelStage enum TOFU|MOFU|BOFU|UNKNOWN, isTracked Bool, priority Int, deletedAt)
- `GeoQueryRun`(brandId, triggeredBy enum SCHEDULE|MANUAL, status enum PENDING|RUNNING|DONE|PARTIAL|FAILED, engineCodes Json, sampleSize, totalQueries, doneQueries, failedQueries, totalCostCents, startedAt, finishedAt, errorSummary)
- `GeoQueryResult`(runId, brandId, promptId, engineCode, sampleIndex, status enum PENDING|OK|FAILED, rawTextRef, preview, fingerprint, model, latencyMs, inputTokens, outputTokens, searchCalls, costCents, errorKind, errorMessage, answeredAt, analyzedAt)
- `GeoMention`(resultId, brandId, promptId, engineCode, entityKind enum BRAND|COMPETITOR, competitorId?, entityName, position Int, isCited Bool, sentiment enum POSITIVE|NEUTRAL|NEGATIVE, sentimentScore Int(-100..100), snippet, answeredAt)
- `GeoCitation`(resultId, brandId, promptId, engineCode, url, domain, platform, category enum, rank, title, answeredAt)
- `GeoVisibilityDaily`(brandId, engineCode, promptId? 用空串表示汇总, date, answers, mentions, mentionRateBp Int(基点), sovBp, avgPositionX100 Int, citationRateBp, sentimentAvgX100, competitorStats Json) `@@unique([tenantId, brandId, engineCode, promptId, date])`
- `GeoAlertRule`(brandId, kind enum VISIBILITY_DROP|COMPETITOR_OVERTAKE|NEGATIVE_MENTION, thresholdBp, channels Json, enabled, lastFiredAt)
- `GeoAlertEvent`(ruleId, brandId, payload Json, notifiedAt)
- `GeoReport`(brandId, period enum WEEKLY|MONTHLY, periodStart, periodEnd, payload Json, status)
- `GeoUsageLedger`(brandId?, metric enum QUERY|LLM_TOKEN|CONTENT_GEN, amount Int, costCents, month String(YYYY-MM), occurredAt)
平台域（无 tenantId）：
- `GeoEngine`(code unique, name, vendor, accessType enum API|BROWSER, enabled, model, baseUrl, credentialEnc, credentialKeyId, pricePerQueryCents, priceInPerMTokenCents, priceOutPerMTokenCents, rateLimitPerMin, config Json)
- `GeoSourcePlatformRule`(pattern, platform, category) 平台字典（可 seed）

## 8. 权限点与菜单（admin 侧）
- `geo:brand:list|write|delete`、`geo:prompt:list|write|delete|generate`、`geo:run:list|trigger`、`geo:result:view`、`geo:dashboard:view`、`geo:citation:view`、`geo:alert:list|write`、`geo:report:view`
- 菜单：GEO 总览（dashboard）、品牌管理、Prompt 管理、监测任务、回答明细、引用来源、告警规则、报表
- platform 侧：引擎管理、用量与成本、任务监控
- 功能项 features：`geo.monitor`(写路径)、`geo.daily_refresh`、`geo.content_gen`(P1 留位)

## 9. 验收标准（P0 完成定义）
1. `pnpm lint && pnpm typecheck && pnpm test && pnpm test:arch` 全绿，未改任何 arch spec 断言。
2. e2e：在 Mock 引擎 + Mock LLM 下，创建品牌与 Prompt → 触发 QueryRun → 队列执行 → Mention/Citation/VisibilityDaily 生成 → dashboard 接口返回正确指标；另一租户看不到该数据。
3. admin 前端：8 个页面可用，趋势图渲染；platform 前端：引擎管理与用量看板可用。
4. 至少通义千问与文心两个真实适配器的解析函数用官方样例 fixture 通过 spec。
5. 配额：超过 `GEO_QUERY_MONTHLY` 时触发 1540301；品牌数超限时 1540301。
6. docs：`docs/GEO-架构.md` 说明模块、队列流、指标口径、引擎接入步骤。
