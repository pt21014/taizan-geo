/**
 * `POST /api/admin/geo/brands/:id/diagnose` —— 「先诊断后付费」编排接口的 HTTP 层。
 *
 * ## 为什么挂在 `api/admin/geo/brands` 前缀下，而不是独立的 `geo/diagnosis`
 *
 * 诊断编排的对象就是"这个品牌"，与 `GeoBrandController` 的 `:id/competitors` 是
 * 同一个判据——URL 表达"这个动作属于哪个品牌"，而不是让 service 层再猜一次。
 * 挂同一个前缀、不同的类，路由表不冲突（Nest 允许多个 `@Controller` 共享前缀），
 * 是刻意拆开的：诊断编排要注入 `GeoPromptService`/`GeoRunService`/`GeoReportService`
 * 三个跨子域的服务，塞进 `GeoBrandController` 会让那个类的职责从"品牌 CRUD"
 * 膨胀成"品牌 CRUD + 编排"，而删除这个功能时也没法"删一个文件"那么干净。
 *
 * ## 为什么复用 `/api/admin/geo/brands` 的 `geo.monitor` 功能闸门，不单独登记 pathPrefix
 *
 * `registry/features.ts` 里 `geo.monitor` 的 `pathPrefixes` 已经含
 * `/api/admin/geo/brands`——这条新路由的完整路径 `/api/admin/geo/brands/:id/diagnose`
 * 天然落在这个前缀之下，写入路由表就自动被同一道闸门挡住写操作，不需要再加一条。
 * 这与"发起诊断要花真金白银（问法生成 + 跑批）"这件事在语义上也是一致的——
 * 免费摘要指的是"看已经生成好的报告"，不是"随便发起新的诊断"。
 *
 * @packageDocumentation
 */

import { Body, Controller, Inject, Param, Post } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Audit } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'
import type { Request } from 'express'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import { DiagnoseGeoBrandDto, GeoDiagnosisTriggerResultView } from './dto/geo-diagnosis.dto'
import { GeoDiagnosisService } from './geo-diagnosis.service'

function paramOf(req: Request, name: string): string | undefined {
  const value = req.params[name]
  return typeof value === 'string' ? value : undefined
}

@ApiTags('admin/geo/diagnosis')
@Controller('api/admin/geo/brands')
@Auth('staff')
export class GeoDiagnosisController {
  constructor(@Inject(GeoDiagnosisService) private readonly diagnosis: GeoDiagnosisService) {}

  @Post(':id/diagnose')
  @ApiOperation({
    summary:
      '一次性诊断编排：按需生成并导入问法 → 建一次跑批并入队 → 立即返回。' +
      '诊断报表就绪后可从 GET /runs/:id 的 diagnosisReportId 拿到',
  })
  @ApiOkResponse({ type: GeoDiagnosisTriggerResultView })
  @RequirePermission('geo-diagnosis:trigger')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_DIAGNOSIS_TRIGGER,
    targetType: 'GeoBrand',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  diagnose(
    @Param('id') id: string,
    @Body(Validate(DiagnoseGeoBrandDto)) dto: DiagnoseGeoBrandDto,
  ): Promise<GeoDiagnosisTriggerResultView> {
    return this.diagnosis.diagnose(id, dto)
  }
}
