/**
 * 「先诊断后付费」编排接口的 DTO。
 *
 * `@ApiProperty` 一律**显式写 `type`**（本仓没有 `emitDecoratorMetadata`）。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'

/** 品牌还没有问法时，自动生成的候选条数。与 `geo-prompt.dto.ts` 的默认值分开配置——
 * 诊断编排要的是"够画出一份报告"，不是"够运营慢慢挑"，值可以不同，但都低于生成上限。 */
export const GEO_DIAGNOSIS_PROMPT_COUNT_DEFAULT = 10

/** `POST /api/admin/geo/brands/:id/diagnose` 的入参。 */
export class DiagnoseGeoBrandDto {
  @ApiPropertyOptional({
    type: Number,
    description: `品牌还没有问法时，自动生成几条候选并导入；默认 ${GEO_DIAGNOSIS_PROMPT_COUNT_DEFAULT}`,
    default: GEO_DIAGNOSIS_PROMPT_COUNT_DEFAULT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'promptCount 必须是整数' })
  @Min(3, { message: 'promptCount 至少 3（否则诊断样本太少）' })
  @Max(30, { message: 'promptCount 上限 30' })
  promptCount?: number
}

/** `POST /diagnose` 的响应：编排立刻建好了跑批并返回，真正的结果要轮询拿。 */
export class GeoDiagnosisTriggerResultView {
  @ApiProperty({ type: String, description: '这次诊断对应的跑批 id；轮询 GET /runs/:id 直到终态' })
  runId!: string

  @ApiProperty({ type: String })
  brandId!: string

  @ApiProperty({
    type: Number,
    description: '这次自动生成并导入了几条候选问法（品牌本来就有问法时恒为 0）',
  })
  promptsGenerated!: number

  @ApiProperty({ type: Number, description: '这次跑批规划出的查询总数（问法数 × 引擎数 × 采样数）' })
  plannedQueries!: number

  @ApiProperty({
    type: Boolean,
    description: '本次是否复用了品牌已有的问法（true = 没有触发 AI 生成）',
  })
  reusedExistingPrompts!: boolean
}
