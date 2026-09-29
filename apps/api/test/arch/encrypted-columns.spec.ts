/**
 * **业务片段的加密列对账**（`docs/SECURITY-INVARIANTS.md` K4 / `docs/PLATFORM-SCHEMA.md` §4.3）。
 *
 * 不在蓝图 §8 的 16 条编号内，登记在 `index.spec.ts` 的 `EXTRA_SPECS` 里。
 * 与 `index.spec.ts` 的 spec 11 的分工：
 *
 * | | spec 11（index.spec.ts） | 本文件 |
 * |---|---|---|
 * | 扫描范围 | `prisma/schema/**` 全部片段（含框架 `00-base/`） | **只扫 `10-business/*.prisma`** |
 * | 判定来源 | `@taizan/crypto` 的 `verifyEncryptedColumns`（含轮换覆盖那一处） | 本文件就地实现的独立扫描 |
 * | 守什么 | 三处对账的总判定 | 业务片段的 `*Enc` ↔ `*KeyId` ↔ `APP_ENCRYPTED_COLUMNS` |
 *
 * 为什么要有第二份而不是全靠 spec 11：spec 11 的注册表是「框架那份 + 业务那份」拼起来的，
 * 一旦有人把 `APP_ENCRYPTED_COLUMNS` 那一项从拼接里去掉（或者干脆把数组清空又同时
 * 把列从 schema 删了），spec 11 依然全绿。本文件盯死**业务片段**这一侧：
 * 业务表里出现一个 `*Enc` 列，就必须在业务注册表里找得到它、并且有配对的 keyId 列。
 *
 * 漏掉的代价见 K4：没有 keyId 的密文在轮换到一半时分不清新旧，只能全量停机换；
 * 没登记的密文列在轮换当天会被跳过，旧密钥退役之后那一列永远解不开——而这两种失败
 * 平时**完全不报错**，所以只能靠静态断言拦。
 *
 * 带「正则失效防假通过」哨兵：静态扫描最容易骗过自己的地方是「扫不到东西」与
 * 「没有问题」在断言上长得一模一样（同 `tenant-models.spec.ts` / `index.spec.ts` 的写法）。
 */

import { keyIdColumnFor } from '@taizan/crypto'
import { describe, expect, it } from 'vitest'

import { APP_ENCRYPTED_COLUMNS } from '../../src/registry/encrypted-columns'
import { readSchemaFiles } from './_helpers'

/** 密文列的命名约定后缀（与 `@taizan/prisma-base` 的 `ENCRYPTED_COLUMN_SUFFIX` 同值）。 */
const ENC_SUFFIX = 'Enc'

/** 一张解析出来的表：模型名 + 字段名集合。 */
interface ScannedModel {
  name: string
  file: string
  fields: string[]
}

/** `model X { … }` 块。`^\}` 配合 `m` 定住块尾，避免被块内的花括号带跑。 */
const MODEL_BLOCK_RE = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm

/**
 * 扫一段 `.prisma` 文本里的 model 与字段名。
 *
 * 只认「行首是标识符、第二个 token 是类型」的字段行；跳过注释（`//` `///`）、
 * 块级属性（`@@index` 等）与空行。
 */
function scanModels(source: string, file: string): ScannedModel[] {
  const out: ScannedModel[] = []
  MODEL_BLOCK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MODEL_BLOCK_RE.exec(source)) !== null) {
    const fields: string[] = []
    for (const line of (match[2] ?? '').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('/') || trimmed.startsWith('@')) continue
      const tokens = trimmed.split(/\s+/)
      const name = tokens[0]
      if (name === undefined || !/^\w+$/.test(name)) continue
      if (tokens[1] === undefined) continue
      fields.push(name)
    }
    out.push({ name: match[1] ?? '', file, fields })
  }
  return out
}

// ── 哨兵：一段答案写死的文本，正则改坏时这里先炸 ────────────────────────────
const SENTINEL = `
/// 哨兵
model SentinelSecret {
  id            String  @id @db.VarChar(26)
  // commentedEnc String  —— 注释掉的字段不算数
  credentialEnc String? @db.Text
  credentialKeyId String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([id])
}

model SentinelPlain {
  id        String   @id @db.VarChar(26)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
`

/** 只要业务片段，框架片段由 spec 11 与 `packages/prisma-base` 那边管。 */
const businessFiles = readSchemaFiles().filter((f) => f.name.startsWith('10-business/'))

