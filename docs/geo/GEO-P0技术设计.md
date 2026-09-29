# GEO P0 技术设计与任务拆解

依据：《GEO-产品定义与P0范围.md》（D1–D12 为准，本文只细化）、《基座接入要点.md》、代码核实 `D:\project\taizan-saas`（与 taizan-geo 同源）。审核人已采纳本文对 D4/D6 的细化。

## 1. 核实结果

### 1.1 nest-billing 配额语义 —— D4 定稿

| 事实 | 文件 | 结论 |
|---|---|---|
| `consume/release/check/usage` 签名 | `packages/nest-billing/src/quota.service.ts:48-66` | `consume(kind: string, delta = 1, tx?: QuotaTx)`；tenantId 由 `requireTenantId()` 从上下文取，**不接受传参**，取不到直接抛 |
| 计数实现 | `packages/nest-billing/src/platform-gateway.ts:388-461` `mutate()` | 读 `QuotaCounter` → `checkQuota(limit, used, delta)` → `updateWithVersion` 乐观锁，最多 5 次重试；超限抛 `BizException(ErrorCode.QUOTA_EXCEEDED)` = **1540301**；`release` 用 `Math.max(0, used - delta)` |
| `QuotaCounter` 表结构 | `packages/prisma-base/schema/02-plan.prisma:73-85` | `id / tenantId / kind QuotaKind / used Int / version Int / createdAt / updatedAt`，`@@unique([tenantId, kind])` |
| **是否有周期重置** | 全仓 grep | **没有**。没有 `periodStart` 列，没有重置 cron。框架配额是**存量型**（占用/释放对称） |
| 平台后台怎么配 limit | `apps/api/src/modules/platform/plan/plan.controller.ts:50` PATCH `/api/platform/plans/:id` → `plan.rules.ts:19` `QUOTA_KINDS` 白名单 → 写 `Plan.quotas` Json | 三态：`3` 上限 / `0` 禁用 / `null` 或缺省=不限 |
| 顶栏展示 | `apps/api/src/registry/quota-kinds.ts:29` `BOOTSTRAP_QUOTA_KINDS = ['STAFF','CUSTOM']` | bootstrap 逐档 `quota.usage()` 下发 |

**D4 细化方案（可执行）：**

1. 改 `packages/prisma-base/schema/02-plan.prisma` 的 `QuotaKind` 枚举，追加 5 个值：`GEO_BRAND`、`GEO_PROMPT`、`GEO_ENGINE`、`GEO_QUERY_MONTHLY`、`GEO_CONTENT_MONTHLY`。
2. **存量型三档**（BRAND/PROMPT/ENGINE）直接用框架 `quota.consume/release`，与 `example-goods` 同形。
3. **月度型两档不自建计数表**，仍走 `quota.consume`，另加月初重置 cron：`@LeaderCron({ key: 'geo-quota-month-reset', cron: '5 0 1 * *', lockTtlMs: 300_000, watchdog: true })`，把这两个 kind 的 `QuotaCounter.used` 置 0。重置是跨租户写，必须走 `RawPrismaService` + `src/tenancy/raw-reasons.ts` 登记 + `// raw-reason:` 注释。已知代价：重置那一刻的 in-flight job 可能多算 1–2 次，写进 cron 注释。
4. `GeoUsageLedger` 照建，职责是**成本与用量明细账**（平台成本看板、对账），**不是配额判定真源**。两者职责写进表注释。
5. 同步改三处常量：`apps/api/src/modules/platform/plan/plan.rules.ts:19` `QUOTA_KINDS`；`apps/platform/src/api/plan.ts:18` `QUOTA_KINDS` + `QUOTA_KIND_LABELS`；`apps/api/src/registry/quota-kinds.ts` → `['STAFF','GEO_BRAND','GEO_PROMPT','GEO_ENGINE','GEO_QUERY_MONTHLY']`（`CUSTOM` 随 example-goods 一起删）。可选：`packages/nest-billing/src/platform-gateway.ts:470` `quotaLabel` 补中文。

### 1.2 packages/sms 形状（geo-engines / llm 的模板）

`packages/sms/src/`：`index.ts`（纯 re-export）、`provider.ts`（`SmsProvider<TConfig>` 泛型接口）、`registry.ts`（Map + `sendWithFallback` 主备切换 + `attempts[]` 记录）、`http-client.ts`（**注入式 HttpClient，本包不 import axios、不用全局 fetch**）、`templates.ts`、`phone.ts`、`providers/{tencent-tc3,aliyun-rpc,mock}.ts` + **每个文件一个同名 `.spec.ts`**。`mock.ts` 导出 `assertMockNotInProd(env)`。配置：`package.json` / `tsup.config.ts` / `vitest.config.ts` / `tsconfig.json` / `eslint.config.js`。

### 1.3 storage —— D6 定稿（改为 DB 存原文）

事实：`packages/storage/src/provider.ts:48` 的 `StorageProvider<TConfig>` 只有 `CosStorageProvider` 一个实现，没有 local/mock；`apps/api` 未依赖 `@taizan/storage`。

**P0 原文直接落 DB，对象存储降为 P1 归档：**
- `GeoQueryResult.rawText String? @db.Text`（超 60000 字符截断并置 `rawTruncated Boolean @default(false)`）
- `preview String @db.VarChar(500)`、`fingerprint String @db.VarChar(64)`（sha256(engineCode+promptId+text)）
- **保留 `rawTextRef String?`** 给 P1。P1 加 `geo.result.archive` handler 把 N 天前的 `rawText` 搬到 COS。

### 1.4 nest-infra 精确签名与限流

