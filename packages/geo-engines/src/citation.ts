/**
 * 引用 URL 的归一化与去重。
 *
 * 为什么必须归一：同一篇文章在六家引擎的回答里会以六个形态出现——带 utm 参数的、
 * 带 `#section` 锚点的、末尾多一个斜杠的、host 大小写不同的。不归一就统计不出
 * "这个域名被引用了几次"，而引用统计正是 GEO 报表的核心指标之一。
 *
 * 全部是纯函数，不发请求、不查 DNS。
 */
import type { EngineCitation } from './types'

/** 归一化时要丢掉的查询参数（前缀匹配 `utm_`，其余精确匹配）。 */
const TRACKING_PARAM_EXACT = new Set([
  'spm',
  'scm',
  'from',
  'src',
  'ref',
  'referrer',
  'fbclid',
  'gclid',
  'msclkid',
  'yclid',
  '_ga',
  'share_token',
  'share_source',
])

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase()
  return k.startsWith('utm_') || TRACKING_PARAM_EXACT.has(k)
}

/**
 * 归一化一个 URL。
 *
 * 做四件事：去掉 `utm_*` 等跟踪参数、去掉 `#fragment`、去掉路径末尾斜杠、
 * host 转小写。**协议原样保留**——`http` 不会被升级成 `https`：同一个站点的
 * http 与 https 在引用统计里确实可能是两条不同的记录（有的站没配跳转），
 * 替它做决定会造成"统计数对不上实际抓到的链接"。
 *
 * 解析不出来的字符串（引擎偶尔会把 `example.com/a` 这种裸域名当 url 返回）
 * 原样 trim 后返回，不抛错——一条脏引用不该让整次解析失败。
 */
export function normalizeUrl(raw: string): string {
  const input = (raw ?? '').trim()
  if (input === '') return ''
  let u: URL
  try {
    u = new URL(input)
  } catch {
    return input
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return input

  u.hash = ''
  for (const key of [...u.searchParams.keys()]) {
    if (isTrackingParam(key)) u.searchParams.delete(key)
  }
  // host 小写：URL 已经帮我们做了，这里只是把意图写明。
  u.hostname = u.hostname.toLowerCase()

  let out = u.toString()
  // 去掉查询串为空时 URL 仍会留下的那个 `?`
  out = out.replace(/\?$/, '')
  // 末尾斜杠：只在没有 query 的时候去，且不把 `https://example.com/` 削成没有路径的形态
  if (!out.includes('?') && out.endsWith('/')) {
    const trimmed = out.slice(0, -1)
    // `https://example.com` 仍然合法；`https:/` 这种削过头的不要
    if (/^https?:\/\/[^/]+$/.test(trimmed) || trimmed.split('/').length > 3) {
      out = trimmed
    }
  }
  return out
}

/**
 * 取一个 URL 的域名，用于 `GeoCitation.domain` 与来源分类。
 *
 * - 去掉 `www.` 前缀（`www.zhihu.com` 与 `zhihu.com` 必须统计成同一个来源）
 * - 去掉端口
 * - **中文域名保留原字面**：`new URL()` 会把 `中文.中国` 转成 punycode
 *   （`xn--fiq228c.xn--fiqs8s`），那串东西落库以后没人看得懂，所以原串里
 *   带非 ASCII 时直接从原串取 authority 段。
 */
export function domainOf(raw: string): string {
  const input = (raw ?? '').trim()
  if (input === '') return ''

  // 先从原串里抠 authority 段，这样中文域名不会被 punycode 化
  const m = input.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/)
  const authority = m ? m[1]! : input.split(/[/?#]/)[0]!
  // 去掉 userinfo
  const hostAndPort = authority.includes('@') ? authority.slice(authority.indexOf('@') + 1) : authority
  // 去掉端口（IPv6 字面量形如 [::1]:8080，先处理方括号）
  let host = hostAndPort
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    host = end >= 0 ? host.slice(0, end + 1) : host
  } else {
    const colon = host.lastIndexOf(':')
    if (colon > 0) host = host.slice(0, colon)
  }
  host = host.toLowerCase()
  if (host.startsWith('www.') && host.length > 4) host = host.slice(4)
  return host
}

/**
 * 按归一化后的 URL 去重，保留首次出现的顺序。
 *
 * 合并策略：后来的同一条引用如果补上了前一条缺的 `title`/`siteName`/`snippet`，
 * 就补进去——引擎经常在第一条只给 url、在后面的重复项里才给标题。
 * `index` 一律重排成 1..n（引擎给的角标在去重后会有洞，落库时角标要连续）。
 * 空 url 的条目直接丢弃。
 */
export function dedupeCitations(citations: readonly EngineCitation[]): EngineCitation[] {
  const byUrl = new Map<string, EngineCitation>()
  for (const c of citations ?? []) {
    const url = normalizeUrl(c?.url ?? '')
    if (url === '') continue
    const existing = byUrl.get(url)
    if (!existing) {
      byUrl.set(url, { ...c, url })
      continue
    }
    if (!existing.title && c.title) existing.title = c.title
    if (!existing.siteName && c.siteName) existing.siteName = c.siteName
    if (!existing.snippet && c.snippet) existing.snippet = c.snippet
  }
  return [...byUrl.values()].map((c, i) => ({ ...c, index: i + 1 }))
}

/**
 * 从回答正文里正则兜底抽 URL。
 *
 * 给**不返回结构化引用字段**的引擎用（混元的 OpenAI 兼容端点、部分自建网关）。
 * 明确是兜底：抽出来的链接没有标题、没有站点名，只能撑起"引用了哪些域名"这一档
 * 统计，撑不起引用列表的展示。
 *
 * 两处刻意的取舍：
 * 1. **匹配时就把 CJK 字符排除在 URL 之外**。中文正文里 `见 https://a.com/p，谢谢`
 *    后面往往不带空格，按"非空白"贪婪匹配会把"，谢谢"一起吞进 URL 再 percent-encode
 *    成一串乱码。代价是正文里的**中文域名裸链接抽不到**——结构化引用字段里的
 *    中文域名不受影响（`domainOf` 专门处理），而兜底路径本来就只是兜底。
 * 2. 结尾的 ASCII 标点与成对括号会被反复剥掉，`见 (https://a.com/p).` 这种
 *    写法不会在域名统计里留下带括号的脏 URL。
 */
export function extractUrlsFromText(text: string): EngineCitation[] {
  const src = text ?? ''
  // 排除 U+3000..U+303F(CJK 标点)、U+4E00..U+9FFF(汉字)、U+FF00..U+FFEF(全角字符)
  const matches =
    src.match(/https?:\/\/[^\s<>"'`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g) ?? []
  const out: EngineCitation[] = []
  for (const m of matches) {
    // 反复剥掉结尾的成对/句读标点
    let url = m
    let prev = ''
    while (url !== prev) {
      prev = url
      url = url.replace(/[.,;:!?)\]}>」』】）〕，。；：！？、…'"]+$/u, '')
    }
    if (url === '' || !/^https?:\/\/[^/]+/.test(url)) continue
    out.push({ url: normalizeUrl(url) })
  }
  return dedupeCitations(out)
}
