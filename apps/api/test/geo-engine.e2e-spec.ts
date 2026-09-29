/**
 * **GEO 引擎（平台域）的 e2e**（T5 的收口证明），跑在真 MySQL(3307) + Redis 上。
 *
 * ```
 * pnpm dev:infra
 * pnpm -F @taizan/api prisma:migrate
 * pnpm -F @taizan/api test:e2e
 * ```
 *
 * ## 为什么必须连真库
 *
 * 这份 e2e 断言的六件事里，有三件只发生在**加解密 + SQL 层**：密文真的落进了
 * `credentialEnc`、`credentialKeyId` 与它成对、接口回来的那一包只有脱敏值。
 * 用替身客户端全都测不出来——替身怎么写，断言就怎么过。
 *
 * 另外三件跨了两个身份域（平台 token 改配置 → 商家 token 读清单），
 * 那条链路本身就是"平台改了什么、商家看得到什么"，只有整条起起来才成立。
 *
 * ## 用例清单
 *
 * ① 平台登录 → 建一个 mock 引擎（默认停用）
 * ② `PUT /:id/credentials` 写密钥：响应里只有 masked，库里 `credentialEnc` 是密文且与
 *    `credentialKeyId` 成对；**整份响应的 JSON 里搜不到明文**
 * ③ 启用 → `POST /:id/test` 真的问通一次（mock 适配器，确定性输出）；
 *    code 与适配器对不上时回一条**可读的 400**，而不是 9050000
 * ④ 商家侧 `GET /api/admin/geo/engines` 能看到它，且四个字段一个不多
 * ⑤ 停用之后商家侧就看不到它了
 * ⑥ 品牌表单选一个未启用的引擎 → 1040000 校验错误
 *
 * @packageDocumentation
 */

import 'reflect-metadata'
import 'dotenv/config'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { ulid } from '@taizan/contracts'
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

/** 每次跑用一段唯一后缀，重复跑也不打架。 */
const RUN = ulid().slice(-8).toLowerCase()

const OWNER_PASSWORD = 'e2e-password-123'

/**
 * 本文件的登录请求专用的「客户端 IP」。
 *
 * `login` 档限流按**客户端 IP** 计（5 分钟 10 次），而 e2e 每个文件都从 `127.0.0.1`
 * 打过来、又串行跑（`fileParallelism: false`），几个文件共用同一个桶。不分桶的话，
 * 后面的文件会拿到 `1042900` 而不是它想断言的东西。
 *
 * 用 `10.96.*` 段——`tenant-isolation` 是 `10.97.*`、`geo-brand` 与 `plan-order` 在
 * `10.98.*`、还有一个文件在 `10.99.*`，这一段没人用。这不是绕过限流：
 * 限流本身由 `test/ratelimit.e2e-spec.ts` 专门验证。
 */
const LOGIN_IP = `10.96.${([...RUN].reduce((a, c) => (a + c.charCodeAt(0)) % 200, 5) + 1).toString()}.9`

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
  return `137${digits}${n}`
}

let app: INestApplication
let prisma: PrismaClient

function http(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0]
}

/** 成功响应的信封形状；`code` 不为 0 时直接把整个 body 打出来。 */
function expectOk<T>(body: unknown): T {
  const envelope = body as { code: number; message: string; data: T }
  expect(envelope.code, `期望 code=0，实际：${JSON.stringify(envelope)}`).toBe(0)
  return envelope.data
}

/** 取业务码。 */
function codeOf(body: unknown): number {
  return (body as { code: number }).code
}

/** 本次运行专用的引擎 code——与 seed 的 `mock` 分开，免得互相干扰。 */
const ENGINE_CODE = `mock-e2e-${RUN}`

/**
 * 这一次真的写进去的密钥明文。
 *
 * 值故意写得长、且带一段一眼认得出的中缀（`super-secret`）：用例②要断言
 * **整份响应的 JSON 里搜不到它**，而短值在脱敏之后会整串变成星号，那样搜不到
 * 是理所当然的，证明不了任何事。
 */
