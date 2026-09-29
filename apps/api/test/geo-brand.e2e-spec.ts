/**
 * **GEO 品牌 / Prompt 的 e2e**（T4 的收口证明），跑在真 MySQL(3307) + Redis 上。
 *
 * ```
 * pnpm dev:infra
 * pnpm -F @taizan/api prisma:migrate
 * pnpm -F @taizan/api test:e2e
 * ```
 *
 * ## 为什么必须连真库
 *
 * 这份 e2e 断言的六件事里，有四件只发生在 SQL 层或框架的扩展链上：
 * 租户条件怎么 `AND` 进去、软删改写成了什么、唯一索引带 `deletedAt` 之后同名能不能
 * 再建、`QuotaCounter` 的加减是不是真的落了库。用替身客户端全都测不出来——
 * 替身怎么写，断言就怎么过。
 *
 * ## 用例清单
 *
 * ① 平台登录 → 建两家店 → 店主登录
 * ② 建品牌（域名/别名被归一化）
 * ③ 建竞品、改竞品、列竞品
 * ④ 建 PromptSet 与 Prompt；不传 promptSetId 时自动归入「默认」集
 * ⑤ `POST /import` 去重：输入内部重复 + 与库里已有重复，都算 skipped
 * ⑥ 软删品牌：列表不见、`GET /:id` → 1240300，同名可以再建（唯一索引带 deletedAt）
 * ⑦ 跨租户：B 店看不到 A 店的品牌（列表空、`GET /:id` → 1240300）
 * ⑧ 套餐 `GEO_BRAND: 1` 时建第二个品牌 → 1540301，且被拦下时库里没有半条数据
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
 * 后面的文件会拿到 `1042900` 而不是它想断言的东西，失败信息看起来像「登录逻辑坏了」。
 *
 * 用 `10.98.*` 段（`tenant-isolation` 是 `10.97.*`、`plan-order` 另有一段），
 * 保证与其它 e2e 文件不撞桶。这不是绕过限流：限流本身由 `test/ratelimit.e2e-spec.ts`
 * 专门验证。
 */
const LOGIN_IP = `10.98.${([...RUN].reduce((a, c) => (a + c.charCodeAt(0)) % 200, 11) + 1).toString()}.7`

/** 本文件所有登录请求的统一起手式：一定带上 {@link LOGIN_IP}。 */
function loginRequest(url: string) {
  return request(http()).post(url).set('X-Forwarded-For', LOGIN_IP)
}

/** 造一个本次运行专用的手机号（全局唯一键，不能和 seed 的演示账号撞）。 */
function phoneFor(n: number): string {
  const digits = [...RUN]
    .map((c) => c.charCodeAt(0) % 10)
    .join('')
    .slice(0, 7)
  return `138${digits}${n}`
}

let app: INestApplication
let prisma: PrismaClient
let gateway: PlatformGateway

/** supertest 的目标（`getHttpServer()` 回的是 `any`，这里收窄成 supertest 认的形状）。 */
function http(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0]
}

/** 成功响应的信封形状；`code` 不为 0 时直接把整个 body 打出来，省得反复加日志。 */
function expectOk<T>(body: unknown): T {
  const envelope = body as { code: number; message: string; data: T }
  expect(envelope.code, `期望 code=0，实际：${JSON.stringify(envelope)}`).toBe(0)
  return envelope.data
}

/** 取业务码。 */
function codeOf(body: unknown): number {
  return (body as { code: number }).code
}

interface Shop {
  tenantId: string
  slug: string
  token: string
}

let platformToken = ''
let shopA: Shop
let shopB: Shop

/** A 店那个贯穿全文件的品牌 id。 */
let brandA = ''
/** A 店那个「默认」Prompt 集 id（由 ④ 自动创建出来）。 */
let defaultSetId = ''

/** 用平台 token 开一家店，然后用店主账号登录，返回 staff token。 */
async function createShopAndLogin(index: number): Promise<Shop> {
  const slug = `e2e-geo-${index}-${RUN}`
  const phone = phoneFor(index)
  const created = await request(http())
    .post('/api/platform/tenants')
    .set('Authorization', `Bearer ${platformToken}`)
    .send({
      slug,
      name: `E2E GEO ${index} ${RUN}`,
      ownerPhone: phone,
      ownerPassword: OWNER_PASSWORD,
      trialDays: 30,
    })
  const data = expectOk<{ tenant: { id: string; slug: string } }>(created.body)

  const login = await loginRequest('/api/admin/auth/login').send({
    phone,
    password: OWNER_PASSWORD,
    tenantId: data.tenant.id,
    ...(await solveCaptcha(app)),
  })
  const session = expectOk<{ access: string }>(login.body)

  return { tenantId: data.tenant.id, slug: data.tenant.slug, token: session.access }
}

