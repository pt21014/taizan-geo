/**
 * 平台域「GEO 引擎接入点」的数据访问层 + 密钥加解密 + 手动诊断。
 *
 * ## 全文没有一处 `prisma.tenant`
 *
 * `GeoEngine` 是**平台域表**（没有 `tenantId` 列，不在 `tenancy/tenant-models.ts`
 * 的隔离名单里）。走 `prisma.tenant.geoEngine` 会被隔离扩展当成未登记模型直接抛。
 * 所以这里全程 `RawPrismaService`，与 `modules/platform/plan/plan.service.ts` 同形，
 * 并在 `tenancy/raw-reasons.ts` 里登记了 `src/modules/geo/engine/` 这条豁免。
 *
 * ## 明文在这个文件里只活三行
 *
 * | 时刻 | 明文在哪 | 之后 |
 * |---|---|---|
 * | `updateCredentials` | 入参 `dto.credentials` | 立刻 `vault.encrypt(JSON.stringify(...))` 落 `credentialEnc`，同时把 `maskCredentials` 的结果落 `credentialMasked` |
 * | `decryptCredentials` | 返回值 | 只给**进程内**的调用方（T6 的跑批 handler、本文件的 `test()`） |
 *
 * **任何一个控制器方法都不回明文**：`toView()` 里根本没有读 `credentialEnc` 的代码，
 * 于是「不小心回了明文」这件事不是靠 review 挡住的，而是数据根本没走到那一层。
 *
 * `decryptCredentials` 是 `public` 的，因为 T6 的 handler 在另一个文件里；
 * 它**不接受 HTTP 入参**（只接受 `code`），也不出现在任何控制器上——
 * 这是这个文件里唯一一处会产出明文的出口，收窄到一个方法便于 review。
 *
 * ## 为什么 `test()` 允许同步调用引擎（与"HTTP 路径不许调引擎"那条不冲突）
 *
 * 技术设计 §10 第 4 条写着「HTTP 请求路径里直接调引擎/LLM」是易犯错误，正确写法是
 * 一律走 `@JobHandler`。那条约束针对的是**商家触发的批量**：一次跑批是
 * `prompts × engines × sampleSize` 次调用，放在 HTTP 里必然超时。
 *
 * `test()` 是**平台运营手动点一次**的诊断接口：一次一条、有人盯着、超时由
 * `GeoEngine.timeoutMs` 兜底（最长 2 分钟）。把它塞进队列的代价是运营点完"测试"
 * 之后要去另一个页面轮询结果——而他要判断的恰恰是"我刚填的这把 key 对不对"，
 * 那个答案必须当场给。这是刻意的例外，不是漏掉了。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { Prisma, type GeoSourceCategory } from '@prisma/client'
import { ErrorCode, normalizePage, ulid, type PageResult } from '@taizan/contracts'
import { createVault, type CredentialVault } from '@taizan/crypto'
import {
  isEngineError,
  type EngineAskOutput,
  type EngineCode,
  type EngineRegistry,
  type HttpClient,
} from '@taizan/geo-engines'
import { BizException, ConfigService } from '@taizan/nest-core'
import { RawPrismaService } from '@taizan/nest-prisma'

import type { AppPrismaClient } from '../../../common/prisma.types'
import type { AppEnv } from '../../../config/env'
import type {
  CreateGeoEngineDto,
  GeoEngineOptionView,
  GeoEngineTestResultView,
  GeoEngineView,
  ListGeoEngineQueryDto,
  UpdateGeoEngineCredentialsDto,
  UpdateGeoEngineDto,
} from './dto/geo-engine.dto'
import { createEngineHttpClient } from './http-client'
import { GEO_ENGINE_REGISTRY } from './geo-engine-registry.provider'
import {
  maskCredentials,
  parseCredentialsJson,
  validateEngineInput,
  validateEnginePatch,
  type GeoAccessTypeLike,
  type RuleViolation,
} from './geo-engine.rules'

/** 测试接口不传 prompt 时用的那一条。 */
const DEFAULT_TEST_PROMPT = '请用一句话介绍一下你自己，并附上你参考的网页链接。'

/** 测试结果里回显的正文长度上限。 */
const TEST_PREVIEW_MAX = 200

