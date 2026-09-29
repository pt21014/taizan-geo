/**
 * **GEO 跑批 + 分析流水线的 e2e**（T6 的收口证明），跑在真 MySQL(3307) + 真 Redis 上。
 *
 * ```
 * pnpm dev:infra
 * pnpm -F @taizan/api prisma:migrate
 * pnpm -F @taizan/api test:e2e
 * ```
 *
 * ## 为什么必须连真 Redis
 *
 * 这份 e2e 断言的核心是**一条跨四个队列任务的链路**：
 * `POST /geo/runs` → `geo.run.dispatch` → N × `geo.query.execute` →
 * N × `geo.result.analyze` → `settle()` → `geo.daily.aggregate`。
 *
 * `@taizan/nest-infra` 的队列**没有内联模式**（技术设计 §1.8）：要么起真 BullMQ worker，
 * 要么什么都不跑。所以这里只能连真 Redis 并**轮询 DB 等终态**，与
 * `rbac-billing.e2e-spec.ts` 等队列的写法一致。
 *
 * 限速器（`GeoRateLimiter`）也只在真 Redis 上才真的执行——它用的是 `EVAL` 脚本。
 *
 * ## 用例清单
 *
 * ① 平台登录 → 开两家店 → 建并启用 mock 引擎
 * ② A 店建品牌（`engineCodes: ['mock']`、`sampleSize: 2`）+ 2 竞品 + 3 问法
 * ③ `POST /geo/runs` → 轮询终态（60s deadline）→ DONE
 * ④ 结果条数 = 3 问法 × 1 引擎 × 2 采样 = 6，全部 OK，且都分析过了
 * ⑤ 每条都有 BRAND 提及（position 1、isCited）与含品牌域名的引用
 * ⑥ `GeoUsageLedger` 有 6 条 QUERY（成本明细账）
 * ⑦ `GET /geo/results/:id` 回得到原文 + 提及 + 引用
 * ⑧ 跨租户：B 店看不到 A 店的跑批（`GET /:id` → 1240300、列表空）
 * ⑨ 套餐 `GEO_QUERY_MONTHLY: 1` 再触发 → 1540301
 * ⑩ 引擎凭据换成 `scenario: auth-fail` → 终态 FAILED、`errorSummary.AUTH === 6`、配额回落
 * ⑪ `POST /geo/prompts/generate` 回 5 条候选（mock LLM 的 `prompt-gen` 场景）
 *
 * @packageDocumentation
 */

import 'reflect-metadata'
import 'dotenv/config'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { ulid } from '@taizan/contracts'
import { PLATFORM_GATEWAY, type PlatformGateway } from '@taizan/nest-billing'
import { seedBase } from '@taizan/prisma-base'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppModule } from '../src/bootstrap/app.module'
import { configureApp } from '../src/bootstrap/configure-app'
import { findFirstUpsertDelegate } from '../src/seed-delegates'
import { solveCaptcha } from './helpers/solve-captcha'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

/** 每次跑用一段唯一后缀，两家店互不干扰、重复跑也不打架。 */
const RUN = ulid().slice(-8).toLowerCase()

const OWNER_PASSWORD = 'e2e-password-123'

/**
 * 本文件的登录请求专用的「客户端 IP」。
 *
 * `login` 档限流按**客户端 IP** 计（5 分钟 10 次），而 e2e 每个文件都从 `127.0.0.1`
 * 打过来、又串行跑（`fileParallelism: false`），几个文件共用同一个桶。不分桶的话，
 * 后面的文件会拿到 `1042900` 而不是它想断言的东西。
 *
 * 用 `10.96.*` 段（`tenant-isolation` 是 `10.97.*`、`geo-brand` 是 `10.98.*`），
 * 保证与其它 e2e 文件不撞桶。
 */
const LOGIN_IP = `10.96.${([...RUN].reduce((a, c) => (a + c.charCodeAt(0)) % 200, 11) + 1).toString()}.7`

/** 品牌的官网域名。`mock` 适配器会在引用里带出 `https://{brandDomain}/product`。 */
const BRAND_DOMAIN = `taizan-${RUN}.example.com`