const businessModels = businessFiles.flatMap((f) => scanModels(f.source, f.name))

/** schema 里扫到的全部业务密文列，`Model.column`。 */
const schemaEncColumns = businessModels
  .flatMap((m) =>
    m.fields.filter((f) => f.endsWith(ENC_SUFFIX)).map((f): string => `${m.name}.${f}`),
  )
  .sort()

const registryColumns = APP_ENCRYPTED_COLUMNS.map((c) => `${c.model}.${c.column}`).sort()

describe('业务片段的加密列：*Enc ↔ *KeyId ↔ APP_ENCRYPTED_COLUMNS', () => {
  it('哨兵：解析器还活着（扫不到东西和没有问题在断言上长得一样）', () => {
    const models = scanModels(SENTINEL, '(sentinel)')
    expect(models.map((m) => m.name)).toEqual(['SentinelSecret', 'SentinelPlain'])
    expect(models[0]?.fields).toEqual([
      'id',
      'credentialEnc',
      'credentialKeyId',
      'createdAt',
      'updatedAt',
    ])
    // 注释掉的 `commentedEnc` 不该被当成真字段。
    expect(models[0]?.fields).not.toContain('commentedEnc')
    expect(models[1]?.fields).not.toContain('credentialEnc')
  })

  it('真的扫到了业务片段（空目录会让下面每一条都通过）', () => {
    // 10-goods.prisma + 20-geo.prisma + 21-geo-platform.prisma。
    // 数字写死是刻意的：有人删掉 10-business/ 之后其余断言仍然全绿，只有这一条会红。
    expect(businessFiles.map((f) => f.name)).toEqual([
      '10-business/10-goods.prisma',
      '10-business/20-geo.prisma',
      '10-business/21-geo-platform.prisma',
    ])
    expect(businessModels.length).toBeGreaterThanOrEqual(15)
  })

  it('每个业务 *Enc 列都在 APP_ENCRYPTED_COLUMNS 里登记了', () => {
    const missing = schemaEncColumns.filter((ref) => !registryColumns.includes(ref))
    expect(
      missing,
      '这些密文列没登记进 src/registry/encrypted-columns.ts：轮换脚本按注册表挑列，' +
        '没登记 = 换密钥那天它被跳过，旧密钥退役之后永远解不开。\n  ' +
        missing.join('\n  '),
    ).toEqual([])
  })

  it('注册表里的列在业务 schema 里都真的存在（改名没同步会命中这条）', () => {
    const stale = registryColumns.filter((ref) => !schemaEncColumns.includes(ref))
    expect(
      stale,
      `这些登记项在 10-business/*.prisma 里查无此列（列改名了？表删了？）：${stale.join(', ')}`,
    ).toEqual([])
  })

  it('每个 *Enc 列都有配对的 keyId 列', () => {
    const byModel = new Map(businessModels.map((m) => [m.name, m] as const))
    const missing: string[] = []
    for (const model of businessModels) {
      for (const column of model.fields.filter((f) => f.endsWith(ENC_SUFFIX))) {
        // 注册表里的 keyIdColumn 是真源；没登记时退回命名推导，好让报错信息能指出
        // 「你应该加哪一列」而不是只说「缺了点什么」。
        const registered = APP_ENCRYPTED_COLUMNS.find(
          (c) => c.model === model.name && c.column === column,
        )
        const expectedKeyId = registered?.keyIdColumn ?? keyIdColumnFor(column)
        if (byModel.get(model.name)?.fields.includes(expectedKeyId) !== true) {
          missing.push(`${model.name}.${column} → 缺 ${expectedKeyId}`)
        }
      }
    }
    expect(
      missing,
      '没有 keyId 列，轮换到一半的行分不清新旧密钥，只能全量停机换（K4）。\n  ' +
        missing.join('\n  '),
    ).toEqual([])
  })

  it('登记项都写了 description（轮换与安全审计要看它）', () => {
    for (const column of APP_ENCRYPTED_COLUMNS) {
      expect(
        (column.description ?? '').length,
        `${column.model}.${column.column} 的 description 为空`,
      ).toBeGreaterThan(10)
    }
  })

  it('GeoEngine.credentialEnc 确实在清单里（防止登记被误删后本 spec 仍然全绿）', () => {
    expect(registryColumns).toContain('GeoEngine.credentialEnc')
    expect(schemaEncColumns).toContain('GeoEngine.credentialEnc')
  })
})
