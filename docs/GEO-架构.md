# GEO 系统架构

GEO 是基于 `taizan-saas` 多租户 SaaS 基座开发的生成式引擎可见度监测与优化（Generative Engine Optimization）SaaS：商家配置品牌/竞品/问法，系统定时或手动调用多家 LLM/搜索引擎模拟真实用户提问，分析回答中的品牌提及、位次、情感与引用来源，产出可见度趋势、竞品对比、告警与周报。

详细设计见 `docs/geo/GEO-P0技术设计.md`（本文档只做架构总览与实现偏差回写，细节以该文档 + 代码为准）。

## 1. 模块划分

代码全部在 `apps/api/src/modules/geo/`，由单一 `geo.module.ts` 汇总装配进 `bootstrap/app.module.ts`。子目录只是文件组织，不是独立 Nest 模块（见 §5.1）。

| 子目录 | 职责 |
|---|---|
| `brand` | 品牌/竞品 CRUD，`GEO_BRAND`/`GEO_ENGINE` 配额判定入口 |
| `prompt` | Prompt（问法）CRUD、AI 生成候选、批量导入，`GEO_PROMPT` 配额 |
| `engine` | 平台侧引擎管理（CRUD/启停/测试）+ 商家侧只读引擎清单 + 引擎适配器 registry 装配 |
| `run` | 跑批调度：建 Run → 分发 → 逐条调引擎执行查询；限流器、配额消费/释放、失败重试与兜底清扫、月度配额重置 |
| `analysis` | LLM 结构化分析回答（提及/位次/情感）、引用归一化与来源分类 |
| `aggregate` | 每日可见度指标聚合（`GeoVisibilityDaily`）+ 兜底重算 cron |
| `dashboard` | 商家侧只读看板查询（概览/趋势/引擎对比/竞品对比） |
| `citation` | 引用来源明细与域名榜单只读查询 |
| `alert` | 告警规则 CRUD、告警评估 handler、告警事件、通知发送 |
| `report` | 周报生成 cron + 只读查询 |
| `usage` | 商家侧用量/成本查询 + 平台侧跨租户用量/成本看板与跑批监控（含失败重试） |

## 2. 数据流

```
品牌/竞品/Prompt 配置 (brand/prompt)
        │  POST /geo/runs 或 @LeaderCron geo-run-schedule
        ▼
   建 GeoQueryRun(PENDING) ── quota.check(GEO_QUERY_MONTHLY)
        │  queue.add('geo.run.dispatch')
        ▼
run.dispatch ── 批量建 GeoQueryResult(PENDING)，逐条入队
        │  queue.add('geo.query.execute')
        ▼
query.execute ── 限流 → quota.consume(GEO_QUERY_MONTHLY,1) → 解密引擎密钥
        │        → adapter.ask() → 写 result(OK/FAILED) + UsageLedger
        │  queue.add('geo.result.analyze')
        ▼
result.analyze (analysis) ── llm.chat(结构化 schema) 抽提及/情感
        │        → 引用归一化/来源分类 → 落 Mention/Citation
        │  settle(runId) 收口 run 状态 → queue.add('geo.daily.aggregate')
        ▼
daily.aggregate (aggregate) ── upsert GeoVisibilityDaily（按品牌/引擎/Prompt 三层聚合）
        │  queue.add('geo.alert.evaluate')
        ▼
alert.evaluate (alert) ── 对比今日/昨日聚合，命中阈值建 GeoAlertEvent → notify.send
        │
        ▼
dashboard / citation / report(周报 cron) ── 只读消费聚合结果
usage ── 贯穿 query.execute 阶段落账，提供成本看板与平台侧跑批监控/重试
```

幂等键是 `queue.add` 的 `jobId`；`GeoQueryRun` 状态机 `PENDING →(dispatch)→ RUNNING →(settle)→ DONE|PARTIAL|FAILED`。

## 3. 配额体系

`QuotaKind` 新增 5 档，接框架 `nest-billing` 的存量型 `consume/release/check/usage`：

| kind | 语义 | 判定方式 |
|---|---|---|
| `GEO_BRAND` | 品牌数上限 | 建/删品牌时 consume/release |
| `GEO_PROMPT` | Prompt 数上限 | 建/删 Prompt 时 consume/release |
| `GEO_ENGINE` | 单品牌可选引擎数上限 | **只读**判断（`quota.usage()` 取 limit 与 `engineCodes.length` 比），`QuotaCounter` 里不会有这一行，不 consume/release（见 §5.4） |
| `GEO_QUERY_MONTHLY` | 月度查询次数上限 | 执行前 check，逐条 consume，失败 release；月初 cron 重置 |
| `GEO_CONTENT_MONTHLY` | 月度内容生成次数上限（P1 功能预留） | 同上 |

