/**
 * 引用来源分类与归一化的业务规则纯函数（GEO P0 技术设计 §4.2 `geo.result.analyze`、§4.4 rules 清单）。
 *
 * ## URL 归一化/域名提取/去重来自 `@taizan/geo-engines`
 *
 * `normalizeUrl` / `domainOf` / `dedupeCitations` 三个纯函数是**引擎协议层**的东西
 * （去跟踪参数、削 `www.`、按归一化后的 URL 合并重复引用），适配器自己在 `parseXxxResponse`
 * 里就要用它们，所以它们的真源在那个包里。
 *
 * T5 写这份文件时 `@taizan/geo-engines` 的符号链接还没建出来，曾经在文件末尾放过一份
 * **逐行抄的本地镜像**。T6 依赖装好之后已经把那三个函数与配套的 `EngineCitation`
 * 类型删掉、换成真 import——两份等价实现长期共存的结局一定是其中一份被改而另一份没有，
 * 而它们分歧之后表现为「同一条引用在明细页和榜单页算成了两个域名」。
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto'

import type { GeoSourceCategory } from '@prisma/client'
import { dedupeCitations, domainOf, type EngineCitation } from '@taizan/geo-engines'

/** 落 `GeoCitation` 前的草稿。 */
export interface CitationDraft {
  url: string
  urlHash: string
  domain: string
  platform: string
  category: GeoSourceCategory
  /** 1-based，去重后的顺序。 */
  rank: number
  title?: string
}

/** 平台后台配置的来源分类规则（对应 `GeoSourcePlatformRule`）。 */
export interface SourceRule {
  /** 域名后缀（如 `baike.baidu.com`），命中含子域。 */
  pattern: string
  platform: string
  category: GeoSourceCategory
  /** 数字越小优先级越高。 */
  priority: number
}

/** {@link classifySource} 的上下文：判定 OWNED/COMPETITOR 要用到的域名。 */
export interface ClassifyContext {
  brandDomain?: string
  competitorDomains: string[]
}

/** `domain` 是不是 `root` 本身或它的子域。 */
function domainMatchesRoot(domain: string, root: string): boolean {
  if (root === '') return false
  return domain === root || domain.endsWith(`.${root}`)
}

/**
 * 判定一个域名的归类。优先级：
 *
 * 1. `OWNED`——命中 `ctx.brandDomain`（含子域）；
 * 2. `COMPETITOR`——命中 `ctx.competitorDomains` 中任意一个（含子域）；
 * 3. 按 `rules` 匹配（`pattern` 做域名后缀匹配，`priority` 小的优先）；
 * 4. 都没命中 → `{ platform: 'OTHER', category: 'OTHER' }`。
 *
 * `OWNED`/`COMPETITOR` 这两档没有"平台名"这个概念可言（自家官网不是一个第三方平台），
 * 所以 `platform` 字段直接复用分类名本身；只有落到 `rules` 分支时 `platform` 才是
 * 规则里配置的具体平台名（如 `知乎`/`百度百科`）。
 */
export function classifySource(
  domain: string,
  rules: SourceRule[],
  ctx: ClassifyContext,
): { platform: string; category: GeoSourceCategory } {
  const d = domainOf(domain)
  if (d === '') return { platform: 'OTHER', category: 'OTHER' as GeoSourceCategory }

  const brandRoot = domainOf(ctx.brandDomain ?? '')
  if (brandRoot !== '' && domainMatchesRoot(d, brandRoot)) {
    return { platform: 'OWNED', category: 'OWNED' as GeoSourceCategory }
  }

  for (const compDomain of ctx.competitorDomains ?? []) {
    const compRoot = domainOf(compDomain)
    if (compRoot !== '' && domainMatchesRoot(d, compRoot)) {
      return { platform: 'COMPETITOR', category: 'COMPETITOR' as GeoSourceCategory }
    }
  }

  const sorted = [...(rules ?? [])].sort((a, b) => a.priority - b.priority)
  for (const rule of sorted) {
    const pattern = domainOf(rule.pattern)
    if (pattern !== '' && domainMatchesRoot(d, pattern)) {
      return { platform: rule.platform, category: rule.category }
    }
  }

  return { platform: 'OTHER', category: 'OTHER' as GeoSourceCategory }
}

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * 把引擎返回的原始引用列表变成可以落 `GeoCitation` 的草稿：去重（保留首次出现顺序，
 * 补全 title/siteName/snippet 缺口）、按 `classifySource` 归类、`rank` 从 1 重排、
 * `urlHash` 是归一化后 URL 的 sha256。
 */
export function buildCitationDrafts(
  citations: EngineCitation[],
  rules: SourceRule[],
  ctx: ClassifyContext,
): CitationDraft[] {
  const deduped = dedupeCitations(citations ?? [])
  return deduped.map((c, i): CitationDraft => {
    const domain = domainOf(c.url)
    const { platform, category } = classifySource(domain, rules, ctx)
    const draft: CitationDraft = {
      url: c.url,
      urlHash: sha256Hex(c.url),
      domain,
      platform,
      category,
      rank: i + 1,
    }
    if (c.title) draft.title = c.title
    return draft
  })
}
