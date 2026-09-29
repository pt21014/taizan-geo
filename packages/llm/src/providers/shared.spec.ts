import { describe, expect, it } from 'vitest'
import { asArray, asNumber, asRecord, asString, pick, trimBaseUrl } from './shared'

describe('取值助手', () => {
  it('asRecord 只认普通对象，null 与数组都返回 undefined', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord(null)).toBeUndefined()
    expect(asRecord([1])).toBeUndefined()
    expect(asRecord('x')).toBeUndefined()
  })

  it('asArray 非数组一律返回空数组', () => {
    expect(asArray([1, 2])).toEqual([1, 2])
    expect(asArray(undefined)).toEqual([])
    expect(asArray({ length: 2 })).toEqual([])
  })

  it('asString 空串与非字符串都返回 undefined', () => {
    expect(asString('x')).toBe('x')
    expect(asString('')).toBeUndefined()
    expect(asString(1)).toBeUndefined()
  })

  it('asNumber 排除 NaN / Infinity / 字符串数字', () => {
    expect(asNumber(0)).toBe(0)
    expect(asNumber(NaN)).toBeUndefined()
    expect(asNumber(Infinity)).toBeUndefined()
    expect(asNumber('1')).toBeUndefined()
  })

  it('pick 中途断链返回 undefined，不抛错', () => {
    expect(pick({ a: { b: 1 } }, 'a', 'b')).toBe(1)
    expect(pick({ a: null }, 'a', 'b')).toBeUndefined()
    expect(pick(undefined, 'a')).toBeUndefined()
  })

  it('trimBaseUrl 去掉末尾所有斜杠', () => {
    expect(trimBaseUrl('https://a.com/v1//')).toBe('https://a.com/v1')
    expect(trimBaseUrl('https://a.com/v1')).toBe('https://a.com/v1')
  })
})