const SECRET_VALUE = 'sk-super-secret-e2e-value-0001'

/** mock 适配器认的场景名。放在凭据包里，测试接口会按它编一段确定性的回答。 */
const SCENARIO = 'mention'

/**
 * `POST /:id/test` 必须打在一个**代码里真的有适配器**的 code 上。
 *
 * `EngineRegistry` 登记的是固定的那几个 code（qwen/ernie/…/mock），而上面那个
 * `mock-e2e-<RUN>` 是为了「建一条属于本次运行的行」现编的——registry 里没有它。
 * 于是诊断接口在这两个 code 上测的是两件不同的事：
 *
 * - `mock`（本常量）：**通不通**；
 * - `mock-e2e-<RUN>`：code 对不上适配器时，回的是**一条可读的 400**，
 *   而不是 9050000「系统内部错误」。
 */
const REAL_MOCK_CODE = 'mock'

let platformToken = ''
let staffToken = ''
let tenantId = ''
let engineId = ''
/** `REAL_MOCK_CODE` 那一行的 id（`ensureRealMockEngine()` 填）。 */
let mockEngineId = ''

/** 带平台 token 发请求。 */
function asPlatform() {
  const token = `Bearer ${platformToken}`
  return {
    get: (url: string, query?: Record<string, unknown>) =>
      request(http())
        .get(url)
        .query(query ?? {})
        .set('Authorization', token),
    post: (url: string, body?: unknown) =>
      request(http()).post(url).set('Authorization', token).send(body ?? {}),
    patch: (url: string, body?: unknown) =>
      request(http()).patch(url).set('Authorization', token).send(body ?? {}),
    put: (url: string, body?: unknown) =>
      request(http()).put(url).set('Authorization', token).send(body ?? {}),
  }
}

/** 带商家 token 发请求。 */
function asShop() {
  const token = `Bearer ${staffToken}`
  return {
    get: (url: string, query?: Record<string, unknown>) =>
      request(http())
        .get(url)
        .query(query ?? {})
        .set('Authorization', token),
    post: (url: string, body?: unknown) =>
      request(http()).post(url).set('Authorization', token).send(body ?? {}),
  }
}

/**
 * 保证 `mock` 引擎在库里且已启用。
 *
 * 直接写库而不是走接口：这只是一个**前置状态**，接口那条链路由本文件的用例
 * ②③⑤ 负责验证。`GeoEngine` 是平台域表（没有 tenantId 列），原始 client 直接写。
 *
 * **不配凭据**：mock 适配器的凭据全部有默认值（`scenario` 默认 `mention`），
 * 而 `decryptCredentials()` 对没配凭据的行回空对象、不抛。少配一份密钥，
 * 这条用例就少一个可能出错的地方。
 */
async function ensureRealMockEngine(): Promise<void> {
  const existing = await prisma.geoEngine.findUnique({
    where: { code: REAL_MOCK_CODE },
    select: { id: true },
  })
  if (existing) {
    await prisma.geoEngine.update({ where: { id: existing.id }, data: { enabled: true } })
    mockEngineId = existing.id
    return
  }
  const created = await prisma.geoEngine.create({
    data: {
      id: ulid(),
      code: REAL_MOCK_CODE,
      name: 'Mock（联调用）',
      vendor: 'taizan',
      accessType: 'API',
      enabled: true,
      model: 'mock-engine-v1',
      rateLimitPerMin: 600,
      timeoutMs: 5000,
      config: {},
    },
  })
  mockEngineId = created.id
}

beforeAll(async () => {
  prisma = new PrismaClient()

  // 保证平台管理员与套餐存在。`withDemoTenant: false`：本文件自己建店，
  // 不依赖也不污染 `pnpm seed` 造的 demo。seedBase 是幂等的。
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

  await ensureRealMockEngine()

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  configureApp(app)
  await app.init()
})

afterAll(async () => {
  // 本次运行造出来的那一行引擎。平台域表没有软删，直接物理删——
  // 留着的话下一次跑 `GET /api/admin/geo/engines` 的断言会被历史数据干扰。
  if (engineId !== '') {
    await prisma.geoEngine.deleteMany({ where: { code: ENGINE_CODE } }).catch(() => undefined)
  }
  await app?.close()
  await prisma?.$disconnect()
})

