/**
 * **「先诊断后付费」编排链路的 e2e**，跑在真 MySQL(3307) + 真 Redis 上。
 *
 * ```
 * pnpm dev:infra
 * pnpm -F @taizan/api prisma:migrate
 * pnpm -F @taizan/api test:e2e
 * ```
 *
 * 与 `geo-run.e2e-spec.ts` 的分工：那份文件把"手动建品牌→建问法→POST /runs→跑批"
 * 这条既有链路钉死了。这份文件专门测**新增的编排入口**
 * `POST /brands/:id/diagnose`：品牌零问法时自动生成+导入、跑批自动打上
 * `isDiagnosis`、日聚合收口后自动生成 `GeoReport(period=ONE_SHOT)` 并回填
 * `diagnosisReportId`，以及报表详情按 `geo.monitor` 闸门做的字段级门禁。
 *
 * ## 用例清单
 *
 * ① 登录开店（默认无 planId，`features=null`=全部功能开放，能正常触发诊断）
 * ② 建一个**零问法**的品牌，`POST /diagnose` → 自动生成 5 条问法（mock LLM 固定候选）
 *    并落库、建一次标记 `isDiagnosis` 的跑批并入队
 * ③ 轮询跑批到终态，`GET /runs/:id` 的 `isDiagnosis === true`
 * ④ 继续轮询到 `diagnosisReportId` 非空（日聚合收口后自动生成的 ONE_SHOT 报表）
 * ⑤ `GET /reports/:id`：`geo.monitor` 闸门放行时，overview 有
 *    `mentionRateBp`/`top1RateBp`/`sentimentAvgX100`，`competitors`/`topCitations`/
 *    `promptSuggestions`/`contentSuggestions` 都不是 null，`promptSuggestions`
 *    长度等于这次自动生成导入的问法数
 * ⑥ 品牌已有问法时再诊断一次：`reusedExistingPrompts === true`，`promptsGenerated === 0`，
 *    不新建 Prompt 集
 * ⑦ 字段级门禁：另一家套餐没有 `geo.monitor` 功能的店，直接 seed 一份报表，
 *    `GET /reports/:id` 里四个付费字段整体为 `null`，`overview` 仍然完整可见
 *
 * @packageDocumentation
 */

import 'reflect-metadata'
import 'dotenv/config'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Prisma, PrismaClient } from '@prisma/client'
import { ulid } from '@taizan/contracts'
import { PLATFORM_GATEWAY, type PlatformGateway } from '@taizan/nest-billing'
import { seedBase } from '@taizan/prisma-base'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppModule } from '../src/bootstrap/app.module'
import { configureApp } from '../src/bootstrap/configure-app'
import { dateKeyToDbDate, toDateKey } from '../src/modules/geo/aggregate/geo-metrics.rules'
import { findFirstUpsertDelegate } from '../src/seed-delegates'
import { solveCaptcha } from './helpers/solve-captcha'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

const RUN = ulid().slice(-8).toLowerCase()
const OWNER_PASSWORD = 'e2e-password-123'

/**
 * `10.94.*` 段——已用过的段见各文件文件头：`geo.e2e-spec` 10.95.*、
 * `geo-run`/`geo-engine` 10.96.*、`tenant-isolation` 10.97.*、
 * `geo-brand`/`platform` 10.98.*、`plan-order`/`geo-engine` 10.99.*。
 */
const LOGIN_IP = `10.94.${([...RUN].reduce((a, c) => (a + c.charCodeAt(0)) % 200, 13) + 1).toString()}.3`

const BRAND_DOMAIN = `taizan-diag-${RUN}.example.com`

/** mock LLM 的 `prompt-gen` 场景固定回 5 条候选（`geo-run.e2e-spec.ts` 用例⑪已验证）。 */
const MOCK_GENERATED_PROMPT_COUNT = 5

const TERMINAL_DEADLINE_MS = 50_000
const DIAGNOSIS_REPORT_DEADLINE_MS = 20_000

