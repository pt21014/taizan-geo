import { describe, expect, it } from 'vitest'

import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN } from './reserved-slugs'
import { suggestSlugFromName, suggestUniqueSlug } from './slug-suggest'
import { isProvisionError } from './types'

describe('suggestSlugFromName', () => {
  it('中文店名：逐字转不带声调的拼音，拼接成小写候选', () => {
    expect(suggestSlugFromName('楼下便利店')).toBe('louxiabianlidian')
  })

  it('混合中英文/数字：非中文原样保留（转小写），中文转拼音', () => {
    expect(suggestSlugFromName('楼下ABC便利店123')).toBe('louxiaabcbianlidian123')
  })

  it('极短名称：清洗结果不足 SLUG_MIN_LENGTH 时垫到下限', () => {
    const result = suggestSlugFromName('AB')
    expect(result.length).toBeGreaterThanOrEqual(SLUG_MIN_LENGTH)
    expect(result).toMatch(SLUG_PATTERN)
    expect(result.startsWith('ab')).toBe(true)
  })

  it('单个中文字也能凑出合法长度（"店" → "dian"）', () => {
    expect(suggestSlugFromName('店')).toBe('dian')
  })

  it('店名里的空格/标点被折成连字符，连续的合并，首尾不留连字符', () => {
    expect(suggestSlugFromName('我的 小店！')).toBe('wode-xiaodian')
  })

  it('整段清洗完是空的（比如全是符号/emoji）时回落到固定基底', () => {
    expect(suggestSlugFromName('★★★')).toBe('shop')
  })

  it('空字符串 / 非字符串输入也能产出一个合法候选，不抛错', () => {
    expect(suggestSlugFromName('')).toMatch(SLUG_PATTERN)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 边界输入探测运行时容错
    expect(suggestSlugFromName(undefined as any)).toMatch(SLUG_PATTERN)
  })

  it('产出恒满足 SLUG_PATTERN 与长度区间（多组样本抽查）', () => {
    for (const name of ['楼下便利店', 'AB', '店', 'My Brand 旗舰店', '  ', '超长'.repeat(20)]) {
      const slug = suggestSlugFromName(name)
      expect(slug, `name=${name} → ${slug}`).toMatch(SLUG_PATTERN)
      expect(slug.length).toBeGreaterThanOrEqual(SLUG_MIN_LENGTH)
      expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH)
    }
  })

  it('超长店名：清洗结果被截断到 SLUG_MAX_LENGTH 且不以连字符收尾', () => {
    const slug = suggestSlugFromName('超长店名'.repeat(20))
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('suggestUniqueSlug', () => {
  it('基底既不是保留字也没被占用：原样返回，isTaken 只被查一次', async () => {
    let calls = 0
    const isTaken = (_slug: string) => {
      calls += 1
      return false
    }
    const slug = await suggestUniqueSlug('楼下便利店', isTaken)
    expect(slug).toBe('louxiabianlidian')
    expect(calls).toBe(1)
  })

  it('基底命中保留字：追加随机后缀重试，直到不再是保留字', async () => {
    // 'Admin' 转出来的候选恰好是保留字 'admin'。
    const slug = await suggestUniqueSlug('Admin', () => false, {
      randomSuffix: () => 'x7k9',
    })
    expect(slug).toBe('admin-x7k9')
  })

  it('基底已被占用：追加随机后缀重试，直到 isTaken 回 false', async () => {
    const taken = new Set(['louxiabianlidian', 'louxiabianlidian-aaaa'])
    let call = 0
    const suffixes = ['aaaa', 'bbbb']
    const slug = await suggestUniqueSlug('楼下便利店', (candidate) => taken.has(candidate), {
      randomSuffix: () => suffixes[call++] ?? 'zzzz',
    })
    expect(slug).toBe('louxiabianlidian-bbbb')
  })

  it('连续 maxAttempts 次都冲突：抛 ProvisionError(SLUG_TAKEN)', async () => {
    let thrown: unknown
    try {
      await suggestUniqueSlug('楼下便利店', () => true, {
        maxAttempts: 3,
        randomSuffix: () => 'aaaa',
      })
    } catch (error) {
      thrown = error
    }
    expect(isProvisionError(thrown)).toBe(true)
    if (isProvisionError(thrown)) expect(thrown.reason).toBe('SLUG_TAKEN')
  })

  it('后缀长度可配置，且不会把结果撑过 SLUG_MAX_LENGTH', async () => {
    const longName = '超长店名超长店名超长店名超长店名超长店名'
    const slug = await suggestUniqueSlug(longName, (candidate) => !candidate.endsWith('-9999'), {
      suffixLength: 4,
      randomSuffix: () => '9999',
    })
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH)
    expect(slug.endsWith('-9999')).toBe(true)
  })
})
