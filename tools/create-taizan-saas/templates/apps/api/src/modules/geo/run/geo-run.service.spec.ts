/**
 * `GeoRunService.settle()` 的单测——**本仓第一个 service 级单测**，刻意只覆盖 `settle`。
 *
 * ## 为什么这一个方法值得破一次例
 *
 * 本仓的测试纪律是「纯函数配 `.rules.spec.ts`，接线交给 e2e」，`settle` 却两头不靠：
 * 它的判定依赖两次数据库计数与一次条件更新的**返回值**，不是纯函数；而它错了的表现
 * 是「可见度数字偏低一点点」和「`finishedAt` 晚了几十毫秒」——e2e 断言不出来，
 * 线上也没人会发现。T6 就是这样带着一个量纲正确但口径错误的实现交付的。
 *
 * 所以这里用一个**手写的假 prisma**（不是 mock 框架）把两条语义钉死：
 *
 * 1. **完成 = `FAILED` 或（`OK` 且 `analyzedAt` 非空）**。`OK` 但没分析的算「仍在进行」，
 *    此时 `settle` 必须回 `null` 且**一条聚合消息都不入队**；
 * 2. **终态写入是 compare-and-set**。并发的第二次 `settle` 拿到 `updateMany.count === 0`，
 *    它必须不入队、不刷 `finishedAt`。
 *
 * 假 prisma 只实现被 `settle` 真正调到的那几个方法（`findFirst` / `count` /
 * `findMany` / `updateMany`），别的一律不提供——多提供一个就多一处「测试里能跑、
 * 真代码里不是这么用的」的可能。
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest'

import { GeoRunService } from './geo-run.service'

/** 假 result 行：只留 `settle` 会看的三列。 */
interface FakeResult {
  status: 'PENDING' | 'OK' | 'FAILED'
  analyzedAt: Date | null
  errorKind?: string | null
}

interface FakeRun {
  id: string
  tenantId: string
  brandId: string
  status: string
  finishedAt: Date | null
  errorSummary: string | null
}

/** 一次 `queue.add` 的记录。 */
interface EnqueueCall {
  name: string
  data: unknown
}

/**
 * 造一套「服务 + 它看得到的世界」。
 *
 * `updateManyBlocked` 模拟「并发的另一条 settle 抢先把 RUNNING 改成了终态」：
 * 置 true 之后 `updateMany` 回 `count: 0`，而库里那行**不变**——这正是
 * compare-and-set 失败时数据库的真实表现。
 */
function makeService(results: FakeResult[], opts: { updateManyBlocked?: boolean } = {}) {
  const run: FakeRun = {
    id: 'run-1',
    tenantId: 'tenant-1',
    brandId: 'brand-1',
    status: 'RUNNING',
    finishedAt: null,
    errorSummary: null,
  }
  const enqueued: EnqueueCall[] = []
  let updateManyCalls = 0

  const matches = (where: Record<string, unknown>): FakeResult[] =>
    results.filter((r) => {
      if (where['status'] !== undefined && r.status !== where['status']) return false
      const analyzedAt = where['analyzedAt']
      if (analyzedAt === null && r.analyzedAt !== null) return false
      if (
        typeof analyzedAt === 'object' &&
        analyzedAt !== null &&
        (analyzedAt as { not?: unknown }).not === null &&
        r.analyzedAt === null
      ) {
        return false
      }
      return true
    })

  const prisma = {
    tenant: {
      geoQueryRun: {
        findFirst: async () => run,
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>
          data: Record<string, unknown>
        }) => {
          updateManyCalls += 1
          if (opts.updateManyBlocked === true) return { count: 0 }
          if (where['status'] !== undefined && run.status !== where['status']) return { count: 0 }
          Object.assign(run, data)
          return { count: 1 }
        },
      },
      geoQueryResult: {
        count: async ({ where }: { where: Record<string, unknown> }) => matches(where).length,
        findMany: async ({ where }: { where: Record<string, unknown> }) => matches(where),
      },
    },
  }

  const queue = {
    add: async (name: string, data: unknown) => {
      enqueued.push({ name, data })
    },
  }
  const logger = { log: () => undefined, warn: () => undefined, error: () => undefined }
  const noop = {} as never

  const service = new GeoRunService(
    prisma as never,
    noop,
    queue as never,
    noop,
    noop,
    logger as never,
  )
  return { service, run, enqueued, updateManyCallCount: () => updateManyCalls }
}

