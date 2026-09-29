/**
 * 平台域「GEO 引擎接入点」的**业务规则纯函数**（GEO P0 技术设计 §4.4）。
 *
 * ## 为什么单独一个文件
 *
 * 与 `brand/geo-brand.rules.ts` 同一条判据：不碰数据库、不读时钟、不 import
 * `@nestjs/*` 或 `@prisma/client`，于是 `geo-engine.rules.spec.ts` 能把每条边界
 * 都过一遍（code 首字符是数字、单价填了负数、超时填了 500ms……），而这些恰恰是
 * 平台运营真的会踩到的输入。
 *
 * ## `maskCredentials` 为什么在这里而不是在 service 里
 *
 * 脱敏是这个模块**最不能出错**的一段逻辑：写错了的后果不是报错，而是把明文
 * apiKey 原样回给了前端，然后它进了浏览器缓存、日志、截图。这种代码必须有
 * 逐条边界的单测（空串、1 个字符、5 个字符、正好 6 个字符……），而单测的前提
 * 是它是个纯函数。
 *
 * **不要往这里 import 任何框架包**：一旦引入，它就不再是纯函数，单测就要起容器，
 * 于是边界用例又会慢慢消失。
 *
 * @packageDocumentation
 */

/** 接入方式（与 `21-geo-platform.prisma` 的 `GeoAccessType` 一一对应）。 */
export type GeoAccessTypeLike = 'API' | 'BROWSER'

/** 合法接入方式全集，供 DTO 校验与本文件共用（两处各写一份必然会漂）。 */
export const GEO_ACCESS_TYPES: readonly GeoAccessTypeLike[] = ['API', 'BROWSER']

/**
 * 引擎 code 的格式：小写字母开头，后接 1–31 个小写字母/数字/连字符。
 *
 * 比 `GeoBrand.engineCodes` 那条正则（`^[a-z0-9][a-z0-9_-]*$`）更严，是刻意的：
 * 这一侧是**产生** code 的地方，那一侧是**消费**它的地方。产生侧收紧、消费侧放宽，
 * 是为了让历史数据里那些用旧规则建出来的 code 仍然读得懂（`GeoQueryResult.engineCode`
 * 是快照列，引擎行删了它还在）。反过来做会让旧数据在列表页上报错。
 *
 * 不允许下划线：code 会出现在 Redis key（`geo:rl:{code}:{窗口}`）与指标名里，
 * 那两处的惯例都是连字符。允许两种写法等于让同一个引擎在监控面板上有两个名字。
 */
export const GEO_ENGINE_CODE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/

/** 限速下限 / 上限（次/分钟）。 */
export const GEO_RATE_LIMIT_MIN = 1
export const GEO_RATE_LIMIT_MAX = 600

/**
 * 超时下限 / 上限（毫秒）。
 *
 * 下限 1000ms：联网检索类的引擎首字节都要几百毫秒，填 200ms 等于把每一次查询
 * 都配置成失败。上限 120000ms：一次查询占住一个 worker 两分钟已经够离谱了，
 * 再长的话跑批会在「看起来卡住」和「真的卡住」之间无法区分。
 */
export const GEO_TIMEOUT_MS_MIN = 1000
export const GEO_TIMEOUT_MS_MAX = 120_000

/** 引擎名 / 厂商标识的长度上限，与 schema 的列宽对齐。 */
export const GEO_ENGINE_NAME_MAX = 60
export const GEO_ENGINE_VENDOR_MAX = 64
export const GEO_ENGINE_MODEL_MAX = 128
export const GEO_ENGINE_BASE_URL_MAX = 500

/** 单个凭据键名 / 值的长度上限。整包 JSON 还要塞进 `@db.Text`，这里先挡住离谱输入。 */
export const GEO_CREDENTIAL_KEY_MAX = 64
export const GEO_CREDENTIAL_VALUE_MAX = 4096
/** 凭据键的条数上限。 */
export const GEO_CREDENTIAL_ENTRY_MAX = 20

