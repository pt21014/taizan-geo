/**
 * 「先诊断后付费」编排服务（产品需求：把「建品牌→生成问法→手动跑批→等结果→看报表」
 * 这条零散链路收成一次调用）。
 *
 * ## 这个 service 做什么，不做什么
 *
 * `diagnose()` 是 HTTP 路径上跑的那一半：校验品牌、按需生成并导入问法（复用
 * `geo-prompt.service.ts` 现成的生成+导入两步，**不重新实现去重/配额逻辑**）、
 * 建一次跑批并入队，然后立刻返回——它不等跑批结果，理由与 `geo-run.controller.ts`
 * 文件头说的一样：一次跑批是"问法 × 引擎 × 采样"次外部调用，放在请求里必然超时。
 *
 * `finalizeReport()` 是队列侧跑的那一半：由
 * `aggregate/geo-daily-aggregate.handler.ts` 在"这个品牌今天的日聚合写完"之后
 * 发现"这个品牌有一个还没生成报告的诊断跑批"时调用，生成一份
 * `GeoReport(period=ONE_SHOT)` 并补写"AI 推荐问法列表"与"内容优化建议"两个字段，
 * 再把 `GeoReport.id` 回填到 `GeoQueryRun.diagnosisReportId` 上——前端轮询
 * `GET /runs/:id` 看到这一列非空，就知道诊断报告已经就绪，去
 * `GET /reports/:id` 取。
 *
 * 两半之间没有直接调用关系（`diagnose()` 不等 `finalizeReport()`），是因为跑批本身
 * 就是异步的：中间隔着 `geo.run.dispatch` → N 条 `geo.query.execute` →
 * N 条 `geo.result.analyze` → `geo.daily.aggregate`，没有任何一步适合在 HTTP
 * 请求里同步等完。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { ErrorCode } from '@taizan/contracts'
import { AppLogger, BizException } from '@taizan/nest-core'
import { PrismaService } from '@taizan/nest-prisma'

import type { AppPrismaService } from '../../../common/prisma.types'
import { GeoBrandService } from '../brand/geo-brand.service'
import { GeoPromptService } from '../prompt/geo-prompt.service'
import type { GeoDiagnosisContentSuggestion, GeoDiagnosisPromptSuggestion } from '../report/geo-report.rules'
import { GeoReportService } from '../report/geo-report.service'
import { GeoRunService } from '../run/geo-run.service'
import type { DiagnoseGeoBrandDto, GeoDiagnosisTriggerResultView } from './dto/geo-diagnosis.dto'
import { GEO_DIAGNOSIS_PROMPT_COUNT_DEFAULT } from './dto/geo-diagnosis.dto'
import {
  buildContentSuggestions,
  type DiagnosisCitationInput,
  type DiagnosisCompetitorInput,
  type DiagnosisOverviewInput,
} from './geo-diagnosis.rules'

const CONTEXT = 'GeoDiagnosis'

/** 诊断自动生成的候选问法落进的 Prompt 集名字。见 `geo-prompt.service.ts` 里
 * `DEFAULT_PROMPT_SET_NAME` 同一套"给一个人能看懂的名字"的做法。 */
const DIAGNOSIS_PROMPT_SET_NAME = 'AI 诊断生成'

/** `payload` 是 Json 列；不是对象时回空对象。与 `geo-report.service.ts` 的同名私有函数
 * 保持同样的防御逻辑，不跨文件共享是因为它只有两三行，共享一个工具函数的收益
 * 不如各自局部清楚。 */
function toPayloadRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

