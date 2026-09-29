import { describe, expect, it } from 'vitest'
import {
  buildOpenAiChatRequest,
  OpenAiCompatibleLlmProvider,
  parseOpenAiChatResponse,
  withSchemaHint,
  type OpenAiCompatibleConfig,
} from './openai-compatible'
import type { HttpClient } from '../http-client'
import type { ChatRequest, JsonSchema, LlmChatContext } from '../types'

const CFG: OpenAiCompatibleConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-x',
  model: 'deepseek-chat',
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: { mentions: { type: 'array', items: { type: 'object' } } },
  required: ['mentions'],
}

const REQ: ChatRequest = { messages: [{ role: 'user', content: 'q' }] }

const FIXTURE = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'deepseek-chat',
  choices: [
    { index: 0, message: { role: 'assistant', content: '{"mentions":[]}' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
}

const ctx = (body: string, status = 200): LlmChatContext => ({
  http: { request: async () => ({ status, body }) } satisfies HttpClient,
})

describe('withSchemaHint', () => {
  it('没有 jsonSchema 时原样返回', () => {
    expect(withSchemaHint(REQ.messages, REQ)).toBe(REQ.messages)
  })

  it('没有 system message 时插一条', () => {
    const out = withSchemaHint(REQ.messages, { ...REQ, jsonSchema: SCHEMA })
    expect(out[0]!.role).toBe('system')
    expect(out[0]!.content).toContain('请严格只输出一个 JSON 对象')
    expect(out[1]!.content).toBe('q')
  })

  it('已有 system message 时追加在它末尾，不新增消息', () => {
    const messages = [
      { role: 'system' as const, content: '你是分析助手' },
      { role: 'user' as const, content: 'q' },
    ]
    const out = withSchemaHint(messages, { messages, jsonSchema: SCHEMA })
    expect(out).toHaveLength(2)
    expect(out[0]!.content).toContain('你是分析助手')
    expect(out[0]!.content).toContain('请严格只输出')
  })
})

describe('buildOpenAiChatRequest', () => {
  it('baseUrl + /chat/completions，Bearer 头，末尾斜杠被去掉', () => {
    const req = buildOpenAiChatRequest(REQ, { ...CFG, baseUrl: 'https://api.deepseek.com/v1/' })
    expect(req.url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(req.method).toBe('POST')
    expect(req.headers['Authorization']).toBe('Bearer sk-x')
    expect(req.headers['Content-Type']).toBe('application/json')
  })

  it('jsonSchema 存在时打开 response_format: json_object', () => {
    const body = JSON.parse(
      buildOpenAiChatRequest({ ...REQ, jsonSchema: SCHEMA }, CFG).body!,
    ) as Record<string, unknown>
    expect(body['response_format']).toEqual({ type: 'json_object' })
  })

  it('strictJsonSchema 时改用 json_schema 强模式', () => {
    const body = JSON.parse(
      buildOpenAiChatRequest({ ...REQ, jsonSchema: SCHEMA }, { ...CFG, strictJsonSchema: true })
        .body!,
    ) as { response_format: { type: string } }
    expect(body.response_format.type).toBe('json_schema')
  })

  it('没有 jsonSchema 时不带 response_format', () => {
    const body = JSON.parse(buildOpenAiChatRequest(REQ, CFG).body!) as Record<string, unknown>
    expect(body['response_format']).toBeUndefined()
  })

  it('temperature / maxTokens 只在传了的时候才出现在 body 里', () => {
    const bare = JSON.parse(buildOpenAiChatRequest(REQ, CFG).body!) as Record<string, unknown>
    expect(bare['temperature']).toBeUndefined()
    expect(bare['max_tokens']).toBeUndefined()
    const full = JSON.parse(
      buildOpenAiChatRequest({ ...REQ, temperature: 0.2, maxTokens: 1024 }, CFG).body!,
    ) as Record<string, unknown>
    expect(full['temperature']).toBe(0.2)
    expect(full['max_tokens']).toBe(1024)
  })

  it('req.model 覆盖 cfg.model', () => {
    const body = JSON.parse(
      buildOpenAiChatRequest({ ...REQ, model: 'kimi-k2' }, CFG).body!,
    ) as { model: string }
    expect(body.model).toBe('kimi-k2')
  })

  it('缺 baseUrl / apiKey / model 时抛错', () => {
    expect(() => buildOpenAiChatRequest(REQ, { ...CFG, baseUrl: '' })).toThrow('baseUrl')
    expect(() => buildOpenAiChatRequest(REQ, { ...CFG, apiKey: '' })).toThrow('apiKey')
    expect(() => buildOpenAiChatRequest(REQ, { ...CFG, model: '' })).toThrow('model')
  })
})

describe('parseOpenAiChatResponse', () => {
  it('解析正文、usage、model、finishReason', () => {
    const res = parseOpenAiChatResponse(FIXTURE, REQ, 'deepseek-chat')
    expect(res.text).toBe('{"mentions":[]}')
    expect(res.usage).toEqual({ inputTokens: 30, outputTokens: 12 })
    expect(res.model).toBe('deepseek-chat')
    expect(res.finishReason).toBe('stop')
    // 没传 jsonSchema 就不解析 json
    expect(res.json).toBeUndefined()
  })

  it('传了 jsonSchema 时把正文过 parseJsonLoose', () => {
    const res = parseOpenAiChatResponse(FIXTURE, { ...REQ, jsonSchema: SCHEMA }, 'm')
    expect(res.json).toEqual({ mentions: [] })
  })

  it('模型把 JSON 包进围栏时也能解析出来', () => {
    const fenced = {
      ...FIXTURE,
      choices: [{ message: { content: '```json\n{"mentions":[]}\n```' }, finish_reason: 'stop' }],
    }
    expect(parseOpenAiChatResponse(fenced, { ...REQ, jsonSchema: SCHEMA }, 'm').json).toEqual({
      mentions: [],
    })
  })

  it('JSON 完全解析不出来时 json 是 undefined，不抛错', () => {
    const garbage = {
      ...FIXTURE,
      choices: [{ message: { content: '今天不想输出 JSON' }, finish_reason: 'stop' }],
    }
    const res = parseOpenAiChatResponse(garbage, { ...REQ, jsonSchema: SCHEMA }, 'm')
    expect(res.json).toBeUndefined()
    expect(res.text).toBe('今天不想输出 JSON')
  })

  it('缺 usage / 空 choices / 整个响应是 null 都不抛错', () => {
    expect(parseOpenAiChatResponse({}, REQ, 'm')).toMatchObject({
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'm',
      finishReason: 'unknown',
    })
    expect(parseOpenAiChatResponse(null, REQ, 'm').text).toBe('')
    expect(parseOpenAiChatResponse({ choices: [] }, REQ, 'm').text).toBe('')
  })
})

describe('OpenAiCompatibleLlmProvider', () => {
  it('name 是 openai-compatible，chat 端到端可用', async () => {
    const provider = new OpenAiCompatibleLlmProvider()
    expect(provider.name).toBe('openai-compatible')
    const res = await provider.chat(REQ, CFG, ctx(JSON.stringify(FIXTURE)))
    expect(res.usage.inputTokens).toBe(30)
  })

  it('非 2xx 时抛错（registry 靠这个切备用）', async () => {
    const provider = new OpenAiCompatibleLlmProvider()
    await expect(provider.chat(REQ, CFG, ctx('rate limited', 429))).rejects.toThrow('HTTP 429')
  })

  it('响应不是 JSON 时抛错', async () => {
    const provider = new OpenAiCompatibleLlmProvider()
    await expect(provider.chat(REQ, CFG, ctx('<html>502</html>'))).rejects.toThrow('不是合法 JSON')
  })
})