/** 带着某家店的 token 发请求。 */
function asShop(shop: Shop) {
  const token = `Bearer ${shop.token}`
  return {
    get: (url: string, query?: Record<string, unknown>) =>
      request(http()).get(url).query(query ?? {}).set('Authorization', token),
    post: (url: string, body?: unknown) =>
      request(http()).post(url).set('Authorization', token).send(body ?? {}),
    put: (url: string, body?: unknown) =>
      request(http()).put(url).set('Authorization', token).send(body ?? {}),
    del: (url: string) => request(http()).delete(url).set('Authorization', token),
  }
}

/**
 * 建一档套餐（平台域表，直接写库——平台后台的套餐管理接口是另一条工作流）。
 *
 * `features: null` = 全部可用：用例⑧只想卡配额，不传 null 的话先撞上的会是 1540302，
 * 那样测的就不是配额了。
 */
async function createPlan(quotas: Record<string, number | null>): Promise<string> {
  const plan = await prisma.plan.create({
    data: {
      id: ulid(),
      code: `e2e-geo-plan-${ulid().slice(-8).toLowerCase()}`,
      name: 'E2E GEO 套餐',
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

/**
 * 改一家店的闸门相关字段，然后**必须** `invalidate`。
 *
 * 不 invalidate 的话闸门视图还在 30 秒缓存里，改了跟没改一样——这条不只是测试的技巧，
 * 线上「续费后要不要等 30 秒才解锁」是同一件事。
 */
async function mutateTenant(tenantId: string, data: Record<string, unknown>): Promise<void> {
  await prisma.tenant.update({ where: { id: tenantId }, data })
  gateway.invalidate(tenantId)
}

/**
 * 保证 `mock` / `qwen` 两个引擎在库里且**已启用**（T5 起的前置条件）。
 *
 * T5 之前 `engineCodes` 只做归一化、不校验存在性，这份 e2e 里随手写 `['mock','qwen']`
 * 就能过。T5 给 `geo-brand.service.ts` 加了 `assertEngineCodes()`——填了一个没启用的
 * 引擎会被判 1040000（现象是"跑批时这个引擎被静默跳过"，而商家以为自己在监测它）。
 * 于是这份 e2e 必须先把它们摆进去。
 *
 * 直接写库而不是调 `/api/platform/geo/engines`：那条链路由
 * `geo-engine.e2e-spec.ts` 专门验证，这里只需要一个前置状态。
 * `GeoEngine` 是平台域表（没有 tenantId 列），原始 client 直接写。
 */
async function seedEngines(): Promise<void> {
  for (const engine of [
    { code: 'mock', name: 'Mock（联调用）', vendor: 'taizan', model: 'mock-engine-v1' },
    { code: 'qwen', name: '通义千问', vendor: 'aliyun', model: 'qwen-plus' },
  ]) {
    const existing = await prisma.geoEngine.findUnique({
      where: { code: engine.code },
      select: { id: true },
    })
    if (existing) {
      await prisma.geoEngine.update({ where: { id: existing.id }, data: { enabled: true } })
    } else {
      await prisma.geoEngine.create({
        data: { id: ulid(), ...engine, accessType: 'API', enabled: true, config: {} },
      })
    }
  }
}

beforeAll(async () => {
  prisma = new PrismaClient()

  // 保证平台管理员与套餐存在。`withDemoTenant: false`：本文件自己建两家店，
  // 不依赖也不污染 `pnpm seed` 造的 demo / demo-b。seedBase 是幂等的，重复跑没事。
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

  await seedEngines()

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  // 与 `main.ts` 调的是同一段配置——否则这套 e2e 测的是另一个 app。
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
  })
})

describe('② 建品牌', () => {
  it('POST /api/admin/geo/brands 建成，且域名/别名被规则函数归一化了', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/brands', {
      name: `  太赞   ${RUN}  `,
      // 整条地址粘进来：协议、www、路径、末尾斜杠都该被削掉
      domain: 'https://www.example.org/pricing?from=ad',
      // 大小写不同的同一个别名 + 一个空串：去重、去空
      aliases: ['Taizan', 'taizan', '  ', '太赞科技'],
      industry: 'SaaS',
      engineCodes: ['Mock', 'mock', 'qwen'],
    })
    const brand = expectOk<{
      id: string
      name: string
      domain: string | null
      aliases: string[]
      locale: string | null
      status: string
      refreshFreq: string
      sampleSize: number
      engineCodes: string[]
    }>(res.body)

    brandA = brand.id
    // 名字：去首尾空白 + 连续空白压成一个
    expect(brand.name).toBe(`太赞 ${RUN}`)
    expect(brand.domain).toBe('example.org')
    expect(brand.aliases).toEqual(['Taizan', '太赞科技'])
    expect(brand.engineCodes).toEqual(['mock', 'qwen'])
    // 默认值只有一处真源（service 里的那几个 `??`），这里把它们钉住
    expect(brand.locale).toBe('zh-CN')
    expect(brand.status).toBe('ACTIVE')
    expect(brand.refreshFreq).toBe('WEEKLY')
    expect(brand.sampleSize).toBe(3)
  })

  it('同名再建被应用层拦下（唯一索引带 deletedAt，管不住活跃行）', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/brands', { name: `太赞 ${RUN}` })
    expect(codeOf(res.body)).toBe(1040000)
  })

  it('采样次数越界被规则函数拦下（DTO 与 rules 两层都在）', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/brands', {
      name: `越界 ${RUN}`,
      sampleSize: 99,
    })
    expect(codeOf(res.body)).toBe(1040000)
  })

  it('列表能搜到它（keyword 命中名称或域名）', async () => {
    const res = await asShop(shopA).get('/api/admin/geo/brands', { keyword: 'example.org' })
    const page = expectOk<{ items: { id: string }[]; total: number }>(res.body)
    expect(page.items.map((r) => r.id)).toContain(brandA)
  })
})

