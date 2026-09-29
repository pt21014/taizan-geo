/**
 * `GeoRateLimiter` 的单测。
 *
 * ## 为什么不连真 Redis
 *
 * 这几条断言要验的全部是**计数与窗口的算术**（第 N 次放不放行、跨窗口会不会
 * 重置、`retryAfterMs` 算得对不对），没有一条与 Redis 的真实行为有关。
 * 连真库的代价是这份 spec 从 `pnpm test` 掉进 `pnpm test:e2e`——那意味着它
 * 在本地改代码时不再跑，而这正是最需要快速反馈的一类逻辑。
 *
 * 所以用一个 30 行的内存假 Redis：它只实现 `eval`，且只认那一条脚本。
 * **假实现越窄越好**——一个"什么都支持"的假 Redis 会在某天悄悄放过一个真 Redis
 * 会拒绝的用法。
 *
 * 时钟同理：不用 `vi.useFakeTimers()`，而是把 `Date.now` 临时换掉。测试要控制的
 * 只有"现在是第几分钟"这一件事，换掉整个定时器系统会顺带影响到别的东西。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  GeoRateLimiter,
  INCR_WITH_TTL_SCRIPT,
  KEY_TTL_SECONDS,
  rateLimitKey,
  windowIndexOf,
  WINDOW_MS,
} from './geo-rate-limiter'

/** 一次 `eval` 调用的留痕，用来断言"key 里真的没有租户前缀"。 */
interface EvalCall {
  script: string
  key: string
  ttlSeconds: number
}

/**
 * 内存假 Redis。
 *
 * 只实现 `RedisService` 在本文件里用得到的两件事：`key()` 加站点前缀、
 * `raw.eval()` 执行那条 INCR+EXPIRE 脚本。其余命令一律不实现——被调用到就是
 * 「限速器的实现偷偷用了别的命令」，那时应当红。
 */
class FakeRedis {
  readonly counters = new Map<string, number>()
  readonly calls: EvalCall[] = []
  /** 每个 key 上一次被设的 TTL（秒）。 */
  readonly ttls = new Map<string, number>()

  readonly raw = {
    eval: async (script: string, numkeys: number, ...args: (string | number)[]): Promise<number> => {
      if (script !== INCR_WITH_TTL_SCRIPT) {
        throw new Error(`假 Redis 只认限速脚本，收到：${script}`)
      }
      if (numkeys !== 1) throw new Error(`限速脚本应当只有 1 个 key，收到 ${numkeys}`)
      const key = String(args[0])
      const ttl = Number(args[1])
      const next = (this.counters.get(key) ?? 0) + 1
      this.counters.set(key, next)
      this.ttls.set(key, ttl)
      this.calls.push({ script, key, ttlSeconds: ttl })
      return next
    },
  }

  key(logicalKey: string): string {
    return `taizan:${logicalKey}`
  }
}

/** 把假 Redis 套上 `RedisService` 的形状塞进限速器。 */
function makeLimiter(): { limiter: GeoRateLimiter; redis: FakeRedis } {
  const redis = new FakeRedis()
  const limiter = new GeoRateLimiter(redis as unknown as ConstructorParameters<
    typeof GeoRateLimiter
  >[0])
  return { limiter, redis }
}

/** 把 `Date.now` 钉在某个时刻。 */
function freezeClock(at: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(at)
}

/** 第 1000 个窗口的起点，一个人类看不出规律但算得清的时刻。 */
const WINDOW_START = 1000 * WINDOW_MS