// ─────────────────────────────────────────────────────────────────────────────
// 用例
// ─────────────────────────────────────────────────────────────────────────────

describe('① 平台登录 + 开一家店', () => {
  it('平台超管登录', async () => {
    const res = await loginRequest('/api/platform/auth/login')
      .send({ username: 'admin', password: 'admin123', ...(await solveCaptcha(app)) })
      .expect(201)
    platformToken = expectOk<{ access: string }>(res.body).access
    expect(platformToken).not.toBe('')
  })

  it('开一家店并用店主登录（用例④⑤⑥要商家 token）', async () => {
    const phone = phoneFor(1)
    const created = await request(http())
      .post('/api/platform/tenants')
      .set('Authorization', `Bearer ${platformToken}`)
      .send({
        slug: `e2e-eng-${RUN}`,
        name: `E2E 引擎 ${RUN}`,
        ownerPhone: phone,
        ownerPassword: OWNER_PASSWORD,
        trialDays: 30,
      })
    const data = expectOk<{ tenant: { id: string } }>(created.body)
    tenantId = data.tenant.id

    const login = await loginRequest('/api/admin/auth/login').send({
      phone,
      password: OWNER_PASSWORD,
      tenantId,
      ...(await solveCaptcha(app)),
    })
    staffToken = expectOk<{ access: string }>(login.body).access
    expect(staffToken).not.toBe('')
  })
})

describe('② 建引擎', () => {
  it('POST /api/platform/geo/engines —— 默认停用、没有凭据', async () => {
    const res = await asPlatform().post('/api/platform/geo/engines', {
      code: ENGINE_CODE,
      name: `E2E Mock ${RUN}`,
      vendor: 'taizan',
      model: 'mock-engine-v1',
      rateLimitPerMin: 600,
      timeoutMs: 5000,
    })
    const engine = expectOk<{
      id: string
      code: string
      enabled: boolean
      hasCredentials: boolean
      credentialMasked: Record<string, string>
      accessType: string
      rateLimitPerMin: number
    }>(res.body)

    engineId = engine.id
    expect(engine.code).toBe(ENGINE_CODE)
    // 默认停用：没填密钥就启用的话，它会立刻进入下一次跑批然后每条都 AUTH 失败。
    expect(engine.enabled).toBe(false)
    expect(engine.hasCredentials).toBe(false)
    expect(engine.credentialMasked).toEqual({})
    expect(engine.accessType).toBe('API')
    expect(engine.rateLimitPerMin).toBe(600)
  })

  it('同一个 code 建第二次 → 1040000（code 是全局唯一键）', async () => {
    const res = await asPlatform().post('/api/platform/geo/engines', {
      code: ENGINE_CODE,
      name: '重名',
      vendor: 'taizan',
    })
    expect(codeOf(res.body)).toBe(1040000)
  })

  it('code 不合法（大写 / 下划线）当场被规则函数拦下', async () => {
    const res = await asPlatform().post('/api/platform/geo/engines', {
      code: 'Mock_Bad',
      name: '不合法',
      vendor: 'taizan',
    })
    expect(codeOf(res.body)).toBe(1040000)
  })

  it('商家 token 打平台接口 → 被守卫拒掉（不是 404）', async () => {
    const res = await asShop().get('/api/platform/geo/engines')
    expect(codeOf(res.body)).not.toBe(0)
  })
})