describe('③ 竞品', () => {
  let competitorId = ''

  it('POST /:id/competitors 建成', async () => {
    const res = await asShop(shopA).post(`/api/admin/geo/brands/${brandA}/competitors`, {
      name: `某某科技 ${RUN}`,
      domain: 'HTTP://WWW.Example.COM/about',
      aliases: ['Example', 'example'],
    })
    const row = expectOk<{ id: string; domain: string | null; aliases: string[] }>(res.body)
    competitorId = row.id
    expect(row.domain).toBe('example.com')
    expect(row.aliases).toEqual(['Example'])
  })

  it('PUT /:id/competitors/:cid 改得动', async () => {
    const res = await asShop(shopA).put(
      `/api/admin/geo/brands/${brandA}/competitors/${competitorId}`,
      { name: `某某科技（改名）${RUN}` },
    )
    expect(expectOk<{ name: string }>(res.body).name).toBe(`某某科技（改名）${RUN}`)
  })

  it('GET /:id/competitors 列得出来', async () => {
    const res = await asShop(shopA).get(`/api/admin/geo/brands/${brandA}/competitors`)
    const rows = expectOk<{ id: string }[]>(res.body)
    expect(rows.map((r) => r.id)).toEqual([competitorId])
  })

  it('拿别家的 brandId 建竞品 → 1240300（不区分「不存在」与「是别人的」）', async () => {
    const res = await asShop(shopB).post(`/api/admin/geo/brands/${brandA}/competitors`, {
      name: '想蹭别人品牌的竞品',
    })
    expect(codeOf(res.body)).toBe(1240300)
  })

  it('DELETE /:id/competitors/:cid 软删掉', async () => {
    const del = await asShop(shopA).del(
      `/api/admin/geo/brands/${brandA}/competitors/${competitorId}`,
    )
    expect(expectOk<{ id: string }>(del.body).id).toBe(competitorId)

    const list = await asShop(shopA).get(`/api/admin/geo/brands/${brandA}/competitors`)
    expect(expectOk<unknown[]>(list.body)).toHaveLength(0)

    // 软删是 update，库里那行还在（`@Audit` 的追溯、回收站、对账都要它）。
    const row = await prisma.geoCompetitor.findUnique({ where: { id: competitorId } })
    expect(row?.deletedAt).not.toBeNull()
  })
})