type GeoEngineRow = NonNullable<Awaited<ReturnType<AppPrismaClient['geoEngine']['findUnique']>>>

/**
 * 跑批 handler 要用的引擎运行参数（见 {@link GeoEngineService.findRuntimeConfig}）。
 *
 * **刻意不含任何密钥列**：要凭据只能另外调 `decryptCredentials(code)`。
 */
export interface GeoEngineRuntimeConfig {
  code: string
  enabled: boolean
  model: string
  baseUrl: string | null
  pricePerQueryCents: number
  priceInPerMTokenCents: number
  priceOutPerMTokenCents: number
  rateLimitPerMin: number
  timeoutMs: number
}

/** 一条来源分类规则（见 {@link GeoEngineService.listSourceRules}）。 */
export interface GeoSourceRuleRow {
  pattern: string
  platform: string
  category: GeoSourceCategory
  priority: number
}

function rejectViolations(violations: readonly RuleViolation[]): void {
  if (violations.length === 0) return
  throw new BizException(ErrorCode.BAD_REQUEST, violations.map((v) => v.message).join('；'), {
    violations,
  })
}

/**
 * `credentialMasked` 在库里是一串 JSON（一列存整包，与 `credentialEnc` 对齐）。
 * 解不出来时回空对象而不是抛：脱敏提示坏了不该让整个列表页打不开。
 */
