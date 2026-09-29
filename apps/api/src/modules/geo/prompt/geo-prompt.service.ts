/**
 * Prompt / PromptSet 的数据访问层。
 *
 * ## 全文没有一处 `tenantId`
 *
 * 与 brand / goods 同一条约定，`test/arch/no-manual-tenant-filter.spec.ts`（spec 4）扫的
 * 就是这件事。`brandId` 属不属于当前租户，靠 {@link GeoBrandService.requireBrand}
 * 用 `prisma.tenant.geoBrand.findFirst({ where: { id } })` 查得到与否来判断——
 * **绝不写 `where: { tenantId }`**。查不到就是 1240300，与「品牌真的不存在」同一个码。
 *
 * ## 配额
 *
 * `QuotaKind.GEO_PROMPT` 是存量型配额：每建一条 +1、软删一条 −1。
 * 批量导入先 `consume(n)` 再写库，写失败 `release(n)`——不能逐条 consume，
 * 那样「导 50 条，第 31 条超限」会留下 30 条半成品，而运营看到的是一个失败的导入。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { GeoPrompt, GeoPromptSet, Prisma } from '@prisma/client'
import { ErrorCode, normalizePage, type PageResult } from '@taizan/contracts'
import { QuotaService } from '@taizan/nest-billing'
import { BizException } from '@taizan/nest-core'
import { PrismaService } from '@taizan/nest-prisma'

import type { JsonSchema } from '@taizan/llm'

import { autoTenantData, type AppPrismaService } from '../../../common/prisma.types'
import { GEO_LLM, type GeoLlm } from '../analysis/geo-llm.provider'
import { GeoBrandService } from '../brand/geo-brand.service'
import {
  GEO_PROMPT_GENERATE_DEFAULT,
  type CreateGeoPromptDto,
  type CreateGeoPromptSetDto,
  type GenerateGeoPromptDto,
  type GeoPromptGenerateResultView,
  type GeoPromptImportResultView,
  type GeoPromptSetView,
  type GeoPromptView,
  type ImportGeoPromptDto,
  type ListGeoPromptQueryDto,
  type UpdateGeoPromptDto,
  type UpdateGeoPromptSetDto,
} from './dto/geo-prompt.dto'
import {
  DEFAULT_PROMPT_SET_NAME,
  dedupePrompts,
  hashPromptText,
  normalizeFunnelStage,
  normalizePromptSetName,
  validatePromptInput,
  validatePromptPatch,
  validatePromptSetInput,
  type GeoFunnelStageLike,
  type GeoPromptSourceLike,
  type RuleViolation,
} from './geo-prompt.rules'

/**
 * Prompt 数占用哪一档配额。
 *
 * `GEO_PROMPT` 是框架 `02-plan.prisma` 里 `QuotaKind` 的真实枚举值（T3 加入），
 * 不是借用 `CUSTOM`——问法数是这个产品的第二个售卖维度，套餐页上要写成
 * 「监测问法数：50」。
 */
const GEO_PROMPT_QUOTA_KIND = 'GEO_PROMPT'

