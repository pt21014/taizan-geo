/**
 * 自动跑批 cron（技术设计 §4.3 的 `geo-run-schedule`）：每天凌晨 3 点扫全平台的
 * `ACTIVE` 品牌，按各自的 `refreshFreq` 决定今天跑不跑。
 *
 * ## 为什么走 `RawPrismaService`
 *
 * 它要扫的是**全部租户**的品牌。cron 不属于任何一个租户上下文，`prisma.tenant` 在这里
 * 会正确地抛「无租户上下文」。这条豁免登记在 `tenancy/raw-reasons.ts` 的
 * `src/modules/geo/run/` 那一条上，每个用点还带 `// raw-reason:` 注释（spec 3 两者都查）。
 *
 * ## 扫描用 raw，**建跑批用租户上下文**
 *
 * 这是本文件最要紧的一条：`runService.create()` 里全程 `prisma.tenant`，还要
 * `quota.check()`（它从上下文取 tenantId，取不到直接抛）。所以每个品牌都用
 * `runWithContext({ tenantId })` 现开一个上下文再调——与
 * `plan-lifecycle/expire-notify.cron.ts` 用 `runWithPatchedContext` 发站内信是同一招。
 *
 * 用 `runWithContext` 而不是 `runWithPatchedContext`：后者是「在当前上下文之上打补丁」，
 * 而 cron 这里**根本没有**当前上下文（不是「有但要改一个字段」）。
 *
 * ## 单个品牌失败不拖垮整批
 *
 * 每个品牌包在 try/catch 里。最常见的失败是 `1540301` 配额不足——那不是故障，
 * 是这家店这个月的额度用完了，记一条日志跳过就对了。让它冒泡的话，
 * 一家超额的店会让后面所有店今天都不跑，而没有任何人会发现。
 *
 * ## `geo.daily_refresh` 这个功能项：**本任务没有注册它**
 *
 * 设计文档 §4.1 想把「日频刷新」做成一个套餐权益位，由这里读
 * `gateway.hasFeature(tenantId, 'geo.daily_refresh')` 决定放不放行。
 *
 * 落地时撞上一条硬约束：`test/arch/billing-routes.spec.ts`（spec 8）要求
 * **每个功能项的 `pathPrefixes` 非空，且每条前缀都由一个真实的 `@Controller` 前缀兑现**
 * （匹配规则是 `控制器前缀 === 功能前缀` 或 `控制器前缀.startsWith(功能前缀 + '/')`）。
 * 而「日频刷新」根本不是一条路由——它是一个调度期的判断。为了凑一条前缀去造一个
 * `/api/admin/geo/runs/daily` 控制器，等于为了让一份注册表好看而在路由表上留一条
 * 没人调的假路由，那比不注册更糟。
 *
 * 所以 T6 的做法是：**直接按 `brand.refreshFreq` 放行**，权益位留给 T7 —— 到那时
 * `geo.daily_refresh` 应该注册成一个 `pathPrefixes` 指向真实写路由的功能项，
 * 或者干脆改成「套餐里配 `sampleSize`/频率上限」这种按数值卖的形状（那是更贴合
 * 这门生意的卖法：日频的成本差异本来就是次数差异）。
 *
 * TODO(T7)：`geo.daily_refresh` 权益位落地后，把 `shouldRunToday` 里 DAILY 那一档
 * 改成「且 `await gateway.hasFeature(tenantId, 'geo.daily_refresh')`」。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, runWithContext } from '@taizan/nest-core'
import { LeaderCron } from '@taizan/nest-infra'
import { RawPrismaService } from '@taizan/nest-prisma'
import { ulid } from '@taizan/contracts'

import type { AppPrismaClient } from '../../../common/prisma.types'
import { GeoRunService } from './geo-run.service'

const CONTEXT = 'GeoRunScheduleCron'

/** 一次分页取多少个品牌。 */
const PAGE_SIZE = 200

/** 一次 cron tick 的产出，供测试与运维台断言。 */
export interface GeoRunScheduleOutcome {
  /** 扫过的 ACTIVE 品牌数。 */
  scanned: number
  /** 今天该跑的品牌数。 */
  matched: number
  /** 真的建出跑批的品牌数。 */
  triggered: number
  /** 因配额不足（1540301）跳过的品牌数。 */
  skippedQuota: number
  /** 其它原因失败的品牌数（没有可跑的引擎/问法，多半是配置还没填完）。 */
  errors: number
}

/** 扫描时选的那点品牌信息。 */
interface BrandCandidate {
  id: string
  tenantId: string
  name: string
  refreshFreq: string
}