/** 这一批的规模：3 问法 × 1 引擎 × 2 采样 = 6 条查询。 */
const PROMPT_COUNT = 3
const SAMPLE_SIZE = 2
const EXPECTED_RESULTS = PROMPT_COUNT * SAMPLE_SIZE

/** 轮询终态的上限。`vitest.e2e.config.ts` 的 `testTimeout` 是 60s，留一点余量。 */
const TERMINAL_DEADLINE_MS = 50_000

let app: INestApplication
let prisma: PrismaClient
let gateway: PlatformGateway

function http(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0]
}

function loginRequest(url: string) {
  return request(http()).post(url).set('X-Forwarded-For', LOGIN_IP)
}

/** 成功响应的信封形状；`code` 不为 0 时直接把整个 body 打出来。 */
function expectOk<T>(body: unknown): T {
  const envelope = body as { code: number; message: string; data: T }
  expect(envelope.code, `期望 code=0，实际：${JSON.stringify(envelope)}`).toBe(0)
  return envelope.data
}

function codeOf(body: unknown): number {
  return (body as { code: number }).code
}

/** 造一个本次运行专用的手机号。 */
function phoneFor(n: number): string {
  const digits = [...RUN]
    .map((c) => c.charCodeAt(0) % 10)
    .join('')
    .slice(0, 7)
  return `137${digits}${n}`
}

interface Shop {
  tenantId: string
  token: string
}

let platformToken = ''
let shopA: Shop
let shopB: Shop
let brandA = ''
let runA = ''
let mockEngineId = ''

/** 用平台 token 开一家店，然后用店主账号登录，返回 staff token。 */
async function createShopAndLogin(index: number): Promise<Shop> {
  const phone = phoneFor(index)
  const created = await request(http())
    .post('/api/platform/tenants')
    .set('Authorization', `Bearer ${platformToken}`)
    .send({
      slug: `e2e-geo-run-${index}-${RUN}`,
      name: `E2E GEO RUN ${index} ${RUN}`,
      ownerPhone: phone,
      ownerPassword: OWNER_PASSWORD,
      trialDays: 30,
    })
  const data = expectOk<{ tenant: { id: string } }>(created.body)

  const login = await loginRequest('/api/admin/auth/login').send({
    phone,
    password: OWNER_PASSWORD,
    tenantId: data.tenant.id,
    ...(await solveCaptcha(app)),
  })
  const session = expectOk<{ access: string }>(login.body)
  return { tenantId: data.tenant.id, token: session.access }
}

function asShop(shop: Shop) {
  const token = `Bearer ${shop.token}`
  return {
    get: (url: string, query?: Record<string, unknown>) =>
      request(http())
        .get(url)
        .query(query ?? {})
        .set('Authorization', token),
    post: (url: string, body?: unknown) =>
      request(http())
        .post(url)
        .set('Authorization', token)
        .send(body ?? {}),
  }
}

function asPlatform() {
  const token = `Bearer ${platformToken}`
  return {
    put: (url: string, body?: unknown) =>
      request(http())
        .put(url)
        .set('Authorization', token)
        .send(body ?? {}),
  }
}

/** 建一档套餐（平台域表，直接写库——套餐管理接口是另一条工作流，由 platform e2e 验证）。 */
async function createPlan(quotas: Record<string, number | null>): Promise<string> {
  const plan = await prisma.plan.create({
    data: {
      id: ulid(),
      code: `e2e-geo-run-plan-${ulid().slice(-8).toLowerCase()}`,
      name: 'E2E GEO 跑批套餐',
      firstPriceCents: 0,
      renewPriceCents: 0,
      periodMonths: 1,
      quotas,
      appKeys: ['admin', 'client'],
      trafficMb: 0,
    },
  })
  return plan.id
}

/** 改一家店的闸门相关字段，然后**必须** `invalidate`（否则 30 秒缓存里还是旧的）。 */
async function mutateTenant(tenantId: string, data: Record<string, unknown>): Promise<void> {
  await prisma.tenant.update({ where: { id: tenantId }, data })
  gateway.invalidate(tenantId)
}

