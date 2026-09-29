/**
 * `geo.result.analyze`：把一条回答正文变成结构化的「提及」与「引用」（技术设计 §4.2）。
 *
 * ```
 * 读 result（不是 OK → 直接返回）
 *   → 读品牌 + 竞品（实体表）+ 平台的来源分类规则
 *   → LLM 结构化抽取（jsonSchema）→ mergeLlmMentions(…, extractMentionsFallback(…))
 *   → buildCitationDrafts(引用, 规则, { brandDomain, competitorDomains }) → markCited
 *   → 事务内 deleteMany + createMany（重放幂等）
 *   → result.analyzedAt = now → UsageLedger(LLM_TOKEN) → settle(runId)
 * ```
 *
 * ## 重放幂等靠 **delete + create**，不靠 `analyzedAt` 判断
 *
 * `GeoMention` / `GeoCitation` 上没有唯一键（同一条回答里同一个实体只该有一行，
 * 但那是业务不变量，不是数据库约束）。所以重放时的正确做法是**按 `resultId` 清空再重建**，
 * 而不是「看到 `analyzedAt` 非空就跳过」——后者会让「改了 LLM 提示词之后重跑分析」
 * 这件事做不到，而那是这个模块最常见的运维动作。
 *
 * 两步必须在同一个事务里：中间崩掉的话这条回答会变成「一条提及都没有」，
 * 而报表看不出区别——它只会显示提及率下降了。
 *
 * ## payload 里为什么有 `citations`
 *
 * 引擎返回的引用列表在 `GeoQueryResult` 上**没有一列可以存**（表结构由 T3 定死，
 * 本任务不改 schema）。`geo.query.execute` 拿到它之后如果不带过来，这里只能从正文里
 * 正则抠 URL（`extractUrlsFromText`），而那会漏掉所有「角标式」引用——也就是
 * 通义/文心/豆包的主流形式，表现是引用率恒接近 0。
 *
 * 所以让它随消息走。没带的时候（手工重放、或 T7 的补算）退回正文抠 URL，
 * 有损但不是空。真正该有的形状是表上加一列 `citationsRaw Json`，留给 T7。
 *
 * ## 抽取用的 JSON Schema 在 `@taizan/llm` 里
 *
 * `MENTION_SCHEMA` 原来就写在本文件里。T7 把它挪进了 `packages/llm/src/schemas.ts`
 * 并由包导出：它**是 provider 侧的契约**——`buildJsonSchemaHint()` 要把它渲染成提示词、
 * `MockLlmProvider` 的 `mention` 场景要按它的形状编 JSON，两件事都发生在那个包里。
 * 留在这里的话，包的单测只能对着一份手抄的简化版跑，而手抄版与真版哪天不一致了
 * 没有任何信号（表现是「抽取率莫名其妙地低」）。
 *
 * 它与 `mergeLlmMentions` 认识的字段仍然要逐个对齐——改 schema 就要改
 * `geo-mention.rules.ts`，反之亦然。
 *
 * ## 这里的 LLM 调用为什么可以「失败就重试」
 *
 * 与 `geo.query.execute` 不同，分析这一步**不花引擎的钱**，也不占 `GEO_QUERY_MONTHLY`。
 * 重试的代价只有 LLM 的 token（P0 不计入成本，见下面落账那一段）。所以这里不做
 * 精细的错误分类，抛出去交给 BullMQ 的 `attempts: 3` 就够了。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { GeoSourceCategory, Prisma } from '@prisma/client'
import { ulid } from '@taizan/contracts'
import { extractUrlsFromText, type EngineCitation } from '@taizan/geo-engines'
import { MENTION_SCHEMA, type ChatRequest } from '@taizan/llm'
import { AppLogger } from '@taizan/nest-core'
import { JobHandler, type JobEnvelope, type JobProcessor } from '@taizan/nest-infra'
import { PrismaService } from '@taizan/nest-prisma'

import { autoTenantData, type AppPrismaService } from '../../../common/prisma.types'
import { GeoEngineService } from '../engine/geo-engine.service'
import { GEO_RESULT_ANALYZE_JOB_NAME } from '../run/geo-job-names'
import { GeoRunService } from '../run/geo-run.service'
import { buildCitationDrafts, type SourceRule } from './geo-citation.rules'
import { GEO_LLM, type GeoLlm } from './geo-llm.provider'
import {
  extractMentionsFallback,
  markCited,
  mergeLlmMentions,
  type EntityDef,
} from './geo-mention.rules'

/** `geo.result.analyze` 的消息体。 */
export interface GeoResultAnalyzePayload {
  resultId: string
  /** 引擎返回的原始引用列表；没带时退回从正文抠 URL。见文件头。 */
  citations?: EngineCitation[]
}

const CONTEXT = 'GeoResultAnalyze'