let app: INestApplication
let prisma: PrismaClient
let gateway: PlatformGateway

function http(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0]
}

function loginRequest(url: string) {
  return request(http()).post(url).set('X-Forwarded-For', LOGIN_IP)
}

function expectOk<T>(body: unknown): T {
  const envelope = body as { code: number; message: string; data: T }
  expect(envelope.code, `期望 code=0，实际：${JSON.stringify(envelope)}`).toBe(0)
  return envelope.data
}

function codeOf(body: unknown): number {
  return (body as { code: number }).code
}

function phoneFor(n: number): string {
  const digits = [...RUN]
    .map((c) => c.charCodeAt(0) % 10)
    .join('')
    .slice(0, 7)
  return `139${digits}${n}`
}

interface Shop {
  tenantId: string
  token: string
}

let platformToken = ''
let shopA: Shop
let shopB: Shop
let brandA = ''
let mockEngineId = ''
let diagRunId = ''
let diagReportId = ''

async function createShopAndLogin(index: number): Promise<Shop> {
  const phone = phoneFor(index)
  const created = await request(http())
    .post('/api/platform/tenants')
    .set('Authorization', `Bearer ${platformToken}`)
    .send({
      slug: `e2e-geo-diag-${index}-${RUN}`,
      name: `E2E GEO DIAG ${index} ${RUN}`,
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

/** 建一档套餐（平台域表，直接写库）。`features` 传 `[]` 时是"一个功能都不开"。 */
async function createPlan(
  quotas: Record<string, number | null>,
  features: string[] | null,
): Promise<string> {
  const plan = await prisma.plan.create({
    data: {
      id: ulid(),
      code: `e2e-geo-diag-plan-${ulid().slice(-8).toLowerCase()}`,
      name: 'E2E GEO 诊断套餐',
      firstPriceCents: 0,
      renewPriceCents: 0,
      periodMonths: 1,
      quotas,
      // `Plan.features` 是 Json? 列：Prisma 的 create input 要求显式 `null` 值传
      // `Prisma.JsonNull`，裸 `null` 只在“整列不设置”时才是合法值——这里要的是
      // "显式写一个 JSON null"（=「全部功能开放」，见 plans.ts 文件头的三态说明）。
      features: features === null ? Prisma.JsonNull : features,
      appKeys: ['admin', 'client'],
      trafficMb: 0,
    },
  })
  return plan.id
}

async function mutateTenant(tenantId: string, data: Record<string, unknown>): Promise<void> {
  await prisma.tenant.update({ where: { id: tenantId }, data })
  gateway.invalidate(tenantId)
}

async function seedMockEngine(): Promise<string> {
  const existing = await prisma.geoEngine.findUnique({ where: { code: 'mock' } })
  if (existing) {
    await prisma.geoEngine.update({
      where: { id: existing.id },
      data: {
        enabled: true,
        credentialEnc: null,
        credentialKeyId: null,
        credentialMasked: null,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
  throw new Error(`跑批 ${runId} 在 ${TERMINAL_DEADLINE_MS}ms 内没有进入终态：${JSON.stringify(last)}`)
}

/**
 * 轮询到 `GeoDailyAggregateHandler` 收口诊断报表：`GET /runs/:id` 的
 * `diagnosisReportId` 变成非空。这条链路比"跑批到终态"多绕一圈日聚合，
 * 给的 deadline 比 `waitForTerminal` 宽松一些。
 */
async function waitForDiagnosisReport(shop: Shop, runId: string): Promise<string> {
  const deadline = Date.now() + DIAGNOSIS_REPORT_DEADLINE_MS
  let last: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    const res = await asShop(shop).get(`/api/admin/geo/runs/${runId}`)
    last = expectOk<Record<string, unknown>>(res.body)
    const reportId = last['diagnosisReportId']
    if (typeof reportId === 'string' && reportId !== '') return reportId
    await sleep(400)
  }
  throw new Error(
    `跑批 ${runId} 在 ${DIAGNOSIS_REPORT_DEADLINE_MS}ms 内没有生成诊断报表：${JSON.stringify(last)}。` +
      '先确认 GeoDailyAggregateHandler 是否真的调用了 GeoDiagnosisService.finalizeReport。',
  )
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

describe('① 登录开店', () => {
  it('平台超管登录，开两家店（默认不挂 planId，features=null=全部开放）', async () => {
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

describe('② 零问法品牌发起诊断：自动生成问法 + 自动建跑批', () => {
  it('建一个没有问法的品牌', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/brands', {
      name: `太赞诊断 ${RUN}`,
      domain: BRAND_DOMAIN,
      aliases: ['Taizan'],
      industry: 'SaaS',
      engineCodes: ['mock'],
      sampleSize: 1,
    })
    const brand = expectOk<{ id: string }>(res.body)
    brandA = brand.id
  })

  it('POST /brands/:id/diagnose：自动生成并导入 5 条问法、建跑批并入队', async () => {
    const before = await prisma.geoPrompt.count({
      where: { tenantId: shopA.tenantId, brandId: brandA, deletedAt: null },
    })
    expect(before).toBe(0)

    const res = await asShop(shopA).post(`/api/admin/geo/brands/${brandA}/diagnose`)
    const result = expectOk<{
      runId: string
      brandId: string
      promptsGenerated: number
      plannedQueries: number
      reusedExistingPrompts: boolean
    }>(res.body)

    expect(result.brandId).toBe(brandA)
    expect(result.reusedExistingPrompts).toBe(false)
    expect(result.promptsGenerated).toBe(MOCK_GENERATED_PROMPT_COUNT)
    // 规划出的查询数 = 5 条新问法 × 1 个引擎 × sampleSize(1)。
    expect(result.plannedQueries).toBe(MOCK_GENERATED_PROMPT_COUNT)

    const after = await prisma.geoPrompt.count({
      where: { tenantId: shopA.tenantId, brandId: brandA, deletedAt: null },
    })
    expect(after).toBe(MOCK_GENERATED_PROMPT_COUNT)

    // 落进了一个 source=AI_GEN 的新 Prompt 集，不是随手塞进默认集。
    const promptSet = await prisma.geoPromptSet.findFirst({
      where: { tenantId: shopA.tenantId, brandId: brandA, name: 'AI 诊断生成' },
    })
    expect(promptSet).toBeTruthy()
    expect(promptSet?.source).toBe('AI_GEN')

    // `GeoQueryRun` 被标记成 isDiagnosis，且这个 promptSet 记在了 diagnosisPromptSetId 上。
    const run = await prisma.geoQueryRun.findUnique({ where: { id: result.runId } })
    expect(run?.isDiagnosis).toBe(true)
    expect(run?.diagnosisPromptSetId).toBe(promptSet?.id)
    expect(run?.diagnosisReportId).toBeNull()
    diagRunId = result.runId
  })
})

describe('③④⑤ 跑批收口后自动生成诊断报表', () => {
  it('轮询到跑批终态，isDiagnosis 为 true', async () => {
    expect(diagRunId).not.toBe('')
    const run = await waitForTerminal(shopA, diagRunId)
    expect(['DONE', 'PARTIAL']).toContain(run['status'])
    expect(run['isDiagnosis']).toBe(true)
  })

  it('继续轮询到 diagnosisReportId 非空（日聚合收口后自动生成）', async () => {
    diagReportId = await waitForDiagnosisReport(shopA, diagRunId)
    expect(diagReportId).not.toBe('')
  })

  it('GET /reports/:id：geo.monitor 放行时，免费与付费字段都可见', async () => {
    expect(diagReportId).not.toBe('')

    const res = await asShop(shopA).get(`/api/admin/geo/reports/${diagReportId}`)
    const report = expectOk<{
      period: string
      payload: {
        overview: {
          mentionRateBp: number
          top1RateBp: number
          sentimentAvgX100: number
          answers: number
        }
        competitors: unknown[] | null
        topCitations: unknown[] | null
        promptSuggestions: Array<{ text: string }> | null
        contentSuggestions: Array<{ kind: string; title: string; detail: string }> | null
      }
    }>(res.body)

    expect(report.period).toBe('ONE_SHOT')
    // mock 引擎默认 `mention` 场景：每条回答都在第一位提到品牌，所以提及率与
    // 首位推荐率都应该是满格（10000bp = 100%）。
    expect(report.payload.overview.answers).toBe(MOCK_GENERATED_PROMPT_COUNT)
    expect(report.payload.overview.mentionRateBp).toBe(10000)
    expect(report.payload.overview.top1RateBp).toBe(10000)

    // 付费字段：闸门放行（这家店 features=null=全开），四个都不是 null。
    expect(report.payload.competitors).not.toBeNull()
    expect(report.payload.topCitations).not.toBeNull()
    expect(report.payload.promptSuggestions).not.toBeNull()
    expect(report.payload.contentSuggestions).not.toBeNull()

    // AI 推荐问法列表 = 这次自动生成导入的 5 条。
    expect(report.payload.promptSuggestions).toHaveLength(MOCK_GENERATED_PROMPT_COUNT)

    // 内容优化建议：规则生成，至少一条，且不是空话（带 kind/title/detail 三段）。
    expect(report.payload.contentSuggestions?.length).toBeGreaterThan(0)
    for (const s of report.payload.contentSuggestions ?? []) {
      expect(s.kind).not.toBe('')
      expect(s.title).not.toBe('')
      expect(s.detail).not.toBe('')
    }
  })
})

describe('⑥ 品牌已有问法时再诊断：不重新生成', () => {
  it('reusedExistingPrompts=true，promptsGenerated=0，不新建 Prompt 集', async () => {
    const setsBefore = await prisma.geoPromptSet.count({
      where: { tenantId: shopA.tenantId, brandId: brandA },
    })

    const res = await asShop(shopA).post(`/api/admin/geo/brands/${brandA}/diagnose`)
    const result = expectOk<{
      runId: string
      promptsGenerated: number
      reusedExistingPrompts: boolean
    }>(res.body)

    expect(result.reusedExistingPrompts).toBe(true)
    expect(result.promptsGenerated).toBe(0)

    const setsAfter = await prisma.geoPromptSet.count({
      where: { tenantId: shopA.tenantId, brandId: brandA },
    })
    expect(setsAfter).toBe(setsBefore)

    const run = await prisma.geoQueryRun.findUnique({ where: { id: result.runId } })
    expect(run?.isDiagnosis).toBe(true)
    expect(run?.diagnosisPromptSetId).toBeNull()
  })
})

describe('⑦ 字段级门禁：geo.monitor 未放行时付费字段整体为 null', () => {
  let gatedReportId = ''
  let gatedBrandId = ''

  it('把 B 店切到一档没有 geo.monitor 的套餐', async () => {
    const planId = await createPlan({}, [])
    await mutateTenant(shopB.tenantId, {
      planId,
      status: 'ACTIVE',
      planExpireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      trialEndAt: null,
    })
    const allowed = await gateway.hasFeature(shopB.tenantId, 'geo.monitor')
    expect(allowed).toBe(false)
  })

  it('直接 seed 一份该店的报表（绕开编排，只测字段门禁本身）', async () => {
    const brandRes = await prisma.geoBrand.create({
      data: {
        id: ulid(),
        tenantId: shopB.tenantId,
        name: `门禁测试品牌 ${RUN}`,
        aliases: [],
        engineCodes: ['mock'],
      },
    })
    gatedBrandId = brandRes.id

    const dateKey = toDateKey(new Date())
    const payload = {
      version: 1,
      brandId: gatedBrandId,
      brandName: brandRes.name,
      period: 'ONE_SHOT',
      periodStart: dateKey,
      periodEnd: dateKey,
      generatedAt: new Date().toISOString(),
      overview: { answers: 5, mentions: 4, mentionRateBp: 8000, sovBp: 10000, avgPositionX100: 100, citationRateBp: 8000, sentimentAvgX100: 30, top1RateBp: 8000 },
      previous: { answers: 0, mentions: 0, mentionRateBp: 0, sovBp: null, avgPositionX100: 0, citationRateBp: 0, sentimentAvgX100: 0, top1RateBp: 0 },
      trend: [],
      engines: [],
      competitors: [{ competitorId: '', name: brandRes.name, isBrand: true, mentions: 4, mentionRateBp: 8000, sovBp: 10000, avgPositionX100: 100 }],
      topCitations: [{ domain: 'example.com', count: 3, category: 'OTHER', platform: '' }],
      promptSuggestions: [{ text: '示例问法', topic: null, funnelStage: 'UNKNOWN' }],
      contentSuggestions: [{ kind: 'HEALTHY', title: '核心指标表现健康', detail: '继续观察' }],
    }

    const report = await prisma.geoReport.create({
      data: {
        id: ulid(),
        tenantId: shopB.tenantId,
        brandId: gatedBrandId,
        period: 'ONE_SHOT',
        periodStart: dateKeyToDbDate(dateKey),
        periodEnd: dateKeyToDbDate(dateKey),
        payload,
        status: 'READY',
      },
    })
    gatedReportId = report.id
  })

  it('GET /reports/:id：付费字段整体为 null，overview 仍然完整可见', async () => {
    const res = await asShop(shopB).get(`/api/admin/geo/reports/${gatedReportId}`)
    const report = expectOk<{
      payload: {
        overview: { mentionRateBp: number; top1RateBp: number; sentimentAvgX100: number }
        competitors: unknown
        topCitations: unknown
        promptSuggestions: unknown
        contentSuggestions: unknown
      }
    }>(res.body)

    // 免费摘要：核心数字原样可见，不受闸门影响。
    expect(report.payload.overview.mentionRateBp).toBe(8000)
    expect(report.payload.overview.top1RateBp).toBe(8000)
    expect(report.payload.overview.sentimentAvgX100).toBe(30)

    // 付费字段：整体置 null（不是被删掉这个 key，前端能区分"要升级"与"没有数据"）。
    expect(report.payload).toHaveProperty('competitors')
    expect(report.payload.competitors).toBeNull()
    expect(report.payload.topCitations).toBeNull()
    expect(report.payload.promptSuggestions).toBeNull()
    expect(report.payload.contentSuggestions).toBeNull()
  })

  it('善后：把 B 店放开到 geo.monitor 全开，确认闸门放行后字段恢复可见（往返一致）', async () => {
    const planId = await createPlan({}, null)
    await mutateTenant(shopB.tenantId, { planId })
    const allowed = await gateway.hasFeature(shopB.tenantId, 'geo.monitor')
    expect(allowed).toBe(true)

    const res = await asShop(shopB).get(`/api/admin/geo/reports/${gatedReportId}`)
    const report = expectOk<{ payload: { competitors: unknown } }>(res.body)
    expect(report.payload.competitors).not.toBeNull()
  })
})

describe('⑧ 跨租户：品牌不存在/不属于自己时诊断接口报 1240300', () => {
  it('B 店对 A 店的品牌发起诊断 → 1240300，不建任何跑批', async () => {
    const before = await prisma.geoQueryRun.count({ where: { tenantId: shopB.tenantId } })
    const res = await asShop(shopB).post(`/api/admin/geo/brands/${brandA}/diagnose`)
    expect(codeOf(res.body)).toBe(1240300)
    const after = await prisma.geoQueryRun.count({ where: { tenantId: shopB.tenantId } })
    expect(after).toBe(before)
  })
})
