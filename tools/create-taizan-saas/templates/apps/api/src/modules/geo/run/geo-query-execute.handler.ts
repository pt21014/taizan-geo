/**
 * `geo.query.execute`：真的去问一次 AI（技术设计 §4.2、§5）。
 *
 * 这是整个产品**唯一一处真的花钱**的代码路径，所以它的每一步顺序都是有理由的：
 *
 * ```
 * 读 result（不是 PENDING → 直接返回）
 *   → 读 GeoEngine 运行参数（停用/不存在 → 判 FAILED，不抛）
 *   → rateLimiter.acquire()          ← 先过闸门，再花钱
 *   → quota.consume(GEO_QUERY_MONTHLY, 1)
 *   → decryptCredentials() → adapter.ask()
 *   ├─ 成功：写 result(OK) + run 计数/成本 + UsageLedger → 入队 geo.result.analyze
 *   └─ 失败：quota.release(1) → 可重试就 rethrow；否则写 result(FAILED) → settle()
 * ```
 *
 * ## 限速在配额之前
 *
 * 反过来的话，被限速拦下的那一次会先把配额扣掉，然后抛错重试——重试再扣一次。
 * 商家的月度次数会被「厂商那边太忙」这件事吃掉，而他什么也没得到。
 *
 * ## `acquire()` 抛错**不 catch 成放行**
 *
 * Redis 挂了时 `GeoRateLimiter.acquire` 会抛（它刻意不降级，见那个文件的文件头）。
 * 这里让它冒泡成一次 job 失败并重试。兜成 `{ ok: true }` 的后果是限速器静默失效、
 * 把厂商配额打穿，而日志里只有一行 warn。
 *
 * ## 关于「最后一次尝试」
 *
 * `JobEnvelope` 里**没有** `attemptsMade`（见 `packages/nest-infra/src/queue/envelope.ts`），
 * `JobProcessor.process(envelope)` 也拿不到 BullMQ 的 job 对象。所以这里用的是
 * 「**每次失败都 release、每次尝试都重新 consume**」这个对称写法：配额的净效果与
 * 「只在最后一次 release」完全一样，代价是重试期间计数会短暂地上下抖动。
 *
 * 已知缺口（留给 T7）：一条**可重试**的错误把 6 次尝试用光之后，消息进死信，而这条
 * result 会一直停在 `PENDING`，于是这一批永远不收口（`resolveRunStatus` 见到 pending>0
 * 就返回 null）。缓解办法是每次失败都把 `errorKind` / `errorMessage` 写进去
 *（本文件已经这么做了），T7 加一个「扫 RUNNING 超过 N 小时的 run」的兜底 cron 即可。
 * 真正的修法是在 `nest-infra` 的 `JobProcessor` 契约上把 attempt 透出来，那是框架包的改动。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { QuotaService } from '@taizan/nest-billing'
import {
  EngineError,
  isEngineError,
  type EngineAskOutput,
  type EngineCode,
  type EngineRegistry,
  type HttpClient,
} from '@taizan/geo-engines'
import { AppLogger } from '@taizan/nest-core'
import {
  JobHandler,
  QueueService,
  type JobEnvelope,
  type JobProcessor,
} from '@taizan/nest-infra'
import { PrismaService } from '@taizan/nest-prisma'

import { autoTenantData, type AppPrismaService } from '../../../common/prisma.types'
import { GEO_ENGINE_REGISTRY } from '../engine/geo-engine-registry.provider'
import { GeoEngineService } from '../engine/geo-engine.service'
import { createEngineHttpClient } from '../engine/http-client'
import { GEO_QUERY_EXECUTE_JOB_NAME, GEO_RESULT_ANALYZE_JOB_NAME } from './geo-job-names'
import { GeoRateLimiter } from './geo-rate-limiter'
import {
  analyzeJobId,
  computeCostCents,
  fingerprintOf,
  makePreview,
  truncateRawText,
} from './geo-run.rules'
import { GEO_QUERY_QUOTA_KIND, GeoRunService } from './geo-run.service'

/** `geo.query.execute` 的消息体。 */
export interface GeoQueryExecutePayload {
  resultId: string
}

