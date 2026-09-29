/**
 * `GET /api/admin/geo/engines` —— 商家侧**只读**的可选引擎清单。
 *
 * ## 它存在的唯一理由
 *
 * 品牌表单上那个「监测引擎」多选框需要一份清单。T4 把它写死在了前端
 * （`apps/admin/src/api/geo-brand.ts` 的 `GEO_ENGINE_OPTIONS`），代价是
 * 「平台上了一个新引擎，前端要发一次版」，而更糟的是反过来：**平台停用了一个
 * 引擎，商家的下拉框里它还在**，选了保存下去，跑批时静默跳过——商家以为自己
 * 在监测它。这条接口把那份清单换成真源。
 *
 * ## 为什么单独一个控制器文件，而不是加在 `geo-engine.controller.ts` 上
 *
 * 那个文件是 `@Auth('platform')` + `@Controller('api/platform/geo/engines')`，
 * 而**身份与路由前缀都是类级装饰器**。同一个类上挂不了两种身份。
 *
 * 分文件的第二个好处是它让「商家能看到引擎的哪些字段」变成一处可以一眼读完的
 * 代码：下面这个方法体只有一行，它 return 的 `GeoEngineOptionView` 一共四个字段，
 * 没有密钥、没有单价、没有限速。把它混进平台控制器里的话，某天有人为了省事
 * 复用 `GeoEngineView`，密钥的脱敏提示与平台成本参数就一起漏给商家了。
 *
 * ## 为什么不是 `@Public()`
 *
 * 公开的话等于把「这个平台接了哪几家引擎」白送出去，还附赠一个不限流的探测端点
 * （`@Public()` 必须配 `@RateLimited`，而这里根本不需要开这个洞）。
 * 权限点用 `geo-engine:list`，理由见 `geo-engine.permissions.ts`。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Auth } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'

import { GeoEngineOptionView } from './dto/geo-engine.dto'
import { GeoEngineService } from './geo-engine.service'

@ApiTags('admin/geo/engines')
@Controller('api/admin/geo/engines')
@Auth('staff')
export class GeoEnginePublicController {
  constructor(@Inject(GeoEngineService) private readonly engines: GeoEngineService) {}

  /**
   * 已启用的引擎清单。
   *
   * **不分页**：引擎总数是平台接了几家，个位数。
   * **不带 `enabled` 过滤参数**：商家没有理由查询"被停用的引擎有哪些"。
   */
  @Get()
  @ApiOperation({ summary: '可选的监测引擎（只有已启用的，不含任何密钥与成本字段）' })
  @ApiOkResponse({ type: GeoEngineOptionView, isArray: true })
  @RequirePermission('geo-engine:list')
  list(): Promise<GeoEngineOptionView[]> {
    return this.engines.listEnabledOptions()
  }
}