/**
 * 保证 `mock` 引擎在库里且已启用。
 *
 * **不写 `credentialEnc`**：`MockEngineAdapter` 在没有 `scenario` 时默认走 `mention` 场景，
 * 而 `brandName` / `brandDomain` / `competitorNames` 由 `geo-query-execute.handler.ts`
 * 在 `engine.code === 'mock'` 时按**当前这条查询的品牌**注入（那是 Mock 专用的注入，
 * 理由写在那个 handler 的 `mockCredentialInjection` 上）。
 *
 * 所以这里一个凭据都不用配，用例⑩再通过平台接口把 `scenario` 改成 `auth-fail`。
 */
async function seedMockEngine(): Promise<string> {
  const existing = await prisma.geoEngine.findUnique({ where: { code: 'mock' } })
  if (existing) {
    await prisma.geoEngine.update({
      where: { id: existing.id },
      data: {
        enabled: true,
        // 清掉别的 e2e 文件可能留下的凭据，保证这一次从「默认 mention 场景」开始。
        credentialEnc: null,
        credentialKeyId: null,
        credentialMasked: null,
        // 限速给到 600/分钟：这份 e2e 会在几秒内打 12 次，默认的 60 也够，
        // 但和别的 e2e 文件共用同一个平台级窗口时会互相挤。
        rateLimitPerMin: 600,
      },
    })
    return existing.id
  }
  const row = await prisma.geoEngine.create({
    data: {
      id: ulid(),
      code: 'mock',
      name: 'Mock（联调用）',
      vendor: 'taizan',
      model: 'mock-engine-v1',
      accessType: 'API',
      enabled: true,
      rateLimitPerMin: 600,
      config: {},
    },
  })
  return row.id
}

/** 读一家店某一档配额的 `used`；没有计数行时回 0。 */
async function quotaUsed(tenantId: string, kind: string): Promise<number> {
  const row = await prisma.quotaCounter.findFirst({
    where: { tenantId, kind: kind as never },
    select: { used: true },
  })
  return row?.used ?? 0
}

/** 轮询 `GET /geo/runs/:id` 直到状态进入终态，或超时。 */
async function waitForTerminal(shop: Shop, runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + TERMINAL_DEADLINE_MS
  let last: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    const res = await asShop(shop).get(`/api/admin/geo/runs/${runId}`)
    last = expectOk<Record<string, unknown>>(res.body)
    const status = String(last['status'])
    if (status === 'DONE' || status === 'PARTIAL' || status === 'FAILED') return last
    await sleep(400)
  }
  throw new Error(
    `跑批 ${runId} 在 ${TERMINAL_DEADLINE_MS}ms 内没有进入终态，最后一次看到的是：` +
      `${JSON.stringify(last)}。先确认 QUEUE_ENABLED=true、Redis 连的是 3 号库、` +
      '以及四个 handler 都进了 GeoModule 的 providers。',
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 轮询到「这一批的全部结果都分析完了」。
 *
 * `settle()` 在**最后一条分析完成**时收口，所以 run 进终态时 `analyzedAt` 理论上都齐了。
 * 但 `geo.result.analyze` 与 `settle` 之间没有事务，极端时序下最后一条的
 * `analyzedAt` 可能比 run 的 `finishedAt` 晚几毫秒落库。等一下比在断言里加
 * 「允许少一条」实在得多——后者会让这条用例永远发现不了「分析根本没跑」。
 */
async function waitForAnalyzed(runId: string, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const n = await prisma.geoQueryResult.count({
      where: { runId, status: 'OK', analyzedAt: { not: null } },
    })
    if (n >= expected) return
    await sleep(200)
  }
}