/** 给 LLM 的系统提示词。抽取任务，不是创作任务——所以话说得很死。 */
function buildSystemPrompt(entities: EntityDef[]): string {
  const list = entities
    .map((e) => {
      const aliases = e.aliases.length > 0 ? `（别名：${e.aliases.join('、')}）` : ''
      return `- ${e.name}${aliases} —— ${e.kind === 'BRAND' ? '本品牌' : '竞品'}`
    })
    .join('\n')

  return [
    '你是一个信息抽取程序。输入是一段 AI 搜索引擎对某个问题的回答原文，',
    '你要从中找出下面这份清单里的实体被提到了哪些、第几个被提到、语气是正面还是负面。',
    '',
    '实体清单：',
    list,
    '',
    '硬性要求：',
    '1. `entityName` 必须**逐字**使用上面清单里的名字，不要用别名、不要改写、不要翻译；',
    '2. 清单之外的任何品牌都**不要**输出——那会污染份额统计；',
    '3. 回答里没提到的实体不要编，宁可返回空数组；',
    '4. `position` 按它在原文里第一次出现的先后排，从 1 开始；',
    '5. 只输出 JSON，不要有任何解释文字、不要用 Markdown 代码块包起来。',
  ].join('\n')
}

@Injectable()
@JobHandler({ name: GEO_RESULT_ANALYZE_JOB_NAME, concurrency: 4, attempts: 3 })
export class GeoResultAnalyzeHandler implements JobProcessor<GeoResultAnalyzePayload> {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(GEO_LLM) private readonly llm: GeoLlm,
    @Inject(GeoEngineService) private readonly engines: GeoEngineService,
    @Inject(GeoRunService) private readonly runs: GeoRunService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async process(envelope: JobEnvelope<GeoResultAnalyzePayload>): Promise<void> {
    const { resultId, citations } = envelope.data

    const result = await this.prisma.tenant.geoQueryResult.findFirst({ where: { id: resultId } })
    if (!result) {
      this.logger.warn(`回答 ${resultId} 不存在，跳过分析`, CONTEXT)
      return
    }
    // 只分析成功的回答。失败的那条没有正文可分析，它的收口由 execute handler 负责。
    if (result.status !== 'OK') return

    const rawText = result.rawText ?? ''

    // ── 实体表：本品牌 + 全部竞品 ────────────────────────────────────────
    const [brand, competitors, ruleRows] = await Promise.all([
      this.prisma.tenant.geoBrand.findFirst({
        where: { id: result.brandId },
        select: { name: true, domain: true, aliases: true },
      }),
      this.prisma.tenant.geoCompetitor.findMany({
        where: { brandId: result.brandId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, domain: true, aliases: true },
      }),
      this.engines.listSourceRules(),
    ])
    if (!brand) {
      // 品牌被软删了。历史回答不级联删（那是刻意的），但没有实体表就没法分析。
      this.logger.warn(`回答 ${resultId} 的品牌已经不在了，跳过分析`, CONTEXT)
      return
    }

    const entities: EntityDef[] = [
      { kind: 'BRAND', name: brand.name, aliases: toStringArray(brand.aliases) },
      ...competitors.map(
        (c): EntityDef => ({
          kind: 'COMPETITOR',
          id: c.id,
          name: c.name,
          aliases: toStringArray(c.aliases),
        }),
      ),
    ]

    // ── 提及：LLM 主路径 + 正则兜底 ──────────────────────────────────────
    const fallback = extractMentionsFallback(rawText, entities)
    const llm = await this.extractWithLlm(rawText, entities, brand.name, competitors)
    let mentions = mergeLlmMentions(llm.json, entities, fallback)

    // ── 引用：归一化 + 分类 ──────────────────────────────────────────────
    const rules: SourceRule[] = ruleRows.map((r) => ({
      pattern: r.pattern,
      platform: r.platform,
      category: r.category as GeoSourceCategory,
      priority: r.priority,
    }))
    const rawCitations =
      citations && citations.length > 0 ? citations : extractUrlsFromText(rawText)
    const citationDrafts = buildCitationDrafts(rawCitations, rules, {
      ...(brand.domain ? { brandDomain: brand.domain } : {}),
      competitorDomains: competitors
        .map((c) => c.domain)
        .filter((d): d is string => typeof d === 'string' && d !== ''),
    })

    // 引用回填 `isCited`：品牌/竞品的官网出现在引用里，才算「被引用」。
    const competitorDomainById: Record<string, string> = {}
    for (const c of competitors) {
      if (c.domain) competitorDomainById[c.id] = c.domain
    }
    mentions = markCited(mentions, citationDrafts, brand.domain ?? undefined, competitorDomainById)

    // ── 落库：事务内清空重建 ─────────────────────────────────────────────
    const answeredAt = result.answeredAt ?? new Date()
    await this.prisma.$transaction(async (tx) => {
      await tx.geoMention.deleteMany({ where: { resultId } })
      await tx.geoCitation.deleteMany({ where: { resultId } })

      if (mentions.length > 0) {
        await tx.geoMention.createMany({
          data: mentions.map(
            (m): Prisma.GeoMentionCreateManyInput => ({
              // `createMany` 不过 ULID 与租户扩展（它们挂在 `create` 上），两列手写。
              // `tenantId` 来自库里那一行，不来自任何请求参数。
              id: ulid(),
              tenantId: result.tenantId,
              resultId,
              brandId: result.brandId,
              promptId: result.promptId,
              engineCode: result.engineCode,
              entityKind: m.entityKind,
              competitorId: m.competitorId ?? null,
              entityName: m.entityName,
              position: m.position,
              isCited: m.isCited,
              sentiment: m.sentiment,
              sentimentScore: m.sentimentScore,
              snippet: m.snippet.slice(0, 500),
              answeredAt,
            }),
          ),
        })
      }

      if (citationDrafts.length > 0) {
        await tx.geoCitation.createMany({
          data: citationDrafts.map(
            (c): Prisma.GeoCitationCreateManyInput => ({
              id: ulid(),
              tenantId: result.tenantId,
              resultId,
              brandId: result.brandId,
              promptId: result.promptId,
              engineCode: result.engineCode,
              url: c.url,
              urlHash: c.urlHash,
              domain: c.domain,
              platform: c.platform,
              category: c.category,
              rank: c.rank,
              title: c.title ?? null,
              answeredAt,
            }),
          ),
        })
      }

      await tx.geoQueryResult.update({ where: { id: resultId }, data: { analyzedAt: new Date() } })
    })

    await this.recordLlmUsage(result, llm.usage)

    this.logger.log(
      `回答 ${resultId} 分析完成：${mentions.length} 条提及、${citationDrafts.length} 条引用`,
      CONTEXT,
    )

    // 这条可能是整批的最后一条。`settle` 自己会判「还有 PENDING 就什么都不做」。
    await this.runs.settle(result.runId)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /**
   * 调一次 LLM 做结构化抽取。失败**抛出去**（交给 BullMQ 重试），见文件头。
   *
   * 用量随返回值一起回，**不挂在 this 上**：`concurrency: 4` 意味着同一个 handler 实例
   * （Nest 的 provider 默认是单例）会有四条消息在并发跑 `process()`，任何实例字段都会
   * 被它们互相覆盖——而覆盖的后果是用量账串了行，没有任何报错。
   */
  private async extractWithLlm(
    rawText: string,
    entities: EntityDef[],
    brandName: string,
    competitors: Array<{ name: string }>,
  ): Promise<{ json: unknown; usage: { inputTokens: number; outputTokens: number } }> {
    const req: ChatRequest = {
      messages: [
        { role: 'system', content: buildSystemPrompt(entities) },
        { role: 'user', content: `回答原文如下：\n\n${rawText}` },
      ],
      jsonSchema: MENTION_SCHEMA,
      // 抽取任务要的是确定性，不是创造力。
      temperature: 0,
      maxTokens: 2000,
    }

    const res = await this.llm.chat(req, {
      // 只有 mock 会读这三个（见 geo-llm.provider.ts）：它据此编出确定性的提及，
      // 让 e2e 能断言「品牌在位次 1」。真实 provider 收到之后原样丢弃。
      scenario: 'mention',
      brandName,
      competitorNames: competitors.map((c) => c.name),
    })
    // `json` 解析失败时是 `undefined`（`parseJsonLoose` 不抛），
    // `mergeLlmMentions` 会因此退回正则兜底——这正是要的行为。
    return { json: res.json, usage: res.usage }
  }

  /**
   * 落 LLM 的 token 用量。
   *
   * `costCents: 0` 是**刻意**的：P0 不把分析用的 LLM token 计入成本。理由是这一档成本
   * 与引擎调用不在一个量级（一次抽取几百 token，按主流开源模型的价格不到 0.01 分），
   * 而要算准它就得再引入一份「LLM 单价表」——那张表的维护成本比它要算的钱还高。
   *
   * 用量本身**照记**：`quantity` 是真实的 in+out token 数。等哪天要算这笔账时，
   * 历史数据是齐的，乘一个单价就行；反过来（先不记、以后想算）是补不回来的。
   */
  private async recordLlmUsage(
    result: { brandId: string; runId: string },
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    const occurredAt = new Date()
    await this.prisma.tenant.geoUsageLedger.create({
      data: autoTenantData<Prisma.GeoUsageLedgerCreateInput>({
        brandId: result.brandId,
        runId: result.runId,
        metric: 'LLM_TOKEN',
        quantity: usage.inputTokens + usage.outputTokens,
        costCents: 0,
        month: occurredAt.toISOString().slice(0, 7),
        occurredAt,
      }),
    })
  }
}

/** `aliases` 在库里是 `Json` 列；业务层约定它是字符串数组，这个函数是那条约定的唯一落点。 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}