@Injectable()
export class GeoDiagnosisService {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(GeoBrandService) private readonly brands: GeoBrandService,
    @Inject(GeoPromptService) private readonly prompts: GeoPromptService,
    @Inject(GeoRunService) private readonly runs: GeoRunService,
    @Inject(GeoReportService) private readonly reports: GeoReportService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * 发起一次诊断编排（HTTP 路径，同步只做到"建好跑批并入队"）。
   *
   * 顺序：
   * 1. 校验品牌属于本店；
   * 2. 品牌还没有任何"追踪中"的问法时，调用 `geo-prompt.service.ts` 的 `generate()`
   *    生成候选（system prompt 已经按"多数不带品牌名"的配比调整过，见该文件），
   *    过滤掉与库里重复的，新建一个 `source=AI_GEN` 的 Prompt 集，走现成的
   *    `importMany()`（textHash 去重 + `GEO_PROMPT` 配额扣减）落库；
   * 3. 建一次跑批（`GeoRunService.create()`，标记 `isDiagnosis`），写库成功后入队；
   * 4. 立刻返回——不等跑批结果。
   *
   * @throws 1240300 品牌不存在/不属于本店
   * @throws 1040000 品牌没有问法、AI 也没能生成出可用候选（没有可诊断的东西）
   * @throws 1540301 `GEO_PROMPT`/`GEO_QUERY_MONTHLY` 配额不足（分别在 importMany/
   *   run.create 内部抛出，这里不重复判断）
   */
  async diagnose(brandId: string, dto: DiagnoseGeoBrandDto): Promise<GeoDiagnosisTriggerResultView> {
    const brand = await this.brands.requireBrand(brandId)

    const existingTracked = await this.prisma.tenant.geoPrompt.count({
      where: { brandId: brand.id, isTracked: true },
    })

    let promptsGenerated = 0
    let promptSetId: string | undefined
    if (existingTracked === 0) {
      const count = dto.promptCount ?? GEO_DIAGNOSIS_PROMPT_COUNT_DEFAULT
      const generated = await this.prompts.generate({ brandId: brand.id, count })
      const fresh = generated.candidates.filter((c) => !c.duplicated)

      if (fresh.length > 0) {
        const set = await this.prompts.createSet({
          brandId: brand.id,
          name: DIAGNOSIS_PROMPT_SET_NAME,
          source: 'AI_GEN',
        })
        const imported = await this.prompts.importMany({
          brandId: brand.id,
          promptSetId: set.id,
          texts: fresh.map((c) => c.text),
        })
        promptSetId = set.id
        promptsGenerated = imported.created
      }
    }

    if (existingTracked === 0 && promptsGenerated === 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        '这个品牌还没有问法，AI 这次也没能生成出可用的候选，请先手动添加几条问法再诊断',
      )
    }

    const { run, planned } = await this.runs.create({ brandId: brand.id }, 'MANUAL', { promptSetId })

    this.logger.log(
      `品牌 ${brand.id} 发起诊断编排：run=${run.id}，新生成问法 ${promptsGenerated} 条，规划查询 ${planned} 条`,
      CONTEXT,
    )

    return {
      runId: run.id,
      brandId: brand.id,
      promptsGenerated,
      plannedQueries: planned,
      reusedExistingPrompts: existingTracked > 0,
    }
  }

  /**
   * 诊断报表的收口（队列路径）。由 `GeoDailyAggregateHandler` 在写完当天日聚合之后调用，
   * **幂等**：`run` 不是诊断跑批、或已经生成过报告时直接返回，不重复生成/覆盖。
   *
   * @param runId - 触发这次聚合的（或"恰好还没收口的"）诊断跑批 id
   * @param date - `YYYY-MM-DD`，report 的 `periodStart`（= `periodEnd`，单日快照）
   */
  async finalizeReport(runId: string, date: string): Promise<void> {
    const run = await this.prisma.tenant.geoQueryRun.findFirst({ where: { id: runId } })
    if (!run || !run.isDiagnosis || run.diagnosisReportId) return

    const generated = await this.reports.generate({
      brandId: run.brandId,
      period: 'ONE_SHOT',
      periodStart: date,
    })

    // 用直接读到的原始行（不经过 `GeoReportService.get()` 的字段级门禁）来算建议——
    // 建议的计算需要竞品/引用的真实数字，门禁只应该发生在"下发给前端"这一步，
    // 不该反过来影响"后端自己算出了什么"。
    const raw = await this.prisma.tenant.geoReport.findFirst({
      where: { id: generated.id },
      select: { payload: true },
    })
    if (!raw) return
    const payload = toPayloadRecord(raw.payload)

    const promptSuggestions: GeoDiagnosisPromptSuggestion[] = run.diagnosisPromptSetId
      ? (
          await this.prisma.tenant.geoPrompt.findMany({
            where: { promptSetId: run.diagnosisPromptSetId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
        ).map((p) => ({ text: p.text, topic: p.topic, funnelStage: p.funnelStage }))
      : []

    const overview = (payload['overview'] ?? {}) as DiagnosisOverviewInput
    const competitors = (payload['competitors'] ?? []) as DiagnosisCompetitorInput[]
    const topCitations = (payload['topCitations'] ?? []) as DiagnosisCitationInput[]
    const contentSuggestions: GeoDiagnosisContentSuggestion[] = buildContentSuggestions(
      overview,
      competitors,
      topCitations,
    )

    await this.prisma.tenant.geoReport.update({
      where: { id: generated.id },
      data: {
        payload: {
          ...payload,
          promptSuggestions,
          contentSuggestions,
        } as unknown as Prisma.InputJsonValue,
      },
    })

    await this.prisma.tenant.geoQueryRun.update({
      where: { id: run.id },
      data: { diagnosisReportId: generated.id },
    })

    this.logger.log(`诊断报表生成完成：run=${run.id} report=${generated.id}`, CONTEXT)
  }
}