beforeAll(async () => {
  prisma = new PrismaClient()

  await seedBase(
    {
      platformAdmin: prisma.platformAdmin,
      plan: prisma.plan,
      tenant: prisma.tenant,
      staffAccount: prisma.staffAccount,
      staff: findFirstUpsertDelegate(prisma.staff),
      role: findFirstUpsertDelegate(prisma.role),
      rolePreset: prisma.rolePreset,
    },
    { withDemoTenant: false },
  )

  mockEngineId = await seedMockEngine()

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  configureApp(app)
  await app.init()
  gateway = app.get<PlatformGateway>(PLATFORM_GATEWAY)
})

afterAll(async () => {
  await app?.close()
  await prisma?.$disconnect()
})

// ─────────────────────────────────────────────────────────────────────────────
// 用例
// ─────────────────────────────────────────────────────────────────────────────

describe('① 登录与开店', () => {
  it('平台超管登录，开出两家店', async () => {
    const res = await loginRequest('/api/platform/auth/login')
      .send({ username: 'admin', password: 'admin123', ...(await solveCaptcha(app)) })
      .expect(201)
    platformToken = expectOk<{ access: string }>(res.body).access

    shopA = await createShopAndLogin(1)
    shopB = await createShopAndLogin(2)
    expect(shopA.tenantId).not.toBe(shopB.tenantId)
    expect(mockEngineId).not.toBe('')
  })
})

describe('② A 店建监测对象', () => {
  it('建品牌（只选 mock 引擎，采样 2 次）', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/brands', {
      name: `太赞 ${RUN}`,
      domain: BRAND_DOMAIN,
      aliases: ['Taizan'],
      industry: 'SaaS',
      engineCodes: ['mock'],
      sampleSize: SAMPLE_SIZE,
    })
    const brand = expectOk<{ id: string; engineCodes: string[]; sampleSize: number }>(res.body)
    brandA = brand.id
    expect(brand.engineCodes).toEqual(['mock'])
    expect(brand.sampleSize).toBe(SAMPLE_SIZE)
  })

  it('建 2 个竞品（它们是份额 SoV 的分母，也是 mock 编回答时的对照组）', async () => {
    for (const name of [`竞品甲 ${RUN}`, `竞品乙 ${RUN}`]) {
      const res = await asShop(shopA).post(`/api/admin/geo/brands/${brandA}/competitors`, {
        name,
        domain: `${name.split(' ')[0]}-${RUN}.example.net`,
      })
      expect(codeOf(res.body)).toBe(0)
    }
  })

  it(`建 ${PROMPT_COUNT} 条问法（默认 isTracked=true，会被自动纳入跑批）`, async () => {
    for (let i = 1; i <= PROMPT_COUNT; i++) {
      const res = await asShop(shopA).post('/api/admin/geo/prompts', {
        brandId: brandA,
        text: `这一类产品有哪些值得推荐的 第${i}问 ${RUN}`,
      })
      expect(codeOf(res.body)).toBe(0)
    }
  })
})

