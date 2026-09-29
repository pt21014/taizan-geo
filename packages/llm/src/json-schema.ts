/**
 * JSON Schema 提示词片段 + 脏 JSON 输出的宽松解析。
 *
 * 为什么需要这一层：即便打开了各家的"JSON 模式"，模型仍然会时不时把 JSON 包进
 * ```json 围栏里、在前面加一句"好的，以下是结果："、或者在 `maxTokens` 截断时
 * 吐出半个对象。`JSON.parse` 在这四种情况下全会抛。而 GEO 的分析任务是批量跑的
 * ——一条脏输出让整批炸掉是不可接受的，所以 `parseJsonLoose` 尽力修，修不动就
 * 返回 `undefined`，**永不抛**。
 *
 * 全部是纯函数。
 */
import type { JsonSchema } from './types'

/**
 * 把 JSON Schema 转成一段提示词，追加在 system message 末尾。
 *
 * 做成"缩进的字段清单"而不是直接把 schema JSON 贴进去：模型对自然语言描述的
 * 遵循度比对原始 schema 更高，而且原始 schema 里的 `$schema`/`additionalProperties`
 * 这类关键字会白占 token。
 */
export function buildJsonSchemaHint(schema: JsonSchema): string {
  const lines = describe(schema, '', new Set())
  return [
    '请严格只输出一个 JSON 对象，不要输出任何解释文字，不要用 Markdown 代码围栏。',
    'JSON 结构如下：',
    ...lines,
  ].join('\n')
}

/** 递归描述一个 schema 节点；`seen` 防自引用 schema 把栈撑爆。 */
function describe(schema: JsonSchema | undefined, indent: string, seen: Set<JsonSchema>): string[] {
  if (!schema || typeof schema !== 'object') return [`${indent}- (未指定)`]
  if (seen.has(schema)) return [`${indent}- (递归引用，略)`]
  seen.add(schema)

  const out: string[] = []
  const type = typeof schema.type === 'string' ? schema.type : undefined

  if (type === 'object' || schema.properties) {
    const required = new Set(schema.required ?? [])
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const childType = typeof child?.type === 'string' ? child.type : 'any'
      const flag = required.has(key) ? '必填' : '可选'
      const desc = typeof child?.description === 'string' ? `，${child.description}` : ''
      const enumHint = Array.isArray(child?.enum)
        ? `，只能取 ${child.enum.map((v) => JSON.stringify(v)).join(' / ')}`
        : ''
      out.push(`${indent}- ${key} (${childType}，${flag}${enumHint}${desc})`)
      if (child?.properties || child?.items) {
        out.push(...describe(child, `${indent}  `, seen))
      }
    }
  } else if (type === 'array' || schema.items) {
    out.push(`${indent}  数组每项：`)
    out.push(...describe(schema.items, `${indent}  `, seen))
  }

  seen.delete(schema)
  return out.length > 0 ? out : [`${indent}- (${type ?? 'any'})`]
}

/**
 * 从模型输出里尽力抠出一个 JSON 对象/数组。**失败返回 `undefined`，绝不抛。**
 *
 * 依次尝试：
 * 1. 直接 `JSON.parse`（大多数时候就成了）；
 * 2. 剥掉 ```json / ``` 围栏后再试；
 * 3. 取第一个 `{` 到最后一个 `}`（或 `[`…`]`）之间那段再试——去掉前后的客套话；
 * 4. 把第 3 步那段做**截尾修复**：补上未闭合的引号与括号，再试。
 *
 * 第 4 步是给 `maxTokens` 截断准备的：一次分析被截断，多半只丢了最后一两个
 * mention，前面几条仍然是有用的数据，扔掉整条结果太浪费。
 */
export function parseJsonLoose(text: string): unknown {
  const raw = (text ?? '').trim()
  if (raw === '') return undefined

  const direct = tryParse(raw)
  if (direct !== undefined) return direct

  const unfenced = stripCodeFence(raw)
  if (unfenced !== raw) {
    const parsed = tryParse(unfenced)
    if (parsed !== undefined) return parsed
  }

  // 两个候选：① 从第一个开括号到最后一个收括号（切掉前后的客套话）
  //           ② 从第一个开括号到字符串末尾（截断时 ① 会把最后一条数据一起切掉）
  const candidates = sliceCandidates(unfenced)

  // 先对两个候选各直接 parse 一次：没被截断的脏输出在这一步就该解决
  for (const candidate of candidates) {
    const parsed = tryParse(candidate)
    if (parsed !== undefined) return parsed
  }
  // 都没成 = 真的被截断了。修复时**反过来先试完整的那段**：
  // 修 ① 也能修出一个合法 JSON，但它已经丢了最后一条数据，会静默少算。
  for (const candidate of [...candidates].reverse()) {
    const repaired = repairTruncated(candidate)
    if (repaired === candidate) continue
    const parsed = tryParse(repaired)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** `JSON.parse` 但不抛；顺便把合法的 `null` 也当成"没解析出来"（调用方要的是对象）。 */
function tryParse(s: string): unknown {
  try {
    const v = JSON.parse(s) as unknown
    return v === null ? undefined : v
  } catch {
    return undefined
  }
}

/** 剥掉 ```json ... ``` 或 ``` ... ``` 围栏；没有围栏时原样返回。 */
export function stripCodeFence(text: string): string {
  const m = text.match(/```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)(?:```|$)/)
  return m && m[1] !== undefined ? m[1].trim() : text
}

/**
 * 生成两个待解析候选，按优先级排列。
 *
 * 起点是第一个 `{` 或 `[`（取靠前的那个），这样前面的客套话就被切掉了。
 * 终点有两种：最后一个收括号、以及字符串末尾。两个都要试——**截断的输出里
 * "最后一个 `}`" 往往落在倒数第二个元素上**，只用它会静默丢掉最后一条数据，
 * 而那正是修复逻辑本来能救回来的部分。
 */
function sliceCandidates(text: string): string[] {
  const firstBrace = text.indexOf('{')
  const firstBracket = text.indexOf('[')
  if (firstBrace < 0 && firstBracket < 0) return []
  const useBrace = firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)
  const start = useBrace ? firstBrace : firstBracket
  const close = useBrace ? '}' : ']'

  const candidates: string[] = []
  const end = text.lastIndexOf(close)
  if (end > start && end < text.length - 1) candidates.push(text.slice(start, end + 1))
  candidates.push(text.slice(start))
  // 收括号正好是最后一个字符时，两个候选是同一段，去掉重复
  if (end === text.length - 1 && end > start) return [text.slice(start)]
  return candidates
}

/**
 * 截尾修复：补齐未闭合的字符串与括号。
 *
 * 扫一遍字符，记住括号栈与是否在字符串里；结尾若还在字符串里就先补一个引号
 * （若最后一个字符是反斜杠，说明连转义都被截断了，把它一起去掉），然后按栈
 * 反序补 `}`/`]`。最后再去掉尾部那个悬空的逗号——`{"a":1,}` 一样 parse 不了。
 */
export function repairTruncated(text: string): string {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }

  let out = text
  if (inString) {
    if (escaped) out = out.slice(0, -1)
    out += '"'
  }
  // 去掉截断处残留的 `"key":` 或悬空逗号，否则补了括号也 parse 不了
  out = out.replace(/,\s*"[^"]*"\s*:\s*$/, '')
  out = out.replace(/\s*"[^"]*"\s*:\s*$/, '')
  out = out.replace(/,\s*$/, '')
  while (stack.length > 0) {
    out += stack.pop() === '{' ? '}' : ']'
  }
  return out
}
