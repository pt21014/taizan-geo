/**
 * `/api/platform/geo/runs` —— 平台侧跑批监控与重跑（技术设计 §4.1 usage(平台) 一行）。
 *
 * ## 为什么列表查询走 raw
 *
 * `GeoQueryRun` 是租户域表，平台要看的是**全平台**的列表（跨租户），还要把
 * `tenantId` 翻成店名（`Tenant` 是平台域表）。豁免登记在 `tenancy/raw-reasons.ts` 的
 * `src/modules/geo/usage/` 那一条——`/runs` 与 `/usage` 是同一块平台看板，共用一条豁免。
 *
 * ## 重跑为什么先 `runWithContext` 再调 `GeoRunService`
 *
 * 「把 FAILED 结果重置为 PENDING」要走 `prisma.tenant`（`GeoRunService` 全文那条
 * 约定，见它文件头），而平台控制器此刻没有租户上下文——所以先用 raw 读一次
 * 「这条 run 属于哪个租户」，再用 `runWithContext({ tenantId })` 现开一个上下文，
 * 那个 `tenantId` 来自库里那条 run，不来自请求参数。真正的引擎调用发生在重新入队
 * 之后的 `geo.query.execute`，配额在那里逐条判定——这里不预判、不预扣，
 * 理由见 `GeoRunService.resetFailedForRetry` 的文件头。
 *
 * ## 无权限点
 *
 * 与 T1-7 那批平台控制器一致，理由见 `geo-usage.permissions.ts`。
 *
 * ## 为什么审计记的是重置条数而不是「重试成功」
 *
 * `@Audit` 记的是"平台运营按下了这个按钮，对哪条 run"，而不是后续每一次真实调用
 * 的成败——那些成败在 `GeoQueryResult` 自己的历史里（每次尝试都会覆盖
 * `errorKind`/`errorMessage`）。审计答的是「谁在什么时候决定重跑」，不是
 * 「重跑最后跑成了没有」。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject, Param, Post, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { ErrorCode, normalizePage, ulid, type PageResult } from '@taizan/contracts'
import { Audit } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'
import { BizException, runWithContext } from '@taizan/nest-core'
import { QueueService } from '@taizan/nest-infra'
import { RawPrismaService } from '@taizan/nest-prisma'
import type { Request } from 'express'

import type { AppPrismaClient } from '../../../common/prisma.types'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import { Validate } from '../../../common/validate.pipe'
import { GEO_QUERY_EXECUTE_JOB_NAME } from '../run/geo-job-names'
import { queryJobId } from '../run/geo-run.rules'
import { GeoRunService } from '../run/geo-run.service'
import {
  GeoPlatformRunRetryResultView,
  GeoPlatformRunView,
  ListGeoPlatformRunQueryDto,
  type GeoPlatformRunStatusLike,
} from './dto/geo-platform-run.dto'

/** express 5 的 `params` 值类型是 `string | string[]`；`:id` 不可能重复，但类型上要收窄。 */
function paramOf(req: Request, name: string): string | undefined {
  const value = req.params[name]
  return typeof value === 'string' ? value : undefined
}

/** raw 查询选的那几列（够拼出 `GeoPlatformRunView`）。 */
interface RunRow {
  id: string
  tenantId: string
  brandId: string
  status: string
  totalQueries: number
  doneQueries: number
  failedQueries: number
  totalCostCents: number
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
}

@ApiTags('platform/geo/runs')
@Controller('api/platform/geo/runs')
@Auth('platform')
export class GeoPlatformRunController {
  constructor(
    // raw-reason: 平台跑批监控天然跨租户，见文件头。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(GeoRunService) private readonly runs: GeoRunService,
  ) {}

  @Get()
  @ApiOperation({ summary: '全平台跑批列表（按租户/状态筛，分页，附店名）' })
  @ApiOkResponse({ type: GeoPlatformRunView, isArray: true })
  async list(
    @Query(Validate(ListGeoPlatformRunQueryDto)) query: ListGeoPlatformRunQueryDto,
  ): Promise<PageResult<GeoPlatformRunView>> {
    const { page, pageSize } = normalizePage(query)
    const where = {
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.status ? { status: query.status } : {}),
    }

    // raw-reason: 全平台分页列表，见文件头。
    const [rows, total] = await Promise.all([
      this.raw.client.geoQueryRun.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.raw.client.geoQueryRun.count({ where }),
    ])

    const tenantIds = [...new Set(rows.map((r) => r.tenantId))]
    // raw-reason: `Tenant` 是平台域表，把 tenantId 翻成店名。
    const tenants =
      tenantIds.length === 0
        ? []
        : await this.raw.client.tenant.findMany({
            where: { id: { in: tenantIds } },
            select: { id: true, name: true },
          })
    const nameById = new Map(tenants.map((t) => [t.id, t.name]))

    return {
      items: rows.map((r) => this.toView(r, nameById)),
      total,
      page,
      pageSize,
    }
  }

  /**
   * 把一次跑批里失败的结果重置为 PENDING 并重新入队。
   *
   * @throws 1040000 跑批不存在，或当前没有 FAILED 结果可重试
   */
  @Post(':id/retry')
  @ApiOperation({ summary: '重置这次跑批里失败的结果并重新入队（会再花钱，见文件头说明）' })
  @ApiOkResponse({ type: GeoPlatformRunRetryResultView })
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_RUN_PLATFORM_RETRY,
    targetType: 'GeoQueryRun',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  async retry(@Param('id') id: string): Promise<GeoPlatformRunRetryResultView> {
    // raw-reason: 先按 id 跨租户定位这条 run 属于哪个租户，见文件头。
    const run = await this.raw.client.geoQueryRun.findFirst({
      where: { id },
      select: { id: true, tenantId: true },
    })
    if (!run) {
      throw new BizException(ErrorCode.BAD_REQUEST, '跑批不存在')
    }

    const resultIds = await runWithContext(
      {
        traceId: ulid(),
        tenantId: run.tenantId,
        // 平台运营的操作，不是某个客户端的请求；填一个明确的哨兵值而不是
        // 127.0.0.1（后者会让日志看起来像是有人从本机发了一个请求）。
        ip: { client: 'platform', edge: 'platform' },
        startedAt: Date.now(),
      },
      () => this.runs.resetFailedForRetry(run.id),
    )
    if (resultIds.length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, '这次跑批当前没有失败的结果可以重试')
    }

    // `jobId` 复用 `queryJobId`：与 dispatch handler 首次入队同一个理由——
    // BullMQ 对已完成并清理掉的 job id 不去重，重新 add 会正常建出一条新任务。
    for (const resultId of resultIds) {
      await this.queue.add(
        GEO_QUERY_EXECUTE_JOB_NAME,
        { resultId },
        { tenantId: run.tenantId, jobId: queryJobId(resultId) },
      )
    }

    return { id: run.id, retriedCount: resultIds.length }
  }

  private toView(row: RunRow, nameById: Map<string, string>): GeoPlatformRunView {
    return {
      id: row.id,
      tenantId: row.tenantId,
      tenantName: nameById.get(row.tenantId) ?? '未知租户',
      brandId: row.brandId,
      status: row.status as GeoPlatformRunStatusLike,
      totalQueries: row.totalQueries,
      doneQueries: row.doneQueries,
      failedQueries: row.failedQueries,
      totalCostCents: row.totalCostCents,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }
  }
}