const CONTEXT = 'GeoQueryExecute'

/** `GeoUsageLedger.month` 的格式：`YYYY-MM`（与 `@db.VarChar(7)` 对齐）。 */
function monthKeyOf(d: Date): string {
  return d.toISOString().slice(0, 7)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 落 `GeoQueryResult.errorMessage` 前截断——它是 `@db.Text`，但没必要存一整份堆栈。 */
function capMessage(raw: string, max = 1000): string {
  return raw.length <= max ? raw : `${raw.slice(0, max)}…`
}

@Injectable()
@JobHandler({
  name: GEO_QUERY_EXECUTE_JOB_NAME,
  concurrency: 4,
  attempts: 6,
  backoff: { type: 'exponential', delayMs: 5000 },
})
export class GeoQueryExecuteHandler implements JobProcessor<GeoQueryExecutePayload> {
  /** 无状态、全进程共用一个：超时与取消都从每次请求的 opts 进来。 */
  private readonly http: HttpClient = createEngineHttpClient()

  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(GeoRateLimiter) private readonly rateLimiter: GeoRateLimiter,
    @Inject(GeoEngineService) private readonly engines: GeoEngineService,
    @Inject(GEO_ENGINE_REGISTRY) private readonly registry: EngineRegistry,
    @Inject(GeoRunService) private readonly runs: GeoRunService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async process(envelope: JobEnvelope<GeoQueryExecutePayload>): Promise<void> {
    const { resultId } = envelope.data

    const result = await this.prisma.tenant.geoQueryResult.findFirst({ where: { id: resultId } })
    if (!result) {
      this.logger.warn(`回答 ${resultId} 不存在，跳过（多半是这条消息被重放到了另一个环境）`, CONTEXT)
      return
    }
    // 幂等：已经跑过了（OK 或 FAILED）就什么都不做。
    if (result.status !== 'PENDING') return

    const engine = await this.engines.findRuntimeConfig(result.engineCode)
    if (engine === null || !engine.enabled) {
      // 平台在这一批跑到一半时把引擎停了（或删了）。这不是「查询失败」而是「不该再查」，
      // 但对这一批来说结果是一样的：这条查不出来。判 FAILED 让它收口，
      // 而不是留一条永远 PENDING 的行把整批卡住。**不消耗配额**——一次调用都没发生。
      await this.markFailed(result, 'ENGINE_DISABLED', `引擎「${result.engineCode}」已被平台停用或删除`)
      return
    }

    // ── 闸门一：引擎级限速（平台级，不带租户前缀） ───────────────────────
    const decision = await this.rateLimiter.acquire(result.engineCode, engine.rateLimitPerMin)
    if (!decision.ok) {
      // 抛一个 EngineError 而不是普通 Error：下面的 catch 靠 `kind` 决定要不要重试，
      // 而 `RATE_LIMIT` 在 `@taizan/geo-engines` 的默认表里就是 `retryable: true`。
      throw new EngineError(
        'RATE_LIMIT',
        `引擎「${result.engineCode}」这一分钟的额度用完了，${decision.retryAfterMs}ms 后再试`,
      )
    }

    // ── 闸门二：月度配额，逐条占用 ───────────────────────────────────────
    // 超限抛 1540301。**不 catch**：它不是「这次失败」，是「这家店这个月不能再查了」，
    // 重试也不会变好——让它进死信，运维看得到。
    await this.quota.consume(GEO_QUERY_QUOTA_KIND)

    let output: EngineAskOutput
    try {
      output = await this.ask(result, engine)
    } catch (error) {
      // 对称补偿：这次没问到东西，配额还回去。见文件头「关于最后一次尝试」。
      await this.quota.release(GEO_QUERY_QUOTA_KIND).catch(() => undefined)

      const kind = isEngineError(error) ? error.kind : 'UPSTREAM'
      const retryable = isEngineError(error) ? error.retryable : true

      // 每次失败都把原因写进去（**状态仍然是 PENDING**）：重试期间这条行看起来
      // 「还在跑，但上一次是 TIMEOUT」，比一条什么线索都没有的 PENDING 行有用得多。
      await this.prisma.tenant.geoQueryResult.update({
        where: { id: result.id },
        data: { errorKind: kind, errorMessage: capMessage(messageOf(error)) },
      })

      if (retryable) {
        this.logger.warn(
          `回答 ${result.id} 失败（${kind}，可重试）：${messageOf(error)}`,
          CONTEXT,
        )
        // 抛出去 = 这次尝试失败，交给 BullMQ 按 attempts/backoff 退避重试。
        throw error
      }

      await this.markFailed(result, kind, messageOf(error))
      return
    }

    await this.recordSuccess(result, engine, output)
  }

  // ── 真正的一次调用 ──────────────────────────────────────────────────────

  /** 解密凭据、取适配器、发一次 `ask()`。 */
  private async ask(
    result: { id: string; brandId: string; promptId: string; engineCode: string },
    engine: { code: string; model: string; baseUrl: string | null; timeoutMs: number },
  ): Promise<EngineAskOutput> {
    const prompt = await this.prisma.tenant.geoPrompt.findFirst({
      where: { id: result.promptId },
      select: { text: true },
    })
    if (!prompt) {
      // 问法在这一批跑到一半时被软删了。**不可重试**——它不会自己回来。
      throw new EngineError('PARSE', `问法 ${result.promptId} 已经不存在了`, { retryable: false })
    }

    const credentials = await this.engines.decryptCredentials(result.engineCode)
    const mockInjection = await this.mockCredentialInjection(result)

    // `registry.get()` 对未登记的 code **硬抛**，这是刻意的（见 geo-engine-registry.provider.ts）：
    // 后台启用了一个代码里还没实现的 code，静默跳过的后果是报表少了一家的数据而没有任何信号。
    const adapter = this.registry.get(result.engineCode as EngineCode)

    return adapter.ask(
      { prompt: prompt.text, timeoutMs: engine.timeoutMs },
      {
        credentials: { ...credentials, ...mockInjection },
        http: this.http,
        timeoutMs: engine.timeoutMs,
        ...(engine.model === '' ? {} : { model: engine.model }),
        ...(engine.baseUrl === null ? {} : { baseUrl: engine.baseUrl }),
      },
    )
  }

  /**
   * **Mock 专用**的凭据注入。
   *
   * `MockEngineAdapter` 从 `ctx.credentials` 里读 `brandName` / `brandDomain` /
   * `competitorNames` 来编造回答（见 `packages/geo-engines/src/adapters/mock.ts`），
   * 而那三个值在真实部署里属于**引擎凭据**——也就是平台后台填的那一包，与租户无关。
   *
   * 结果是：不注入的话，所有租户的 mock 回答里出现的都是平台后台填的那一个品牌名，
   * 于是提及率恒为 0（正文里没有本店的品牌词），而这恰恰是要验证的东西。
   *
   * 所以这里在 `code === 'mock'` 时把**当前这一条查询的**品牌/竞品覆盖进去。
   * 真实引擎的 credentials 里没有这三个键，也永远走不到这个分支。
   *
   * @returns 要合并进 credentials 的键值；非 mock 引擎时是空对象
   */
  private async mockCredentialInjection(result: {
    brandId: string
    engineCode: string
  }): Promise<Record<string, string>> {
    if (result.engineCode !== 'mock') return {}

    const [brand, competitors] = await Promise.all([
      this.prisma.tenant.geoBrand.findFirst({
        where: { id: result.brandId },
        select: { name: true, domain: true },
      }),
      this.prisma.tenant.geoCompetitor.findMany({
        where: { brandId: result.brandId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { name: true },
      }),
    ])
    if (!brand) return {}

    return {
      brandName: brand.name,
      ...(brand.domain ? { brandDomain: brand.domain } : {}),
      ...(competitors.length > 0
        ? { competitorNames: competitors.map((c) => c.name).join(',') }
        : {}),
    }
  }

  // ── 落库 ────────────────────────────────────────────────────────────────

  /** 成功分支：写 result、累加 run 的计数与成本、落用量明细账、入队分析。 */
  private async recordSuccess(
    result: { id: string; runId: string; brandId: string; promptId: string; engineCode: string; tenantId: string },
    engine: {
      pricePerQueryCents: number
      priceInPerMTokenCents: number
      priceOutPerMTokenCents: number
    },
    output: EngineAskOutput,
  ): Promise<void> {
    const { text, truncated } = truncateRawText(output.text)
    const costCents = computeCostCents(engine, output.usage)
    const answeredAt = new Date()

    await this.prisma.tenant.geoQueryResult.update({
      where: { id: result.id },
      data: {
        status: 'OK',
        rawText: text,
        rawTruncated: truncated,
        preview: makePreview(text),
        fingerprint: fingerprintOf(result.engineCode, result.promptId, text),
        model: output.model,
        latencyMs: output.latencyMs,
        inputTokens: output.usage.inputTokens,
        outputTokens: output.usage.outputTokens,
        searchCalls: output.usage.searchCalls,
        costCents,
        // 上一次失败留下的痕迹要清掉——否则一条「重试了两次最后成功」的行会带着
        // 一个 TIMEOUT 的 errorKind，而 `summarizeErrors` 只看 errorKind 不看 status。
        errorKind: null,
        errorMessage: null,
        answeredAt,
      },
    })

    // 原子自增：同一批里有 4 个 worker 在并发写同一行 run，读-改-写会丢更新。
    await this.prisma.tenant.geoQueryRun.update({
      where: { id: result.runId },
      data: { doneQueries: { increment: 1 }, totalCostCents: { increment: costCents } },
    })

    // 用量明细账。它是**成本对账的真源**，不是配额判定的真源（技术设计 §1.1 D4 第 4 条）：
    // 配额看 `QuotaCounter`，这张表回答「这个月这家店在哪个引擎上花了多少钱」。
    await this.prisma.tenant.geoUsageLedger.create({
      data: autoTenantData<Prisma.GeoUsageLedgerCreateInput>({
        brandId: result.brandId,
        runId: result.runId,
        metric: 'QUERY',
        engineCode: result.engineCode,
        quantity: 1,
        costCents,
        month: monthKeyOf(answeredAt),
        occurredAt: answeredAt,
      }),
    })

    // `citations` 随消息走：`GeoQueryResult` 上没有一列能存引擎返回的引用列表，
    // 而分析 handler 需要它才能建 `GeoCitation`（理由见那个文件的文件头）。
    await this.queue.add(
      GEO_RESULT_ANALYZE_JOB_NAME,
      { resultId: result.id, citations: output.citations },
      { tenantId: result.tenantId, jobId: analyzeJobId(result.id) },
    )
  }

  /**
   * 失败分支：写 result(FAILED)、`failedQueries + 1`、收口。
   *
   * ## 这个方法**不碰配额**，这是刻意的
   *
   * 两个调用点各自已经把配额处理完了：
   * - 「引擎被停用」那条**根本没 consume 过**（一次调用都没发生）；
   * - 「不可重试的错误」那条在 `process()` 的 catch 里已经 release 过了
   *   （那里是对称补偿，见文件头）。
   *
   * 在这里再还一次的话，`release` 用的是 `Math.max(0, used - delta)`，
   * 多还的那一个会把**别的**查询占住的名额吃掉——表现是月底的用量比实际少几次，
   * 没有任何错误，只是配额静默放宽。
   */
  private async markFailed(
    result: { id: string; runId: string },
    errorKind: string,
    errorMessage: string,
  ): Promise<void> {
    await this.prisma.tenant.geoQueryResult.update({
      where: { id: result.id },
      data: {
        status: 'FAILED',
        errorKind,
        errorMessage: capMessage(errorMessage),
        answeredAt: new Date(),
      },
    })

    await this.prisma.tenant.geoQueryRun.update({
      where: { id: result.runId },
      data: { failedQueries: { increment: 1 } },
    })

    this.logger.warn(`回答 ${result.id} 判失败（${errorKind}）：${errorMessage}`, CONTEXT)

    // 这条可能是整批的最后一条。`settle` 自己会判「还有 PENDING 就什么都不做」。
    await this.runs.settle(result.runId)
  }
}
