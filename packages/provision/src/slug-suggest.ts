/**
 * 没填店铺路径时,根据店铺名称自动生成一个可用 slug（T-自助注册 slug 选填）。
 *
 * 两个函数分层：
 *
 * - {@link suggestSlugFromName} 是**纯函数**——中文转拼音、非中文原样保留、按
 *   {@link validateSlug} 同一套字符集/长度规则清洗。不查库、不管保留字，
 *   因为「查库」这件事一旦混进来，这个函数就没法在裸 node 环境里跑单测了。
 * - {@link suggestUniqueSlug} 在它之上加一层「避让」：保留字判定（`isReservedSlug`，
 *   纯函数，不算破坏「零 DB」）与已占用判定（`isTaken`，**调用方注入**，
 *   一般是 `tx.tenant.findUnique`）。冲突就追加短随机后缀重试，重试次数耗尽就抛
 *   {@link ProvisionError}——宁可注册失败一次，也不要把「查不到可用路径」悄悄
 *   吞掉、开出一家路径长得莫名其妙的店。
 *
 * @packageDocumentation
 */

import { pinyin } from 'pinyin-pro'

import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, isReservedSlug } from './reserved-slugs'
import { ProvisionError } from './types'

/** 清洗结果太短时用来垫长度的字符——不是字母表里挑出来的词，纯粹是占位。 */
const PAD_CHAR = 'x'

/** 清洗结果整段都用不了（比如全是表情符号）时的兜底基底。 */
const FALLBACK_BASE = 'shop'

/** 追加随机后缀时用的字符表：小写字母 + 数字，与 {@link SLUG_PATTERN} 的字符集一致。 */
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * 把「拼音转换后的原始字符串」清洗成落在 {@link SLUG_MIN_LENGTH}–{@link SLUG_MAX_LENGTH}
 * 区间、只含小写字母数字连字符、不以连字符开头结尾的候选。
 *
 * 与 `validateSlug` 共用的是**规则**（字符集、长度），不是校验本身——这里产出的是
 * 一个「已经合法」的字符串，不需要再跑一遍 `validateSlug` 去确认（`suggestSlugFromName`
 * 的单测直接断言产出满足 `SLUG_PATTERN`）。
 */
function cleanupCandidate(raw: string): string {
  const collapsed = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')

  const base = collapsed.length > 0 ? collapsed : FALLBACK_BASE

  const padded =
    base.length < SLUG_MIN_LENGTH ? base + PAD_CHAR.repeat(SLUG_MIN_LENGTH - base.length) : base

  if (padded.length <= SLUG_MAX_LENGTH) return padded

  // 超长：砍到上限，再把砍出来的结尾连字符收掉（收完不会低于下限，MAX 比 MIN 宽裕得多）。
  return padded.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '')
}

/**
 * 根据店铺名称生成一个候选 slug。**纯函数**：不查库、不判断保留字，调用方按需
 * 用 {@link isReservedSlug} 与自己的查重逻辑再避让一轮（见 {@link suggestUniqueSlug}）。
 *
 * 转换规则：
 * - 中文字符逐字转不带声调的拼音（`pinyin-pro`，`toneType: 'none'`）；
 * - 非中文字符原样保留、统一转小写；
 * - 结果里非 `[a-z0-9]` 的片段（空格、标点、emoji…）折成一个连字符，
 *   连续连字符合并，掐掉开头结尾的连字符；
 * - 太短（&lt; {@link SLUG_MIN_LENGTH}）就垫到下限，太长（&gt; {@link SLUG_MAX_LENGTH}）
 *   就截断；清洗完整段为空（比如店名全是符号）就回落到固定基底 `shop`——
 *   这个基底本身命中保留字是**预期行为**，交给 {@link suggestUniqueSlug} 去加后缀。
 *
 * @param name - 店铺名称，一般是 `SignupDto.name`（尚未跑 `validateTenantName`，
 *   这里对输入形状不做假设，任何字符串都能产出一个合法候选）
 */
export function suggestSlugFromName(name: string): string {
  const trimmed = String(name ?? '').trim()
  if (trimmed.length === 0) return cleanupCandidate('')

  const joined = pinyin(trimmed, { toneType: 'none', type: 'array' }).join('')
  return cleanupCandidate(joined)
}

/** {@link suggestUniqueSlug} 的选项。 */
export interface SuggestUniqueSlugOptions {
  /** 最多尝试几次（含不带后缀的第一次），默认 5。 */
  maxAttempts?: number
  /** 冲突时追加的随机后缀长度，默认 4。 */
  suffixLength?: number
  /**
   * 随机后缀生成器，默认用 `Math.random()` 从 {@link SUFFIX_ALPHABET} 里抽。
   * 单测注入一个确定性实现，不然「追加后缀重试」这件事测不出稳定断言。
   */
  randomSuffix?: (length: number) => string
}

function defaultRandomSuffix(length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += SUFFIX_ALPHABET[Math.floor(Math.random() * SUFFIX_ALPHABET.length)]
  }
  return out
}

/** 把随机后缀接到基底上，超长就砍基底（后缀是这一轮用来避让冲突的凑数，砍它等于白试）。 */
function withSuffix(base: string, suffix: string): string {
  const room = SLUG_MAX_LENGTH - 1 - suffix.length
  const trimmedBase = (base.length > room ? base.slice(0, room) : base).replace(/-+$/, '')
  return `${trimmedBase}-${suffix}`
}

/**
 * 在 {@link suggestSlugFromName} 的基础上避开保留字与已占用的路径。
 *
 * 保留字用 {@link isReservedSlug}（纯函数）；是否已占用由调用方通过 `isTaken` 注入——
 * 本函数本身不认识任何数据库客户端，一般传 `(slug) => tx.tenant.findUnique({ where: { slug } })
 * .then((row) => row !== null)`，且调用方应该在**同一个事务快照**里查，避免这里判完到
 * `provisionTenant` 真正建之间那条缝（那条缝的后果是拿一个看似可用、实际已被抢走的
 * slug 去建租户，`provisionTenant` 自己那道 `SLUG_TAKEN` 检查会兜底但体验是白填一次）。
 *
 * 冲突就在**清洗后的基底**上追加短随机后缀重试；`maxAttempts` 次都冲突就抛
 * {@link ProvisionError}（`reason: 'SLUG_TAKEN'`）——这不是商家填错了什么，
 * 但复用这个 reason 是因为对前端而言「这个路径用不了，换一个」是同一句话，
 * 没必要为「自动生成连续撞车」单开一个原因码。
 *
 * @throws {@link ProvisionError} `SLUG_TAKEN`，尝试次数耗尽仍未找到可用 slug 时
 */
export async function suggestUniqueSlug(
  name: string,
  isTaken: (slug: string) => boolean | Promise<boolean>,
  options: SuggestUniqueSlugOptions = {},
): Promise<string> {
  const base = suggestSlugFromName(name)
  const maxAttempts = options.maxAttempts ?? 5
  const suffixLength = options.suffixLength ?? 4
  const randomSuffix = options.randomSuffix ?? defaultRandomSuffix

  let candidate = base
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!isReservedSlug(candidate) && !(await isTaken(candidate))) {
      return candidate
    }
    candidate = withSuffix(base, randomSuffix(suffixLength))
  }

  throw new ProvisionError(
    'SLUG_TAKEN',
    '根据店铺名称自动生成的店铺路径连续冲突，请手动填写一个店铺路径',
  )
}