`GeoUsageLedger` 是成本与用量明细账（对账/成本看板用），不是配额判定真源。

## 4. 关键设计约定

- **整数化指标**：可见度指标全部整数运算，无 Float/Decimal——比率类字段用 `*Bp`（万分之一），均值类用 `*X100`（放大 100 倍），金额一律 `Int` + `Cents` 后缀。
- **权限点两段式命名**：`geo-<子模块>:<action>`，例如 `geo-brand:list`（基座权限注册表用正则校验格式，两段式是硬约束）。
- **跨租户扫描走 `RawPrismaService`**：cron/平台侧跨租户查询禁止用 `prisma.tenant.xxx`，必须用 `RawPrismaService` 并在 `src/tenancy/raw-reasons.ts` 登记 + 代码里写 `// raw-reason:` 注释；`test/arch/raw-usage.spec.ts` 会校验登记与实际用法是否对得上。
- **异步任务一律走队列**：HTTP 请求路径不同步调引擎/LLM，只建记录 + 入队；实际执行在 `@JobHandler`，写库成功之后、事务之外再入队。
- **平台级配置表不进 `TENANT_MODELS`**：`GeoEngine`、`GeoSourcePlatformRule` 无 `tenantId`，不登记进 `src/tenancy/tenant-models.ts`。
- **无 relation**：Prisma schema 全程不建 `@relation`，关联字段是裸 id 列。
- **权限点/审计动作/菜单/套餐功能项/队列任务**是七个扩展点里除表结构和隔离注册外的五个，每接一处新能力都要同步登记（见 `geo.module.ts` 文件头的清单）。

## 5. 实现阶段与设计文档的偏差

以下是编码过程中确立、和 `docs/geo/GEO-P0技术设计.md` 原文有出入的地方，已在该文档相应位置回写，这里汇总一份速查：

1. **GEO 是一个 Nest 模块**：`geo.module.ts` 一个模块汇总全部子目录，不是每个子目录各自成一个 Nest 模块（原因：子模块之间要互相注入，拆开会多出大量 `imports`/`exports` 样板）。
2. **权限点必须两段式**：`geo-brand:list` 这种格式是框架正则的硬约束，不能用原设计文档里出现过的三段式写法。
3. **`GeoUsageLedger.amount` 实际字段名是 `quantity`**：`amount` 会被 schema lint 的金额列规则误判成金额并要求 `Cents` 后缀，改名规避。
4. **`errorKind` 走 lint 枚举豁免**：这是自由文本 `String?` 而非 DB enum（值域由 `packages/geo-engines` 各适配器定义，做成枚举等于每接一个新引擎就要一次库迁移），登记在 `test/arch/index.spec.ts` 的 `ENUM_EXEMPTIONS` 里。
5. **LLM 回答原文直接落库到 `rawText`**：对应 §1.3 的 D6 定稿（P0 不接对象存储，原文直接进 DB `@db.Text`，超长截断置 `rawTruncated`）。
6. **`GeoSourcePlatformRule.platform` 用大写码**：seed 里是 `ZHIHU`/`BAIDU_BAIKE`/`XHS` 这类大写标识符，不是中文可读名（`classifySource` 命中默认分支时也固定产出大写的 `OWNED`/`COMPETITOR`/`OTHER`）。
7. **`openai` 这个 engine code 注册的是 Responses API 适配器**，不是 Chat Completions——因为要用 `/responses` + `web_search` 工具让模型真正联网搜索，chat/completions 协议上没有这个工具。`EngineRegistry.register()` 对重复 code 直接抛错不覆盖，两个适配器的 `code` 都是 `'openai'` 但只能装一个。
8. **`geo-metrics.rules.ts` 的 `sentimentAvgX100` 计算是 `round(mean(sentimentScore))`**，不是 `round(mean(sentimentScore) * 100)`。T6 期间曾经多乘了一次 100（`sentimentScore` 本身已经是 ×100 的形式），导致值域跑到 `[-10000, 10000]`，与列注释"平均情感分 ×100"对不上；T7 改回 `[-100, 100]` 并把公式钉进注释与单测。
9. **`GEO_ENGINE` 配额是只读判断，不 consume/release**：语义是"这个品牌最多能同时选几个引擎"而不是存量消耗，`QuotaCounter` 表里不会有这一档的记录行。
