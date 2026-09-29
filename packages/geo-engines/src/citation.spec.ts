import { describe, expect, it } from 'vitest'
import { dedupeCitations, domainOf, extractUrlsFromText, normalizeUrl } from './citation'

describe('normalizeUrl', () => {
  it('去掉 utm_* 与其他跟踪参数，保留业务参数', () => {
    expect(normalizeUrl('https://a.com/p?utm_source=qwen&id=7&utm_medium=cpc')).toBe(
      'https://a.com/p?id=7',
    )
    expect(normalizeUrl('https://a.com/p?spm=1.2.3&gclid=x&id=7')).toBe('https://a.com/p?id=7')
  })

  it('全是跟踪参数时连问号一起去掉', () => {
    expect(normalizeUrl('https://a.com/p?utm_source=x')).toBe('https://a.com/p')
  })

  it('去掉 fragment', () => {
    expect(normalizeUrl('https://a.com/p#section-2')).toBe('https://a.com/p')
  })

  it('去掉末尾斜杠，根路径也去', () => {
    expect(normalizeUrl('https://a.com/p/')).toBe('https://a.com/p')
    expect(normalizeUrl('https://a.com/')).toBe('https://a.com')
  })

  it('host 转小写，路径大小写保留（路径是大小写敏感的）', () => {
    expect(normalizeUrl('https://WWW.A.COM/Path/To')).toBe('https://www.a.com/Path/To')
  })

  it('协议原样保留，http 不会被升级成 https', () => {
    expect(normalizeUrl('http://a.com/p')).toBe('http://a.com/p')
  })

  it('解析不出来的字符串原样 trim 返回，不抛错', () => {
    expect(normalizeUrl('  a.com/p  ')).toBe('a.com/p')
    expect(normalizeUrl('')).toBe('')
    expect(normalizeUrl('ftp://a.com/p')).toBe('ftp://a.com/p')
  })
})

describe('domainOf', () => {
  it('去掉 www. 前缀', () => {
    expect(domainOf('https://www.zhihu.com/question/1')).toBe('zhihu.com')
    expect(domainOf('https://zhihu.com/question/1')).toBe('zhihu.com')
  })

  it('去掉端口与 userinfo', () => {
    expect(domainOf('http://a.com:8080/p')).toBe('a.com')
    expect(domainOf('http://user:pw@a.com:8080/p')).toBe('a.com')
  })

  it('中文域名保留原字面，不转 punycode', () => {
    expect(domainOf('https://中文域名.中国/页面')).toBe('中文域名.中国')
  })

  it('裸域名（引擎偶尔会这么回）也能取出来', () => {
    expect(domainOf('example.com/a/b')).toBe('example.com')
  })

  it('空串返回空串', () => {
    expect(domainOf('')).toBe('')
  })

  it('www 开头但不是前缀的域名不被误切', () => {
    expect(domainOf('https://wwwx.com/p')).toBe('wwwx.com')
  })
})

describe('dedupeCitations', () => {
  it('按归一化后的 URL 去重，保留首次出现顺序，index 重排为 1..n', () => {
    const out = dedupeCitations([
      { url: 'https://a.com/p?utm_source=x', title: 'A', index: 5 },
      { url: 'https://a.com/p/', index: 9 },
      { url: 'https://b.com/q', title: 'B', index: 2 },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]!.url).toBe('https://a.com/p')
    expect(out[0]!.index).toBe(1)
    expect(out[1]!.url).toBe('https://b.com/q')
    expect(out[1]!.index).toBe(2)
  })

  it('重复项里补齐前一条缺的 title / siteName / snippet', () => {
    const out = dedupeCitations([
      { url: 'https://a.com/p' },
      { url: 'https://a.com/p', title: 'A', siteName: '站点A', snippet: '摘要' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.title).toBe('A')
    expect(out[0]!.siteName).toBe('站点A')
    expect(out[0]!.snippet).toBe('摘要')
  })

  it('空 url 的条目直接丢弃；空数组进空数组出', () => {
    expect(dedupeCitations([{ url: '' }, { url: '   ' }])).toEqual([])
    expect(dedupeCitations([])).toEqual([])
  })
})

describe('extractUrlsFromText', () => {
  it('从正文里抽出 http/https 链接并归一去重', () => {
    const out = extractUrlsFromText(
      '可以看 https://a.com/p?utm_source=x 和 http://b.com/q ，另外 https://a.com/p 也是同一篇。',
    )
    expect(out.map((c) => c.url)).toEqual(['https://a.com/p', 'http://b.com/q'])
  })

  it('剥掉结尾的中英文标点', () => {
    expect(extractUrlsFromText('见 https://a.com/p。')[0]!.url).toBe('https://a.com/p')
    expect(extractUrlsFromText('见 (https://a.com/p).')[0]!.url).toBe('https://a.com/p')
    expect(extractUrlsFromText('见 https://a.com/p，谢谢')[0]!.url).toBe('https://a.com/p')
  })

  it('没有链接时返回空数组，不抛错', () => {
    expect(extractUrlsFromText('这段话里没有链接')).toEqual([])
    expect(extractUrlsFromText('')).toEqual([])
  })

  it('抽出来的条目只有 url 与 index，没有标题——这是兜底路径的固有代价', () => {
    const out = extractUrlsFromText('https://a.com/p')
    expect(out[0]).toEqual({ url: 'https://a.com/p', index: 1 })
  })
})