```ts
// packages/nest-infra/src/queue/job-handler.decorator.ts:26
interface JobHandlerOptions { name: string; concurrency?: number; attempts?: number
  backoff?: { type: 'fixed'|'exponential'; delayMs: number }; deadLetter?: boolean }
// 默认：concurrency 1 / attempts 3 / exponential 2000ms / deadLetter true
interface JobProcessor<T> { process(envelope: JobEnvelope<T>): Promise<void> } // 抛异常 = 本次失败

// packages/nest-infra/src/queue/queue.service.ts:59
add<T>(name: string, data: T, opts?: { tenantId?: string; delayMs?: number
  jobId?: string; attempts?: number; backoff?: JobBackoff }): Promise<string>
// jobId：同 id 重复入队幂等 —— 这就是我们的幂等键

// packages/nest-infra/src/queue/envelope.ts
interface JobEnvelope<T> { originTenantId?: string; traceId: string; parentTraceId?: string; data: T; enqueuedAt: number }

// packages/nest-infra/src/cron/leader-cron.decorator.ts:22
interface LeaderCronOptions { key: string; cron: string; lockTtlMs: number; watchdog?: boolean; timezone?: string }
```

**没有 per-queue rate limiter**。→ `GeoEngine.rateLimitPerMin` 自己实现：`GeoRateLimiter`（`modules/geo/run/geo-rate-limiter.ts`），用 `RedisService` 裸 client 做分钟窗口计数 `INCR geo:rl:{engineCode}:{floor(now/60000)}` + `EXPIRE 120`。**不能用 `CacheService`**（强制租户前缀，引擎限速是平台级）。超限抛 `EngineError{kind:'RATE_LIMIT', retryable:true}`，交给 BullMQ 按 `attempts: 6, backoff: exponential 5000ms` 退避；并发用 `@JobHandler({ concurrency: 4 })` 粗控。

### 1.5 nest-notify —— 告警通道

`packages/nest-notify/src/types.ts:8`：`NotifyChannelKind = 'SMS' | 'INBOX' | 'MP_TEMPLATE' | 'APP_PUSH'`，**没有 EMAIL**。模板登记在 `apps/api/src/registry/notify-templates.ts` 的 `NOTIFY_TEMPLATES`，**模板缺失是同步抛错**。`fallback !== true` 时是广播。

**P0**：告警 `channels: ['INBOX','SMS']`、`fallback: false`。`GeoAlertRule.channels Json` 只允许 `['INBOX']` 或 `['INBOX','SMS']`，`alert.rules.ts` 校验。邮件通道是独立 P1 任务。

### 1.6 crypto

`createVault({ keys, currentKeyId })` → `encrypt(plain) => { valueEnc, keyId }` / `decrypt` / `mask`。既有样例：`TenantCredential(valueEnc @db.Text, keyId, maskedHint)`（`01-tenant.prisma:66`）；`PlatformSetting(valueEnc, keyId)`（`06-ops.prisma:41`）。`packages/prisma-base/src/encrypted-columns.ts` 的 `ENCRYPTED_COLUMNS` + `verifyEncryptedColumns()` 注释明写"业务项目自己的加密列在项目侧另建一份注册表"。

→ `GeoEngine.credentialEnc String? @db.Text` + `credentialKeyId String?` + `credentialMasked String?`，密文是**整包 credentials 的 JSON**，解密后 `JSON.parse` 喂 `EngineAdapter.ask(ctx.credentials)`。新建 `apps/api/src/registry/encrypted-columns.ts` 登记 + `test/arch/` 加一条对账 spec。

### 1.7 codegen 适用判断

`pnpm gen:module <slug> --name=中文名 [--dry-run]` 生成 11 个后端文件 + 2 个 admin 文件并自动改七处注册表；模块目录已存在则抛错。模板是单表 CRUD。

| 子模块 | 用 codegen | 理由 |
|---|---|---|
| brand / prompt / alert | ✅ 生成后大改 | 标准租户域 CRUD |
| run / analysis / aggregate / dashboard / report / usage / engine(平台) | ❌ 手写 | 非 CRUD |

推荐：**只对 `geo-brand` 跑一次 `gen:module`** 拿注册表改写样板，其余照着手写。

### 1.8 e2e 写法（队列没有内联模式）

- 连真 MySQL(3307) + Redis；`apps/api/vitest.e2e.config.ts` 把 Redis 自动改写到 **3 号库**，`fileParallelism: false`，`testTimeout 60s`。
- 登录链路：`POST /api/platform/auth/login` → `POST /api/platform/tenants` 建租户 → `POST /api/admin/auth/login`。**每个 e2e 文件必须设自己的 `X-Forwarded-For`**（见 `tenant-isolation.e2e-spec.ts:73` `LOGIN_IP`），否则 login 档限流让后续文件拿到 1042900。
- **队列无同步模式**：`QUEUE_ENABLED=true` 跑真 worker；既有写法是轮询 + deadline（`rbac-billing.e2e-spec.ts:792`）。GEO 推荐**轮询 DB**：`until GeoQueryRun.status in (DONE|PARTIAL|FAILED) or deadline(60s)`。
- `seedBase` 可在测试里直接 import。

### 1.9 seed.ts

`apps/api/src/seed.ts`：raw `PrismaClient`（带 `// raw-reason:`）；`seedBase()` 产出 `base.plans.trial/standard` + 平台超管；`seedDemoTenant()` 造 demo 与 demo-b（B 店已到期做闸门对照）；全程 upsert。

### 1.10 实现阶段确立的偏差（T4–T7 回写，T8 定稿）