function parseMasked(raw: string | null): Record<string, string> {
  if (raw === null || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 行 → 下发视图。
 *
 * **这个函数里没有一处读 `row.credentialEnc`**。不是"读了但没回"，是根本不读——
 * 于是将来有人往 `GeoEngineView` 上加字段时，也不可能顺手把密文带出去。
 */
function toView(row: GeoEngineRow): GeoEngineView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    vendor: row.vendor,
    accessType: row.accessType as GeoAccessTypeLike,
    enabled: row.enabled,
    model: row.model,
    baseUrl: row.baseUrl,
    credentialMasked: parseMasked(row.credentialMasked),
    hasCredentials: row.credentialEnc !== null && row.credentialEnc !== '',
    pricePerQueryCents: row.pricePerQueryCents,
    priceInPerMTokenCents: row.priceInPerMTokenCents,
    priceOutPerMTokenCents: row.priceOutPerMTokenCents,
    rateLimitPerMin: row.rateLimitPerMin,
    timeoutMs: row.timeoutMs,
    config: (row.config as Record<string, unknown> | null) ?? {},
    sort: row.sort,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

@Injectable()
export class GeoEngineService {
  private readonly vault: CredentialVault
  private readonly http: HttpClient

  constructor(
    // raw-reason: 平台后台——GeoEngine 是平台域表（一套密钥服务全部租户），没有 tenantId 列。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(ConfigService) config: ConfigService<AppEnv>,
    @Inject(GEO_ENGINE_REGISTRY) private readonly registry: EngineRegistry,
  ) {
    this.vault = createVault({
      keys: config.get('CRYPTO_KEYS'),
      currentKeyId: config.get('CRYPTO_KEY_CURRENT'),
    })
    // 无状态、可以全进程共用一个：超时与取消都从每次请求的 opts 进来。
    this.http = createEngineHttpClient()
  }

  // ── 读 ──────────────────────────────────────────────────────────────────

  /** 分页列表。 */
  async list(query: ListGeoEngineQueryDto): Promise<PageResult<GeoEngineView>> {
    const { page, pageSize } = normalizePage(query)

    const where: Prisma.GeoEngineWhereInput = {}
    if (query.enabled !== undefined) where.enabled = query.enabled
    const keyword = query.keyword?.trim()
    if (keyword) {
      where.OR = [
        { code: { contains: keyword } },
        { name: { contains: keyword } },
        { vendor: { contains: keyword } },
      ]
    }

    const [rows, total] = await Promise.all([
      // raw-reason: 平台后台——GeoEngine 是平台域表，没有 tenantId 列。
      this.raw.client.geoEngine.findMany({
        where,
        orderBy: [{ sort: 'asc' }, { code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.raw.client.geoEngine.count({ where }),
    ])

    return { items: rows.map(toView), total, page, pageSize }
  }

  /** 取一条。 */
  async get(id: string): Promise<GeoEngineView> {
    return toView(await this.requireEngine(id))
  }

  /**
   * 商家侧的下拉框数据源：**只有启用的**，只回四个字段。
   *
   * 不分页：引擎总数是个位数（平台一共接了几家）。加分页的代价是前端要处理翻页，
   * 而它永远翻不到第二页。
   */
  async listEnabledOptions(): Promise<GeoEngineOptionView[]> {
    // raw-reason: 平台域表 GeoEngine 的只读投影，下发给商家侧做下拉框；没有 tenantId 列。
    const rows = await this.raw.client.geoEngine.findMany({
      where: { enabled: true },
      orderBy: [{ sort: 'asc' }, { code: 'asc' }],
      select: { code: true, name: true, vendor: true, accessType: true },
    })
    return rows
      .filter((row) => this.isSelectable(row.code))
      .map((row) => ({
        code: row.code,
        name: row.name,
        vendor: row.vendor,
        accessType: row.accessType as GeoAccessTypeLike,
      }))
  }

  /**
   * 生产环境刚出的真实事故：`GeoEngine.enabled` 只是数据库这一列的状态，`mock`
   * 无论在哪个环境都在这张表里 `enabled: true`（`seed.ts` 的 `seedGeoEngines`
   * 对 `--prod`/本地一视同仁——mock 那一行的存在本身是"装完能不能跑通一次"的
   * 占位证据），但 `@taizan/geo-engines` 的适配器 registry 在
   * `NODE_ENV=production` 下**刻意不登记 mock**（`geo-engine-registry.provider.ts`
   * 的 `assertMockNotInProd`：真实商家绝不该拿到编出来的可见度数据）。
   *
   * 后果是商家侧「监测引擎」下拉框会显示 mock、`POST /api/admin/geo/brands`
   * 也会放行 `engineCodes: ["mock"]`，而一旦跑批，`geo-query-execute.handler.ts`
   * 里 `registry.has('mock')` 恒为 false，run 永远卡在 RUNNING（BullMQ 把
   * "未登记的引擎" 这种配置错误当成 `UPSTREAM` 无限重试）。
   *
   * 修法只对 `code === 'mock'` 这一个特例生效，且直接问 registry（而不是
   * 自己复制一份 `NODE_ENV === 'production'` 判断）——环境判据只有 registry
   * 装配那一处真源。**不**对其它 code 做同样的 registry 交叉校验：那会破坏既有
   * 设计（`geo-engine-registry.provider.ts` 文件头写明的分工是"DB enabled 回答
   * 平台想不想用、registry.has 回答代码有没有实现，两者只在**跑批时**一起过"），
   * `geo-engine.e2e-spec.ts` 用例⑤⑥就是在验证"后台建一个代码里还没实现适配器的
   * 引擎，enabled 之后商家侧照样选得上"——那是刻意留到跑批时才收口的缺口，不是
   * 这次要堵的洞。本地开发/`pnpm test:e2e` 不受影响：非 production 环境下
   * `registry.has('mock')` 仍然是 true。
   */
  private isSelectable(code: string): boolean {
    return code !== 'mock' || this.registry.has('mock' as EngineCode)
  }

  /**
   * 当前启用的引擎 code 集合。
   *
   * 给 `geo-brand.service.ts` 的 `assertEngineCodesExist` 用。回 `Set` 而不是数组：
   * 调用方要做的是「逐个 code 判在不在」，`includes` 在循环里是 O(n²)——量小无所谓，
   * 但接口形状本身应该说清楚它是拿来查表的。
   */
  async enabledCodes(): Promise<Set<string>> {
    // raw-reason: 平台域表 GeoEngine 的存在性校验，没有 tenantId 列。
    const rows = await this.raw.client.geoEngine.findMany({
      where: { enabled: true },
      select: { code: true },
    })
    // 与 listEnabledOptions() 同一条理由（见 isSelectable 的注释）：只有下拉框里
    // 不给选、校验这边不拦的话，等于留了一条「直接调 API 传
    // engineCodes: ["mock"]」的后门，品牌照样能建成，跑批照样一条查询都出不来。
    return new Set(rows.map((row) => row.code).filter((code) => this.isSelectable(code)))
  }

  /**
   * `code → 展示名` 的全量映射，**含已停用的**。
   *
   * 看板与报表要把历史数据里的 `engineCode` 翻成中文名，而历史数据里完全可能
   * 出现一个后来被平台停用的引擎（`GeoQueryResult.engineCode` 是快照值，
   * 21-geo-platform.prisma 的文件头说明了为什么按 code 而不是 id 引用）。
   * 用 {@link GeoEngineService.listEnabledOptions} 的话，那些行会变成
   * 「名字空白的一行数据」——而它本来是有名字的，只是不再启用。
   *
   * 回 `Map` 而不是数组：调用方要做的是逐个 code 查表。
   */
  async nameByCode(): Promise<Map<string, string>> {
    // raw-reason: 平台域表 GeoEngine 的只读投影（code + name），没有 tenantId 列；
    // 含停用的，因为历史数据里引用得到它们。
    const rows = await this.raw.client.geoEngine.findMany({ select: { code: true, name: true } })
    return new Map(rows.map((row) => [row.code, row.name]))
  }

  // ── 写 ──────────────────────────────────────────────────────────────────

  /**
   * 新建。
   *
   * `enabled` 默认 **false**：新接一个引擎时密钥还没填（凭据走单独的 `PUT`），
   * 默认启用的话它会立刻进入下一次跑批，然后每条查询都以 AUTH 失败告终。
   */
  async create(dto: CreateGeoEngineDto): Promise<GeoEngineView> {
    const effective = {
      ...dto,
      accessType: dto.accessType ?? 'API',
      pricePerQueryCents: dto.pricePerQueryCents ?? 0,
      priceInPerMTokenCents: dto.priceInPerMTokenCents ?? 0,
      priceOutPerMTokenCents: dto.priceOutPerMTokenCents ?? 0,
      rateLimitPerMin: dto.rateLimitPerMin ?? 60,
      timeoutMs: dto.timeoutMs ?? 60_000,
    }
    rejectViolations(validateEngineInput(effective))

    const code = dto.code.trim().toLowerCase()
    // raw-reason: 平台域表 GeoEngine 的 code 唯一性检查，没有 tenantId 列。
    const taken = await this.raw.client.geoEngine.findUnique({ where: { code } })
    if (taken) {
      throw new BizException(ErrorCode.BAD_REQUEST, `引擎 code「${code}」已经被占用了`)
    }

    // raw-reason: 平台域表 GeoEngine，没有 tenantId 列。
    const row = await this.raw.client.geoEngine.create({
      data: {
        // 平台域表不过 ULID 扩展（那是租户扩展链的一部分），主键自己填。
        id: ulid(),
        code,
        name: dto.name.trim(),
        vendor: dto.vendor.trim(),
        accessType: effective.accessType,
        enabled: dto.enabled ?? false,
        model: dto.model?.trim() ?? '',
        baseUrl: dto.baseUrl?.trim() || null,
        pricePerQueryCents: effective.pricePerQueryCents,
        priceInPerMTokenCents: effective.priceInPerMTokenCents,
        priceOutPerMTokenCents: effective.priceOutPerMTokenCents,
        rateLimitPerMin: effective.rateLimitPerMin,
        timeoutMs: effective.timeoutMs,
        config: (dto.config ?? {}) as Prisma.InputJsonValue,
        sort: dto.sort ?? 0,
      },
    })
    return toView(row)
  }

  /** 修改。只改传了的字段；`code` / `enabled` / 凭据都不走这里（见 DTO 的说明）。 */
  async update(id: string, dto: UpdateGeoEngineDto): Promise<GeoEngineView> {
    rejectViolations(validateEnginePatch(dto))
    await this.requireEngine(id)

    // raw-reason: 平台域表 GeoEngine，没有 tenantId 列。
    const row = await this.raw.client.geoEngine.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.vendor !== undefined ? { vendor: dto.vendor.trim() } : {}),
        ...(dto.accessType !== undefined ? { accessType: dto.accessType } : {}),
        ...(dto.model !== undefined ? { model: dto.model.trim() } : {}),
        ...(dto.baseUrl !== undefined ? { baseUrl: dto.baseUrl.trim() || null } : {}),
        ...(dto.pricePerQueryCents !== undefined
          ? { pricePerQueryCents: dto.pricePerQueryCents }
          : {}),
        ...(dto.priceInPerMTokenCents !== undefined
          ? { priceInPerMTokenCents: dto.priceInPerMTokenCents }
          : {}),
        ...(dto.priceOutPerMTokenCents !== undefined
          ? { priceOutPerMTokenCents: dto.priceOutPerMTokenCents }
          : {}),
        ...(dto.rateLimitPerMin !== undefined ? { rateLimitPerMin: dto.rateLimitPerMin } : {}),
        ...(dto.timeoutMs !== undefined ? { timeoutMs: dto.timeoutMs } : {}),
        ...(dto.config !== undefined ? { config: dto.config as Prisma.InputJsonValue } : {}),
        ...(dto.sort !== undefined ? { sort: dto.sort } : {}),
      },
    })
    return toView(row)
  }

  /**
   * 启用 / 停用。
   *
   * 停用是**立刻生效**的：跑批每次都重新读 `enabled`，不缓存。存量品牌的
   * `engineCodes` 里仍然留着这个 code（那是快照，不该被平台的操作改写），
   * 跑批时会跳过它——这正是「平台下架了一个引擎」该有的表现。
   */
  async setEnabled(id: string, enabled: boolean): Promise<GeoEngineView> {
    await this.requireEngine(id)
    // raw-reason: 平台域表 GeoEngine，没有 tenantId 列。
    const row = await this.raw.client.geoEngine.update({ where: { id }, data: { enabled } })
    return toView(row)
  }

  /**
   * 整包替换凭据。
   *
   * 三列一起写，缺一列都会在换密钥那天出事：
   * - `credentialEnc`：整包 JSON 的密文；
   * - `credentialKeyId`：加密用的密钥版本号（轮换脚本按它挑行）；
   * - `credentialMasked`：脱敏提示的 JSON（平台运营在列表页看到的那个）。
   *
   * 传一个空对象 = **清空凭据**（三列一起置空），而不是"什么都不做"：
   * 「把配错的 key 删掉」必须有办法表达，否则只能删掉整个引擎行，
   * 而那会连着历史结果一起失去引用对象。
   */
  async updateCredentials(
    id: string,
    dto: UpdateGeoEngineCredentialsDto,
  ): Promise<GeoEngineView> {
    await this.requireEngine(id)

    // 先过一遍纯函数的形状校验：值必须都是字符串、键数与长度有上限。
    // 走 JSON 序列化再解析，是为了和"从库里读回来"走**同一条**校验路径——
    // 两条路径的话，某天其中一条会放过另一条挡下的东西。
    const parsed = parseCredentialsJson(JSON.stringify(dto.credentials ?? {}))
    if (!parsed.ok) throw new BizException(ErrorCode.BAD_REQUEST, parsed.message)
    const credentials = parsed.credentials

    if (Object.keys(credentials).length === 0) {
      // raw-reason: 平台域表 GeoEngine，没有 tenantId 列。
      const cleared = await this.raw.client.geoEngine.update({
        where: { id },
        data: { credentialEnc: null, credentialKeyId: null, credentialMasked: null },
      })
      return toView(cleared)
    }

    const { valueEnc, keyId } = this.vault.encrypt(JSON.stringify(credentials))

    // raw-reason: 平台域表 GeoEngine，没有 tenantId 列。
    const row = await this.raw.client.geoEngine.update({
      where: { id },
      data: {
        credentialEnc: valueEnc,
        credentialKeyId: keyId,
        credentialMasked: JSON.stringify(maskCredentials(credentials)),
      },
    })
    return toView(row)
  }

  /**
   * 跑批要用的引擎运行参数（T6）。
   *
   * ## 为什么跑批 handler 不自己查 `GeoEngine`
   *
   * `GeoEngine` 是平台域表，查它必须走 `RawPrismaService`，而那需要在
   * `tenancy/raw-reasons.ts` 里给 `run/` 目录开一条豁免。多开一条 raw 豁免的代价不是
   * 「多写几行注册表」，而是**那个目录从此整体脱离租户隔离的静态检查**——将来有人在
   * 同一个目录里写一条本该走 `prisma.tenant` 的查询，spec 3 不会再拦它。
   *
   * 把这一次读收到本文件里，`run/` 目录就还是「一处 raw 都没有」的干净状态
   * （两个 cron 另有它们自己的跨租户理由，那是单独一条豁免）。
   *
   * ## 为什么不回整行
   *
   * 回整行等于把 `credentialEnc` 带进跑批 handler 的作用域，而那里有日志。
   * 这个投影里**没有密钥列**——要凭据只能另外调 {@link decryptCredentials}，
   * 那是本文件里唯一的明文出口。
   *
   * @param code - 引擎 code（来自 `GeoBrand.engineCodes` 的快照）
   * @returns 引擎当前的运行参数；库里没有这个 code 时回 `null`
   *   （**不抛**：跑批时「平台把这个引擎删了」是一个要跳过、不是要炸掉整批的情况）
   */
  async findRuntimeConfig(code: string): Promise<GeoEngineRuntimeConfig | null> {
    // raw-reason: 平台域表 GeoEngine，跑批 handler 按 code 取运行参数；没有 tenantId 列。
    const row = await this.raw.client.geoEngine.findUnique({
      where: { code },
      select: {
        code: true,
        enabled: true,
        model: true,
        baseUrl: true,
        pricePerQueryCents: true,
        priceInPerMTokenCents: true,
        priceOutPerMTokenCents: true,
        rateLimitPerMin: true,
        timeoutMs: true,
      },
    })
    return row ?? null
  }

  /**
   * 平台配置的来源分类规则全表（`GeoSourcePlatformRule`，T6 的分析 handler 用）。
   *
   * 与 {@link findRuntimeConfig} 同一个理由收到本文件里：它也是平台域表，
   * 而 `analysis/` 目录不该为了读它整体拿到 raw 豁免。
   *
   * **每次都查、不缓存**：这张表只有十几行，一次查询几毫秒；而缓存它就要面对
   * 「平台后台改了一条规则，什么时候生效」这个问题——答案只能是「等进程重启」或者
   * 「再写一套失效机制」，两者都比这几毫秒贵。
   */
  async listSourceRules(): Promise<GeoSourceRuleRow[]> {
    // raw-reason: 平台域表 GeoSourcePlatformRule（一套来源分类规则服务全部租户），没有 tenantId 列。
    return this.raw.client.geoSourcePlatformRule.findMany({
      orderBy: [{ priority: 'asc' }, { pattern: 'asc' }],
      select: { pattern: true, platform: true, category: true, priority: true },
    })
  }

  // ── 内部：解密 ──────────────────────────────────────────────────────────

  /**
   * 按 `code` 解出整包明文凭据。**进程内专用**，任何控制器都不许直接暴露它。
   *
   * 按 `code` 而不是按 `id` 取：调用方是跑批 handler，它手里只有
   * `GeoBrand.engineCodes` 里的那个字符串快照——那正是 code 存在的理由。
   *
   * @param code - 引擎 code
   * @returns 解密并 `JSON.parse` 之后的整包凭据；没配过凭据时是**空对象**
   *   （不是抛错——mock 引擎就不需要凭据，`BROWSER` 类也可能不需要）
   * @throws `BizException` 1040000 引擎不存在、密文解不开（密钥轮换出了事），
   *   或解出来的东西不是一个合法的凭据包
   */
  async decryptCredentials(code: string): Promise<Record<string, string>> {
    // raw-reason: 平台域表 GeoEngine，跑批 handler 按 code 取凭据；没有 tenantId 列。
    const row = await this.raw.client.geoEngine.findUnique({
      where: { code },
      select: { credentialEnc: true, credentialKeyId: true },
    })
    if (!row) {
      throw new BizException(ErrorCode.BAD_REQUEST, `引擎「${code}」不存在`)
    }
    if (row.credentialEnc === null || row.credentialEnc === '') return {}
    if (row.credentialKeyId === null || row.credentialKeyId === '') {
      // 密文列有值、配对的 keyId 列没有——这一行是被绕过 `updateCredentials()`
      // 直接改库改出来的（那两列在本文件里永远一起写）。解不开，而且解不开的
      // 原因不是密钥轮换，所以单独报一句，省得运维往轮换那边查。
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `引擎「${code}」的凭据缺 credentialKeyId——密文与密钥版本号必须成对写入`,
      )
    }

    let plain: string
    try {
      plain = this.vault.decrypt(row.credentialEnc, row.credentialKeyId)
    } catch (error) {
      // 解不开只有一个原因：这一列用某个 keyId 加密，而那把密钥已经不在
      // `CRYPTO_KEYS` 里了（轮换时漏了这一列）。把 code 带进消息里，
      // 否则运维拿到的信息只有"解密失败"。
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `引擎「${code}」的凭据解不开——多半是密钥轮换时漏了 GeoEngine.credentialEnc 这一列`,
        { cause: error instanceof Error ? error.message : String(error) },
      )
    }

    const parsed = parseCredentialsJson(plain)
    if (!parsed.ok) {
      throw new BizException(ErrorCode.BAD_REQUEST, `引擎「${code}」的凭据格式不对：${parsed.message}`)
    }
    return parsed.credentials
  }

  // ── 手动诊断 ────────────────────────────────────────────────────────────

  /**
   * 用真适配器实测一次，返回「通没通 / 多久 / 回了什么 / 几条引用」。
   *
   * **失败不抛异常**，而是回 `{ ok: false, error }`：这个接口的全部意义就是把
   * 失败原因显示给运营看。抛出去的话，前端拿到的是一个通用的 400 信封，
   * 而「AUTH 失败」和「网络不通」在那里长得一模一样。
   *
   * 引擎不在 registry 里（后台建了一个代码里还没实现的 code）**是例外**——
   * 那是平台的装配错误，不是"这次没问通"，所以照常抛。
   *
   * @param id - 引擎行 id
   * @param prompt - 测试用的问题；不传用 {@link DEFAULT_TEST_PROMPT}
   */
  async test(id: string, prompt?: string): Promise<GeoEngineTestResultView> {
    const row = await this.requireEngine(id)

    // 代码里没有这个 code 的实现时，回一条**可读的 400**，而不是让
    // `registry.get()` 抛一个裸 Error（那会变成 9050000「系统内部错误」）。
    //
    // 两者的区别不在严重程度，在于**谁看到它、能做什么**：这是平台运营在后台点的
    // 诊断按钮，他能做的事是「把 code 改成一个真的接了适配器的」。给他一个 500，
    // 他只会去找后端，而后端要翻日志才能看到那句话。
    //
    // 跑批那条路（T6）**仍然是硬抛**：那里没有人在看，静默跳过一个引擎的后果是
    // 报表少了一家的数据而没有任何信号。两条路径的处理不同是刻意的。
    if (!this.registry.has(row.code as EngineCode)) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `代码里没有「${row.code}」这个引擎的适配器（已登记：${this.registry.codes().join('、')}）。` +
          '引擎 code 必须与 @taizan/geo-engines 里的某个适配器对上。',
      )
    }
    const adapter = this.registry.get(row.code as EngineCode)
    const credentials = await this.decryptCredentials(row.code)

    const startedAt = Date.now()
    let output: EngineAskOutput
    try {
      output = await adapter.ask(
        { prompt: prompt?.trim() || DEFAULT_TEST_PROMPT, timeoutMs: row.timeoutMs },
        {
          credentials,
          http: this.http,
          timeoutMs: row.timeoutMs,
          ...(row.model === '' ? {} : { model: row.model }),
          ...(row.baseUrl === null ? {} : { baseUrl: row.baseUrl }),
        },
      )
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        preview: '',
        citationCount: 0,
        error: error instanceof Error ? error.message : String(error),
        errorKind: isEngineError(error) ? error.kind : 'UPSTREAM',
        model: row.model,
      }
    }

    return {
      ok: true,
      // 用适配器自己计的 `latencyMs`（它从发请求前开始计），而不是这里的墙钟差——
      // 后者把解密与 registry 查找也算了进去，在排查"是不是引擎慢"时会误导。
      latencyMs: output.latencyMs,
      preview: output.text.slice(0, TEST_PREVIEW_MAX),
      citationCount: output.citations.length,
      error: null,
      errorKind: null,
      model: output.model,
    }
  }

  // ── 私有 ────────────────────────────────────────────────────────────────

  /** 按 id 取一条，取不到抛 1040000（与 `plan.service.ts` 的「套餐不存在」同形）。 */
  private async requireEngine(id: string): Promise<GeoEngineRow> {
    // raw-reason: 平台域表 GeoEngine，没有 tenantId 列。
    const row = await this.raw.client.geoEngine.findUnique({ where: { id } })
    if (!row) throw new BizException(ErrorCode.BAD_REQUEST, '引擎不存在')
    return row
  }
}