describe('③④⑤⑥⑦ 跑一次完整流水线', () => {
  it('POST /geo/runs 只建 run 并入队，同步不调任何引擎', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/runs', { brandId: brandA })
    const run = expectOk<{ id: string; status: string; totalQueries: number }>(res.body)
    runA = run.id
    expect(run.status).toBe('PENDING')
    // `totalQueries` 由 dispatch handler 在真的建出 result 行之后回填，
    // 所以同步返回的这一刻它必然是 0——这正是「HTTP 只建 run」的证据。
    expect(run.totalQueries).toBe(0)
  })

  it('轮询到终态 DONE（PENDING → RUNNING → DONE）', async () => {
    const run = await waitForTerminal(shopA, runA)
    expect(run['status']).toBe('DONE')
    expect(run['totalQueries']).toBe(EXPECTED_RESULTS)
    expect(run['doneQueries']).toBe(EXPECTED_RESULTS)
    expect(run['failedQueries']).toBe(0)
    expect(run['finishedAt']).not.toBeNull()
    // 没有失败就不该有失败分布，而不是一个空对象——`{}` 会让前端画出一个空的错误提示。
    expect(run['errorSummary']).toBeNull()
  })

  it(`结果条数 = ${PROMPT_COUNT} 问法 × 1 引擎 × ${SAMPLE_SIZE} 采样 = ${EXPECTED_RESULTS}，全部 OK`, async () => {
    await waitForAnalyzed(runA, EXPECTED_RESULTS)
    const rows = await prisma.geoQueryResult.findMany({ where: { runId: runA } })
    expect(rows).toHaveLength(EXPECTED_RESULTS)
    expect(rows.every((r) => r.status === 'OK')).toBe(true)
    expect(rows.every((r) => (r.rawText ?? '') !== '')).toBe(true)
    expect(rows.every((r) => r.preview !== '')).toBe(true)
    expect(rows.every((r) => r.fingerprint.length === 64)).toBe(true)
    expect(rows.every((r) => r.answeredAt !== null)).toBe(true)
    expect(rows.every((r) => r.analyzedAt !== null)).toBe(true)
    // 同一条问法的两次采样各占一个 sampleIndex（1 和 2），唯一键保证不重复。
    expect(new Set(rows.map((r) => r.sampleIndex))).toEqual(new Set([1, 2]))
  })

  it('每条回答都抽出了品牌提及：BRAND、position 1、且被自家官网引用命中（isCited）', async () => {
    const rows = await prisma.geoQueryResult.findMany({
      where: { runId: runA },
      select: { id: true },
    })
    for (const row of rows) {
      const mentions = await prisma.geoMention.findMany({ where: { resultId: row.id } })
      const brandMention = mentions.find((m) => m.entityKind === 'BRAND')
      expect(brandMention, `回答 ${row.id} 没有抽出品牌提及`).toBeTruthy()
      expect(brandMention?.position).toBe(1)
      // `markCited`：引用里有 `https://{brandDomain}/product`，所以品牌提及算「被引用」。
      expect(brandMention?.isCited).toBe(true)
    }
  })

  it('每条回答都落了引用，且其中一条是品牌官网（归类 OWNED）', async () => {
    const rows = await prisma.geoQueryResult.findMany({
      where: { runId: runA },
      select: { id: true },
    })
    for (const row of rows) {
      const citations = await prisma.geoCitation.findMany({ where: { resultId: row.id } })
      expect(citations.length, `回答 ${row.id} 一条引用都没有`).toBeGreaterThan(0)
      const owned = citations.find((c) => c.domain === BRAND_DOMAIN)
      expect(owned, `回答 ${row.id} 的引用里没有品牌官网`).toBeTruthy()
      // `classifySource` 的第一优先级：命中 brandDomain → OWNED。
      expect(owned?.category).toBe('OWNED')
      expect(owned?.urlHash.length).toBe(64)
    }
  })

  it(`GeoUsageLedger 有 ${EXPECTED_RESULTS} 条 QUERY（成本明细账，与配额判定是两回事）`, async () => {
    const queryLedger = await prisma.geoUsageLedger.findMany({
      where: { tenantId: shopA.tenantId, runId: runA, metric: 'QUERY' },
    })
    expect(queryLedger).toHaveLength(EXPECTED_RESULTS)
    expect(queryLedger.every((l) => l.quantity === 1)).toBe(true)
    expect(queryLedger.every((l) => l.engineCode === 'mock')).toBe(true)
    expect(queryLedger.every((l) => /^\d{4}-\d{2}$/.test(l.month))).toBe(true)

    // 分析那一步也落账，但 `costCents` 是 0（P0 不计 LLM 成本，见 handler 的说明）。
    const llmLedger = await prisma.geoUsageLedger.findMany({
      where: { tenantId: shopA.tenantId, runId: runA, metric: 'LLM_TOKEN' },
    })
    expect(llmLedger).toHaveLength(EXPECTED_RESULTS)
    expect(llmLedger.every((l) => l.costCents === 0)).toBe(true)
    expect(llmLedger.every((l) => l.quantity > 0)).toBe(true)
  })

  it('GET /geo/results 列表不含原文；GET /geo/results/:id 含原文 + 提及 + 引用', async () => {
    const list = await asShop(shopA).get('/api/admin/geo/results', { runId: runA, pageSize: 50 })
    const page = expectOk<{ items: Array<Record<string, unknown>>; total: number }>(list.body)
    expect(page.total).toBe(EXPECTED_RESULTS)
    // 列表里刻意不下发 `rawText`：一页 20 条就是几百 KB，而列表上没地方显示它。
    expect(page.items.every((i) => !('rawText' in i))).toBe(true)
    expect(page.items.every((i) => String(i['preview']) !== '')).toBe(true)

    const first = page.items[0] as { id: string }
    const detail = await asShop(shopA).get(`/api/admin/geo/results/${first.id}`)
    const row = expectOk<{
      rawText: string | null
      mentions: Array<{ entityKind: string; position: number }>
      citations: Array<{ domain: string }>
    }>(detail.body)
    expect(row.rawText ?? '').toContain(`太赞 ${RUN}`)
    expect(row.mentions.length).toBeGreaterThan(0)
    expect(row.citations.length).toBeGreaterThan(0)
  })
})

