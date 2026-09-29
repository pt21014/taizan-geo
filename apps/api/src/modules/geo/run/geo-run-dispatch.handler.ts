/**
 * `geo.run.dispatch`：把一次跑批**展开**成一条条待执行的查询（技术设计 §4.2）。
 *
 * ```
 * PENDING ──(本 handler)──> RUNNING ──(settle)──> DONE | PARTIAL | FAILED
 * ```
 *
 * 它自己不调任何引擎，只做三件事：建 `GeoQueryResult(PENDING)` 行、把 run 推到
 * `RUNNING` 并回填 `totalQueries`、逐条入队 `geo.query.execute`。
 *
 * ## 重放安全靠**唯一键**，不靠「我记得我做过」
 *
 * `GeoQueryResult` 上有 `@@unique([tenantId, runId, promptId, engineCode, sampleIndex])`，
 * `createMany({ skipDuplicates: true })` 于是天然幂等：这条消息被重放多少次，
 * 库里都只有那一份行。前面那道 `run.status !== 'PENDING' → 直接返回`
 * （在 `loadDispatchPlan` 里）只是省掉一次白跑，**不是**幂等的依靠——死信重放用的是
 * 另一个 job id，`jobId` 去重对它不生效。
 *
 * ## payload 里为什么有 `promptIds`
 *
 * `GeoQueryRun` 上没有一列能存「这一批跑的是哪几条问法」（表结构由 T3 定死，
 * 本任务不改 schema）。而 `POST /geo/runs` 允许传 `promptIds` 只跑一个子集——
 * 如果 dispatch 在这里重新查一遍「全部 isTracked 的问法」，那个子集就失效了，
 * 表现是「我只想重跑一条，结果它把三百条全跑了」，而账单上看得见。
 *
 * 于是把它放进 payload。代价是这条消息比设计文档里写的 `{ runId }` 多一个字段；
 * 收益是死信重放时那个子集仍然**原样保留**（`replayEnvelope` 不改 payload）。
 * 真正该有的形状是表上加一列 `promptIds Json`，那是 T7 改 schema 时顺手的事。
 *
 * ## 逐条入队而不是一条消息跑完整批
 *
 * 一批可能是几百次真实的引擎调用，跑满几十分钟。放在一条消息里的话，第 200 次失败
 * 会让前面 199 次全部重来（BullMQ 的重试粒度是消息）；而拆开之后，失败的只有那一条。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { ulid } from '@taizan/contracts'
import { AppLogger, currentContext } from '@taizan/nest-core'
import {
  JobHandler,
  QueueService,
  type JobEnvelope,
  type JobProcessor,
} from '@taizan/nest-infra'
import { PrismaService } from '@taizan/nest-prisma'

import type { AppPrismaService } from '../../../common/prisma.types'
import { GEO_QUERY_EXECUTE_JOB_NAME, GEO_RUN_DISPATCH_JOB_NAME } from './geo-job-names'
import { queryJobId } from './geo-run.rules'
import { GeoRunService } from './geo-run.service'

/** `geo.run.dispatch` 的消息体。 */
export interface GeoRunDispatchPayload {
  runId: string
  /** 触发方指定的问法子集；不传 = 品牌下全部 `isTracked` 的。见文件头。 */
  promptIds?: string[]
}

const CONTEXT = 'GeoRunDispatch'

@Injectable()
@JobHandler({ name: GEO_RUN_DISPATCH_JOB_NAME, concurrency: 2, attempts: 3 })
export class GeoRunDispatchHandler implements JobProcessor<GeoRunDispatchPayload> {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(GeoRunService) private readonly runs: GeoRunService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async process(envelope: JobEnvelope<GeoRunDispatchPayload>): Promise<void> {
    const { runId, promptIds } = envelope.data
    const tenantId = currentContext()?.tenantId ?? envelope.originTenantId

    const plan = await this.runs.loadDispatchPlan(runId, promptIds)
    if (plan === null) {
      // 两种情况：run 不存在（入队成功但建 run 的事务回滚了），或者它已经不是 PENDING
      //（这条消息是重放）。都不是错误——**不要抛**，抛了会让这条消息一路走到死信，
      // 而死信页上一条「跑批已经跑过了」的记录只会浪费运维的时间。
      this.logger.log(`跑批 ${runId} 没有可展开的计划（不存在或已不是 PENDING），跳过`, CONTEXT)
      return
    }

    const { run, rows } = plan

    // ── 建结果行 ────────────────────────────────────────────────────────
    // `skipDuplicates` 配合唯一键 = 重放安全（见文件头）。
    // `id` 手写一个 ULID：`createMany` **不过** ULID 扩展（那个扩展挂在 `create` 上），
    // 而主键没有 `@default`。
    const data: Prisma.GeoQueryResultCreateManyInput[] = rows.map((row) => ({
      id: ulid(),
      // `createMany` 同样不过租户扩展的自动注入，`tenantId` 只能从 run 上带过来——
      // 它来自库里那一行，不来自任何请求参数，所以这不是「手写租户过滤条件」。
      tenantId: run.tenantId,
      runId: run.id,
      brandId: run.brandId,
      promptId: row.promptId,
      engineCode: row.engineCode,
      sampleIndex: row.sampleIndex,
      status: 'PENDING',
    }))

    await this.prisma.tenant.geoQueryResult.createMany({ data, skipDuplicates: true })

    // 真正建出来的行（含上一次重放已经建好的）才是 `totalQueries`——
    // 用 `data.length` 的话，重放时两者会对不上。
    const created = await this.prisma.tenant.geoQueryResult.findMany({
      where: { runId: run.id },
      select: { id: true, status: true },
    })

    await this.prisma.tenant.geoQueryRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', totalQueries: created.length, startedAt: new Date() },
    })

    // ── 逐条入队 ────────────────────────────────────────────────────────
    // 只给还是 PENDING 的入队：重放时已经跑完的那些不该再跑一次（`jobId` 也会挡，
    // 但 BullMQ 对**已完成并被清理掉**的 job id 是不去重的，所以这一层筛选是必要的）。
    for (const result of created) {
      if (result.status !== 'PENDING') continue
      await this.queue.add(
        GEO_QUERY_EXECUTE_JOB_NAME,
        { resultId: result.id },
        { tenantId: run.tenantId, jobId: queryJobId(result.id) },
      )
    }

    this.logger.log(
      `跑批 ${runId} 已展开 ${created.length} 条查询并入队（租户 ${tenantId ?? '无'}）`,
      CONTEXT,
    )
  }
}
