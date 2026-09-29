import { describe, expect, it } from 'vitest'
import { buildJsonSchemaHint, parseJsonLoose, repairTruncated, stripCodeFence } from './json-schema'
import type { JsonSchema } from './types'

const MENTION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          entityName: { type: 'string', description: '实体名' },
          position: { type: 'integer', description: '出现位次，从 1 开始' },
          isCited: { type: 'boolean' },
          sentiment: { type: 'string', enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] },
          sentimentScore: { type: 'integer' },
          snippet: { type: 'string' },
        },
        required: ['entityName', 'position', 'isCited', 'sentiment'],
      },
    },
  },
  required: ['mentions'],
}

describe('buildJsonSchemaHint', () => {
  it('把 schema 转成字段清单，标出必填/可选与枚举取值', () => {
    const hint = buildJsonSchemaHint(MENTION_SCHEMA)
    expect(hint).toContain('请严格只输出一个 JSON 对象')
    expect(hint).toContain('mentions (array，必填)')
    expect(hint).toContain('entityName (string，必填，实体名)')
    expect(hint).toContain('snippet (string，可选)')
    expect(hint).toContain('只能取 "POSITIVE" / "NEUTRAL" / "NEGATIVE"')
  })

  it('数组会展开"数组每项"这一层', () => {
    expect(buildJsonSchemaHint(MENTION_SCHEMA)).toContain('数组每项')
  })

  it('空 schema / 没有 properties 的 schema 不抛错', () => {
    expect(buildJsonSchemaHint({})).toContain('请严格只输出')
    expect(buildJsonSchemaHint({ type: 'string' })).toContain('string')
  })

  it('自引用 schema 不会把栈撑爆', () => {
    const node: JsonSchema = { type: 'object', properties: {} }
    node.properties = { self: node }
    expect(() => buildJsonSchemaHint(node)).not.toThrow()
    expect(buildJsonSchemaHint(node)).toContain('递归引用')
  })
})

describe('stripCodeFence', () => {
  it('剥掉 ```json 围栏', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('剥掉无语言标注的围栏', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('没有围栏时原样返回', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}')
  })
})

describe('parseJsonLoose —— 6 种脏输入', () => {
  it('① 干净的 JSON 直接解析', () => {
    expect(parseJsonLoose('{"mentions":[]}')).toEqual({ mentions: [] })
  })

  it('② 包在 ```json 围栏里', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('③ 前后有客套话（"好的，以下是结果："）', () => {
    expect(parseJsonLoose('好的，以下是结果：\n{"a":1}\n希望对你有帮助。')).toEqual({ a: 1 })
  })

  it('④ 被 maxTokens 截断：数组里最后一个对象没闭合', () => {
    const truncated =
      '{"mentions":[{"entityName":"A","position":1},{"entityName":"B","position":2'
    expect(parseJsonLoose(truncated)).toEqual({
      mentions: [
        { entityName: 'A', position: 1 },
        { entityName: 'B', position: 2 },
      ],
    })
  })

  it('⑤ 截断在字符串中间：未闭合的引号被补上', () => {
    expect(parseJsonLoose('{"mentions":[],"note":"这条被截断了')).toEqual({
      mentions: [],
      note: '这条被截断了',
    })
  })

  it('⑥ 截断在 key 之后、value 之前：把悬空的 key 丢掉', () => {
    expect(parseJsonLoose('{"mentions":[],"note":')).toEqual({ mentions: [] })
  })

  it('围栏 + 客套话 + 截断三样一起来也能修出来', () => {
    const dirty = '好的：\n```json\n{"mentions":[{"entityName":"A"'
    expect(parseJsonLoose(dirty)).toEqual({ mentions: [{ entityName: 'A' }] })
  })

  it('顶层是数组时也能解析', () => {
    expect(parseJsonLoose('前言\n[1,2,3]')).toEqual([1, 2, 3])
  })

  it('完全修不动时返回 undefined，绝不抛', () => {
    expect(parseJsonLoose('模型今天不想输出 JSON')).toBeUndefined()
    expect(parseJsonLoose('')).toBeUndefined()
    expect(parseJsonLoose('   ')).toBeUndefined()
    expect(parseJsonLoose('null')).toBeUndefined()
  })
})

describe('repairTruncated', () => {
  it('补齐未闭合的对象与数组括号', () => {
    expect(repairTruncated('{"a":[1,2')).toBe('{"a":[1,2]}')
  })

  it('去掉尾部悬空的逗号', () => {
    expect(repairTruncated('{"a":1,')).toBe('{"a":1}')
  })

  it('截断在转义符上时把它一起去掉', () => {
    expect(JSON.parse(repairTruncated('{"a":"x\\'))).toEqual({ a: 'x' })
  })

  it('已经完整的 JSON 原样返回', () => {
    expect(repairTruncated('{"a":1}')).toBe('{"a":1}')
  })
})