/**
 * 今天该不该跑这个品牌。
 *
 * - `WEEKLY`：**只在周一**跑。固定在一周的同一天，趋势图上的采样点才是等距的；
 *   「建品牌那天算第一周」会让每个品牌各有各的节奏，横向对比就不成立了。
 * - `DAILY`：每天跑（权益位见文件头的 TODO）。
 *
 * 导出成纯函数是为了让 spec 能直接对着它断言星期几，而不用去操纵系统时钟。
 *
 * @param refreshFreq - `GeoRefreshFreq` 的值
 * @param now - 判定用的时刻
 */
export function shouldRunToday(refreshFreq: string, now: Date): boolean {
  if (refreshFreq === 'DAILY') return true
  if (refreshFreq !== 'WEEKLY') return false
  // `getDay()` 用的是**本进程时区**。cron 本身声明了 `timezone: 'Asia/Shanghai'`，
  // 部署时两者一致；不一致的后果是「周一」偏移一天，不影响正确性（仍然一周一次、
  // 仍然固定在同一天），所以这里不引入一套时区换算。
  return now.getDay() === 1
}

@Injectable()
export class GeoRunScheduleCron {
  constructor(
    // raw-reason: 平台域 cron 跨租户——自动跑批要扫全平台的 ACTIVE 品牌，
    // 不属于任何单一租户上下文。建跑批那一步会用 runWithContext 现开租户上下文。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(GeoRunService) private readonly runs: GeoRunService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  @LeaderCron({
    key: 'geo-run-schedule',
    cron: '0 3 * * *',
    lockTtlMs: 600_000,
    watchdog: true,
    timezone: 'Asia/Shanghai',
  })
  async run(now: Date = new Date()): Promise<GeoRunScheduleOutcome> {
    const outcome: GeoRunScheduleOutcome = {
      scanned: 0,
      matched: 0,
      triggered: 0,
      skippedQuota: 0,
      errors: 0,
    }
    let cursor: string | undefined

    for (;;) {
      // raw-reason: 平台域 cron 跨租户，游标分页不全表读（几万个品牌时一次 findMany 会吃光内存）。
      const page: BrandCandidate[] = await this.raw.client.geoBrand.findMany({
        where: { status: 'ACTIVE', deletedAt: null },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true, tenantId: true, name: true, refreshFreq: true },
      })
      if (page.length === 0) break
      cursor = page[page.length - 1]?.id

      for (const brand of page) {
        outcome.scanned += 1
        if (!shouldRunToday(brand.refreshFreq, now)) continue
        outcome.matched += 1
        await this.triggerOne(brand, outcome)
      }
    }

    if (outcome.matched > 0 || outcome.errors > 0) {
      this.logger.log(
        `自动跑批 cron：扫描 ${outcome.scanned} 个品牌、今天该跑 ${outcome.matched} 个、` +
          `实际触发 ${outcome.triggered} 个、配额不足跳过 ${outcome.skippedQuota} 个、失败 ${outcome.errors} 个`,
        CONTEXT,
      )
    }
    return outcome
  }

  /** 在这个品牌所属租户的上下文里建一次跑批。失败只记账，不往外抛。 */
  private async triggerOne(brand: BrandCandidate, outcome: GeoRunScheduleOutcome): Promise<void> {
    try {
      await runWithContext(
        {
          // 每个品牌一个新的 traceId：一次 tick 可能触发几百次跑批，共用一个 traceId 的话
          // 日志里这几百条会糊成一团，而「这一家为什么没跑起来」是按品牌问的。
          traceId: ulid(),
          tenantId: brand.tenantId,
          // `ip` / `startedAt` 是 `RequestContext` 的必填项（日志与限流要用）。
          // cron 没有客户端，填一个明确的哨兵值而不是 `127.0.0.1`——后者会让
          // 审计/日志看起来像是有人从本机发了一个请求。
          ip: { client: 'cron', edge: 'cron' },
          startedAt: Date.now(),
        },
        async () => {
          await this.runs.create({ brandId: brand.id }, 'SCHEDULE')
        },
      )
      outcome.triggered += 1
    } catch (err) {
      // 配额不足是**预期内**的：这家店这个月的额度用完了。记一条 log 跳过，
      // 不算错误——把它计进 errors 会让运维每个月底都收到一批假警报。
      if (isQuotaExceeded(err)) {
        outcome.skippedQuota += 1
        this.logger.log(
          `品牌「${brand.name}」（租户 ${brand.tenantId}）本月查询配额不足，今天跳过`,
          CONTEXT,
        )
        return
      }
      outcome.errors += 1
      this.logger.error(
        `品牌「${brand.name}」（租户 ${brand.tenantId}）自动跑批失败：${messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
        CONTEXT,
      )
    }
  }
}

/**
 * 是不是「配额超限」那个错误（1540301）。
 *
 * 按 `code` 判而不是按 `instanceof BizException`：后者在 esm/cjs 两份产物同时被加载时
 * 会失效（两个不同的类对象），而这种失效不报错——它只会让配额不足被当成真故障报警。
 */
function isQuotaExceeded(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  return (err as { code?: unknown }).code === 1540301
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
