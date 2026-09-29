/**
 * 跑批（`GeoQueryRun`）与回答明细（`GeoQueryResult`）的数据访问层 + 状态机收口。
 *
 * ## 全文没有一处 `tenantId`
 *
 * 与 `brand/geo-brand.service.ts` 同一条约定，`test/arch/no-manual-tenant-filter.spec.ts`
 * （spec 4）扫的就是这件事。**队列 handler 里同样成立**——worker 会用信封里的
 * `originTenantId` 开一个租户上下文（见 `processor.factory.ts` 的 `execute`），
 * 所以 handler 里照常 `prisma.tenant`。
 *
 * ## 三个入口，一个 `create()`
 *
 * `POST /geo/runs`（手动）与 `geo-run-schedule.cron.ts`（定时）都调同一个
 * {@link GeoRunService.create}，只有 `triggeredBy` 不同。不做成两条路径是因为
 * 配额前置、引擎过滤、问法选取这三件事一旦有两份实现，定时那条迟早会漏掉其中一件——
 * 而定时那条是**没有人看着**的那一条。
 *
 * ## `settle()` 为什么在 service 而不是 handler
 *
 * 它有两个调用点：`geo-query-execute.handler.ts`（失败分支）与
 * `analysis/geo-result-analyze.handler.ts`（分析完成）。放在任一个 handler 里都会让
 * 另一个 handler 反向依赖它，而两个 handler 之间本来没有任何关系。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { GeoQueryRun, GeoRunTrigger, Prisma } from '@prisma/client'
import { ErrorCode, normalizePage, type PageResult } from '@taizan/contracts'
import { QuotaService } from '@taizan/nest-billing'
import { AppLogger, BizException, currentContext } from '@taizan/nest-core'
import { QueueService } from '@taizan/nest-infra'
import { PrismaService } from '@taizan/nest-prisma'

import { autoTenantData, type AppPrismaService } from '../../../common/prisma.types'
import { toDateKey } from '../aggregate/geo-metrics.rules'
import { GeoBrandService } from '../brand/geo-brand.service'
import { GeoEngineService } from '../engine/geo-engine.service'
import { GEO_DAILY_AGGREGATE_JOB_NAME, GEO_RUN_DISPATCH_JOB_NAME } from './geo-job-names'
import {
  aggregateJobId,
  planQueries,
  resolveRunStatus,
  runJobId,
  summarizeErrors,
  type RunCounts,
} from './geo-run.rules'
import type {
  CreateGeoRunDto,
  GeoResultDetailView,
  GeoResultView,
  GeoRunDetailView,
  GeoRunStatusLike,
  GeoRunTriggerLike,
  GeoRunView,
  ListGeoResultQueryDto,
  ListGeoRunQueryDto,
} from './dto/geo-run.dto'

const CONTEXT = 'GeoRun'

/**
 * 月度查询次数占哪一档配额（技术设计 §1.1 D4）。
 *
 * 它与 `GEO_BRAND` / `GEO_PROMPT` 那种「存量型」不同：**只增不减**，靠
 * `geo-quota-month-reset.cron.ts` 在每月 1 号把 `QuotaCounter.used` 清零。
 * 失败时的 `release` 是**补偿**（这次没跑成，不该算数），不是「删掉一个对象」。
 */
export const GEO_QUERY_QUOTA_KIND = 'GEO_QUERY_MONTHLY'

/** `create()` 回给调用方的东西：视图 + 这次规划出来的查询条数。 */
export interface CreatedRun {
  run: GeoRunView
  /** 规划出的查询条数（= `prompts × engines × sampleSize`）。 */
  planned: number
}

/** {@link GeoRunService.loadDispatchPlan} 的产出，给 dispatch handler 用。 */
export interface DispatchPlan {
  run: GeoQueryRun
  rows: Array<{ promptId: string; engineCode: string; sampleIndex: number }>
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** `errorSummary` 在库里是一段 JSON 文本；解不出来回 `null` 而不是抛（它只是给人看的统计）。 */
function parseErrorSummary(raw: string | null): Record<string, number> | null {
  if (raw === null || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number') out[key] = value
    }
    return out
  } catch {
    return null
  }
}