以下几点是编码过程中发现本文档原方案行不通、或需要补充细化后确立的，代码以这里为准；架构总览见 `docs/GEO-架构.md` §5。

1. **GEO 是一个 Nest 模块**：`geo.module.ts` 汇总全部子目录（brand/prompt/engine/run/analysis/aggregate/dashboard/citation/alert/report/usage），不是每个子目录各进一个 Nest 模块——子模块之间要互相注入（prompt 要 brand 的 `requireBrand`、run 要 brand 的配置），拆开会多出大量样板 `imports`/`exports`。
2. **权限点两段式**：格式是 `geo-<子模块>:<action>`（如 `geo-brand:list`），不是本文档 §4.1 路由表里写的 `geo:brand:list` 三段式——框架权限注册表的正则只认两段式，这是硬约束。§4.1 表格里的权限点列请按两段式理解。
3. **`GeoUsageLedger` 的用量列实际字段名是 `quantity`**，不是 §3.1 表格与 §5 写的 `amount`——`amount` 会被 schema lint 的金额列规则误判成金额并要求 `Cents` 后缀。
4. **`errorKind` 走 lint 枚举豁免**：`GeoQueryResult.errorKind` 是 `String? @db.VarChar(64)` 自由文本而非 DB enum（值域由 `packages/geo-engines` 各适配器定义，做枚举等于每接一个新引擎就要一次库迁移），登记在 `test/arch/index.spec.ts` 的 `ENUM_EXEMPTIONS` 里。
5. **`GeoSourcePlatformRule.platform` 用大写码**：seed 15 条规则（§8.3）用的是 `ZHIHU`/`BAIDU_BAIKE`/`XHS`/`WECHAT`/`MEDIA` 这类大写标识符，不是中文可读名；`classifySource` 命中默认分支时也固定产出大写的 `OWNED`/`COMPETITOR`/`OTHER`。
6. **`openai` 这个 engine code 注册的是 Responses API 适配器**（`/responses` + `web_search` 工具），不是 Chat Completions——因为要让模型真正联网搜索。`OpenAiCompatibleEngineAdapter` 与 `OpenAiResponsesEngineAdapter` 的 `code` 都是 `'openai'`，`EngineRegistry.register()` 对重复 code 直接抛错不覆盖，两者只能装一个，目前装的是 Responses 版本。
7. **`sentimentAvgX100` 的公式是 `round(mean(sentimentScore))`**，不是 `round(mean(sentimentScore) * 100)`——`sentimentScore` 本身已经是 ×100 的形式，T6 期间曾经多乘一次 100 导致值域跑到 `[-10000, 10000]`，与列注释"平均情感分 ×100"（值域应为 `[-100, 100]`）对不上，T7 已修正并把公式钉进 `geo-metrics.rules.ts` 注释与单测。
8. **`GEO_ENGINE` 配额是只读判断，不 consume/release**：语义是"这个品牌最多能同时选几个引擎"而不是存量消耗，用 `quota.usage()` 取 `limit` 与 `engineCodes.length` 比较；`QuotaCounter` 表里不会有 `GEO_ENGINE` 这一档的记录行，和 `GEO_BRAND`/`GEO_PROMPT` 的存量消耗模型不同。

---

## 2. 包设计

### 2.1 `packages/geo-engines`

```
src/
  index.ts            纯 re-export
  http-client.ts      照抄 sms：interface HttpClient { request(...): Promise<HttpResponse> }
  types.ts            EngineAskInput / EngineCitation / EngineAskOutput / EngineAdapter / EngineCode
  errors.ts           EngineError { kind: 'AUTH'|'RATE_LIMIT'|'TIMEOUT'|'CONTENT_FILTER'|'UPSTREAM'|'PARSE'; retryable: boolean }
  registry.ts         EngineRegistry: register(adapter) / get(code) / codes()
  citation.ts         normalizeUrl / domainOf / dedupeCitations + citation.spec.ts
  adapters/
    qwen.ts           buildQwenRequest / parseQwenResponse / QwenEngineAdapter + qwen.spec.ts
    ernie.ts hunyuan.ts zhipu.ts metaso.ts doubao.ts openai-compatible.ts + 各自 .spec.ts
    mock.ts           MockEngineAdapter + assertMockNotInProd + mock.spec.ts
```

每个适配器拆三部分：`buildXxxRequest(input, cfg) → { url, method, headers, body }` 与 `parseXxxResponse(json) → EngineAskOutput` 是**纯函数**（官方文档样例响应做 fixture 写 spec），`XxxEngineAdapter` 只做 `httpClient.request(build(...))` → `parse(...)`。**不 import 任何 nest/prisma**。

**Mock 引擎行为（`credentials.scenario` 驱动）：**

| scenario | 行为 |
|---|---|
| `mention`（默认） | 回答含 `credentials.brandName`，位次 1，2 条引用（1 条是 `credentials.brandDomain`） |
| `no-mention` | 不含品牌词，citations 空 |
| `competitor` | 只提竞品（`credentials.competitorNames` 逗号分隔） |
| `cited` | 提及 + 引用本品牌官网 |
| `negative` | 提及但语气负面 |
| `timeout` | sleep 后抛 `EngineError{TIMEOUT, retryable:true}` |
| `rate-limit` | 立即抛 `EngineError{RATE_LIMIT, retryable:true}` |
| `auth-fail` | 抛 `EngineError{AUTH, retryable:false}` |

输出必须**确定性**（`latencyMs` 固定 12，`usage` 固定）。

### 2.2 `packages/llm`

