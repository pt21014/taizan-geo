/**
 * 蓝图 §7 扩展点③：「先诊断后付费」编排接口的权限点。
 *
 * 只有一个 `trigger`：这条接口不新增数据形状（品牌/问法/跑批都是已有资源），
 * 它只是把已有的三个写操作（生成问法、导入问法、建跑批）编排到一次调用里，
 * 所以不需要 `list`/`write`/`delete` 三档——那三档的语义已经分别挂在
 * `geo-prompt:*`/`geo-run:*` 上了，这里只需要一个"允许发起编排"的开关。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 诊断编排模块的权限点。 */
export const GEO_DIAGNOSIS_PERMISSIONS = definePermissions({
  'geo-diagnosis:trigger': { module: 'GEO 诊断', name: '发起一次诊断编排', type: 'API' },
})