function toRunView(row: GeoQueryRun): GeoRunView {
  return {
    id: row.id,
    brandId: row.brandId,
    triggeredBy: row.triggeredBy as GeoRunTriggerLike,
    status: row.status as GeoRunStatusLike,
    engineCodes: toStringArray(row.engineCodes),
    sampleSize: row.sampleSize,
    totalQueries: row.totalQueries,
    doneQueries: row.doneQueries,
    failedQueries: row.failedQueries,
    totalCostCents: row.totalCostCents,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    errorSummary: parseErrorSummary(row.errorSummary),
    createdBy: row.createdBy,
    isDiagnosis: row.isDiagnosis,
    diagnosisReportId: row.diagnosisReportId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

type GeoQueryResultRow = Awaited<
  ReturnType<AppPrismaService['tenant']['geoQueryResult']['findFirst']>
>

function toResultView(row: NonNullable<GeoQueryResultRow>): GeoResultView {
  return {
    id: row.id,
    runId: row.runId,
    brandId: row.brandId,
    promptId: row.promptId,
    engineCode: row.engineCode,
    sampleIndex: row.sampleIndex,
    status: row.status as GeoResultView['status'],
    preview: row.preview,
    rawTruncated: row.rawTruncated,
    model: row.model,
    latencyMs: row.latencyMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    searchCalls: row.searchCalls,
    costCents: row.costCents,
    errorKind: row.errorKind,
    errorMessage: row.errorMessage,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    analyzedAt: row.analyzedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

@Injectable()
export class GeoRunService {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(GeoBrandService) private readonly brands: GeoBrandService,
    @Inject(GeoEngineService) private readonly engines: GeoEngineService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  // ── 建一次跑批 ──────────────────────────────────────────────────────────

  /**
   * 建一次跑批并入队。
   *
   * 顺序是**定死**的（技术设计 §10 第 4、5 条）：
   * 1. 校验品牌属于本店（复用 `GeoBrandService.requireBrand`，错误码与品牌页一致）；
   * 2. 算出引擎集与问法集，`planQueries` 展开成查询计划；
   * 3. `quota.check(GEO_QUERY_MONTHLY, total)` —— **只算不写**，不足直接抛 1540301；
   * 4. 建 `GeoQueryRun(PENDING)`；
   * 5. **写库成功之后、事务之外**入队 `geo.run.dispatch`。
   *
   * 第 3 步为什么是 `check` 而不是 `consume`：一次跑批的 total 可能是几百，
   * 在这里整批占掉的话，某一条查询失败时要精确地还回去几个，而失败是逐条发生的。
   * 真正的占用在 `geo-query-execute.handler.ts` 里**逐条** `consume(1)`，
   * 这里的 `check` 只是「明知不够就别开始」的前置拦截——它挡住的是
   * 「跑了一半钱没了、报表半残」这种最难解释的状态。
   *
   * 第 5 步为什么不在事务里：入队成功而事务回滚的话，worker 会拿着一个
   * 库里不存在的 runId 醒来（dispatch handler 因此必须容忍「run 找不到」）。
   *
   * @param dto - 手动触发的入参；cron 调用时只填 `brandId`
   * @param triggeredBy - `MANUAL`（HTTP）或 `SCHEDULE`（cron）
   * @param diagnosis - 仅 `GeoDiagnosisService` 传：把这次跑批标成「诊断编排触发」，
   *   `geo.daily.aggregate` 写完当天汇总后会顺带找到它并生成一份 `ONE_SHOT` 报表
   *   （见 `aggregate/geo-daily-aggregate.handler.ts` 的 `maybeFinalizeDiagnosis`）。
   *   不传 = 普通跑批（HTTP 手动 / cron 定时），行为与改动前完全一致。
   * @throws 1240300 品牌不存在/不属于本店；1040000 没有可跑的引擎或问法；1540301 配额不足
   */
  async create(
    dto: CreateGeoRunDto,
    triggeredBy: GeoRunTriggerLike,
    diagnosis?: { promptSetId?: string },
  ): Promise<CreatedRun> {
    const brand = await this.brands.requireBrand(dto.brandId)

    const engineCodes = await this.resolveEngineCodes(brand, dto.engineCodes)
    const promptIds = await this.resolvePromptIds(brand.id, dto.promptIds)
    const sampleSize = dto.sampleSize ?? brand.sampleSize

    const planned = planQueries({ brandId: brand.id, promptIds, engineCodes, sampleSize })
    if (planned.length === 0) {
      // 走到这里说明 `planQueries` 把两个非空集合展开成了空——只可能是 sampleSize 被夹到 0，
      // 而它的下界是 1。留一条明确的错误，比建一个 totalQueries=0 的空 run 好。
      throw new BizException(ErrorCode.BAD_REQUEST, '这次跑批一条查询都规划不出来，请检查采样次数')
    }

    // 前置拦截：只算不写。
    const check = await this.quota.check(GEO_QUERY_QUOTA_KIND, planned.length)
    if (!check.ok) {
      throw new BizException(
        ErrorCode.QUOTA_EXCEEDED,
        `本月查询次数不够了：这一批要 ${planned.length} 次，` +
          `当前已用 ${check.used}${check.limit === null ? '' : ` / ${check.limit}`} 次。` +
          '可以先减少引擎或问法，或者升一档套餐。',
        { kind: GEO_QUERY_QUOTA_KIND, need: planned.length, used: check.used, limit: check.limit },
      )
    }

    const row = await this.prisma.tenant.geoQueryRun.create({
      data: autoTenantData<Prisma.GeoQueryRunCreateInput>({
        brandId: brand.id,
        triggeredBy: triggeredBy as GeoRunTrigger,
        status: 'PENDING',
        // 落的是**这一次真正要跑的**引擎集，不是品牌配置里那一份快照：
        // 平台停用了某个引擎之后，这一批确实没跑它，报表要能对得上。
        engineCodes,
        sampleSize,
        // `totalQueries` 由 dispatch handler 在真的建出 result 行之后回填。
        // 在这里先写一个预估值的话，dispatch 因唯一键跳过若干重复行时两者就对不上了。
        totalQueries: 0,
        createdBy: currentContext()?.identity?.id ?? null,
        isDiagnosis: diagnosis !== undefined,
        diagnosisPromptSetId: diagnosis?.promptSetId ?? null,
      }),
    })

    // ── 入队：写库成功之后、事务之外 ─────────────────────────────────────
    // `tenantId` **必须显式传**：worker 侧没有 HTTP 请求，租户上下文只能从信封恢复
    //（技术设计 §10 第 3 条）。漏传的表现是 handler 里第一条 `prisma.tenant` 直接抛。
    await this.queue.add(
      GEO_RUN_DISPATCH_JOB_NAME,
      // `promptIds` 只在触发方**显式指定了子集**时带上，理由见 dispatch handler 的文件头
      //（表上没有一列能存「这一批跑的是哪几条问法」，而 dispatch 里重新取一遍会取到全量）。
      { runId: row.id, ...(dto.promptIds && dto.promptIds.length > 0 ? { promptIds } : {}) },
      { tenantId: row.tenantId, jobId: runJobId(row.id) },
    )

    return { run: toRunView(row), planned: planned.length }
  }

  // ── 读 ──────────────────────────────────────────────────────────────────

  /** 跑批分页列表。 */
  async list(query: ListGeoRunQueryDto): Promise<PageResult<GeoRunView>> {
    const { page, pageSize } = normalizePage(query)

    const where: Prisma.GeoQueryRunWhereInput = {}
    if (query.brandId) where.brandId = query.brandId
    if (query.status) where.status = query.status

    const [rows, total] = await Promise.all([
      this.prisma.tenant.geoQueryRun.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tenant.geoQueryRun.count({ where }),
    ])

    return { items: rows.map(toRunView), total, page, pageSize }
  }

  /** 跑批详情，附一份按结果状态分的实时计数（前端的进度条靠它）。 */
  async get(id: string): Promise<GeoRunDetailView> {
    const row = await this.requireRun(id)
    const counts = await this.countResultsByStatus(id)
    return { ...toRunView(row), resultCounts: counts }
  }

  /** 回答明细分页列表（**不含原文**，理由见 `GeoResultDetailView` 的说明）。 */
  async listResults(query: ListGeoResultQueryDto): Promise<PageResult<GeoResultView>> {
    const { page, pageSize } = normalizePage(query)

    const where: Prisma.GeoQueryResultWhereInput = {}
    if (query.brandId) where.brandId = query.brandId
    if (query.runId) where.runId = query.runId
    if (query.engineCode) where.engineCode = query.engineCode
    if (query.promptId) where.promptId = query.promptId
    if (query.status) where.status = query.status

    const [rows, total] = await Promise.all([
      this.prisma.tenant.geoQueryResult.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tenant.geoQueryResult.count({ where }),
    ])

    return { items: rows.map(toResultView), total, page, pageSize }
  }

  /** 回答明细详情：原文 + 这条回答分析出来的提及与引用。 */
  async getResult(id: string): Promise<GeoResultDetailView> {
    const row = await this.prisma.tenant.geoQueryResult.findFirst({ where: { id } })
    if (!row) {
      throw new BizException(ErrorCode.CROSS_TENANT_FORBIDDEN, '回答不存在，或不属于当前店铺')
    }

    const [mentions, citations] = await Promise.all([
      this.prisma.tenant.geoMention.findMany({
        where: { resultId: id },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.tenant.geoCitation.findMany({
        where: { resultId: id },
        orderBy: [{ rank: 'asc' }, { id: 'asc' }],
      }),
    ])

    return {
      ...toResultView(row),
      rawText: row.rawText,
      mentions: mentions.map((m) => ({
        id: m.id,
        entityKind: m.entityKind,
        competitorId: m.competitorId,
        entityName: m.entityName,
        position: m.position,
        isCited: m.isCited,
        sentiment: m.sentiment,
        sentimentScore: m.sentimentScore,
        snippet: m.snippet,
      })),
      citations: citations.map((c) => ({
        id: c.id,
        url: c.url,
        domain: c.domain,
        platform: c.platform,
        category: c.category,
        rank: c.rank,
        title: c.title,
      })),
    }
  }

  // ── 给 handler 用 ───────────────────────────────────────────────────────

  /**
   * dispatch handler 用：读出这次跑批要建哪些 result 行。
   *
   * 回 `null` 表示「这次不用做了」——run 不存在（入队成功但事务回滚了），
   * 或者它已经不是 `PENDING`（这条消息是重放）。两种都不是错误。
   *
   * @param runId - 跑批 id
   * @param promptIds - 触发方指定的问法子集（见 `geo-run-dispatch.handler.ts` 文件头
   *   「payload 里为什么有 promptIds」）；不传则取品牌下全部 `isTracked` 的
   */
  async loadDispatchPlan(runId: string, promptIds?: string[]): Promise<DispatchPlan | null> {
    const run = await this.prisma.tenant.geoQueryRun.findFirst({ where: { id: runId } })
    if (!run) return null
    // 幂等：`jobId` 已经挡掉了绝大多数重复投递，但死信重放会绕过它（那是另一个 job id）。
    if (run.status !== 'PENDING') return null

    const engineCodes = toStringArray(run.engineCodes)
    const prompts = await this.resolvePromptIds(
      run.brandId,
      promptIds && promptIds.length > 0 ? promptIds : undefined,
    )
    const rows = planQueries({
      brandId: run.brandId,
      promptIds: prompts,
      engineCodes,
      sampleSize: run.sampleSize,
    })
    return { run, rows }
  }

  /**
   * 状态机收口（技术设计 §4.2 的 `settle(runId)`）。**不是 job**，是一个纯计数 + 一次条件更新。
   *
   * 三个调用点：`geo-query-execute.handler.ts` 的失败分支、
   * `analysis/geo-result-analyze.handler.ts` 的末尾、`geo-run-sweeper.cron.ts` 的兜底。
   * 每一条都可能是「最后一条」，而哪一条是最后一条要等真的数完才知道——
   * 所以判定放在这里，不放在调用点。
   *
   * ## T7 修正一：「完成」的定义要求 `analyzedAt`
   *
   * T6 数的是 `GeoQueryResult.status`，而那一列在**执行**阶段就变成了 `OK`
   * （分析是它派生出来的下一条消息）。于是「全部执行完」会**先于**「全部分析完」发生，
   * `geo.daily.aggregate` 可能在最后几条 `geo.result.analyze` 还没落库时就被消费——
   * 按 `GeoMention` 算出来的可见度会**偏低**，而且不报错、只是数字小一点。
   *
   * T7 把口径改成：**一条结果算「完成」当且仅当**
   * - `status === 'FAILED'`（它没有正文可分析，执行 handler 已经替它收过口），或者
   * - `status === 'OK' 且 analyzedAt !== null`。
   *
   * `OK 且 analyzedAt 为空` 与 `PENDING` 一样算「仍在进行」。这样聚合消息只会在
   * **分析全部落库之后**入队。代价是一条分析永远失败的结果会把整批卡在 RUNNING——
   * 那正是 `geo-run-sweeper.cron.ts` 兜的场景。
   *
   * ## T7 修正二：终态用条件更新，只有真正改到的那一次才入队
   *
   * 写终态用 `updateMany({ where: { id, status: 'RUNNING' } })` 而不是 `update({ where: { id } })`。
   * 并发的两条 settle（最后两条分析几乎同时完成）会同时数到「都完成了」，
   * 用无条件 `update` 的话两次都会写一遍 `finishedAt` 并各入队一次聚合：
   * jobId 相同所以聚合本身无害，但 `finishedAt` 会被刷成第二次那一刻，
   * 而那不是这一批真正结束的时间（对账时「跑了多久」会短一截）。
   *
   * `updateMany` 的返回值 `count` 是**这次真的把 RUNNING 改成终态的行数**：
   * 只有 `count === 1` 的那一次继续往下入队，另一次直接返回状态。
   * 这是一次数据库层面的 compare-and-set，不需要额外的锁。
   *
   * 条件写死 `status: 'RUNNING'`（不是 `{ in: ['PENDING','RUNNING'] }`）：
   * `geo-run-dispatch.handler.ts` 在建出 result 行的同一次更新里就把 run 置成了
   * `RUNNING` 并回填 `startedAt`，所以任何「有结果可数」的时刻 run 必然已经是 RUNNING。
   * 放宽条件只会让一条本该被 sweeper 处理的异常 run 被悄悄收口。
   *
   * @param runId - 跑批 id
   * @returns 这次收口之后的状态；还没到收口时机（仍有未完成的结果）时回 `null`
   */
  async settle(runId: string): Promise<GeoRunStatusLike | null> {
    const run = await this.prisma.tenant.geoQueryRun.findFirst({ where: { id: runId } })
    if (!run) return null
    if (run.status === 'DONE' || run.status === 'PARTIAL' || run.status === 'FAILED') {
      return run.status as GeoRunStatusLike
    }

    const counts = await this.countSettleProgress(runId)
    const status = resolveRunStatus(counts)
    if (status === null) return null

    // 失败分布只在真有失败时才去查——没失败的那一批（绝大多数）省掉一次查询。
    let errorSummary: string | null = null
    if (counts.failed > 0) {
      const failedRows = await this.prisma.tenant.geoQueryResult.findMany({
        where: { runId, status: 'FAILED' },
        select: { errorKind: true },
      })
      errorSummary = JSON.stringify(summarizeErrors(failedRows))
    }

    // compare-and-set：只有把 RUNNING 真的改成终态的那一次才算「我收的口」。
    const applied = await this.prisma.tenant.geoQueryRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: { status, finishedAt: new Date(), errorSummary },
    })
    if (applied.count === 0) {
      // 并发的另一条 settle 抢先收口了（或者这条 run 根本不在 RUNNING）。
      // 不入队、不刷 finishedAt——那一次已经做过了，jobId 相同做第二次也只是浪费。
      return status as GeoRunStatusLike
    }

    // 收口之后触发当天的聚合。聚合 handler 自己还会再判一次「当天有没有
    // OK 但没分析的结果」（见 `aggregate/geo-daily-aggregate.handler.ts`）——
    // 这里的判定管的是「这一批」，那里管的是「这一天」，两者不是同一个集合：
    // 同一天可能有别的 run 还在跑。
    const date = toDateKey(new Date())
    await this.queue.add(
      GEO_DAILY_AGGREGATE_JOB_NAME,
      { brandId: run.brandId, date },
      { tenantId: run.tenantId, jobId: aggregateJobId(run.tenantId, run.brandId, date) },
    )

    this.logger.log(
      `跑批 ${runId} 收口：${status}（完成 ${counts.done}、失败 ${counts.failed}、共 ${counts.total}）`,
      CONTEXT,
    )
    return status as GeoRunStatusLike
  }

  // ── 给平台侧重跑用 ──────────────────────────────────────────────────────

  /**
   * 【平台侧重跑】把这次跑批里还停在 `FAILED` 的结果重置为 `PENDING`，run 收回 `RUNNING`。
   *
   * 调用方是 `usage/geo-platform-run.controller.ts` 的 `POST /:id/retry`：它先用
   * `runWithContext({ tenantId })` 现开一个租户上下文（`tenantId` 来自它 raw 读到的
   * 那条 run），再调这个方法——本方法因此仍然全程 `prisma.tenant`，与文件头那条
   * 约定不冲突。
   *
   * **不判配额、不判限速**：闸门在 `geo-query-execute.handler.ts` 的
   * `quota.consume`/`rateLimiter.acquire` 里，每条重新入队的消息会在真正执行时
   * 按当时的余量判定。这里提前查一遍是重复劳动，还会长出第二套判据——
   * 两套判据一旦有一天口径不一致（比如一个算了 release 的补偿、一个没算），
   * 「重试按钮显示能点但点了就 1540301」这种体验才是真正难查的 bug。
   *
   * @param runId - 跑批 id（必须属于当前上下文租户，由调用方保证）
   * @returns 被重置的 `GeoQueryResult` id 列表；这次跑批没有 `FAILED` 结果时回空数组
   *   （调用方据此判断"没什么可重试的"，不必入队）
   * @throws 1240300 跑批不存在，或不属于当前上下文租户
   */
  async resetFailedForRetry(runId: string): Promise<string[]> {
    const run = await this.requireRun(runId)
    const failedRows = await this.prisma.tenant.geoQueryResult.findMany({
      where: { runId: run.id, status: 'FAILED' },
      select: { id: true },
    })
    if (failedRows.length === 0) return []

    await this.prisma.tenant.geoQueryResult.updateMany({
      where: { runId: run.id, status: 'FAILED' },
      data: { status: 'PENDING', errorKind: null, errorMessage: null, answeredAt: null },
    })
    // `finishedAt` 清空、状态收回 RUNNING：这一批还没真的结束，settle() 会在
    // 重跑的结果都落定之后再次判定终态（与首次跑批完全同一套收口逻辑）。
    await this.prisma.tenant.geoQueryRun.update({
      where: { id: run.id },
      data: {
        status: 'RUNNING',
        finishedAt: null,
        failedQueries: { decrement: failedRows.length },
      },
    })
    return failedRows.map((r) => r.id)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** 拿到一条属于本店的跑批，否则 1240300（与品牌那边同形，不区分「不存在」与「是别人的」）。 */
  private async requireRun(id: string): Promise<GeoQueryRun> {
    const row = await this.prisma.tenant.geoQueryRun.findFirst({ where: { id } })
    if (!row) {
      throw new BizException(ErrorCode.CROSS_TENANT_FORBIDDEN, '跑批不存在，或不属于当前店铺')
    }
    return row
  }

  /** 一次跑批下的 result 按 status 分组计数。 */
  private async countResultsByStatus(runId: string): Promise<Record<string, number>> {
    const grouped = await this.prisma.tenant.geoQueryResult.groupBy({
      by: ['status'],
      where: { runId },
      _count: { _all: true },
    })
    const out: Record<string, number> = {}
    for (const g of grouped) out[g.status] = g._count._all
    return out
  }

  /**
   * 收口用的进度计数。与 {@link GeoRunService.countResultsByStatus} 的区别是
   * **它把「OK 但还没分析」算进 `pending`**，理由见 `settle()` 的「T7 修正一」。
   *
   * 三次 `count` 而不是一次 `groupBy`：`groupBy(['status'])` 分不出「OK 已分析」与
   * 「OK 未分析」这两桶（`analyzedAt` 是一个可空时间列，不是分组维度）。加一个
   * `groupBy(['status','analyzedAt'])` 会按每一个不同的时间戳各分一组——那是几百组。
   * 三次带索引的 `count` 比在应用层展开几百组便宜，也好读得多。
   *
   * @param runId - 跑批 id
   */
  private async countSettleProgress(runId: string): Promise<RunCounts> {
    const [pendingExec, failed, done, awaitingAnalysis] = await Promise.all([
      this.prisma.tenant.geoQueryResult.count({ where: { runId, status: 'PENDING' } }),
      this.prisma.tenant.geoQueryResult.count({ where: { runId, status: 'FAILED' } }),
      this.prisma.tenant.geoQueryResult.count({
        where: { runId, status: 'OK', analyzedAt: { not: null } },
      }),
      this.prisma.tenant.geoQueryResult.count({
        where: { runId, status: 'OK', analyzedAt: null },
      }),
    ])
    const pending = pendingExec + awaitingAnalysis
    return { total: pending + done + failed, done, failed, pending }
  }

  /**
   * 算出这次要跑哪些引擎。
   *
   * 两层过滤：
   * 1. 必须在品牌的 `engineCodes` 里——商家选的就是这几个，接口不该能绕过它；
   * 2. 必须**当前仍然启用**——平台停用一个引擎是立刻生效的，存量品牌的快照里还留着
   *    那个 code（那是历史记录，不该被平台的操作改写），跑批时跳过它。
   *
   * 过滤完一个不剩就抛，不是建一个空 run：空 run 在列表上显示成「完成，0 条」，
   * 而商家要的答案是「你选的引擎平台都停用了」。
   */
  private async resolveEngineCodes(
    brand: { engineCodes: unknown; name: string },
    requested: string[] | undefined,
  ): Promise<string[]> {
    const brandCodes = toStringArray(brand.engineCodes)
    if (brandCodes.length === 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `品牌「${brand.name}」还没有选监测引擎，先去品牌管理里选至少一个`,
      )
    }

    const wanted = requested === undefined ? brandCodes : brandCodes.filter((c) => requested.includes(c))
    if (wanted.length === 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        '指定的引擎都不在这个品牌的监测范围里；先去品牌管理里把它加进去',
      )
    }

    const enabled = await this.engines.enabledCodes()
    const usable = wanted.filter((code) => enabled.has(code))
    if (usable.length === 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `这个品牌选的引擎（${wanted.join('、')}）当前都被平台停用了，没有可跑的引擎`,
      )
    }
    return usable
  }

  /**
   * 算出这次要跑哪些问法。
   *
   * 不指定时取品牌下全部 `isTracked` 的（`isTracked=false` 的问法是「留着看历史但不再花钱」）；
   * 指定时仍然要与库里对一遍——传一个别的品牌的 promptId 进来必须查不到，
   * 而不是被当成这个品牌的问法跑掉。
   */
  private async resolvePromptIds(
    brandId: string,
    requested: string[] | undefined,
  ): Promise<string[]> {
    const where: Prisma.GeoPromptWhereInput = { brandId }
    if (requested === undefined) where.isTracked = true
    else where.id = { in: requested }

    const rows = await this.prisma.tenant.geoPrompt.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
    if (rows.length === 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        requested === undefined
          ? '这个品牌下一条「追踪中」的问法都没有，先去 Prompt 管理里加几条'
          : '指定的问法一条都不属于这个品牌',
      )
    }
    return rows.map((r) => r.id)
  }
}
