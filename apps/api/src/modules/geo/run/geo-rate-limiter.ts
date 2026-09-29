/**
 * `GeoRateLimiter`：引擎级的**平台级**限速闸门（GEO P0 技术设计 §1.4）。
 *
 * 每个 `GeoEngine` 有一列 `rateLimitPerMin`（厂商给的配额，超了对方直接 429）。
 * 跑批 worker 在真的发出一次 `ask()` 之前先来这里领一个名额，领不到就抛
 * `EngineError{ kind: 'RATE_LIMIT', retryable: true }`，交给 BullMQ 退避。
 *
 * ## 为什么不用 `CacheService`（这是本文件存在的全部理由）
 *
 * `CacheService` 的 key **强制带租户前缀**（蓝图：「缓存 key 强制租户前缀」）。
 * 那条约定是对的——缓存里存的几乎都是租户数据，不带前缀就是跨租户串数据。
 *
 * 但引擎限速恰恰是**平台级**的：通义给的是「这个账号每分钟 60 次」，不是
 * 「每个租户每分钟 60 次」。用带租户前缀的 key 计数，实际放行量会变成
 * `60 × 在跑批的租户数`——十家店同时跑批就是 600 次/分钟，厂商那边直接 429，
 * 而本地的计数器显示「每家都只用了 60，没超」。**这种失效不会报错，只会让
 * 跑批成功率在业务增长之后慢慢变差**，等有人去查的时候已经过了几个月。
 *
 * 所以这里用 `RedisService` 的裸 client（`redis.raw`），自己拼 key，key 里
 * 一个 tenantId 都没有。技术设计 §10 的附加条目把这条写成了硬约定：
 * 「平台级 key 用 `RedisService` 裸 client 不用 `CacheService`」。
 *
 * ## 为什么是「分钟窗口计数」而不是令牌桶 / 滑动窗口
 *
 * 固定窗口的已知缺陷是**边界双倍**：在第 59 秒和第 61 秒各打满一次，一分钟内
 * 实际发出了 2 倍的请求。对这个场景可以接受，理由有两条：
 *
 * 1. 厂商侧的配额本身也是按自然分钟统计的（各家文档口径一致），边界双倍在
 *    厂商那边同样不算超——真正会被拒的是「同一个自然分钟内超过 N 次」。
 * 2. 跑批是**持续**的流量而不是突发，超限之后 BullMQ 会退避重排，队列自己会把
 *    毛刺磨平。为此引入滑动窗口（要么 `ZSET` 存每次调用的时间戳、要么 Lua 脚本），
 *    换来的精度在这里没有对应的收益，而多出来的 key 与脚本是实打实的运维面。
 *
 * ## `INCR` + `EXPIRE` 为什么合成一个 Lua 脚本
 *
 * 两条命令分两次往返的话，两者之间进程崩溃会留下一个**永不过期**的 key。量小
 * （每个引擎每分钟一个），但那种泄漏是只增不减的。用 `EVAL` 把两条包成一次原子
 * 执行，顺带只走一次往返。
 *
 * 另一个理由是接口面：`@taizan/nest-infra` 的 `RedisClient` 是一份**刻意收窄**的
 * 命令子集（「只列真正用到的命令」，见那个文件的说明），里面有 `eval` 但没有
 * `incr` / `expire` / `pipeline`。为了两条命令去拓宽那个接口、或者把 `raw` 强转成
 * `ioredis`，都是在框架包的边界上开口子——而 `eval` 本来就是为这种场景留的。
 *
 * ## 这个文件**不接线**
 *
 * T5 只放文件 + spec。真正的调用点在 T6 的 `geo-query-execute.handler.ts`
 * （`acquire()` 在 `adapter.ask()` 之前，失败就抛 `EngineError`）。
 * 提前放在这里是因为它是纯基础设施，与队列流程无关，可以独立测。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { RedisService } from '@taizan/nest-infra'

/**
 * 窗口长度（毫秒）。**不是可配项**：`rateLimitPerMin` 这个列名里的 “PerMin”
 * 就是这一分钟，两处能各改各的话，配置的含义就不是「每分钟几次」了。
 */
export const WINDOW_MS = 60_000

/**
 * key 的存活时间（秒）。
 *
 * 取 2 倍窗口而不是刚好 60 秒：`EXPIRE` 是在 `INCR` **之后**执行的，如果窗口
 * 正好在两条命令之间翻过去，60 秒的 TTL 会让这个 key 在当前窗口结束前就消失，
 * 于是这一分钟的配额被悄悄清零重来。多留一个窗口的余量，代价是每个引擎多占
 * 一个几十字节的 key。
 */
export const KEY_TTL_SECONDS = 120

/** key 前缀。`geo:rl:{engineCode}:{窗口序号}`，**没有 tenantId**——理由见文件头。 */
export const KEY_PREFIX = 'geo:rl'

/** {@link GeoRateLimiter.acquire} 的结果。 */
export interface RateLimitDecision {
  /** 这次放不放行。 */
  ok: boolean
  /**
   * 放行时恒为 `0`；被拦下时是「到下一个窗口还有多少毫秒」。
   *
   * 调用方拿它填 BullMQ 的 `delayMs`，或者塞进 `EngineError` 让上层知道等多久。
   * 回毫秒而不是秒：BullMQ 的延迟单位是毫秒，在这里换算一次比在每个调用点
   * 各换一次安全。
   */
  retryAfterMs: number
}