```
src/
  index.ts  http-client.ts
  types.ts        ChatMessage / ChatRequest { messages, model, jsonSchema?, temperature?, maxTokens? }
                  ChatResponse { text, json?: unknown, usage, model, finishReason }
                  LlmProvider<TConfig> { readonly name: string; chat(req, cfg): Promise<ChatResponse> }
  registry.ts     LlmProviderRegistry（照抄 sms 主备 fallback）
  json-schema.ts  buildJsonSchemaHint / parseJsonLoose（剥 ```json 围栏、截尾修复）+ spec
  providers/
    openai-compatible.ts  （DeepSeek/Kimi/智谱/vLLM 通吃）+ spec
    dashscope.ts          （通义原生）+ spec
    mock.ts               MockLlmProvider + assertMockNotInProd + spec
```

`MockLlmProvider` 按 `cfg.scenario` 与入参品牌词做**确定性字符串匹配**产出结构化 JSON（提及/位次/情感）。

---

## 3. Prisma Schema

### 3.1 `apps/api/prisma/schema/10-business/20-geo.prisma`（租户域）

约定：`id String @id @db.VarChar(26)`（应用层 ULID）、`tenantId String @db.VarChar(26)` NOT NULL、`createdAt @default(now())`、`updatedAt @updatedAt`、软删表 `deletedAt DateTime?`、每表 `@@index([tenantId, id])`、唯一索引带 `deletedAt`、**无 relation**。

| 模型 | 关键列 | 索引 | 软删 |
|---|---|---|---|
| `GeoBrand` | name, domain, aliases Json, industry, locale, status `GeoBrandStatus`, refreshFreq `GeoRefreshFreq`, sampleSize Int @default(3), engineCodes Json, createdBy String? | `@@unique([tenantId,name,deletedAt])`、`@@index([tenantId,status])`、`@@index([tenantId,createdBy])` | ✅ |
| `GeoCompetitor` | brandId, name, domain, aliases Json | `@@unique([tenantId,brandId,name,deletedAt])`、`@@index([tenantId,brandId])` | ✅ |
| `GeoPromptSet` | brandId, name, source `GeoPromptSource` | `@@unique([tenantId,brandId,name,deletedAt])` | ✅ |
| `GeoPrompt` | brandId, promptSetId, text `@db.Text`, textHash `@db.VarChar(64)`, topic, funnelStage `GeoFunnelStage`, isTracked Bool @default(true), priority Int @default(0) | `@@unique([tenantId,brandId,textHash,deletedAt])`、`@@index([tenantId,brandId,isTracked])` | ✅ |
| `GeoQueryRun` | brandId, triggeredBy `GeoRunTrigger`, status `GeoRunStatus`, engineCodes Json, sampleSize, totalQueries, doneQueries, failedQueries, totalCostCents, startedAt?, finishedAt?, errorSummary? `@db.Text`, createdBy? | `@@index([tenantId,brandId,createdAt])`、`@@index([tenantId,status])` | ❌ |
| `GeoQueryResult` | runId, brandId, promptId, engineCode, sampleIndex Int, status `GeoResultStatus`, rawText? `@db.Text`, rawTruncated Bool, rawTextRef?, preview `@db.VarChar(500)`, fingerprint `@db.VarChar(64)`, model, latencyMs, inputTokens, outputTokens, searchCalls, costCents, errorKind?, errorMessage?, answeredAt?, analyzedAt? | `@@unique([tenantId,runId,promptId,engineCode,sampleIndex])`、`@@index([tenantId,brandId,answeredAt])`、`@@index([tenantId,runId,status])` | ❌ |
| `GeoMention` | resultId, brandId, promptId, engineCode, entityKind `GeoEntityKind`, competitorId?, entityName, position Int, isCited Bool, sentiment `GeoSentiment`, sentimentScore Int(-100..100), snippet `@db.VarChar(500)`, answeredAt | `@@index([tenantId,brandId,answeredAt])`、`@@index([tenantId,resultId])` | ❌ |
| `GeoCitation` | resultId, brandId, promptId, engineCode, url `@db.Text`, urlHash `@db.VarChar(64)`, domain `@db.VarChar(255)`, platform `@db.VarChar(64)`, category `GeoSourceCategory`, rank Int, title?, answeredAt | `@@index([tenantId,brandId,answeredAt])`、`@@index([tenantId,brandId,domain])` | ❌ |
| `GeoVisibilityDaily` | brandId, engineCode(`''`=汇总), promptId(`''`=汇总), date `@db.Date`, answers, mentions, mentionRateBp, sovBp, avgPositionX100, citationRateBp, sentimentAvgX100, competitorStats Json | `@@unique([tenantId,brandId,engineCode,promptId,date])`、`@@index([tenantId,brandId,date])` | ❌ |
| `GeoAlertRule` | brandId, kind `GeoAlertKind`, thresholdBp Int, channels Json, enabled Bool, lastFiredAt? | `@@unique([tenantId,brandId,kind,deletedAt])` | ✅ |
| `GeoAlertEvent` | ruleId, brandId, kind, payload Json, notifiedAt? | `@@index([tenantId,brandId,createdAt])` | ❌ |
| `GeoReport` | brandId, period `GeoReportPeriod`, periodStart `@db.Date`, periodEnd `@db.Date`, payload Json, status `GeoReportStatus` | `@@unique([tenantId,brandId,period,periodStart])` | ❌ |
| `GeoUsageLedger` | brandId?, runId?, metric `GeoUsageMetric`, engineCode?, amount Int, costCents Int, month `@db.VarChar(7)`, occurredAt | `@@index([tenantId,month,metric])`、`@@index([tenantId,brandId,occurredAt])` | ❌ |

枚举：`GeoBrandStatus{ACTIVE,PAUSED}`、`GeoRefreshFreq{WEEKLY,DAILY}`、`GeoPromptSource{MANUAL,AI_GEN,IMPORT}`、`GeoFunnelStage{TOFU,MOFU,BOFU,UNKNOWN}`、`GeoRunTrigger{SCHEDULE,MANUAL}`、`GeoRunStatus{PENDING,RUNNING,DONE,PARTIAL,FAILED}`、`GeoResultStatus{PENDING,OK,FAILED}`、`GeoEntityKind{BRAND,COMPETITOR}`、`GeoSentiment{POSITIVE,NEUTRAL,NEGATIVE}`、`GeoSourceCategory{OWNED,COMPETITOR,EARNED,SOCIAL,ENCYCLOPEDIA,PR,OTHER}`、`GeoAlertKind{VISIBILITY_DROP,COMPETITOR_OVERTAKE,NEGATIVE_MENTION}`、`GeoReportPeriod{WEEKLY,MONTHLY}`、`GeoReportStatus{PENDING,READY,FAILED}`、`GeoUsageMetric{QUERY,LLM_TOKEN,CONTENT_GEN}`。

### 3.2 `10-business/21-geo-platform.prisma`（平台域，无 tenantId）

- `GeoEngine`：`code String @unique`、name、vendor、accessType `GeoAccessType{API,BROWSER}`、enabled Bool、model、baseUrl、`credentialEnc String? @db.Text`、`credentialKeyId String?`、`credentialMasked String?`、pricePerQueryCents Int、priceInPerMTokenCents Int、priceOutPerMTokenCents Int、rateLimitPerMin Int、timeoutMs Int、config Json、sort Int。`@@index([enabled, sort])`。
- `GeoSourcePlatformRule`：pattern `@db.VarChar(255)`、platform、category、priority Int。`@@unique([pattern])`、`@@index([priority])`。

### 3.3 QuotaKind 改动与 lock 重生成

```
1) 改 packages/prisma-base/schema/02-plan.prisma 的 enum QuotaKind（追加 5 值）
2) pnpm -F @taizan/prisma-base build
3) pnpm -F @taizan/api taizan:schema-sync   # 重写 00-base/** 并重算 base.lock.json
4) pnpm -F @taizan/api prisma:generate
5) pnpm -F @taizan/api exec prisma migrate dev --name add_geo_quota_kinds_and_geo_tables
6) pnpm -F @taizan/api taizan:verify-schema
7) pnpm test:arch
```
**不要手改 `00-base/**` 或 lock**。

### 3.4 注册清单变更

- `apps/api/src/tenancy/tenant-models.ts`：`registry.register([...])` 加 13 张租户表（不含 `GeoEngine`、`GeoSourcePlatformRule`）；`SOFT_DELETE_MODELS` 加 `GeoBrand, GeoCompetitor, GeoPromptSet, GeoPrompt, GeoAlertRule`。（`Goods, GoodsSku` 在 T8 删 example-goods 时移除）
- `apps/api/package.json` 的 `taizan:verify-schema --registered=` 补这 13 个模型名。

---

## 4. 后端模块划分

目录 `apps/api/src/modules/geo/{brand,prompt,engine,run,analysis,aggregate,dashboard,alert,report,usage}/`，由 `geo.module.ts` 汇总并进 `bootstrap/app.module.ts`。

### 4.1 控制器路由表

| 模块 | 方法 路径 | 权限点 | 审计动作 | 功能项 |
|---|---|---|---|---|
| brand | GET `/api/admin/geo/brands`（`@DataScope({ownerField:'createdBy'})`） | `geo:brand:list` | — | geo.monitor |
| | GET/POST/PUT/DELETE `/api/admin/geo/brands[/:id]` | `geo:brand:list` / `:write` / `:write` / `:delete` | `geo-brand.{create,update,delete}` | 同上 |
| | POST `/:id/competitors`、DELETE `/:id/competitors/:cid` | `geo:brand:write` | `geo-brand.competitor-*` | 同上 |
| prompt | GET/POST/PUT/DELETE `/api/admin/geo/prompts[/:id]` | `geo:prompt:list|write|delete` | `geo-prompt.*` | geo.monitor |
| | POST `/api/admin/geo/prompts/generate`（LLM 生成候选，不落库） | `geo:prompt:generate` | `geo-prompt.generate` | 同上 |
| | POST `/api/admin/geo/prompts/import`（批量） | `geo:prompt:write` | `geo-prompt.import` | 同上 |
| run | GET `/api/admin/geo/runs`、GET `/:id` | `geo:run:list` | — | geo.monitor |
| | POST `/api/admin/geo/runs`（立即刷新） | `geo:run:trigger` | `geo-run.trigger` | geo.monitor |
| result | GET `/api/admin/geo/results`、GET `/:id`（含 rawText） | `geo:result:view` | — | — |
| citation | GET `/api/admin/geo/citations`、GET `/domains`（榜单） | `geo:citation:view` | — | — |
| dashboard | GET `/api/admin/geo/dashboard/overview|trend|engines|competitors` | `geo:dashboard:view` | — | — |
| alert | GET/POST/PUT/DELETE `/api/admin/geo/alert-rules[/:id]`、GET `/api/admin/geo/alert-events` | `geo:alert:list|write` | `geo-alert.*` | geo.monitor |
| report | GET `/api/admin/geo/reports`、GET `/:id` | `geo:report:view` | — | — |
| engine(平台) | GET/POST/PATCH `/api/platform/geo/engines[/:id]`、PATCH `/:id/enable|disable`、POST `/:id/test`（`@Auth('platform')`，与既有平台控制器一致） | — | `geo-engine.{create,update,enable,disable,credential-update}` | — |
| usage(平台) | GET `/api/platform/geo/usage`、GET `/api/platform/geo/runs`、POST `/api/platform/geo/runs/:id/retry` | — | `geo-run.platform-retry` | — |

`registry/features.ts` 新增：`{ key: 'geo.monitor', name: 'GEO 监测', writeOnly: true, pathPrefixes: ['/api/admin/geo/brands','/api/admin/geo/prompts','/api/admin/geo/runs','/api/admin/geo/alert-rules'] }`、`{ key: 'geo.daily_refresh', name: '日频刷新', writeOnly: true, pathPrefixes: [] }`（权益位，由调度读 `gateway.hasFeature`）、`{ key: 'geo.content_gen', ... }`（P1 留位）。

### 4.2 队列流程

```
[HTTP POST /geo/runs] 或 [@LeaderCron geo-run-schedule]
   └─ RunService.create(): quota.check(GEO_QUERY_MONTHLY, total) → 建 GeoQueryRun(PENDING)
      → queue.add('geo.run.dispatch', {runId}, { tenantId, jobId:`run:${runId}` })

geo.run.dispatch   concurrency 2  attempts 3
   └─ 读 brand/prompts/engines → 批量建 GeoQueryResult(PENDING) → run.status = RUNNING
      → 逐条 queue.add('geo.query.execute', {resultId}, { tenantId, jobId:`q:${resultId}` })

geo.query.execute  concurrency 4  attempts 6  backoff exp 5000ms  deadLetter true
   └─ rateLimiter.acquire(engineCode) → quota.consume(GEO_QUERY_MONTHLY,1)
      → vault.decrypt(GeoEngine.credentialEnc) → adapter.ask()
      ├─ 成功: 写 result(OK, rawText/preview/usage/costCents) + UsageLedger
      │        → queue.add('geo.result.analyze', {resultId}, { tenantId, jobId:`a:${resultId}` })
      └─ 失败: retryable → throw（重试）；不可重试或重试耗尽 →
               写 result(FAILED, errorKind) + quota.release(1) → settle(runId)

geo.result.analyze concurrency 4  attempts 3
   └─ llm.chat(jsonSchema) 抽提及/情感 → 引用归一化(纯函数)
      → 事务内 deleteMany(resultId) + createMany(Mention/Citation)（重放幂等）
      → result.analyzedAt = now → settle(runId)

settle(runId)  // 纯计数收口，非 job
   └─ count by status；仍有 PENDING → return
      failed==0 → DONE / 0<failed<total → PARTIAL / failed==total → FAILED
      → queue.add('geo.daily.aggregate', {brandId,date}, { tenantId, jobId:`agg:${tenantId}:${brandId}:${date}` })

geo.daily.aggregate concurrency 2  attempts 3
   └─ 按 (brandId, engineCode∈{各引擎,''}, promptId∈{各Prompt,''}) upsert GeoVisibilityDaily
      → queue.add('geo.alert.evaluate', {brandId,date}, { tenantId, jobId:`al:${tenantId}:${brandId}:${date}` })

geo.alert.evaluate concurrency 1  attempts 3
   └─ evaluateAlertRules(today, yesterday, rules) → 建 GeoAlertEvent
      → notify.send({ tenantId, templateKey:'geo.alert.visibility-drop', channels:['INBOX','SMS'] })
```

幂等键：`queue.add` 的 `jobId`。死信：全部默认 `deadLetter: true`。**QueryRun 状态机**：`PENDING →(dispatch)→ RUNNING →(settle)→ DONE | PARTIAL | FAILED`；`errorSummary` 存按 `errorKind` 分组计数 JSON。

### 4.3 cron key

| key | cron | lockTtlMs / watchdog | 作用 |
|---|---|---|---|
| `geo-run-schedule` | `0 3 * * *` | 600000 / true | 扫 ACTIVE 品牌，WEEKLY 只周一跑，DAILY 每天（需 `hasFeature('geo.daily_refresh')`）。跨租户扫描走 RawPrismaService + raw-reason |
| `geo-daily-aggregate` | `20 1 * * *` | 600000 / true | 兜底重算昨天 |
| `geo-quota-month-reset` | `5 0 1 * *` | 300000 / true | 月度两档 `QuotaCounter.used = 0` |
| `geo-weekly-report` | `0 8 * * 1` | 600000 / true | 生成上周 `GeoReport` |

### 4.4 纯函数 rules（每个配 `.spec.ts`）

| 文件 | 内容 |
|---|---|
| `brand/geo-brand.rules.ts` | `validateBrandInput`、`normalizeDomain`、`normalizeAliases` |
| `prompt/geo-prompt.rules.ts` | `validatePromptInput`、`hashPromptText`、`dedupePrompts` |
| `run/geo-run.rules.ts` | `planQueries(brand, prompts, engines, sampleSize) → QuerySpec[]`、`computeCostCents(engine, usage)`、`resolveRunStatus(total, done, failed)`、`isRetryable(errorKind)` |
| `analysis/geo-mention.rules.ts` | `extractMentionsFallback`（正则兜底）、`normalizeSentimentScore`、`resolvePosition` |
| `analysis/geo-citation.rules.ts` | `normalizeUrl`、`domainOf`、`classifySource(domain, rules, brandDomain, competitorDomains) → {platform, category}` |
| `aggregate/geo-metrics.rules.ts` | `mentionRateBp`、`sovBp`、`avgPositionX100`、`citationRateBp`、`sentimentAvgX100`（全整数运算） |
| `alert/geo-alert.rules.ts` | `evaluateVisibilityDrop`、`evaluateCompetitorOvertake`、`evaluateNegativeMention`、`validateChannels` |

---

## 5. 成本与配额接线

| 环节 | 代码位置 | 动作 |
|---|---|---|
| 前置拦截 | `run/geo-run.service.ts` `create()` | `quota.check('GEO_QUERY_MONTHLY', totalQueries)`，不足直接抛 1540301 |
| 品牌/Prompt/引擎数 | brand/prompt service `create()`/`remove()` | `quota.consume('GEO_BRAND')` 先占后写，catch 里 release；软删时 release |
| 逐次占用 | `run/geo-query-execute.handler.ts` 入口 | `quota.consume('GEO_QUERY_MONTHLY', 1)` |
| 失败释放 | 同 handler 的 catch | 写 `result(FAILED)` 后 `quota.release('GEO_QUERY_MONTHLY', 1).catch(()=>undefined)` |
| 落账 | 成功分支 | `GeoUsageLedger.create({ metric:'QUERY', engineCode, amount:1, costCents, month })`；analyze handler 落 `LLM_TOKEN` |
| 成本公式 | `run/geo-run.rules.ts` `computeCostCents` | `pricePerQueryCents + ceil(inputTokens * priceInPerMTokenCents / 1e6) + ceil(outputTokens * priceOutPerMTokenCents / 1e6)`；累加进 `GeoQueryRun.totalCostCents` |

---

## 6. 前端

### 6.1 admin 8 个页面

| # | 页面文件 | componentKey | path | 形态 | API hook |
|---|---|---|---|---|---|
| 1 | `pages/geo/GeoDashboardPage.tsx` | `GeoDashboard` | `/geo` | 自定义（Statistic + Line + Column + Bar） | `api/geo-dashboard.ts` |
| 2 | `pages/geo/GeoBrandListPage.tsx` | `GeoBrandList` | `/geo/brands` | CrudTable + 竞品子抽屉 | `api/geo-brand.ts` |
| 3 | `pages/geo/GeoPromptListPage.tsx` | `GeoPromptList` | `/geo/prompts` | CrudTable + AI 生成抽屉 | `api/geo-prompt.ts` |
| 4 | `pages/geo/GeoRunListPage.tsx` | `GeoRunList` | `/geo/runs` | CrudTable + 立即刷新 + 进度列 | `api/geo-run.ts` |
| 5 | `pages/geo/GeoResultListPage.tsx` | `GeoResultList` | `/geo/results` | CrudTable + 原文 Drawer | `api/geo-result.ts` |
| 6 | `pages/geo/GeoCitationListPage.tsx` | `GeoCitationList` | `/geo/citations` | CrudTable + Pie | `api/geo-citation.ts` |
| 7 | `pages/geo/GeoAlertRuleListPage.tsx` | `GeoAlertRuleList` | `/geo/alerts` | CrudTable | `api/geo-alert.ts` |
| 8 | `pages/geo/GeoReportListPage.tsx` | `GeoReportList` | `/geo/reports` | CrudTable + 详情 Drawer | `api/geo-report.ts` |

登记进 `apps/admin/src/routes/component-map.ts`，与 `menus.ts` 的 `componentKey` 对齐；改完跑 `pnpm -F @taizan/admin sync-menus`。

### 6.2 platform 3 个页面

`pages/PlatformGeoEngineList.tsx`（`PlatformGeoEngineList`, `/geo/engines`）、`pages/PlatformGeoUsage.tsx`（`PlatformGeoUsage`, `/geo/usage`）、`pages/PlatformGeoRunMonitor.tsx`（`PlatformGeoRunMonitor`, `/geo/runs`）。登记进 `apps/platform/src/routes/component-map.ts`。

### 6.3 图表依赖

`apps/admin/package.json` 加 `"@ant-design/plots": "^2.3.0"`。页面用 `lazy` 包住。加完确认 `pnpm -F @taizan/admin build` 绿。admin-ui 纪律：页面里不出现 `useState/useEffect`；Dashboard 数据获取包成 `useGeoDashboard()` hook。

---

## 7. 测试计划

| 层次 | 内容 |
|---|---|
| 包单测 | geo-engines：每个 adapter 的 build/parse 用官方样例 fixture（通义 `search_info`、文心 `search_results` 必须有）；`citation.ts`；mock 8 scenario。llm：`parseJsonLoose`、mock 确定性 |
| 应用单测 | 7 个 `*.rules.spec.ts`，重点 `geo-metrics.rules.ts` 整数口径与 `resolveRunStatus` |
| arch spec | `tenant-models`、`permission-registry`、`menu-route-map`、`no-manual-tenant-filter`、`raw-usage`、`cluster-safe`、`base-schema-integrity`、`guard-default-deny`、`response-shape`。**一条不改，不 skip** |
| e2e `apps/api/test/geo.e2e-spec.ts` | ① 建 A/B 两租户、建 Mock 引擎 ② A 建品牌+竞品+3 Prompt ③ `POST /geo/runs` ④ 轮询终态（60s）⑤ 断言 result 条数 = prompts×engines×sampleSize、Mention/Citation、VisibilityDaily 数值精确 ⑥ dashboard overview ⑦ B 查 A 的 brandId → 1240300、列表空 ⑧ `GEO_QUERY_MONTHLY: 1` 再触发 → 1540301；`GEO_BRAND: 1` 建第二品牌 → 1540301 ⑨ scenario=`rate-limit` 跑出 `PARTIAL` 且 release 过配额 |

---

## 8. seed 变更

1. 套餐：`geo-trial` `{ GEO_BRAND: 1, GEO_PROMPT: 20, GEO_ENGINE: 2, GEO_QUERY_MONTHLY: 200, GEO_CONTENT_MONTHLY: 0 }`，`features: ['geo.monitor']`；`geo-standard` `{ GEO_BRAND: 5, GEO_PROMPT: 200, GEO_ENGINE: 6, GEO_QUERY_MONTHLY: 5000, GEO_CONTENT_MONTHLY: 50 }`，`features: ['geo.monitor','geo.daily_refresh']`
2. `GeoEngine`：`mock`（enabled，credentialEnc 存 `{"scenario":"mention"}` 密文）、`qwen`/`ernie`（disabled，无密钥）
3. `GeoSourcePlatformRule` 15 条（zhihu.com→ZHIHU/SOCIAL、baike.baidu.com→BAIDU_BAIKE/ENCYCLOPEDIA、xiaohongshu.com→XHS/SOCIAL、weixin.qq.com→WECHAT/SOCIAL、36kr.com→MEDIA/PR 等）
4. demo 租户：1 品牌（"钛赞云"，domain `taizan.example.com`，aliases `["钛赞","Taizan"]`，engineCodes `["mock"]`，sampleSize 3）+ 2 竞品 + 1 PromptSet + 5 Prompt + 1 AlertRule(VISIBILITY_DROP, 1000)
5. 删 GOODS 相关 seed（T8）

---

## 9. 任务拆解

| # | 任务包 | 目标 | 产出 | 验收命令 | 前置 |
|---|---|---|---|---|---|
| **T1** | `packages/geo-engines` | 引擎层 + 8 适配器 + Mock | 包全部源文件 + spec + 配置 + README | `pnpm -F @taizan/geo-engines lint && typecheck && test && build` | 无 |
| **T2** | `packages/llm` | 分析 LLM 层 + 3 provider | 同上 | `pnpm -F @taizan/llm ...` | 无 |
| **T3** | Schema + 配额枚举 + 注册清单 | 两个 prisma 文件、QuotaKind、lock、迁移、三处 QUOTA_KINDS、tenant-models、verify-schema、encrypted-columns | 见 §3 | `taizan:schema-check && prisma:generate && taizan:verify-schema && pnpm test:arch` | 无 |
| **T4** | brand + prompt 模块 | 第一个 GEO 模块跑通七个扩展点 | `modules/geo/{brand,prompt}/**`、`geo.module.ts`、注册表改动、admin 两页 + api + component-map | `pnpm lint && typecheck && test && test:arch`；`sync-menus && build` | T3 |
| **T5** | engine(平台) + 密钥 + 限流器 | 平台引擎 CRUD、vault、`GeoRateLimiter` | `modules/geo/engine/**`、`run/geo-rate-limiter.ts`、platform 引擎页 | `pnpm test && test:arch`；platform build | T1,T3 |
| **T6** | run + analysis 流水线 | 3 handler + settle + 配额/成本 + 2 cron | `modules/geo/{run,analysis}/**`、`registry/jobs.ts` | `pnpm test && test:arch` | T4,T5 |
| **T7** | aggregate + dashboard + alert + report + usage | 聚合、只读查询、告警通知、周报 | `modules/geo/{aggregate,dashboard,alert,report,usage}/**`、notify 模板 | `pnpm test && test:arch` | T6 |
| **T8** | 前端图表页 + seed + e2e + 删 example-goods + docs | 6 admin 页、2 platform 页、plots、seed、`geo.e2e-spec.ts`、`docs/GEO-架构.md` | 上述文件 | 全量 lint/typecheck/test/arch/e2e/build | T7 |

第一批并行：T1+T2（同一 agent，避免并发 pnpm install）与 T3。第二批：T4 / T5 并行。之后 T6 → T7 → T8。

---

## 10. 实现 agent 最容易犯的 10 个错

| # | 易犯错误 | 正确写法 |
|---|---|---|
| 1 | 写 `where: { tenantId, brandId }` | `this.prisma.tenant.geoBrand.findMany({ where: { status } })`；建记录用 `autoTenantData<Prisma.GeoBrandCreateInput>({...})` |
| 2 | cron 跨租户扫描用 `prisma.tenant` | `RawPrismaService` + `raw-reasons.ts` 登记 + `// raw-reason:` |
| 3 | handler 里 `quota.consume` 抛缺租户上下文 | `queue.add(..., { tenantId })` 必须显式传 |
| 4 | HTTP 请求路径里直接调引擎/LLM | 一律 `@JobHandler`；`POST /geo/runs` 只建 run + 入队 |
| 5 | 事务里入队 | 入队在写库成功之后、事务之外 |
| 6 | 指标用 Float/Decimal | 全整数：`*Bp`、`*X100`；金额 `Int` + `Cents` |
| 7 | 建 `@relation` | 一条都不建 |
| 8 | 隐式注入 / DTO 不加 `Validate` | `@Inject(Token)`；`@Body(Validate(Dto))`；`@ApiProperty({ type })` |
| 9 | 唯一索引忘带 `deletedAt`；以为它保证活跃唯一 | 带 `deletedAt`；活跃唯一性应用层再兜（见 `goods.service.ts` `assertNameAvailable`） |
| 10 | arch spec 红了改断言 / `.skip`；手改 `00-base/**` | 先假设自己错；schema 全链 `schema-sync → generate → migrate → verify-schema → test:arch`；`prisma.config.ts` 顶部 `import 'dotenv/config'` 不能删 |

附加：`@Public()` 必须 `@RateLimited(tier)`；平台级 key 用 `RedisService` 裸 client 不用 `CacheService`；进程内 `Map/Set` 写 `// process-local:` 理由。