describe('③ 写密钥：响应只有脱敏值，明文只进密文列', () => {
  it('PUT /:id/credentials —— 响应里只有 masked，搜不到明文', async () => {
    const res = await asPlatform().put(`/api/platform/geo/engines/${engineId}/credentials`, {
      credentials: { apiKey: SECRET_VALUE, scenario: SCENARIO },
    })
    const engine = expectOk<{
      hasCredentials: boolean
      credentialMasked: Record<string, string>
    }>(res.body)

    expect(engine.hasCredentials).toBe(true)
    // 键名保留（平台运营要看得出「配了 apiKey 没配 secretKey」），值只留前 3 后 2。
    expect(Object.keys(engine.credentialMasked).sort()).toEqual(['apiKey', 'scenario'])
    expect(engine.credentialMasked.apiKey).toBe('sk-******01')

    // 最硬的一条：**整份响应**（不只是那两个字段）里搜不到明文。
    // 按字段断言挡不住「某天有人给 GeoEngineView 加了一个字段顺手带出了密文」。
    expect(JSON.stringify(res.body)).not.toContain('super-secret')
  })

  it('库里：credentialEnc 是密文，且与 credentialKeyId 成对', async () => {
    const row = await prisma.geoEngine.findUnique({ where: { id: engineId } })
    expect(row).not.toBeNull()
    expect(row?.credentialEnc).toBeTruthy()
    // 明文一个字节都不能落库。
    expect(row?.credentialEnc).not.toContain('super-secret')
    // `v1:` 是 `@taizan/crypto` 的密文前缀。
    expect(row?.credentialEnc?.startsWith('v1:')).toBe(true)
    // 缺了 keyId 的那一行在密钥轮换那天就再也解不开了——这条守的是那件事。
    expect(row?.credentialKeyId).toBeTruthy()
  })

  it('GET /:id 详情同样不回明文', async () => {
    const res = await asPlatform().get(`/api/platform/geo/engines/${engineId}`)
    expectOk(res.body)
    expect(JSON.stringify(res.body)).not.toContain('super-secret')
  })

  it('凭据的值不是字符串 → 1040000（放进去之后适配器会在队列里炸）', async () => {
    const res = await asPlatform().put(`/api/platform/geo/engines/${engineId}/credentials`, {
      credentials: { apiKey: 123 },
    })
    expect(codeOf(res.body)).toBe(1040000)
  })
})

describe('④ 启用 + 实测一次', () => {
  it('PATCH /:id/enabled { enabled: true }', async () => {
    const res = await asPlatform().patch(`/api/platform/geo/engines/${engineId}/enabled`, {
      enabled: true,
    })
    expect(expectOk<{ enabled: boolean }>(res.body).enabled).toBe(true)
  })

  it('POST /:id/test —— mock 适配器真的问通一次', async () => {
    const res = await asPlatform().post(`/api/platform/geo/engines/${mockEngineId}/test`, {
      prompt: '国内做 GEO 监测的工具有哪些？',
    })
    const result = expectOk<{
      ok: boolean
      latencyMs: number
      preview: string
      citationCount: number
      error: string | null
      model: string
    }>(res.body)

    expect(result.ok, `测试没通：${result.error ?? '(无错误信息)'}`).toBe(true)
    expect(result.error).toBeNull()
    // mock 的 `mention` 场景固定回 2 条引用、一段含品牌名的正文（见 mock.ts 的场景表）。
    expect(result.citationCount).toBeGreaterThan(0)
    expect(result.preview.length).toBeGreaterThan(0)
    expect(result.model).toBe('mock-engine-v1')
    // 诊断结果里同样不能夹带密钥。
    expect(JSON.stringify(res.body)).not.toContain('super-secret')
  })

  it('POST /:id/test 打在一个代码里没有适配器的 code 上 → 可读的 1040000，不是 9050000', async () => {
    const res = await asPlatform().post(`/api/platform/geo/engines/${engineId}/test`)
    expect(codeOf(res.body)).toBe(1040000)
    // 消息里点名了这个 code，并列出代码里真的有哪些——运营据此知道下一步该改什么。
    expect((res.body as { message: string }).message).toContain(ENGINE_CODE)
    expect((res.body as { message: string }).message).toContain('mock')
  })

  it('审计里留下了 create / credential-update / enable / test 四条', async () => {
    const own = await prisma.platformAuditLog.findMany({
      where: { targetType: 'GeoEngine', targetId: engineId },
      select: { action: true },
    })
    const set = new Set(own.map((a) => a.action))
    // 启停分两条动作码而不是一条 set-enabled：`where action = 'geo-engine.disable'`
    // 要能一句话捞出「谁把这个引擎停掉的」。
    expect(set.has('geo-engine.enable')).toBe(true)
    expect(set.has('geo-engine.credential-update')).toBe(true)

    // `geo-engine.create` **没有 targetId**：`@Audit` 的 `targetId` 回调是从
    // `req.params.id` 取的，而新建那一刻 id 还不存在（它是这次请求的产物）。
    // 所以它只能按动作码查——这不是漏了，是 `AuditOptions` 的形状决定的。
    const created = await prisma.platformAuditLog.findMany({
      where: { targetType: 'GeoEngine', action: 'geo-engine.create' },
      select: { action: true },
    })
    expect(created.length).toBeGreaterThan(0)

    // 测试那一条打在 `mock` 那一行上（见 REAL_MOCK_CODE 的说明）。
    const tested = await prisma.platformAuditLog.findMany({
      where: { targetType: 'GeoEngine', targetId: mockEngineId, action: 'geo-engine.test' },
      select: { action: true },
    })
    expect(tested.length).toBeGreaterThan(0)
  })

  it('审计的 payload 里没有明文密钥', async () => {
    const logs = await prisma.platformAuditLog.findMany({
      where: { targetType: 'GeoEngine', targetId: engineId, action: 'geo-engine.credential-update' },
    })
    expect(logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(logs)).not.toContain('super-secret')
  })
})