/**
 * 脱敏时保留的前缀 / 后缀长度。
 *
 * 前 3 后 2 是「够认出是哪一把 key、又拼不回原值」的折中：平台运营手里通常有
 * 好几把不同厂商的 key，全打星号的话他分不清库里存的是不是他刚换的那一把。
 */
export const MASK_KEEP_HEAD = 3
export const MASK_KEEP_TAIL = 2

/** 一条校验结论。形状与 `geo-brand.rules.ts` 的同名类型一致（两边各自导出，不互相 import）。 */
export interface RuleViolation {
  /** 出问题的字段名，与 DTO 字段同名，便于前端定位到输入框。 */
  field: string
  /** 给人看的中文说明。 */
  message: string
}

/** 校验入参（新建时字段齐全，修改时可缺）。 */
export interface GeoEngineInput {
  code?: unknown
  name?: unknown
  vendor?: unknown
  accessType?: unknown
  model?: unknown
  baseUrl?: unknown
  pricePerQueryCents?: unknown
  priceInPerMTokenCents?: unknown
  priceOutPerMTokenCents?: unknown
  rateLimitPerMin?: unknown
  timeoutMs?: unknown
  sort?: unknown
}

/**
 * 新建时的完整校验。
 *
 * 校验的是**生效之后**的输入（默认值已经填好），不是原始 DTO——与品牌那边同一条
 * 约定：默认值只能有一处真源，就是 service 里的那几个 `??`。
 */
export function validateEngineInput(input: GeoEngineInput): RuleViolation[] {
  return [
    ...checkCode(input.code, true),
    ...checkName(input.name, true),
    ...checkVendor(input.vendor, true),
    ...checkAccessType(input.accessType, false),
    ...checkModel(input.model),
    ...checkBaseUrl(input.baseUrl),
    ...checkPrice('pricePerQueryCents', input.pricePerQueryCents, false),
    ...checkPrice('priceInPerMTokenCents', input.priceInPerMTokenCents, false),
    ...checkPrice('priceOutPerMTokenCents', input.priceOutPerMTokenCents, false),
    ...checkRateLimit(input.rateLimitPerMin, false),
    ...checkTimeout(input.timeoutMs, false),
    ...checkSort(input.sort),
  ]
}

/**
 * 修改时的校验：**只校验给了的字段**。
 *
 * 与 {@link validateEngineInput} 分成两个函数而不是加一个 `partial` 布尔参数：
 * 布尔参数的调用点读起来是 `validate(x, true)`，谁也说不清 true 是哪一边。
 *
 * `code` 不在这里：引擎 code 是**不可改**的（`GeoQueryResult.engineCode` 是按 code
 * 存的快照，改了 code 等于让所有历史结果指向一个不存在的引擎）。改的路径是
 * 「停用旧的、建一个新的」。
 */
export function validateEnginePatch(patch: GeoEngineInput): RuleViolation[] {
  const violations: RuleViolation[] = []
  if (patch.code !== undefined) {
    violations.push({
      field: 'code',
      message: '引擎 code 不能修改（历史查询结果按 code 存快照，改了会指向一个不存在的引擎）',
    })
  }
  if (patch.name !== undefined) violations.push(...checkName(patch.name, false))
  if (patch.vendor !== undefined) violations.push(...checkVendor(patch.vendor, false))
  if (patch.accessType !== undefined) violations.push(...checkAccessType(patch.accessType, true))
  if (patch.model !== undefined) violations.push(...checkModel(patch.model))
  if (patch.baseUrl !== undefined) violations.push(...checkBaseUrl(patch.baseUrl))
  if (patch.pricePerQueryCents !== undefined) {
    violations.push(...checkPrice('pricePerQueryCents', patch.pricePerQueryCents, true))
  }
  if (patch.priceInPerMTokenCents !== undefined) {
    violations.push(...checkPrice('priceInPerMTokenCents', patch.priceInPerMTokenCents, true))
  }
  if (patch.priceOutPerMTokenCents !== undefined) {
    violations.push(...checkPrice('priceOutPerMTokenCents', patch.priceOutPerMTokenCents, true))
  }
  if (patch.rateLimitPerMin !== undefined) {
    violations.push(...checkRateLimit(patch.rateLimitPerMin, true))
  }
  if (patch.timeoutMs !== undefined) violations.push(...checkTimeout(patch.timeoutMs, true))
  if (patch.sort !== undefined) violations.push(...checkSort(patch.sort))
  return violations
}