function toPromptView(row: GeoPrompt): GeoPromptView {
  return {
    id: row.id,
    brandId: row.brandId,
    promptSetId: row.promptSetId,
    text: row.text,
    textHash: row.textHash,
    topic: row.topic,
    funnelStage: row.funnelStage as GeoFunnelStageLike,
    isTracked: row.isTracked,
    priority: row.priority,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toPromptSetView(row: GeoPromptSet): GeoPromptSetView {
  return {
    id: row.id,
    brandId: row.brandId,
    name: row.name,
    source: row.source as GeoPromptSourceLike,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function rejectViolations(violations: readonly RuleViolation[]): void {
  if (violations.length === 0) return
  throw new BizException(ErrorCode.BAD_REQUEST, violations.map((v) => v.message).join('；'), {
    violations,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// AI 生成候选问法用的提示词与解析（T6）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 生成接口的超时（毫秒）。
 *
 * 比引擎默认的 60 秒短得多，因为这是**交互式**接口：运营点一下「AI 生成」在等结果。
 * 等到 60 秒的时候他早就以为页面卡死并刷新了，而那次刷新会再发一个请求——
 * 于是同一次点击变成两次 LLM 调用。20 秒是「够生成 30 条」与「人还愿意等」的折中。
 */
const GENERATE_TIMEOUT_MS = 20_000

/** 要求 LLM 回的结构。字段与 `GeoPromptCandidateView` 对齐（`duplicated` 由服务端算，不让模型编）。 */
const PROMPT_GEN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    prompts: {
      type: 'array',
      description: '生成出来的候选问法',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '问法正文，一句话，不超过 40 字' },
          funnelStage: {
            type: 'string',
            enum: ['TOFU', 'MOFU', 'BOFU'],
            description: 'TOFU=还在了解品类，MOFU=在几个方案之间比较，BOFU=快要下单了',
          },
          topic: { type: 'string', description: '主题标签，如「价格」「口碑」「选型」' },
        },
        required: ['text', 'funnelStage'],
      },
    },
  },
  required: ['prompts'],
}

/**
 * 生成的问法里，最多允许几条带品牌名。其余的必须是不带品牌名的行业通用问法。
 *
 * **为什么要卡这个数，不是留给模型自由发挥**：带品牌名的问题（"太赞怎么样"）
 * AI 当然会提到这个品牌——那测的是"AI 认不认识这个品牌"，不是"用户问行业通用问题时
 * AI 会不会想到这个品牌"，而后者才是 GEO 监测真正要回答的问题（诊断报告的
 * "品牌提及率"在带品牌名的问法上恒接近 100%，会把整体指标灌水到失真）。
 * 上限给 5 是经验值：留几条对比型问法（"太赞和 YY 哪个好"）仍然有价值——它测的是
 * "AI 会不会拿这个品牌去对比"，与"AI 会不会主动想到"是两个不同但都有用的信号。
 */
export const GEO_PROMPT_GEN_BRANDED_MAX = 5

/**
 * 系统提示词：说清「要几条」「什么是好问法」「品牌名配比」「只输出 JSON」。
 *
 * 导出成一个纯函数（不是留在模块作用域里）是为了让 {@link GEO_PROMPT_GEN_BRANDED_MAX}
 * 配比要求能被单测直接断言——它是一段拼给 LLM 看的自然语言，没法靠"跑一次生成、
 * 看结果里带品牌名的条数"来测（mock LLM 的输出是固定的，不会真的读这段提示词），
 * 能验证的只有"提示词字符串里有没有把这条硬性要求说清楚"。
 */
export function buildPromptGenSystem(count: number, funnelStage: string | undefined): string {
  const stageLine =
    funnelStage === undefined || funnelStage === '' || funnelStage === 'UNKNOWN'
      ? '各个漏斗阶段都要覆盖到（TOFU/MOFU/BOFU 大致均匀）。'
      : `全部生成 ${funnelStage} 阶段的问法。`

  const brandedMax = Math.min(GEO_PROMPT_GEN_BRANDED_MAX, count)

  return [
    '你在帮一个品牌做 GEO（生成式引擎优化）监测。任务是列出**真实用户会去问 AI 的问题**，',
    '这些问题稍后会被逐条发给各家 AI 搜索引擎，用来观测这个品牌在回答里出现得多不多。',
    '',
    `要求生成 ${count} 条。`,
    stageLine,
    '',
    '什么是好问法：',
    '1. 像**人真的会打字问出来**的话，不是营销文案，也不是关键词堆砌；',
    `2. **品牌名配比是硬性要求**：这 ${count} 条里最多 ${brandedMax} 条可以包含品牌名，` +
      '且只应该是「XX 和 YY 哪个好」这种对比型问法；其余的**必须不出现品牌名**，' +
      '写成用户在没听说过这个品牌时也会问的行业通用问题——比如「XX（品类）怎么选」' +
      '「XX 城市有哪些靠谱的 XX（品类）」「买 XX（品类）要注意什么」，把品类/场景/' +
      '地域换成这个品牌实际所在的行业，不要写死例子里的词；',
    '3. 彼此之间要**真的不同**，不要用同义改写凑数（「好用吗」「怎么样」「值得买吗」算一条）；',
    '4. 用中文，一句话，不超过 40 字，不要编号、不要引号。',
    '',
    '只输出 JSON，不要有任何解释文字、不要用 Markdown 代码块包起来。',
  ].join('\n')
}

/** 用户提示词：把品牌的上下文交给模型。 */
function buildPromptGenUser(
  brand: { name: string; industry: string | null; domain: string | null },
  competitorNames: string[],
): string {
  const lines = [`品牌名：${brand.name}`]
  if (brand.industry) lines.push(`所属行业：${brand.industry}`)
  if (brand.domain) lines.push(`官网：${brand.domain}`)
  if (competitorNames.length > 0) lines.push(`主要竞品：${competitorNames.join('、')}`)
  return lines.join('\n')
}

/** 从 LLM 的结构化输出里读候选。认不出来的条目直接丢，**不抛** —— 见下面的说明。 */
function readCandidates(
  json: unknown,
): Array<{ text: string; funnelStage?: unknown; topic?: string }> {
  // 解析失败时 `json` 是 `undefined`（`parseJsonLoose` 不抛），这里回空数组，
  // 由调用方统一抛一条「这次没生成出来，再试一次」——那句话比一个解析错误堆栈
  // 对运营有用得多，而他能做的动作也确实只有「再点一次」。
  if (typeof json !== 'object' || json === null) return []
  const list = (json as Record<string, unknown>)['prompts']
  if (!Array.isArray(list)) return []

  const out: Array<{ text: string; funnelStage?: unknown; topic?: string }> = []
  const seen = new Set<string>()
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const text = typeof r['text'] === 'string' ? r['text'].trim() : ''
    if (text === '') continue
    // 模型偶尔会把同一条写两遍。在这里去重而不是留给前端：前端要显示的是
    // 「这是 10 条候选」，而不是「这是 10 条里有 2 条一样」。
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      text,
      funnelStage: r['funnelStage'],
      ...(typeof r['topic'] === 'string' && r['topic'].trim() !== ''
        ? { topic: r['topic'].trim() }
        : {}),
    })
  }
  return out
}