describe('④ PromptSet 与 Prompt', () => {
  let namedSetId = ''
  let promptId = ''

  it('POST /prompts/sets 建一个具名集', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/prompts/sets', {
      brandId: brandA,
      name: `核心问法 ${RUN}`,
    })
    const set = expectOk<{ id: string; name: string; source: string }>(res.body)
    namedSetId = set.id
    expect(set.source).toBe('MANUAL')
  })

  it('POST /prompts 不传 promptSetId → 自动归入品牌下名为「默认」的集', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/prompts', {
      brandId: brandA,
      text: `  太赞  好用吗 ${RUN}  `,
      funnelStage: 'bofu',
    })
    const prompt = expectOk<{
      id: string
      promptSetId: string
      text: string
      funnelStage: string
      isTracked: boolean
    }>(res.body)
    promptId = prompt.id
    defaultSetId = prompt.promptSetId
    expect(prompt.text).toBe(`太赞  好用吗 ${RUN}`)
    // `normalizeFunnelStage` 大小写不敏感
    expect(prompt.funnelStage).toBe('BOFU')
    expect(prompt.isTracked).toBe(true)

    const sets = await asShop(shopA).get('/api/admin/geo/prompts/sets', { brandId: brandA })
    const names = expectOk<{ id: string; name: string }[]>(sets.body)
    expect(names.find((s) => s.id === defaultSetId)?.name).toBe('默认')
    expect(defaultSetId).not.toBe(namedSetId)
  })

  it('只差空白/大小写的同一条问法被去重口径拦下', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/prompts', {
      brandId: brandA,
      text: `太赞 好用吗 ${RUN}`.toUpperCase(),
    })
    expect(codeOf(res.body)).toBe(1040000)
  })

  it('列表按 brandId 查得到，并且 isTracked=false 筛不到它', async () => {
    const all = await asShop(shopA).get('/api/admin/geo/prompts', { brandId: brandA })
    expect(expectOk<{ items: { id: string }[] }>(all.body).items.map((r) => r.id)).toContain(
      promptId,
    )

    const untracked = await asShop(shopA).get('/api/admin/geo/prompts', {
      brandId: brandA,
      isTracked: 'false',
    })
    expect(expectOk<{ items: { id: string }[] }>(untracked.body).items).toHaveLength(0)
  })

  it('PUT /prompts/:id 改得动（改挂到具名集 + 停用追踪）', async () => {
    const res = await asShop(shopA).put(`/api/admin/geo/prompts/${promptId}`, {
      promptSetId: namedSetId,
      isTracked: false,
      priority: 50,
    })
    const row = expectOk<{ promptSetId: string; isTracked: boolean; priority: number }>(res.body)
    expect(row.promptSetId).toBe(namedSetId)
    expect(row.isTracked).toBe(false)
    expect(row.priority).toBe(50)
  })

  it('里面还有问法的 Prompt 集删不掉（不做级联软删）', async () => {
    const res = await asShop(shopA).del(`/api/admin/geo/prompts/sets/${namedSetId}`)
    expect(codeOf(res.body)).toBe(1040000)
  })

  it('DELETE /prompts/:id 软删掉之后，同一条正文可以再建回来', async () => {
    const del = await asShop(shopA).del(`/api/admin/geo/prompts/${promptId}`)
    expect(expectOk<{ id: string }>(del.body).id).toBe(promptId)

    const again = await asShop(shopA).post('/api/admin/geo/prompts', {
      brandId: brandA,
      text: `太赞 好用吗 ${RUN}`,
    })
    expect(codeOf(again.body)).toBe(0)
  })
})

describe('⑤ 批量导入去重', () => {
  it('POST /prompts/import：输入内部重复 + 与库里已有重复，都算 skipped', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/prompts/import', {
      brandId: brandA,
      promptSetId: defaultSetId,
      texts: [
        `导入一 ${RUN}`,
        `导入二 ${RUN}`,
        // 与上一行只差空白与大小写 → 输入内部重复
        `  导入二   ${RUN}  `,
        // ④ 里已经建过的那一条 → 与库里已有重复
        `太赞 好用吗 ${RUN}`,
        // 空行不计进 skipped（否则「跳过 3 条」里会混进空行）
        '',
        '   ',
      ],
    })
    const result = expectOk<{ created: number; skipped: number; promptSetId: string }>(res.body)
    expect(result.created).toBe(2)
    expect(result.skipped).toBe(2)
    expect(result.promptSetId).toBe(defaultSetId)
  })

  it('再导一遍同样的内容：一条都不建（created=0）', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/prompts/import', {
      brandId: brandA,
      texts: [`导入一 ${RUN}`, `导入二 ${RUN}`],
    })
    const result = expectOk<{ created: number; skipped: number }>(res.body)
    expect(result.created).toBe(0)
    expect(result.skipped).toBe(2)
  })

  it('拿别家的 brandId 导入 → 1240300', async () => {
    const res = await asShop(shopB).post('/api/admin/geo/prompts/import', {
      brandId: brandA,
      texts: ['蹭别人品牌的问法'],
    })
    expect(codeOf(res.body)).toBe(1240300)
  })
})

