/**
 * 蓝图 §7 扩展点③ **注册权限点**：商家自带引擎密钥的权限点。
 *
 * ## 一档 `manage`，不拆 list/write
 *
 * 与告警（list/write 两档）不同：这张表**只有本店自己能看见**（`prisma.tenant`
 * 天然按租户隔离，不存在「看得到但改不了别家的」这种越权场景），而密钥这种东西
 * 能看列表（哪怕只有脱敏提示）本身就该等同于能管理——拆两档只会让角色配置页
 * 多一行没人分得清用途的勾选项，与 `geo-alert:list`/`write` 那两档要拆开的理由
 * （告警事件是审计流水，任何有权看规则的人都该看得到）并不适用于这里。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 商家自带引擎密钥的权限点。 */
export const GEO_ENGINE_CREDENTIAL_PERMISSIONS = definePermissions({
  'geo-engine-credential:manage': {
    module: 'GEO 引擎密钥',
    name: '查看/新增/编辑/删除本店的专属引擎密钥',
    type: 'API',
  },
})