describe('⑤ 商家侧只读清单', () => {
  it('GET /api/admin/geo/engines —— 看得到，且只有四个字段', async () => {
    const res = await asShop().get('/api/admin/geo/engines')
    const items = expectOk<Record<string, unknown>[]>(res.body)
    const mine = items.find((item) => item.code === ENGINE_CODE)
    expect(mine, '启用了却在商家侧看不到').toBeDefined()
    // 四个字段一个不多：多一个就意味着平台的成本参数或密钥提示漏给了商家。
    expect(Object.keys(mine ?? {}).sort()).toEqual(['accessType', 'code', 'name', 'vendor'])
  })

  it('停用之后商家侧就看不到它了', async () => {
    await asPlatform().patch(`/api/platform/geo/engines/${engineId}/enabled`, { enabled: false })

    const res = await asShop().get('/api/admin/geo/engines')
    const items = expectOk<{ code: string }[]>(res.body)
    expect(items.some((item) => item.code === ENGINE_CODE)).toBe(false)
  })

  it('但平台侧仍然查得到（停用不是删除）', async () => {
    const res = await asPlatform().get(`/api/platform/geo/engines/${engineId}`)
    expect(expectOk<{ enabled: boolean }>(res.body).enabled).toBe(false)
  })
})

describe('⑥ 品牌表单选了未启用的引擎', () => {
  it('POST /api/admin/geo/brands 带一个已停用的 code → 1040000，且消息点名了它', async () => {
    const res = await asShop().post('/api/admin/geo/brands', {
      name: `未启用引擎的品牌 ${RUN}`,
      engineCodes: [ENGINE_CODE],
    })
    expect(codeOf(res.body)).toBe(1040000)
    expect((res.body as { message: string }).message).toContain(ENGINE_CODE)
  })

  it('一条都不填是允许的（"先建品牌、回头再挑引擎"是正常路径）', async () => {
    const res = await asShop().post('/api/admin/geo/brands', {
      name: `不选引擎的品牌 ${RUN}`,
      engineCodes: [],
    })
    expect(expectOk<{ engineCodes: string[] }>(res.body).engineCodes).toEqual([])
  })

  it('重新启用之后就选得上了', async () => {
    await asPlatform().patch(`/api/platform/geo/engines/${engineId}/enabled`, { enabled: true })

    const res = await asShop().post('/api/admin/geo/brands', {
      name: `选了引擎的品牌 ${RUN}`,
      engineCodes: [ENGINE_CODE],
    })
    expect(expectOk<{ engineCodes: string[] }>(res.body).engineCodes).toEqual([ENGINE_CODE])
  })
})