describe('⑥ 跨租户：B 店看不到 A 店的品牌', () => {
  it('B 店的列表里没有 A 店的品牌', async () => {
    const res = await asShop(shopB).get('/api/admin/geo/brands')
    const page = expectOk<{ items: { id: string }[]; total: number }>(res.body)
    expect(page.items.map((r) => r.id)).not.toContain(brandA)
    expect(page.total).toBe(0)
  })

  it('B 店拿 A 店的 id 直接读 → 1240300（与「不存在」同一个码，不做存在性探测器）', async () => {
    const res = await asShop(shopB).get(`/api/admin/geo/brands/${brandA}`)
    expect(codeOf(res.body)).toBe(1240300)
  })

  it('B 店拿 A 店的 id 改 / 删，同样 1240300', async () => {
    const put = await asShop(shopB).put(`/api/admin/geo/brands/${brandA}`, { name: '抢过来' })
    expect(codeOf(put.body)).toBe(1240300)
    const del = await asShop(shopB).del(`/api/admin/geo/brands/${brandA}`)
    expect(codeOf(del.body)).toBe(1240300)
  })

  it('B 店按 A 店的 brandId 查问法 → 1240300（不是一张空表）', async () => {
    const res = await asShop(shopB).get('/api/admin/geo/prompts', { brandId: brandA })
    expect(codeOf(res.body)).toBe(1240300)
  })
})

describe('⑦ 软删品牌', () => {
  it('DELETE 之后列表不见、GET /:id → 1240300，但库里那行还在', async () => {
    const del = await asShop(shopA).del(`/api/admin/geo/brands/${brandA}`)
    expect(expectOk<{ id: string }>(del.body).id).toBe(brandA)

    const list = await asShop(shopA).get('/api/admin/geo/brands', { keyword: 'example.org' })
    expect(expectOk<{ items: { id: string }[] }>(list.body).items.map((r) => r.id)).not.toContain(
      brandA,
    )

    const get = await asShop(shopA).get(`/api/admin/geo/brands/${brandA}`)
    expect(codeOf(get.body)).toBe(1240300)

    const row = await prisma.geoBrand.findUnique({ where: { id: brandA } })
    expect(row?.deletedAt).not.toBeNull()
  })

  it('软删之后可以再建一条同名品牌（唯一索引带 deletedAt 的活体验收）', async () => {
    const res = await asShop(shopA).post('/api/admin/geo/brands', { name: `太赞 ${RUN}` })
    expect(codeOf(res.body)).toBe(0)
    // 建回来之后立刻删掉，给用例⑧一个干净的起点（配额计数要从 0 开始算）。
    const rebuilt = expectOk<{ id: string }>(res.body).id
    await asShop(shopA).del(`/api/admin/geo/brands/${rebuilt}`)
  })
})

describe('⑧ 配额：套餐 GEO_BRAND = 1', () => {
  let shop: Shop

  beforeAll(async () => {
    shop = await createShopAndLogin(3)
    // `features` 不传 → 全部可用：只把配额卡死，否则先撞上的会是 1540302，
    // 那样这条用例测的就不是配额了。
    const planId = await createPlan({ GEO_BRAND: 1 })
    await mutateTenant(shop.tenantId, {
      planId,
      status: 'ACTIVE',
      planExpireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      trialEndAt: null,
    })
  })

  it('第一个建得成', async () => {
    const res = await asShop(shop).post('/api/admin/geo/brands', { name: `配额店 甲 ${RUN}` })
    expect(codeOf(res.body)).toBe(0)
  })

  it('第二个 → 1540301（配额超限，与「功能未包含」的 1540302 是两个码）', async () => {
    const res = await asShop(shop).post('/api/admin/geo/brands', { name: `配额店 乙 ${RUN}` })
    expect(codeOf(res.body)).toBe(1540301)
  })

  it('被拦下之后库里没有多出半条（先占配额再写库，占不到就不写）', async () => {
    const count = await prisma.geoBrand.count({
      where: { tenantId: shop.tenantId, deletedAt: null },
    })
    expect(count).toBe(1)
  })

  it('软删之后配额被释放，又能再建一个（删了 1 个再建 1 个不该超限）', async () => {
    const list = await asShop(shop).get('/api/admin/geo/brands')
    const first = expectOk<{ items: { id: string }[] }>(list.body).items[0]
    expect(first).toBeDefined()

    await asShop(shop).del(`/api/admin/geo/brands/${first?.id ?? ''}`)

    const again = await asShop(shop).post('/api/admin/geo/brands', { name: `配额店 丙 ${RUN}` })
    expect(codeOf(again.body)).toBe(0)
  })
})