describe('GeoRunService.settle —— 完成的定义要求 analyzedAt（T7 修正一）', () => {
  it('全部 OK 且都分析过了 → DONE，并入队一条聚合', async () => {
    const { service, run, enqueued } = makeService([
      { status: 'OK', analyzedAt: new Date() },
      { status: 'OK', analyzedAt: new Date() },
    ])
    expect(await service.settle('run-1')).toBe('DONE')
    expect(run.status).toBe('DONE')
    expect(run.finishedAt).not.toBeNull()
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.name).toBe('geo.daily.aggregate')
  })

  it('**OK 但 analyzedAt 为空 → 仍在进行**：回 null，且一条消息都不入队', async () => {
    const { service, run, enqueued } = makeService([
      { status: 'OK', analyzedAt: new Date() },
      // 这一条执行完了、分析还没落库。T6 会把它当成「完成」并立刻聚合，
      // 于是它那份提及不计入当天的可见度——数字偏低，且不报错。
      { status: 'OK', analyzedAt: null },
    ])
    expect(await service.settle('run-1')).toBeNull()
    expect(run.status).toBe('RUNNING')
    expect(run.finishedAt).toBeNull()
    expect(enqueued).toEqual([])
  })

  it('还有 PENDING → 仍在进行（与 T6 一致，这一条不该被改坏）', async () => {
    const { service, enqueued } = makeService([
      { status: 'OK', analyzedAt: new Date() },
      { status: 'PENDING', analyzedAt: null },
    ])
    expect(await service.settle('run-1')).toBeNull()
    expect(enqueued).toEqual([])
  })

  it('FAILED 不需要 analyzedAt：它没有正文可分析，本身就算「完成」', async () => {
    const { service, run } = makeService([
      { status: 'FAILED', analyzedAt: null, errorKind: 'AUTH' },
      { status: 'FAILED', analyzedAt: null, errorKind: 'AUTH' },
    ])
    expect(await service.settle('run-1')).toBe('FAILED')
    expect(run.errorSummary).toBe(JSON.stringify({ AUTH: 2 }))
  })

  it('一半成功一半失败（成功的都分析过了）→ PARTIAL', async () => {
    const { service } = makeService([
      { status: 'OK', analyzedAt: new Date() },
      { status: 'FAILED', analyzedAt: null, errorKind: 'TIMEOUT' },
    ])
    expect(await service.settle('run-1')).toBe('PARTIAL')
  })

  it('失败的那些算完成、成功的那条还没分析 → 仍然不收口', async () => {
    const { service, enqueued } = makeService([
      { status: 'FAILED', analyzedAt: null, errorKind: 'TIMEOUT' },
      { status: 'OK', analyzedAt: null },
    ])
    expect(await service.settle('run-1')).toBeNull()
    expect(enqueued).toEqual([])
  })

  it('没有失败时不写 errorSummary（`{}` 会让前端画出一个空的错误提示）', async () => {
    const { service, run } = makeService([{ status: 'OK', analyzedAt: new Date() }])
    expect(await service.settle('run-1')).toBe('DONE')
    expect(run.errorSummary).toBeNull()
  })
})

describe('GeoRunService.settle —— 终态是条件更新（T7 修正二）', () => {
  it('并发的第二次 settle 拿到 count=0：不入队、不刷 finishedAt', async () => {
    const { service, run, enqueued, updateManyCallCount } = makeService(
      [{ status: 'OK', analyzedAt: new Date() }],
      { updateManyBlocked: true },
    )
    // 判定本身照样算得出 DONE（计数是对的），但这一次不是「我收的口」。
    expect(await service.settle('run-1')).toBe('DONE')
    expect(updateManyCallCount()).toBe(1)
    expect(run.status).toBe('RUNNING') // 库里那行没被这次调用改动
    expect(run.finishedAt).toBeNull()
    expect(enqueued).toEqual([])
  })

  it('同一个 run 连着 settle 两次：只有第一次入队（第二次在终态早退）', async () => {
    const { service, enqueued } = makeService([{ status: 'OK', analyzedAt: new Date() }])
    expect(await service.settle('run-1')).toBe('DONE')
    expect(await service.settle('run-1')).toBe('DONE')
    expect(enqueued).toHaveLength(1)
  })
})
