/**
 * 商家自带引擎密钥的 HTTP 层：`/api/admin/geo/engine-credentials`。
 *
 * | 装饰器 | 作用 | 谁在看着 |
 * |---|---|---|
 * | `@Auth('staff')` | 只接受商家员工 token | `guard-default-deny.spec.ts`（spec 5） |
 * | `@RequirePermission('geo-engine-credential:manage')` | 一档权限，理由见 `geo-engine-credential.permissions.ts` | `permission-registry.spec.ts`（spec 6） |
 * | `@Audit` | 四个写操作各一条动作码 | —— |
 *
 * 类前缀就是完整资源路径（与 alert-rules 一致），配合 `features.ts` 里
 * `geo.monitor` 那条 `pathPrefixes`（`billing-routes.spec.ts`，spec 8）。
 *
 * @packageDocumentation
 */

import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'
import type { Request } from 'express'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import {
  CreateGeoEngineCredentialDto,
  GeoEngineCredentialView,
  ListGeoEngineCredentialQueryDto,
  SetGeoEngineCredentialEnabledDto,
  UpdateGeoEngineCredentialDto,
} from './dto/geo-engine-credential.dto'
import { GeoEngineCredentialService } from './geo-engine-credential.service'

function paramOf(req: Request, name: string): string | undefined {
  const value = req.params[name]
  return typeof value === 'string' ? value : undefined
}

@ApiTags('admin/geo/engine-credentials')
@Controller('api/admin/geo/engine-credentials')
@Auth('staff')
export class GeoEngineCredentialController {
  constructor(
    @Inject(GeoEngineCredentialService) private readonly credentials: GeoEngineCredentialService,
  ) {}

  @Get()
  @ApiOperation({ summary: '本店的专属引擎密钥列表' })
  @ApiOkResponse({ type: GeoEngineCredentialView, isArray: true })
  @RequirePermission('geo-engine-credential:manage')
  list(
    @Query(Validate(ListGeoEngineCredentialQueryDto)) query: ListGeoEngineCredentialQueryDto,
  ): Promise<PageResult<GeoEngineCredentialView>> {
    return this.credentials.list(query)
  }

  @Post()
  @ApiOperation({ summary: '新配一把专属密钥（同一个引擎只能配一条活跃的）' })
  @ApiOkResponse({ type: GeoEngineCredentialView })
  @RequirePermission('geo-engine-credential:manage')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_ENGINE_CREDENTIAL_TENANT_CREATE,
    targetType: 'GeoEngineCredential',
  })
  create(
    @Body(Validate(CreateGeoEngineCredentialDto)) dto: CreateGeoEngineCredentialDto,
  ): Promise<GeoEngineCredentialView> {
    return this.credentials.create(dto)
  }

  @Put(':id')
  @ApiOperation({ summary: '换密钥（整包替换，不合并）' })
  @ApiOkResponse({ type: GeoEngineCredentialView })
  @RequirePermission('geo-engine-credential:manage')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_ENGINE_CREDENTIAL_TENANT_UPDATE,
    targetType: 'GeoEngineCredential',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  update(
    @Param('id') id: string,
    @Body(Validate(UpdateGeoEngineCredentialDto)) dto: UpdateGeoEngineCredentialDto,
  ): Promise<GeoEngineCredentialView> {
    return this.credentials.update(id, dto)
  }

  @Patch(':id/enabled')
  @ApiOperation({ summary: '启用 / 停用' })
  @ApiOkResponse({ type: GeoEngineCredentialView })
  @RequirePermission('geo-engine-credential:manage')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_ENGINE_CREDENTIAL_TENANT_SET_ENABLED,
    targetType: 'GeoEngineCredential',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  setEnabled(
    @Param('id') id: string,
    @Body(Validate(SetGeoEngineCredentialEnabledDto)) dto: SetGeoEngineCredentialEnabledDto,
  ): Promise<GeoEngineCredentialView> {
    return this.credentials.setEnabled(id, dto.enabled)
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除（软删）' })
  @ApiOkResponse({ type: GeoEngineCredentialView })
  @RequirePermission('geo-engine-credential:manage')
  @Audit({
    action: APP_AUDIT_ACTIONS.GEO_ENGINE_CREDENTIAL_TENANT_DELETE,
    targetType: 'GeoEngineCredential',
    targetId: (req: Request) => paramOf(req, 'id'),
  })
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.credentials.remove(id)
  }
}