/**
 * 脱敏一个密钥值：只留**前 3 后 2**，中间一律固定 6 个星号。
 *
 * 中间用**固定长度**而不是按原值长度补星，是刻意的：`sk-****************ab` 这种
 * 写法把原值的长度泄了出去，而长度本身是爆破时的有用信息（32 位 hex 和 51 位
 * base58 的搜索空间差着好几个数量级）。
 *
 * 短值（长度 ≤ 前缀+后缀）一律**整串打星**，绝不退化成「原样返回」——那是这类
 * 函数最经典的坑：`mask('abc')` 返回 `'abc'`，于是一把 3 个字符的测试 key
 * 在接口上是明文，而没有人会注意到。
 *
 * @param value - 原始密钥值
 * @returns 脱敏串；`value` 不是字符串时返回空串
 */
export function maskSecretValue(value: unknown): string {
  if (typeof value !== 'string') return ''
  const stars = '******'
  if (value.length <= MASK_KEEP_HEAD + MASK_KEEP_TAIL) return stars
  return `${value.slice(0, MASK_KEEP_HEAD)}${stars}${value.slice(value.length - MASK_KEEP_TAIL)}`
}

/**
 * 整包凭据脱敏：键名原样保留，每个值过 {@link maskSecretValue}。
 *
 * 键名保留是必要的——平台运营要能看出「这个引擎配了 apiKey 没配 secretKey」，
 * 而那正是接入失败最常见的原因。键名本身不是秘密（它写在适配器文件的注释里）。
 *
 * @param credentials - 明文整包凭据
 * @returns 脱敏后的同形对象；非字符串值会被丢掉（凭据整包是 `Record<string,string>`）
 */
export function maskCredentials(credentials: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  if (credentials === null || typeof credentials !== 'object') return out
  for (const [key, value] of Object.entries(credentials)) {
    if (typeof value !== 'string') continue
    out[key] = maskSecretValue(value)
  }
  return out
}

/** {@link parseCredentialsJson} 的结果：要么解出一包凭据，要么给出一条中文原因。 */
export type ParseCredentialsResult =
  | { ok: true; credentials: Record<string, string> }
  | { ok: false; message: string }

/**
 * 把库里那串 JSON 解成整包凭据，并校验形状。
 *
 * **解析失败不抛异常**，而是返回 `{ ok: false }`：这个函数有两个调用方——解密
 * 之后的内部读取（失败意味着密钥轮换出了事，要带着引擎 code 抛业务异常），
 * 与接口层的入参校验（失败要变成一条 400 的字段级提示）。两边要的错误形态不同，
 * 由纯函数统一抛一种异常只会让其中一边再 catch 一次。
 *
 * 值一律要求是字符串：`EngineAskContext.credentials` 的类型就是
 * `Record<string, string>`，放进去一个数字之后，适配器里 `apiKey.trim()` 会在
 * 运行时炸，而炸的位置离真正的原因（后台表单填了个数字）隔着一整条队列。
 *
 * @param raw - 库里那串 JSON；`null` / `undefined` / 空串一律视为「没配凭据」，返回空对象
 */