/**
 * 算当前时刻属于哪个分钟窗口。
 *
 * 导出成纯函数是为了让 spec 能直接对着它断言窗口边界，而不用去操纵时钟。
 *
 * @param now - 毫秒时间戳
 */
export function windowIndexOf(now: number): number {
  return Math.floor(now / WINDOW_MS)
}

/**
 * 拼一个限速 key。
 *
 * @param engineCode - 引擎 code（`GeoEngine.code`）
 * @param windowIndex - {@link windowIndexOf} 的结果
 */
export function rateLimitKey(engineCode: string, windowIndex: number): string {
  return `${KEY_PREFIX}:${engineCode}:${windowIndex}`
}

/**
 * 「计数 +1 并续上过期时间」的原子脚本。
 *
 * `EXPIRE` **每次都发**而不是只在 `n === 1` 时发：只在第一次设过期的写法，
 * 在「key 因为某种原因丢了 TTL」之后会永久残留，而那种情况没有任何信号。
 * 每次都设的代价是一条命令，换来的是这个 key 不可能没有 TTL。
 */
export const INCR_WITH_TTL_SCRIPT =
  "local n = redis.call('INCR', KEYS[1]) redis.call('EXPIRE', KEYS[1], ARGV[1]) return n"

/**
 * 引擎级限速器。
 *
 * 无状态（计数全在 Redis 里），可以全进程共用一个实例，多进程之间天然共享同一份
 * 计数——这正是它不能用进程内 `Map` 的原因：两个 worker 进程各数各的，
 * 实际放行量翻倍。
 */
@Injectable()
export class GeoRateLimiter {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  /**
   * 领一个名额。
   *
   * **先占后判**：无论放不放行都会 `INCR` 一次。这意味着被拦下的请求也会把计数
   * 推高——看起来浪费，实际是必须的：先判后占的话，两个 worker 会同时读到
   * 「59 < 60」然后各自发一次请求，而那正是分布式限流要挡的东西。
   * 被拦下的请求在 BullMQ 里会退避到下一个窗口，那时计数已经换了 key。
   *
   * ## 失败时**放行**，不是拦截
   *
   * Redis 不可用时这个方法会抛（`RedisService` 不做降级，见它的文件头），
   * 调用方应当让那次异常冒泡成一次 job 失败并重试——**不要在这里 catch 成
   * `{ ok: true }`**。限速器静默失效的后果是跑批把厂商的配额打穿，
   * 而日志里只有一行 warn。
   *
   * @param engineCode - 引擎 code
   * @param limitPerMin - 这个引擎每分钟允许多少次（`GeoEngine.rateLimitPerMin`）。
   *   `<= 0` 视为**不限速**直接放行，且不写 Redis——「没配限速」与「限速 0 次」
   *   在这里都只可能是配置缺失，而把整个引擎锁死不是这个函数该做的决定
   *   （挡住它的是 `GeoEngine.enabled`）。
   * @returns 放行与否，以及被拦下时距离下一个窗口还有多久
   */
  async acquire(engineCode: string, limitPerMin: number): Promise<RateLimitDecision> {
    if (!Number.isFinite(limitPerMin) || limitPerMin <= 0) {
      return { ok: true, retryAfterMs: 0 }
    }

    const now = Date.now()
    const windowIndex = windowIndexOf(now)
    // 逻辑 key 过一遍 `RedisService.key()` 拿到全局前缀（默认 `taizan:`）——
    // 同一台 Redis 上常常还跑着别的站，前缀是「别互删」的第一道保险。
    // 它加的是**站点**前缀，不是租户前缀，与本文件头说的那条约束不冲突。
    const key = this.redis.key(rateLimitKey(engineCode, windowIndex))

    // 一次往返、原子执行两条命令：拆开的话，两者之间进程挂掉会留下永不过期的 key。
    const raw = await this.redis.raw.eval(INCR_WITH_TTL_SCRIPT, 1, key, KEY_TTL_SECONDS)
    const count = readCount(raw)
    if (count <= limitPerMin) return { ok: true, retryAfterMs: 0 }

    // 到下一个窗口还有多久。至少回 1ms——回 0 会让调用方的 `delayMs: 0` 变成
    // 「立刻重试」，于是在窗口的最后一毫秒里空转一轮。
    const nextWindowAt = (windowIndex + 1) * WINDOW_MS
    return { ok: false, retryAfterMs: Math.max(1, nextWindowAt - now) }
  }
}

/**
 * 把 `EVAL` 的返回值收窄成计数。
 *
 * Lua 的 number 经 RESP 回来是整数，ioredis 给的是 `number`；但 `eval` 的签名是
 * `Promise<unknown>`（它能返回任何东西），所以必须在这里判一次。
 *
 * **判不出来就抛，绝不兜底成 0**：兜底成 0 意味着计数永远小于上限，限速器静默
 * 失效——跑批会把厂商的配额打穿，而日志里什么都没有。
 */
function readCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  // 某些客户端（或 RESP3 下的某些实现）会把整数回成字符串，兼容一下。
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  throw new Error(
    `[GeoRateLimiter] 限速脚本返回了一个不是计数的东西：${JSON.stringify(value)}。` +
      '限速器不能在这种情况下静默放行——那会把厂商配额打穿且没有任何信号。',
  )
}
