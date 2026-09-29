import { describe, expect, it } from 'vitest'
import {
  buildDashScopeRequest,
  DashScopeLlmProvider,
  parseDashScopeResponse,
  type DashScopeConfig,
} from './dashscope'
import type { ChatRequest, JsonSchema, LlmChatContext } from '../types'

const CFG: DashScopeConfig = { apiKey: 'sk-qwen', model: 'qwen-plus' }
const REQ: ChatRequest = { messages: [{ role: 'user', content: 'q' }] }
const SCHEMA: JsonSchema = {
  type: 'object',
  properties: { mentions: { type: 'array' } },
  required: ['mentions'],
}

const FIXTURE = {
  output: {
    choices: [
      {
        finish_reason: 'stop',
        message: { role: 'assistant', content: '{"mentions":[{"entityName":"A"}]}' },
      },
    ],
  },
  usage: { input_tokens: 55, output_tokens: 20, total_tokens: 75 },
  request_id: 'req-1',
}

const ctx = (body: string, status = 200): LlmChatContext => ({
  http: { request: async () => ({ status, body }) },
})

describe('buildDashScopeRequest', () => {
  it('打 DashScope 原生文本生成端点，result_format 是 message', () => {
    const req = buildDashScopeRequest(REQ, CFG)
    expect(req.url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
    )
    expect(req.headers['Authorization']).toBe('Bearer sk-qwen')
    const body = JSON.parse(req.body!) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'qwen-plus',
      input: { messages: [{ role: 'user', content: 'q' }] },
      parameters: { result_format: 'message', incremental_output: false },
    })
  })

  it('jsonSchema 存在时把 schema 提示插成 system message（原生协议没有可靠的 JSON 模式）', () => {
    const body = JSON.parse(
      buildDashScopeRequest({ ...REQ, jsonSchema: SCHEMA }, CFG).body!,
    ) as { input: { messages: Array<{ role: string; content: string }> } }
    expect(body.input.messages[0]!.role).toBe('system')
    expect(body.input.messages[0]!.content).toContain('请严格只输出一个 JSON 对象')
  })

  it('temperature / maxTokens 只在传了的时候才出现', () => {
    const bare = JSON.parse(buildDashScopeRequest(REQ, CFG).body!) as {
      parameters: Record<string, unknown>
    }
    expect(bare.parameters['temperature']).toBeUndefined()
    const full = JSON.parse(
      buildDashScopeRequest({ ...REQ, temperature: 0.1, maxTokens: 512 }, CFG).body!,
    ) as { parameters: Record<string, unknown> }
    expect(full.parameters['temperature']).toBe(0.1)
    expect(full.parameters['max_tokens']).toBe(512)
  })

  it('baseUrl 可以覆盖，末尾斜杠被去掉', () => {
    const req = buildDashScopeRequest(REQ, { ...CFG, baseUrl: 'https://gw.internal/' })
    expect(req.url.startsWith('https://gw.internal/api/v1/')).toBe(true)
  })

  it('缺 apiKey / model 时抛错', () => {
    expect(() => buildDashScopeRequest(REQ, { ...CFG, apiKey: '' })).toThrow('apiKey')
    expect(() => buildDashScopeRequest(REQ, { ...CFG, model: '' })).toThrow('model')
  })
})

describe('parseDashScopeResponse', () => {
  it('解析 output.choices[0].message.content 与下划线风格的 usage', () => {
    const res = parseDashScopeResponse(FIXTURE, REQ, 'qwen-plus')
    expect(res.text).toContain('entityName')
    expect(res.usage).toEqual({ inputTokens: 55, outputTokens: 20 })
    expect(res.model).toBe('qwen-plus')
    expect(res.finishReason).toBe('stop')
  })

  it('传了 jsonSchema 时把正文过 parseJsonLoose', () => {
    const res = parseDashScopeResponse(FIXTURE, { ...REQ, jsonSchema: SCHEMA }, 'qwen-plus')
    expect(res.json).toEqual({ mentions: [{ entityName: 'A' }] })
  })

  it('老的 text 格式（没有 choices）也能取到正文', () => {
    const res = parseDashScopeResponse(
      { output: { text: '老格式', finish_reason: 'stop' } },
      REQ,
      'm',
    )
    expect(res.text).toBe('老格式')
    expect(res.finishReason).toBe('stop')
  })

  it('截断的 JSON 被修复后仍能拿到 json', () => {
    const truncated = {
      output: { choices: [{ message: { content: '{"mentions":[{"entityName":"A"' } }] },
    }
    expect(parseDashScopeResponse(truncated, { ...REQ, jsonSchema: SCHEMA }, 'm').json).toEqual({
      mentions: [{ entityName: 'A' }],
    })
  })

  it('空响应 / null 不抛错', () => {
    expect(parseDashScopeResponse({}, REQ, 'm')).toMatchObject({
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: 'unknown',
    })
    expect(parseDashScopeResponse(null, REQ, 'm').text).toBe('')
  })
})

describe('DashScopeLlmProvider', () => {
  it('name 是 dashscope，chat 端到端可用', async () => {
    const provider = new DashScopeLlmProvider()
    expect(provider.name).toBe('dashscope')
    const res = await provider.chat(REQ, CFG, ctx(JSON.stringify(FIXTURE)))
    expect(res.usage.inputTokens).toBe(55)
  })

  it('非 2xx 与非 JSON 响应都抛错（registry 靠这个切备用）', async () => {
    const provider = new DashScopeLlmProvider()
    await expect(provider.chat(REQ, CFG, ctx('{"code":"Throttling"}', 429))).rejects.toThrow(
      'HTTP 429',
    )
    await expect(provider.chat(REQ, CFG, ctx('not json'))).rejects.toThrow('不是合法 JSON')
  })
})