@Injectable()
export class GeoPromptService {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    // 复用 brand service 的 `requireBrand`，而不是在这里再查一次 `geoBrand`：
    // 「品牌不属于我」的错误码只能有一处真源，复制一份的结果是两边慢慢走偏
    // （一边 1240300、一边 1240400，前端要写两套处理）。
    @Inject(GeoBrandService) private readonly brands: GeoBrandService,
    // AI 生成候选问法用（`generate()`）。它是本项目**唯一**一处在 HTTP 路径上同步调
    // LLM 的地方，理由写在那个方法的文档注释里。
    @Inject(GEO_LLM) private readonly llm: GeoLlm,
  ) {}

  // ── Prompt ──────────────────────────────────────────────────────────────

  /** 分页列表。`brandId` 必填，先校验它属于本租户。 */
  async list(query: ListGeoPromptQueryDto): Promise<PageResult<GeoPromptView>> {
    await this.brands.requireBrand(query.brandId)
    const { page, pageSize } = normalizePage(query)

    const where: Prisma.GeoPromptWhereInput = { brandId: query.brandId }
    if (query.promptSetId) where.promptSetId = query.promptSetId
    if (query.funnelStage) where.funnelStage = query.funnelStage
    if (query.isTracked !== undefined) where.isTracked = query.isTracked === 'true'
    const keyword = query.keyword?.trim()
    if (keyword) {
      where.OR = [{ text: { contains: keyword } }, { topic: { contains: keyword } }]
    }

    const [rows, total] = await Promise.all([
      this.prisma.tenant.geoPrompt.findMany({
        where,
        // 高优先级在前：配额不够时先跑的就是这一批，列表顺序与执行顺序一致，
        // 运营调优先级时看得见效果。
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tenant.geoPrompt.count({ where }),
    ])

    return { items: rows.map(toPromptView), total, page, pageSize }
  }

  /** 取一条。不属于本店（或不存在）→ 1240300。 */
  async get(id: string): Promise<GeoPromptView> {
    return toPromptView(await this.requirePrompt(id))
  }

  /** 新建一条 Prompt（占用一个 GEO_PROMPT 配额）。 */
  async create(dto: CreateGeoPromptDto): Promise<GeoPromptView> {
    await this.brands.requireBrand(dto.brandId)
    rejectViolations(validatePromptInput(dto))

    const promptSetId = await this.resolvePromptSetId(dto.brandId, dto.promptSetId)
    const text = dto.text.trim()
    const textHash = hashPromptText(text)
    await this.assertPromptTextAvailable(dto.brandId, textHash)

    // 配额：先占，再写。
    await this.quota.consume(GEO_PROMPT_QUOTA_KIND)

    let row: GeoPrompt
    try {
      row = await this.prisma.tenant.geoPrompt.create({
        data: autoTenantData<Prisma.GeoPromptCreateInput>({
          brandId: dto.brandId,
          promptSetId,
          text,
          textHash,
          topic: dto.topic?.trim() || null,
          funnelStage: normalizeFunnelStage(dto.funnelStage),
          isTracked: dto.isTracked ?? true,
          priority: dto.priority ?? 0,
        }),
      })
    } catch (error) {
      await this.quota.release(GEO_PROMPT_QUOTA_KIND).catch(() => undefined)
      throw error
    }

    return toPromptView(row)
  }

  /** 修改。只改传了的字段；`brandId` 不可改（换品牌等于另一条 Prompt）。 */
  async update(id: string, dto: UpdateGeoPromptDto): Promise<GeoPromptView> {
    rejectViolations(validatePromptPatch(dto))
    const current = await this.requirePrompt(id)

    let textHash: string | undefined
    let text: string | undefined
    if (dto.text !== undefined) {
      text = dto.text.trim()
      textHash = hashPromptText(text)
      if (textHash !== current.textHash) {
        await this.assertPromptTextAvailable(current.brandId, textHash)
      }
    }

    if (dto.promptSetId !== undefined) {
      // 改挂到另一个集：那个集必须存在、且属于同一个品牌。
      await this.requirePromptSet(current.brandId, dto.promptSetId)
    }

    const row = await this.prisma.tenant.geoPrompt.update({
      where: { id },
      data: {
        ...(text !== undefined && textHash !== undefined ? { text, textHash } : {}),
        ...(dto.promptSetId !== undefined ? { promptSetId: dto.promptSetId } : {}),
        ...(dto.topic !== undefined ? { topic: dto.topic.trim() || null } : {}),
        ...(dto.funnelStage !== undefined
          ? { funnelStage: normalizeFunnelStage(dto.funnelStage) }
          : {}),
        ...(dto.isTracked !== undefined ? { isTracked: dto.isTracked } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
      },
    })

    return toPromptView(row)
  }

  /** 删除（软删，释放一个 GEO_PROMPT 配额）。 */
  async remove(id: string): Promise<{ id: string }> {
    await this.requirePrompt(id)
    await this.prisma.tenant.geoPrompt.delete({ where: { id } })
    await this.quota.release(GEO_PROMPT_QUOTA_KIND)
    return { id }
  }

  /**
   * 批量导入：去重之后一次性建。
   *
   * 去重分两层，都在写库之前完成：
   * - **输入内部**：粘进来的 50 行里有 3 行一样；
   * - **与库里已有的**：先把这个品牌下所有活跃 Prompt 的 `textHash` 拉出来比。
   *
   * 两层都命中的算 `skipped`，只有 `kept` 才占配额。**先 `consume(n)` 再写**，
   * 写失败整批 `release(n)`——逐条 consume 的话，「导 50 条、第 31 条超限」会留下
   * 30 条半成品，而运营看到的是一个失败的导入。
   */
  async importMany(dto: ImportGeoPromptDto): Promise<GeoPromptImportResultView> {
    await this.brands.requireBrand(dto.brandId)
    const promptSetId = await this.resolvePromptSetId(dto.brandId, dto.promptSetId)

    // 只取 hash 列：一个品牌下可能有几百条问法，把正文全拉回来只为比指纹是浪费。
    const existing = await this.prisma.tenant.geoPrompt.findMany({
      where: { brandId: dto.brandId },
      select: { textHash: true },
    })
    const existingHashes = new Set(existing.map((row) => row.textHash))

    const { kept, skipped } = dedupePrompts(dto.texts, existingHashes)
    if (kept.length === 0) {
      return { created: 0, skipped, promptSetId }
    }

    // 逐条跑一遍正文校验：一条超长的问法不该被"批量"这个入口绕过 DTO 之外的规则。
    for (const item of kept) {
      rejectViolations(validatePromptInput({ text: item.text }))
    }

    await this.quota.consume(GEO_PROMPT_QUOTA_KIND, kept.length)

    try {
      await this.prisma.tenant.geoPrompt.createMany({
        data: kept.map((item) =>
          autoTenantData<Prisma.GeoPromptCreateManyInput>({
            brandId: dto.brandId,
            promptSetId,
            text: item.text,
            textHash: item.textHash,
            topic: null,
            funnelStage: 'UNKNOWN',
            isTracked: true,
            priority: 0,
          }),
        ),
      })
    } catch (error) {
      await this.quota.release(GEO_PROMPT_QUOTA_KIND, kept.length).catch(() => undefined)
      throw error
    }

    return { created: kept.length, skipped, promptSetId }
  }

  // ── PromptSet ───────────────────────────────────────────────────────────

  /** 某个品牌下的 Prompt 集列表（不分页——一个品牌下几个集而已）。 */
  async listSets(brandId: string): Promise<GeoPromptSetView[]> {
    await this.brands.requireBrand(brandId)
    const rows = await this.prisma.tenant.geoPromptSet.findMany({
      where: { brandId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return rows.map(toPromptSetView)
  }

  /** 新建 Prompt 集。不占配额（占配额的是里面的问法）。 */
  async createSet(dto: CreateGeoPromptSetDto): Promise<GeoPromptSetView> {
    await this.brands.requireBrand(dto.brandId)
    rejectViolations(validatePromptSetInput(dto))

    const name = normalizePromptSetName(dto.name)
    await this.assertSetNameAvailable(dto.brandId, name)

    const row = await this.prisma.tenant.geoPromptSet.create({
      data: autoTenantData<Prisma.GeoPromptSetCreateInput>({
        brandId: dto.brandId,
        name,
        source: dto.source ?? 'MANUAL',
      }),
    })
    return toPromptSetView(row)
  }

  /** 改 Prompt 集的名字。`source` 是"它怎么来的"，改不了历史。 */
  async updateSet(id: string, dto: UpdateGeoPromptSetDto): Promise<GeoPromptSetView> {
    const current = await this.requireAnyPromptSet(id)
    rejectViolations(validatePromptSetInput({ name: dto.name }))

    const name = normalizePromptSetName(dto.name)
    if (name !== current.name) {
      await this.assertSetNameAvailable(current.brandId, name)
    }

    const row = await this.prisma.tenant.geoPromptSet.update({ where: { id }, data: { name } })
    return toPromptSetView(row)
  }

  /**
   * 删除 Prompt 集（软删）。
   *
   * **里面还有问法就不让删**：级联软删几十条 Prompt 的同时要释放同样多的配额，
   * 任何一步失败都会留下对不上的计数；而「先把问法挪走或删掉，再删这个空篮子」
   * 是运营本来就该做的事，也让他看得见自己删掉了什么。
   */
  async removeSet(id: string): Promise<{ id: string }> {
    await this.requireAnyPromptSet(id)
    const inUse = await this.prisma.tenant.geoPrompt.count({ where: { promptSetId: id } })
    if (inUse > 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `这个 Prompt 集下还有 ${inUse} 条问法，先把它们删掉或挪到别的集里`,
      )
    }
    await this.prisma.tenant.geoPromptSet.delete({ where: { id } })
    return { id }
  }

  // ── AI 生成候选问法（T6） ───────────────────────────────────────────────

  /**
   * 用 LLM 生成一批候选问法。**一条都不落库**。
   *
   * ## 为什么不落库
   *
   * 生成出来的问法质量参差：模型很容易写出「太赞怎么样」「太赞好用吗」「太赞值得买吗」
   * 这种三条其实是一条的东西。直接落库的话，商家的 `GEO_PROMPT` 配额会被这些近义句吃掉，
   * 而每一条都会在下一次跑批里真的花钱去问。
   *
   * 所以这条接口只**返回候选**，由人在前端勾选之后走既有的 `POST /prompts/import`
   * 落库——那条路径上已经有 `textHash` 去重与配额扣减，一条都不用重写。
   *
   * `duplicated` 是先算好的「库里已经有这条了」，让前端可以默认不勾它。
   *
   * ## 为什么这里可以同步调 LLM（唯一的例外）
   *
   * 技术设计 §10 第 4 条：「HTTP 请求路径里直接调引擎/LLM」是易犯错误，一律走
   * `@JobHandler`。那条约束针对的是**批量**——一次跑批是几百次调用，放在 HTTP 里必然超时。
   *
   * 这条接口是**交互式的单次调用**：运营点一下「AI 生成」，等两三秒看结果。
   * 把它塞进队列的代价是他点完之后要去另一个地方轮询，而他要的恰恰是当场看到候选
   * 好不好、不好就改一下行业描述再点一次。这是刻意的例外，与
   * `engine/geo-engine.service.ts` 的 `test()` 同一个判据。
   *
   * 超时压到 20 秒（比引擎默认的 60 秒短得多）：一个交互式接口等 60 秒没有意义，
   * 那时候运营早就以为页面卡死并刷新了。
   *
   * @throws 1240300 品牌不属于本店
   */
  async generate(dto: GenerateGeoPromptDto): Promise<GeoPromptGenerateResultView> {
    const brand = await this.brands.requireBrand(dto.brandId)
    const count = dto.count ?? GEO_PROMPT_GENERATE_DEFAULT

    const competitors = await this.prisma.tenant.geoCompetitor.findMany({
      where: { brandId: brand.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { name: true },
    })

    const res = await this.llm.chat(
      {
        messages: [
          { role: 'system', content: buildPromptGenSystem(count, dto.funnelStage) },
          {
            role: 'user',
            content: buildPromptGenUser(brand, competitors.map((c) => c.name)),
          },
        ],
        jsonSchema: PROMPT_GEN_SCHEMA,
        // 这一档要的是多样性，不是确定性——温度压到 0 会让同一个品牌每次生成的
        // 十条一模一样，而运营点第二次的原因通常就是「第一批不太行，再来一批」。
        temperature: 0.7,
        maxTokens: 2000,
        timeoutMs: GENERATE_TIMEOUT_MS,
      },
      // 只有 mock 会读（见 `analysis/geo-llm.provider.ts`）：`prompt-gen` 场景让它回
      // 五条固定的候选，e2e 据此断言。真实 provider 收到之后原样丢弃。
      { scenario: 'prompt-gen', brandName: brand.name },
    )

    const raw = readCandidates(res.json).slice(0, count)
    if (raw.length === 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        'AI 这次没生成出可用的候选问法，请稍后重试；多试两次仍然如此的话，多半是模型配置有问题',
      )
    }

    // 与库里已有的问法比一遍，标出重复的。用 `textHash` 而不是原文比：
    // 那是 `POST /import` 去重用的同一个口径，两处不一致的话前端标了"不重复"
    // 而导入时被判成重复，运营会以为接口坏了。
    const hashes = raw.map((c) => hashPromptText(c.text))
    const existing = await this.prisma.tenant.geoPrompt.findMany({
      where: { brandId: brand.id, textHash: { in: hashes } },
      select: { textHash: true },
    })
    const taken = new Set(existing.map((r) => r.textHash))

    return {
      candidates: raw.map((c, i) => ({
        text: c.text,
        funnelStage: normalizeFunnelStage(c.funnelStage),
        topic: c.topic ?? null,
        duplicated: taken.has(hashes[i] ?? ''),
      })),
      provider: this.llm.providerName,
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /**
   * 定位这条 Prompt 该归进哪个集。
   *
   * 传了就校验它属于这个品牌；没传就找（或建）品牌下名为 {@link DEFAULT_PROMPT_SET_NAME}
   * 的那一个。自动建的集 `source` 是 `MANUAL`——它装的是运营一条条敲进来的问法，
   * 与 `AI_GEN`（某次 AI 批量生成的候选）必须分得开，两者的可信度不一样。
   */
  private async resolvePromptSetId(brandId: string, promptSetId?: string): Promise<string> {
    if (promptSetId) {
      const set = await this.requirePromptSet(brandId, promptSetId)
      return set.id
    }

    const existing = await this.prisma.tenant.geoPromptSet.findFirst({
      where: { brandId, name: DEFAULT_PROMPT_SET_NAME },
    })
    if (existing) return existing.id

    const created = await this.prisma.tenant.geoPromptSet.create({
      data: autoTenantData<Prisma.GeoPromptSetCreateInput>({
        brandId,
        name: DEFAULT_PROMPT_SET_NAME,
        source: 'MANUAL',
      }),
    })
    return created.id
  }

  /** 拿到一条属于本店的 Prompt，否则 1240300。 */
  private async requirePrompt(id: string): Promise<GeoPrompt> {
    const row = await this.prisma.tenant.geoPrompt.findFirst({ where: { id } })
    if (!row) {
      throw new BizException(ErrorCode.CROSS_TENANT_FORBIDDEN, '问法不存在，或不属于当前店铺')
    }
    return row
  }

  /** 拿到一条属于本店、且挂在指定品牌下的 Prompt 集。 */
  private async requirePromptSet(brandId: string, id: string): Promise<GeoPromptSet> {
    const row = await this.prisma.tenant.geoPromptSet.findFirst({ where: { id, brandId } })
    if (!row) {
      throw new BizException(
        ErrorCode.CROSS_TENANT_FORBIDDEN,
        'Prompt 集不存在，或不属于这个品牌',
      )
    }
    return row
  }

  /** 拿到一条属于本店的 Prompt 集（不限品牌，给 `PUT/DELETE /sets/:id` 用）。 */
  private async requireAnyPromptSet(id: string): Promise<GeoPromptSet> {
    const row = await this.prisma.tenant.geoPromptSet.findFirst({ where: { id } })
    if (!row) {
      throw new BizException(
        ErrorCode.CROSS_TENANT_FORBIDDEN,
        'Prompt 集不存在，或不属于当前店铺',
      )
    }
    return row
  }

  /**
   * 同一个品牌下活跃问法的指纹不能重复。
   *
   * 理由与 `goods.service.ts` 的 `assertNameAvailable` 同源：`@@unique([tenantId, brandId,
   * textHash, deletedAt])` 在 MySQL 里管不住两行 `deletedAt IS NULL` 的同指纹记录
   * （NULL 互不相同），活跃唯一性只能应用层再兜一次。
   */
  private async assertPromptTextAvailable(brandId: string, textHash: string): Promise<void> {
    const existing = await this.prisma.tenant.geoPrompt.findFirst({ where: { brandId, textHash } })
    if (existing) {
      throw new BizException(ErrorCode.BAD_REQUEST, '这个品牌下已经有一条一样的问法了')
    }
  }

  /** 同一个品牌下活跃 Prompt 集名不能重复（理由同上）。 */
  private async assertSetNameAvailable(brandId: string, name: string): Promise<void> {
    const existing = await this.prisma.tenant.geoPromptSet.findFirst({ where: { brandId, name } })
    if (existing) {
      throw new BizException(ErrorCode.BAD_REQUEST, `这个品牌下已经有一个叫「${name}」的 Prompt 集了`)
    }
  }
}
