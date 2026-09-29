/**
 * 蓝图 §7 扩展点③ **注册权限点**：模块内定义，`src/registry/permissions.ts` 汇总。
 *
 * ## 为什么 `geo-prompt:generate` 与 `geo-prompt:write` 是两档
 *
 * 生成本身**不落库**（见 `geo-prompt.controller.ts`），所以它不占配额、不改数据。
 * 但它是这个模块里唯一一个会**真的调 LLM**的动作：每点一次都往外发一次请求，
 * 而那条接口没有节流（它是交互式的，节流会把正常使用也挡掉）。
 *
 * 拆成单独一档之后，「这个角色能编问法，但不给他 AI 生成」表达得出来——
 * 而那正是接了自建模型、按 token 付费的部署里会做的事。
 *
 * ## PromptSet 为什么不单开一组权限点
 *
 * Prompt 集是 Prompt 的容器，不是独立实体——能建问法的人必然要能建放问法的篮子。
 * 单开一档的结果只会是「运营发现建不了问法，因为他缺的是另一个权限」。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** Prompt 模块的权限点。 */
export const GEO_PROMPT_PERMISSIONS = definePermissions({
  'geo-prompt:list': { module: 'GEO Prompt', name: '查看问法与 Prompt 集', type: 'API' },
  'geo-prompt:write': { module: 'GEO Prompt', name: '新增/编辑/导入问法', type: 'API' },
  'geo-prompt:delete': { module: 'GEO Prompt', name: '删除问法与 Prompt 集', type: 'API' },
  'geo-prompt:generate': { module: 'GEO Prompt', name: 'AI 生成候选问法（会调 LLM）', type: 'API' },
})