export function parseCredentialsJson(raw: unknown): ParseCredentialsResult {
  if (raw === null || raw === undefined || raw === '') return { ok: true, credentials: {} }
  if (typeof raw !== 'string') return { ok: false, message: '凭据必须是一串 JSON 文本' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, message: '凭据不是合法的 JSON' }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: '凭据必须是一个 JSON 对象（形如 {"apiKey":"sk-xxx"}）' }
  }

  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length > GEO_CREDENTIAL_ENTRY_MAX) {
    return { ok: false, message: `凭据最多 ${GEO_CREDENTIAL_ENTRY_MAX} 个键` }
  }

  const credentials: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (key.trim() === '') return { ok: false, message: '凭据的键名不能为空' }
    if (key.length > GEO_CREDENTIAL_KEY_MAX) {
      return { ok: false, message: `凭据键名「${key.slice(0, 16)}…」过长` }
    }
    if (typeof value !== 'string') {
      return { ok: false, message: `凭据「${key}」的值必须是字符串` }
    }
    if (value.length > GEO_CREDENTIAL_VALUE_MAX) {
      return { ok: false, message: `凭据「${key}」的值过长` }
    }
    credentials[key] = value
  }
  return { ok: true, credentials }
}

/**
 * 校验「品牌选的这些引擎 code 是不是都在启用集合里」。
 *
 * 纯函数版：**启用集合由调用方查出来传进来**（`GeoEngineService.enabledCodes()`）。
 * 这样它既能在 `geo-brand.service.ts` 里用，也能在 seed / 导入脚本里用，
 * 而不需要把 Nest 的注入链拖进来。
 *
 * 只校验「在不在启用集合里」，不校验「代码里有没有对应的适配器」：后者是装配期
 * 的事（`EngineRegistry.get()` 取不到会抛），放在这里等于把一个平台侧的装配错误
 * 报成商家侧的表单错误。
 *
 * @param codes - 已归一（小写、去重）的引擎 code
 * @param enabledCodes - 当前启用的引擎 code 集合
 */
