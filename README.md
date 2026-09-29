# 钛赞GEO

**多租户 GEO（Generative Engine Optimization，生成式引擎优化）SaaS：帮助品牌方与代理商监测自己在豆包、通义千问、文心、混元、智谱、秘塔等 AI 回答中的可见度、引用来源与情感，找出差距并给出优化方向。**

商家配置品牌、竞品和问法（Prompt），系统定时或手动调用多家大模型/AI 搜索引擎模拟真实用户提问，
用 LLM 结构化分析每一条回答里的品牌提及、位次、情感与引用来源，聚合成提及率、声量份额（SoV）、
引用率等指标，产出看板、竞品对比、引用缺口、告警与报表。

本仓库构建在 [taizan-saas](#基于-taizan-saas-基座) 多租户 SaaS 基座（`@taizan/*` 包）之上：
租户隔离、计费与配额、RBAC、支付、审计等由基座承接，GEO 业务集中在
`apps/api/src/modules/geo/` 与两个 GEO 专用包里。

---

## 目录

- [核心能力](#核心能力)
- [支持的 AI 引擎](#支持的-ai-引擎)
- [系统架构](#系统架构)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [目录结构](#目录结构)
- [基于 taizan-saas 基座](#基于-taizan-saas-基座)
- [文档索引](#文档索引)
- [贡献](#贡献)
- [许可证](#许可证)

---

## 核心能力

| 能力 | 说明 | 代码位置（`apps/api/src/modules/geo/`） |
| --- | --- | --- |
| 品牌 / 竞品管理 | 品牌带别名、行业、官网域名；竞品带别名与域名，用于份额对比与引用归类 | `brand/` |
| 问法（Prompt）管理 | 人工录入、批量导入、**LLM 自动生成候选问法**；按文本指纹去重 | `prompt/` |
| AI 可见度诊断 | 「先诊断后付费」编排：`POST /api/admin/geo/brands/:id/diagnose` 一次调用完成「按需生成问法 → 建跑批 → 分析 → 聚合 → 生成一次性诊断报告（附推荐问法与内容优化建议）」；商家后台有对应的三步向导 | `diagnosis/` |
| 监测跑批 | 手动「立即刷新」+ `@LeaderCron` 定时调度；1 次查询 = 1 问法 × 1 引擎 × 1 次采样；按引擎限速、失败重试、兜底清扫 | `run/` |
| 回答分析 | LLM 结构化抽取品牌/竞品提及、位次、情感；引用 URL 归一化并按来源分类（自有 / 竞品 / 第三方媒体 / 社区 / 百科 / PR / 其他） | `analysis/` |
| 指标聚合 | 每日按 品牌 × 引擎 × 问法 三层预聚合（`GeoVisibilityDaily`）：提及率、SoV、平均位次、引用率、情感均值、竞品快照 | `aggregate/` |
| 可见度看板 | 概览、趋势、引擎对比、竞品对比；回答明细可查看原文与引用 | `dashboard/`、`run/` |
| 引用来源 | 引用明细、域名榜；**引用缺口**：找出「竞品被提及而本品牌未被提及」的回答实际引用了哪些第三方来源 | `citation/` |
| 告警 | 可见度下跌、竞品份额反超、负面提及三类规则，命中后走基座通知通道 | `alert/` |
| 报表 | 周报（cron 自动生成）、周报/月报手动生成，以及一次性诊断报告；报表详情有**字段级付费门禁**：套餐未放行时仅返回免费摘要，竞品、引用榜、推荐问法、内容建议置为 `null` | `report/` |
| 用量与成本 | 商家侧用量；平台侧跨租户用量/成本看板、跑批监控与失败重试 | `usage/` |
| 引擎管理 | 平台侧引擎启停、密钥（加密落库）、单价、限速；商家可配置**专属引擎密钥**用自己的账号付费 | `engine/`、`engine-credential/` |
| 自助注册 | 官网自助开店，店铺路径（slug）选填，不填时按店铺名称自动生成；试用期与试用到期策略由 env 控制 | `apps/site`、`apps/api/src/modules/public/` |

**指标口径**（唯一真源：`aggregate/geo-metrics.rules.ts`，有 spec 钉住）：全部整数运算，比率类字段以基点存储（`*Bp`，10000 = 100%），均值类放大 100 倍（`*X100`），金额一律 `Int` + `Cents` 后缀。

- 提及率 = 提及本品牌的回答数 ÷ 有效回答数
- SoV（声量份额）= 本品牌提及回答数 ÷ (本品牌 + 全部竞品提及回答数)。日聚合里分母为 0 时记 0；报表层分母为 0 时返回 `null`，以区分「谁都没被提及」与「份额为 0%」
- 引用率 = 被引用的品牌提及回答数 ÷ 有效回答数
- 另有平均位次、情感均值、首位推荐率（报表 overview）

配额维度（接基座 `nest-billing`）：`GEO_BRAND`、`GEO_PROMPT`、`GEO_ENGINE`、`GEO_QUERY_MONTHLY`、`GEO_CONTENT_MONTHLY`（内容生成为 P1 预留）。详见 [`docs/GEO-架构.md`](docs/GEO-架构.md) §3。

> AI 生成 GEO 内容、浏览器自动化引擎、PDF 报告等属于 P1/P2 规划，尚未实现，范围见 [`docs/geo/GEO-产品定义与P0范围.md`](docs/geo/GEO-产品定义与P0范围.md)。

---

## 支持的 AI 引擎

引擎适配器在 [`packages/geo-engines`](packages/geo-engines/README.md)，统一 `EngineAdapter` 契约，请求构造与响应解析均为纯函数：

| code | 引擎 | 联网 / 引用方式 |
| --- | --- | --- |
| `qwen` | 通义千问（DashScope） | `enable_search` + `search_options` |
| `ernie` | 文心（千帆 v2） | `web_search` |
| `hunyuan` | 腾讯混元 | `enable_enhancement` + `citation` + `search_info` |
| `zhipu` | 智谱 GLM | `web_search` 工具 |
| `metaso` | 秘塔 | Search API |
| `doubao` | 豆包（火山方舟） | Responses API + `web_search` |
| `openai` | OpenAI Responses API，或 OpenAI 协议兼容端点（DeepSeek / Kimi / vLLM / 自建网关） | Responses API `web_search`；兼容端点多数**不联网**，引用字段为各家扩展 |
| `mock` | 确定性 Mock 引擎 | 开发、测试、演示用；生产环境启用会拒启 |

各引擎凭据键名、默认模型、官方文档核对结论与「仍待实测」清单见 [`packages/geo-engines/README.md`](packages/geo-engines/README.md)。
回答分析用的 LLM 由 [`packages/llm`](packages/llm/README.md) 提供（OpenAI 协议兼容 / DashScope 原生 / mock，支持主备切换）。

---

## 系统架构

### 各端职责

| 端 | 技术栈 | 职责 |
| --- | --- | --- |
| `apps/api` | NestJS 11 + Prisma + BullMQ | 唯一后端进程（模块化单体）。命名空间：`/api/platform`（平台超管）、`/api/admin`（商家后台）、`/api/client`（C 端）、`/api/public`（免登录，如自助注册）。GEO 全部业务、定时任务与队列 worker 都在这里 |
| `apps/admin` | React 18 + Vite + AntD 5 + `@taizan/admin-ui` | 商家后台：AI 可见度诊断向导、可见度看板、品牌/问法管理、监测任务、回答明细、引用来源、告警、报表、专属引擎密钥，以及基座自带的员工/角色/账单/审计等 |
| `apps/platform` | React 18 + Vite + `@taizan/admin-ui` | 平台超管后台：租户与套餐、订单与收入、GEO 引擎管理、GEO 用量/成本、GEO 跑批监控、定时任务与死信队列 |
| `apps/site` | React 18 + Vite + react-router 6 | 官网营销页 + 自助开店表单（接 `/api/public/*`） |
| `apps/client` | Taro 4 + React | C 端 H5 + 微信小程序（基座示例业务） |
| `apps/app-client` / `apps/app-merchant` | Expo | C 端 App / 商家助手 App（基座示例业务） |

> `client`、`app-client`、`app-merchant` 目前承载的是基座自带的示例业务（`example-goods`），尚未接入 GEO 功能。

### GEO 数据流

```
品牌 / 竞品 / 问法配置（brand、prompt）
        │  POST /api/admin/geo/runs、诊断编排，或 @LeaderCron geo-run-schedule
        ▼
建 GeoQueryRun(PENDING) ── 配额预检 GEO_QUERY_MONTHLY
        │  queue: geo.run.dispatch
        ▼
run.dispatch ── 批量建 GeoQueryResult，逐条入队
        │  queue: geo.query.execute
        ▼
query.execute ── 限流 → 扣配额 → 解密引擎凭据 → adapter.ask() → 写回答 + 用量账
        │  queue: geo.result.analyze
        ▼
result.analyze ── LLM 抽取提及/位次/情感 → 引用归一化与来源分类 → 收口 Run 状态
        │  queue: geo.daily.aggregate
        ▼
daily.aggregate ── upsert GeoVisibilityDaily（品牌 / 引擎 / 问法 三层）
        │           └─ 若有待收口的诊断跑批 → 生成 ONE_SHOT 诊断报告
        │  queue: geo.alert.evaluate
        ▼
alert.evaluate ── 对比今日/昨日聚合，命中阈值 → GeoAlertEvent → 通知
        │
        ▼
dashboard / citation / report ── 只读消费聚合结果
```

HTTP 请求路径不同步调用引擎或 LLM，只建记录并入队；幂等键是队列 `jobId`；
Run 状态机为 `PENDING → RUNNING → DONE | PARTIAL | FAILED`。
设计约定与实现偏差见 [`docs/GEO-架构.md`](docs/GEO-架构.md)。

---

## 技术栈

- **后端**：Node.js ≥ 22、NestJS 11、Prisma（MySQL 8）、Redis 7、BullMQ、pino、zod（env 校验）、Swagger
- **前端**：React 18、Vite、Ant Design 5（后台）、Taro 4（小程序/H5）、Expo（App）
- **工程**：pnpm 11 workspace、turbo 2、TypeScript 5.7+、vitest 3、Playwright、ESLint 9（flat config）、Prettier、tsup、Changesets
- **部署**：Docker Compose 或 宝塔 + PM2 + nginx（见 [`deploy/README.md`](deploy/README.md)）

---

## 快速开始

### 1. 环境依赖

- Node.js ≥ 22
- pnpm 11（`packageManager` 固定为 `pnpm@11.1.2`，建议用 corepack）
- Docker（本地起 MySQL 8 + Redis 7）

### 2. 安装与基础设施

```bash
pnpm install

# 起 MySQL（宿主 3307）+ Redis（宿主 6380），见 deploy/docker/docker-compose.dev.yml
pnpm dev:infra
```

### 3. 配置环境变量

```bash
cp apps/api/.env.example apps/api/.env
```

`apps/api/.env.example` 由 `apps/api/src/config/env.ts` 的 zod schema 自动生成（`pnpm -F @taizan/api taizan:env-example`），不要手改。启动时缺字段会逐条列出并拒启。

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | MySQL 连接串（必填）。本地 compose 对应值见 `.env.example` 末尾注释 |
| `REDIS_URL` | Redis 连接串（必填），队列、锁、限流、缓存共用 |
| `JWT_SECRET_PLATFORM` / `JWT_SECRET_STAFF` / `JWT_SECRET_MEMBER` | 三套身份的 JWT 密钥（必填，各 ≥ 32 位且互不相同） |
| `CRYPTO_KEYS` / `CRYPTO_KEY_CURRENT` | 加密列密钥表（JSON，keyId → 64 位 hex）与当前 keyId（必填）；引擎凭据等敏感列用它加密 |
| `GEO_LLM_PROVIDER` / `GEO_LLM_BASE_URL` / `GEO_LLM_API_KEY` / `GEO_LLM_MODEL` | 回答分析用的 LLM。默认 `mock`（仅非生产）；可选 `openai-compatible`、`dashscope` |
| `CRON_ENABLED` / `QUEUE_ENABLED` | 本进程是否跑定时任务 / 消费队列（web 与 worker 分开部署时用） |
| `BILLING_ENFORCE` | 计费闸门总开关 |
| `SIGNUP_ENABLED` / `SIGNUP_TRIAL_DAYS` / `SIGNUP_TRIAL_AUTO_PLAN` | 自助注册开关、试用天数、试用到期自动挂的套餐 |
| `SMS_PROVIDER` 及 `LUOSIMAO_*` | 短信与人机验证（默认 `mock`，仅非生产） |
| `CLIENT_DEV_LOGIN` / `SMS_RETURN_DEV_CODE` / `WECHAT_DEV_FAKE_LOGIN` / `PAY_FAKE_ENABLED` | 联调开关，`NODE_ENV=production` 下打开会拒启 |

完整清单与说明以 [`apps/api/.env.example`](apps/api/.env.example) 为准。前端：`apps/admin/.env.example`（`VITE_API_BASE`）、`apps/site/.env.example`（`VITE_ADMIN_URL` 等），本地开发留空即可（Vite 已把 `/api` 代理到 `localhost:3000`）。生产 compose 变量见 `deploy/docker/.env.prod.example`。

> 引擎的 API Key 不走 env：由平台后台「GEO 引擎」录入（加密落库），或由商家在「专属引擎密钥」里配置。

### 4. 建表与演示数据

```bash
pnpm -F @taizan/api prisma:migrate   # schema-sync + prisma migrate dev
pnpm -F @taizan/api seed             # 本地演示数据（幂等，可重复执行）
```

`seed` 产出：平台管理员、两档套餐（含 GEO 配额）、GEO 引擎配置（默认只启用 `mock`）、来源平台分类规则、两家演示店（B 店**已到期**，作为计费闸门对照组），以及 A 店下的 GEO 演示品牌「钛赞云」、2 个竞品、一组问法与 1 条告警规则。

| 身份 | 入口 | 本地演示账号 |
| --- | --- | --- |
| 平台超管 | `apps/platform` / `POST /api/platform/auth/login` | `admin` / `admin123` |
| 商家（A 店店主） | `apps/admin` / `POST /api/admin/auth/login` | `13800000000` / `123456` |
| 商家（B 店店主，已到期） | 同上 | `13800000001` / `123456` |

以上仅为本地演示账号。生产初始化使用 `pnpm -F @taizan/api seed:prod`（只建系统基线，平台管理员口令随机生成，不建演示租户）。

### 5. 启动

```bash
pnpm -F @taizan/api dev        # http://localhost:3000   Swagger: /docs
pnpm -F @taizan/admin dev      # http://localhost:5173   商家后台
pnpm -F @taizan/platform dev   # http://localhost:5175   平台后台
pnpm -F @taizan/site dev       # http://localhost:5176   官网 + 自助注册
```

也可以用 `pnpm dev`（turbo 并行启动全部端）。用 A 店账号登录商家后台，进入「GEO 监测 → AI可见度诊断」即可用 mock 引擎走完整条诊断链路。

### 6. 测试与检查

```bash
pnpm test                        # turbo 全仓单测
pnpm -F @taizan/api test         # api 单测 + 架构约束 spec（不连库）
pnpm test:arch                   # 仅架构约束 spec（隔离注册、raw 用法登记、权限/菜单对账等）
pnpm test:e2e                    # api e2e（连真库：隔离、RBAC/计费、GEO 跑批与诊断等）
pnpm typecheck && pnpm lint
```

e2e 连接 `pnpm dev:infra` 起的 MySQL + Redis，并默认使用 Redis 3 号库以免与本地 dev 进程抢队列任务。部分用例依赖 `.env` 中的联调开关（如 `PAY_FAKE_ENABLED`、`CLIENT_DEV_LOGIN`）。多次执行后如出现与数据量相关的失败，可用 `pnpm dev:infra:down`（**会清空数据卷**）后重建。

---

## 目录结构

```
taizan-geo/
├─ apps/
│  ├─ api/            NestJS 后端；GEO 业务在 src/modules/geo/，表结构在 prisma/schema/10-business/
│  ├─ admin/          商家后台（GEO 页面在 src/pages/geo/）
│  ├─ platform/       平台超管后台（GEO 引擎 / 用量 / 跑批监控）
│  ├─ site/           官网 + 自助注册
│  ├─ client/         Taro H5 + 小程序（基座示例）
│  ├─ app-client/     Expo C 端 App（基座示例）
│  └─ app-merchant/   Expo 商家助手 App（基座示例）
├─ packages/
│  ├─ geo-engines/    GEO 引擎适配器 + registry + 错误分类 + 引用归一化
│  ├─ llm/            LLM Provider + 主备切换 + JSON Schema 输出解析
│  └─ …               其余为 taizan-saas 基座的 @taizan/* 包（见下一节）
├─ tools/             共享配置（tsconfig / eslint / prettier）、create-taizan-saas 生成器、codegen
├─ deploy/            Docker / PM2 / nginx / 部署脚本 / 线上只读自检
├─ docs/              架构、GEO 设计、基座契约与红线文档
├─ scripts/           仓库级脚本（架构检查、错误码生成、peer 依赖校验、验收）
└─ .github/workflows/ CI
```

---

## 基于 taizan-saas 基座

taizan-saas 是一套「多租户 SaaS 地基」：`@taizan/*` npm 包 + `create-taizan-saas` 生成器，新项目只写业务模块。
钛赞GEO 就是在它之上用「七个扩展点」（表、隔离注册、权限点、菜单、套餐功能项、审计动作、队列任务）接入的一个业务模块，逐项位置见 `apps/api/src/modules/geo/geo.module.ts` 文件头。

基座把以下容易「做错了也不报错」的事情做成**不变量 + CI 里会红的静态断言**（清单见 [`docs/SECURITY-INVARIANTS.md`](docs/SECURITY-INVARIANTS.md)）：

- **租户隔离**：Prisma `$extends` 自动注入租户条件；业务表必须登记 `TENANT_MODELS`，跨租户扫描必须走 `RawPrismaService` 并登记理由
- **计费与配额**：到期现算、宽限期、只读/打烊三态、配额物化计数、功能开关、续费白名单
- **三套身份 + RBAC**：平台 / 商家员工 / C 端会员三种 JWT；全局默认拒绝；每请求现查成员关系；菜单按「权限 ∩ 套餐」服务端下发
- **密钥加密与轮换**：AES-256-GCM + 多 keyId + 幂等轮换
- **多实例安全**：`@LeaderCron` 单实例定时任务、Redis 分布式锁、限流按 XFF 末尾倒数防伪造
- **支付与通知**：微信支付 V3（含服务商分账、虚拟支付）、短信主备、站内信/公众号模板/App 推送

| 类别 | 包 |
| --- | --- |
| 零框架依赖（可在裸 node 单测） | `contracts`、`tenant-scope`、`rbac-core`、`billing-rules`、`ratelimit-core`、`crypto`、`provision`、`payment-core`、`wechatpay`、`wechat-open`、`sms`、`storage`、`prisma-base`、`tokens`、`geo-engines`、`llm` |
| Nest 适配 | `nest-core`、`nest-prisma`、`nest-auth`、`nest-rbac`、`nest-billing`、`nest-infra`、`nest-audit`、`nest-notify`、`nest-payment` |
| 前端 | `admin-ui`（后台基座）、`client-core`（Taro）、`app-ui`（Expo） |

各包职责与用法见各自目录下的 README 与 [`docs/框架设计蓝图.md`](docs/框架设计蓝图.md)。
新增业务模块的逐文件手册见 [`docs/EXTENSION-POINTS.md`](docs/EXTENSION-POINTS.md)，也可用 `pnpm gen:module <name>` 生成骨架。

---

## 文档索引

**GEO**

| 文档 | 内容 |
| --- | --- |
| [`docs/GEO-架构.md`](docs/GEO-架构.md) | 模块划分、数据流、配额体系、关键约定、实现与设计的偏差 |
| [`docs/geo/GEO-产品定义与P0范围.md`](docs/geo/GEO-产品定义与P0范围.md) | 产品定位、核心概念与指标口径、P0/P1/P2 范围、关键决策 |
| [`docs/geo/GEO-P0技术设计.md`](docs/geo/GEO-P0技术设计.md) | P0 详细技术设计 |
| [`docs/geo/GEO-功能需求调研报告.md`](docs/geo/GEO-功能需求调研报告.md) | 国内外 GEO 产品与需求调研 |
| [`docs/geo/基座接入要点.md`](docs/geo/基座接入要点.md) | GEO 接入 taizan-saas 基座的要点 |
| [`packages/geo-engines/README.md`](packages/geo-engines/README.md) | 引擎适配器契约、凭据键名、怎么加一个引擎 |
| [`packages/llm/README.md`](packages/llm/README.md) | LLM Provider 与结构化输出 |

**基座与工程**

| 文档 | 内容 |
| --- | --- |
| [`docs/README.md`](docs/README.md) | 基座文档完整索引 |
| [`docs/SECURITY-INVARIANTS.md`](docs/SECURITY-INVARIANTS.md) | 安全不变量（**改隔离/计费/认证/支付代码前先读**） |
| [`docs/EXTENSION-POINTS.md`](docs/EXTENSION-POINTS.md) | 加业务模块的七件事 |
| [`docs/PLATFORM-SCHEMA.md`](docs/PLATFORM-SCHEMA.md) | 基础表契约与不可改字段 |
| [`docs/ERROR-CODES.md`](docs/ERROR-CODES.md) | 7 位错误码总表（自动生成） |
| [`docs/CI.md`](docs/CI.md) | CI 流水线说明 |
| [`docs/UPGRADE.md`](docs/UPGRADE.md) / [`docs/RELEASE.md`](docs/RELEASE.md) | 升级 `@taizan/*` 版本 / 发版流程 |
| [`docs/框架设计蓝图.md`](docs/框架设计蓝图.md) | 基座整体设计 |
| [`apps/api/README.md`](apps/api/README.md) | 后端本地起步、身份登录、七件事速查、架构 spec 清单 |
| [`deploy/README.md`](deploy/README.md) | 部署形态、env 清单、线上自检顺序 |

---

## 贡献

欢迎提交 Issue 与 Pull Request。提交前请：

1. 改动隔离、计费、认证、支付相关代码前先读 [`docs/SECURITY-INVARIANTS.md`](docs/SECURITY-INVARIANTS.md)；
2. 本地通过 `pnpm typecheck`、`pnpm lint`、`pnpm test`，涉及数据访问的改动再跑 `pnpm test:e2e`；
3. 新增或修改错误码后执行 `pnpm docs:error-codes`，不要手改 `docs/ERROR-CODES.md`；
4. 修改 `packages/*` 时用 `pnpm changeset` 记录变更；
5. 代码风格由 Prettier（`semi: false, singleQuote: true, printWidth: 100`）与 ESLint 约束。

国内网络下 `pnpm install` 较慢时，可在本地 `.npmrc` 设置 `registry=https://registry.npmmirror.com`。

---

## 许可证

待定。<!-- TODO: 确定开源许可证后补充 LICENSE 文件并更新此处 -->