beforeEach(() => {
  freezeClock(WINDOW_START)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('windowIndexOf / rateLimitKey', () => {
  it('同一分钟内的两个时刻落在同一个窗口', () => {
    expect(windowIndexOf(WINDOW_START)).toBe(windowIndexOf(WINDOW_START + WINDOW_MS - 1))
  })

  it('跨过整分钟就换窗口', () => {
    expect(windowIndexOf(WINDOW_START + WINDOW_MS)).toBe(windowIndexOf(WINDOW_START) + 1)
  })

  it('key 形如 geo:rl:{code}:{窗口}', () => {
    expect(rateLimitKey('qwen', 1000)).toBe('geo:rl:qwen:1000')
  })
})

describe('GeoRateLimiter.acquire', () => {
  it('额度以内逐次放行，超出后拦下', async () => {
    const { limiter } = makeLimiter()
    for (let i = 0; i < 3; i += 1) {
      expect(await limiter.acquire('qwen', 3)).toEqual({ ok: true, retryAfterMs: 0 })
    }
    const denied = await limiter.acquire('qwen', 3)
    expect(denied.ok).toBe(false)
  })

  it('被拦下时 retryAfterMs 指向下一个窗口的起点', async () => {
    const { limiter } = makeLimiter()
    // 窗口过了 20 秒的时刻打满并超限。
    freezeClock(WINDOW_START + 20_000)
    await limiter.acquire('qwen', 1)
    const denied = await limiter.acquire('qwen', 1)
    expect(denied).toEqual({ ok: false, retryAfterMs: WINDOW_MS - 20_000 })
  })

  it('窗口最后一毫秒被拦下时也至少回 1ms（回 0 会让调用方空转一轮）', async () => {
    const { limiter } = makeLimiter()
    freezeClock(WINDOW_START + WINDOW_MS - 1)
    await limiter.acquire('qwen', 1)
    const denied = await limiter.acquire('qwen', 1)
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterMs).toBe(1)
  })

  it('换了窗口计数重新开始', async () => {
    const { limiter } = makeLimiter()
    await limiter.acquire('qwen', 1)
    expect((await limiter.acquire('qwen', 1)).ok).toBe(false)

    freezeClock(WINDOW_START + WINDOW_MS)
    expect((await limiter.acquire('qwen', 1)).ok).toBe(true)
  })

  it('两个引擎各数各的（一个打满不影响另一个）', async () => {
    const { limiter } = makeLimiter()
    await limiter.acquire('qwen', 1)
    expect((await limiter.acquire('qwen', 1)).ok).toBe(false)
    expect((await limiter.acquire('ernie', 1)).ok).toBe(true)
  })

  it.each([0, -1, Number.NaN])('limitPerMin=%s 视为不限速，且完全不碰 Redis', async (limit) => {
    const { limiter, redis } = makeLimiter()
    expect(await limiter.acquire('qwen', limit)).toEqual({ ok: true, retryAfterMs: 0 })
    expect(redis.calls).toHaveLength(0)
  })

  it('被拦下的那次也计数（先占后判——先判后占会让两个进程同时放行）', async () => {
    const { limiter, redis } = makeLimiter()
    await limiter.acquire('qwen', 1)
    await limiter.acquire('qwen', 1)
    const key = redis.key(rateLimitKey('qwen', windowIndexOf(WINDOW_START)))
    expect(redis.counters.get(key)).toBe(2)
  })

  it('key 里没有任何租户标识——引擎限速是平台级的', async () => {
    const { limiter, redis } = makeLimiter()
    await limiter.acquire('qwen', 10)
    expect(redis.calls[0]?.key).toBe(`taizan:geo:rl:qwen:${windowIndexOf(WINDOW_START)}`)
    // 站点前缀之后紧跟 `geo:rl:`，中间塞不进 `t:<tenantId>` 这种段。
    expect(redis.calls[0]?.key).toMatch(/^taizan:geo:rl:[a-z0-9-]+:\d+$/)
  })

  it('每次都续 TTL，且 TTL 是两个窗口（EXPIRE 落在 INCR 之后，刚好 60 秒会提前清零）', async () => {
    const { limiter, redis } = makeLimiter()
    await limiter.acquire('qwen', 10)
    await limiter.acquire('qwen', 10)
    expect(redis.calls.map((c) => c.ttlSeconds)).toEqual([KEY_TTL_SECONDS, KEY_TTL_SECONDS])
    expect(KEY_TTL_SECONDS).toBe(2 * (WINDOW_MS / 1000))
  })

  it('脚本回了个非计数时抛，绝不静默放行', async () => {
    const { limiter, redis } = makeLimiter()
    vi.spyOn(redis.raw, 'eval').mockResolvedValue(undefined as unknown as number)
    await expect(limiter.acquire('qwen', 10)).rejects.toThrow(/不是计数/)
  })

  it('Redis 抛错时原样冒泡（不 catch 成放行）', async () => {
    const { limiter, redis } = makeLimiter()
    vi.spyOn(redis.raw, 'eval').mockRejectedValue(new Error('READONLY'))
    await expect(limiter.acquire('qwen', 10)).rejects.toThrow('READONLY')
  })
})