describe('⑧ 跨租户：B 店看不到 A 店的跑批', () => {
  it('GET /geo/runs/:id → 1240300（与「不存在」同一个码，不提供存在性探测）', async () => {
    const res = await asShop(shopB).get(`/api/admin/geo/runs/${runA}`)
    expect(codeOf(res.body)).toBe(1240300)
  })

  it('GET /geo/runs 列表是空的（租户条件由隔离扩展 AND 进去，不是靠 where 写对）', async () => {
    const res = await asShop(shopB).get('/api/admin/geo/runs')
    const page = expectOk<{ items: unknown[]; total: number }>(res.body)
    expect(page.total).toBe(0)
    expect(page.items).toHaveLength(0)
  })

  it('GET /geo/results 列表也是空的', async () => {
    const res = await asShop(shopB).get('/api/admin/geo/results', { runId: runA })
    const page = expectOk<{ total: number }>(res.body)
    expect(page.total).toBe(0)
  })
})

describe('⑨ 配额：套餐 GEO_QUERY_MONTHLY = 1', () => {
  it('再触发一次 → 1540301（前置拦截，一条 result 都不建）', async () => {
    const planId = await createPlan({ GEO_QUERY_MONTHLY: 1 })
    await mutateTenant(shopA.tenantId, {
      planId,
      status: 'ACTIVE',
      planExpireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      trialEndAt: null,
    })

    const before = await prisma.geoQueryRun.count({ where: { tenantId: shopA.tenantId } })
    const res = await asShop(shopA).post('/api/admin/geo/runs', { brandId: brandA })
    expect(codeOf(res.body)).toBe(1540301)
    // 被拦下时连 run 都不该建出来——`quota.check` 在 `create()` 里排在写库之前。
    const after = await prisma.geoQueryRun.count({ where: { tenantId: shopA.tenantId } })
    expect(after).toBe(before)
  })
})