export function assertEngineCodesExist(
  codes: readonly string[],
  enabledCodes: ReadonlySet<string>,
): RuleViolation[] {
  const unknown = codes.filter((code) => !enabledCodes.has(code))
  if (unknown.length === 0) return []
  return [
    {
      field: 'engineCodes',
      message:
        `引擎「${unknown.join('、')}」不可用（没有这个引擎，或平台已把它停用）。` +
        '选了不可用的引擎，跑批时它会被静默跳过，而你以为自己在监测它。',
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐字段校验（本文件私有）
// ─────────────────────────────────────────────────────────────────────────────

function checkCode(value: unknown, required: boolean): RuleViolation[] {
  if (value === undefined || value === null || value === '') {
    return required ? [{ field: 'code', message: '引擎 code 不能为空' }] : []
  }
  if (typeof value !== 'string') return [{ field: 'code', message: '引擎 code 必须是字符串' }]
  if (!GEO_ENGINE_CODE_PATTERN.test(value)) {
    return [
      {
        field: 'code',
        message:
          `引擎 code「${value.slice(0, 40)}」不合法：` +
          '小写字母开头，之后是 1–31 个小写字母/数字/连字符（如 qwen、baidu-ernie）',
      },
    ]
  }
  return []
}

function checkName(value: unknown, required: boolean): RuleViolation[] {
  if (value === undefined || value === null) {
    return required ? [{ field: 'name', message: '引擎名不能为空' }] : []
  }
  if (typeof value !== 'string') return [{ field: 'name', message: '引擎名必须是字符串' }]
  const name = value.trim()
  if (name === '') return [{ field: 'name', message: '引擎名不能为空（去掉首尾空白之后）' }]
  if ([...name].length > GEO_ENGINE_NAME_MAX) {
    return [{ field: 'name', message: `引擎名不能超过 ${GEO_ENGINE_NAME_MAX} 个字` }]
  }
  return []
}

function checkVendor(value: unknown, required: boolean): RuleViolation[] {
  if (value === undefined || value === null) {
    return required ? [{ field: 'vendor', message: '厂商不能为空' }] : []
  }
  if (typeof value !== 'string') return [{ field: 'vendor', message: '厂商必须是字符串' }]
  const vendor = value.trim()
  if (vendor === '') return [{ field: 'vendor', message: '厂商不能为空（去掉首尾空白之后）' }]
  if (vendor.length > GEO_ENGINE_VENDOR_MAX) {
    return [{ field: 'vendor', message: `厂商不能超过 ${GEO_ENGINE_VENDOR_MAX} 个字符` }]
  }
  return []
}

function checkAccessType(value: unknown, provided: boolean): RuleViolation[] {
  if (value === undefined || value === null) {
    return provided ? [{ field: 'accessType', message: '接入方式不能为空' }] : []
  }
  if (!GEO_ACCESS_TYPES.includes(value as GeoAccessTypeLike)) {
    return [{ field: 'accessType', message: `接入方式只能是 ${GEO_ACCESS_TYPES.join(' / ')}` }]
  }
  return []
}

function checkModel(value: unknown): RuleViolation[] {
  if (value === undefined || value === null || value === '') return []
  if (typeof value !== 'string') return [{ field: 'model', message: '模型名必须是字符串' }]
  if (value.length > GEO_ENGINE_MODEL_MAX) {
    return [{ field: 'model', message: `模型名不能超过 ${GEO_ENGINE_MODEL_MAX} 个字符` }]
  }
  return []
}

function checkBaseUrl(value: unknown): RuleViolation[] {
  if (value === undefined || value === null || value === '') return []
  if (typeof value !== 'string') return [{ field: 'baseUrl', message: '接口地址必须是字符串' }]
  if (value.length > GEO_ENGINE_BASE_URL_MAX) {
    return [{ field: 'baseUrl', message: `接口地址不能超过 ${GEO_ENGINE_BASE_URL_MAX} 个字符` }]
  }
  // 只认 http/https。填了一个 `ws://` 或者少打了协议的地址，表现是跑批时每一条
  // 都失败，而错误信息来自 HTTP 库、看不出是这里填错了。
  if (!/^https?:\/\/[^\s]+$/.test(value)) {
    return [{ field: 'baseUrl', message: '接口地址必须以 http:// 或 https:// 开头' }]
  }
  return []
}

/** 单价：非负整数（分）。三个单价字段共用。 */
function checkPrice(field: string, value: unknown, provided: boolean): RuleViolation[] {
  if (value === undefined || value === null) {
    return provided ? [{ field, message: '单价不能为空' }] : []
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return [{ field, message: '单价必须是整数（单位：分）' }]
  }
  if (value < 0) return [{ field, message: '单价不能是负数' }]
  return []
}

function checkRateLimit(value: unknown, provided: boolean): RuleViolation[] {
  if (value === undefined || value === null) {
    return provided ? [{ field: 'rateLimitPerMin', message: '限速不能为空' }] : []
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return [{ field: 'rateLimitPerMin', message: '限速必须是整数' }]
  }
  if (value < GEO_RATE_LIMIT_MIN || value > GEO_RATE_LIMIT_MAX) {
    return [
      {
        field: 'rateLimitPerMin',
        message: `限速只能在 ${GEO_RATE_LIMIT_MIN}–${GEO_RATE_LIMIT_MAX} 次/分钟之间`,
      },
    ]
  }
  return []
}

function checkTimeout(value: unknown, provided: boolean): RuleViolation[] {
  if (value === undefined || value === null) {
    return provided ? [{ field: 'timeoutMs', message: '超时不能为空' }] : []
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return [{ field: 'timeoutMs', message: '超时必须是整数（毫秒）' }]
  }
  if (value < GEO_TIMEOUT_MS_MIN || value > GEO_TIMEOUT_MS_MAX) {
    return [
      {
        field: 'timeoutMs',
        message: `超时只能在 ${GEO_TIMEOUT_MS_MIN}–${GEO_TIMEOUT_MS_MAX} 毫秒之间`,
      },
    ]
  }
  return []
}

function checkSort(value: unknown): RuleViolation[] {
  if (value === undefined || value === null) return []
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return [{ field: 'sort', message: '排序必须是整数' }]
  }
  return []
}