describe('⑩ 不可重试的引擎错误：scenario=auth-fail', () => {
  let usedBefore = 0

  it('把 mock 引擎的凭据改成 auth-fail（走平台接口，密文与 keyId 成对落库）', async () => {
    const res = await asPlatform().put(`/api/platform/geo/engines/${mockEngineId}/credentials`, {
      credentials: { scenario: 'auth-fail' },
    })
    expect(codeOf(res.body)).toBe(0)

    // 把配额放开，否则这一批会先撞 1540301 而不是跑到引擎那一步。
    const planId = await createPlan({ GEO_QUERY_MONTHLY: 1000 })
    await mutateTenant(shopA.tenantId, {
      planId,
      status: 'ACTIVE',
      planExpireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      trialEndAt: null,
    })
    usedBefore = await quotaUsed(shopA.tenantId, 'GEO_QUERY_MONTHLY')
  })

  it('触发 → 终态 FAILED，errorSummary 里 AUTH 计满', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/runs', { brandId: brandA })
    const created = expectOk<{ id: string }>(res.body)

    const run = await waitForTerminal(shopA, created.id)
    expect(run['status']).toBe('FAILED')
    expect(run['failedQueries']).toBe(EXPECTED_RESULTS)
    expect(run['doneQueries']).toBe(0)
    expect(run['errorSummary']).toEqual({ AUTH: EXPECTED_RESULTS })

    const rows = await prisma.geoQueryResult.findMany({ where: { runId: created.id } })
    expect(rows).toHaveLength(EXPECTED_RESULTS)
    expect(rows.every((r) => r.status === 'FAILED')).toBe(true)
    expect(rows.every((r) => r.errorKind === 'AUTH')).toBe(true)
  })

  it('配额回落到跑批之前的值（失败要还，不然虚高的计数没人会去修）', async () => {
    // `release` 与 `markFailed` 之间没有事务，收口之后可能还差几毫秒落库。
    const deadline = Date.now() + 5_000
    let used = await quotaUsed(shopA.tenantId, 'GEO_QUERY_MONTHLY')
    while (used !== usedBefore && Date.now() < deadline) {
      await sleep(200)
      used = await quotaUsed(shopA.tenantId, 'GEO_QUERY_MONTHLY')
    }
    expect(used).toBe(usedBefore)
  })

  it('善后：把 mock 引擎的凭据清空，别影响后面的用例与别的 e2e 文件', async () => {
    const res = await asPlatform().put(`/api/platform/geo/engines/${mockEngineId}/credentials`, {
      credentials: {},
    })
    expect(codeOf(res.body)).toBe(0)
    const row = await prisma.geoEngine.findUnique({ where: { id: mockEngineId } })
    expect(row?.credentialEnc).toBeNull()
  })
})

describe('⑪ AI 生成候选问法（唯一一条同步调 LLM 的接口）', () => {
  it('POST /geo/prompts/generate 回 5 条候选，且一条都没落库', async () => {
    const before = await prisma.geoPrompt.count({
      where: { tenantId: shopA.tenantId, brandId: brandA, deletedAt: null },
    })

    const res = await asShop(shopA).post('/api/admin/geo/prompts/generate', { brandId: brandA })
    const data = expectOk<{
      candidates: Array<{ text: string; funnelStage: string; duplicated: boolean }>
      provider: string
    }>(res.body)

    // mock LLM 的 `prompt-gen` 场景回的是 5 条固定候选（`buildMockPrompts`）。
    expect(data.candidates).toHaveLength(5)
    expect(data.provider).toBe('mock')
    expect(data.candidates.every((c) => c.text !== '')).toBe(true)
    expect(data.candidates.every((c) => ['TOFU', 'MOFU', 'BOFU'].includes(c.funnelStage))).toBe(
      true,
    )
    // 这五条都是新的（②里建的三条问法长得不一样）。
    expect(data.candidates.every((c) => !c.duplicated)).toBe(true)

    const after = await prisma.geoPrompt.count({
      where: { tenantId: shopA.tenantId, brandId: brandA, deletedAt: null },
    })
    expect(after, '生成接口不该落库——落库走 POST /prompts/import').toBe(before)
  })

  it('勾选之后走既有的 POST /prompts/import 才真的落库', async () => {
    const gen = await asShop(shopA).post('/api/admin/geo/prompts/generate', { brandId: brandA })
    const data = expectOk<{ candidates: Array<{ text: string }> }>(gen.body)
    const texts = data.candidates.slice(0, 2).map((c) => c.text)

    const res = await asShop(shopA).post('/api/admin/geo/prompts/import', {
      brandId: brandA,
      texts,
    })
    const result = expectOk<{ created: number; skipped: number }>(res.body)
    expect(result.created).toBe(2)
    expect(result.skipped).toBe(0)

    // 再导一次同样的两条 → 全部被 textHash 去重挡下，这也正是 `duplicated` 的口径。
    const again = await asShop(shopA).post('/api/admin/geo/prompts/import', {
      brandId: brandA,
      texts,
    })
    const result2 = expectOk<{ created: number; skipped: number }>(again.body)
    expect(result2.created).toBe(0)
    expect(result2.skipped).toBe(2)
  })
})
