/**
 * 五张注册表之四：**审计动作**（蓝图 §4.8、§7 扩展点⑥）。
 *
 * 框架自带的动作在 `@taizan/nest-audit` 的 `AUDIT_ACTIONS`（建租户、冻结、员工变更、
 * 订单标记已付…）；业务自己的动作在这里。**两份分开维护、分开展示**——框架升级新增
 * 内置动作时不该动到业务文件，反之亦然。
 *
 * 动作码格式定死 `module.action`（小写 + 连字符，两段之间恰好一个点），
 * `defineAuditActions()` 在加载期校验。统一格式是为了审计查询页能
 * `action.split('.')[0]` 直接按模块筛选。
 *
 * @packageDocumentation
 */

import { AUDIT_ACTIONS, defineAuditActions } from '@taizan/nest-audit'

/** 本应用的业务审计动作。 */
export const APP_AUDIT_ACTIONS = defineAuditActions({
  // ── T4 GEO 品牌与 Prompt ────────────────────────────────────────────

  /** 新建监测品牌（占用一个 GEO_BRAND 配额）。 */
  GEO_BRAND_CREATE: 'geo-brand.create',
  /** 修改监测品牌（改域名/别名/引擎/采样次数都走这一条）。 */
  GEO_BRAND_UPDATE: 'geo-brand.update',
  /**
   * 删除（软删）监测品牌。
   *
   * 单独记而不是并进 `geo-brand.update`：删品牌是本模块最不可逆的动作——
   * 历史趋势还在库里，但它从此不再跑批，而"为什么这个品牌的数据停在三个月前"
   * 是事后一定会被追问的问题。
   */
  GEO_BRAND_DELETE: 'geo-brand.delete',
  /** 新建竞品。 */
  GEO_BRAND_COMPETITOR_CREATE: 'geo-brand.competitor-create',
  /** 修改竞品。 */
  GEO_BRAND_COMPETITOR_UPDATE: 'geo-brand.competitor-update',
  /**
   * 删除（软删）竞品。
   *
   * 竞品是份额 SoV 的分母，删掉一个之后所有历史对比的口径就变了。
   * 报表上"份额突然涨了 20 个点"最常见的真实原因就是这一条。
   */
  GEO_BRAND_COMPETITOR_DELETE: 'geo-brand.competitor-delete',

  /** 新建问法（占用一个 GEO_PROMPT 配额）。 */
  GEO_PROMPT_CREATE: 'geo-prompt.create',
  /** 修改问法。改正文等于改 `textHash`，于是它在去重口径上变成了另一条问法。 */
  GEO_PROMPT_UPDATE: 'geo-prompt.update',
  /** 删除（软删）问法。 */
  GEO_PROMPT_DELETE: 'geo-prompt.delete',
  /**
   * 批量导入问法。
   *
   * 与 `geo-prompt.create` 分开记：一次导入可能建进去几十条，逐条记会把审计页刷屏，
   * 而真正要能回答的问题是"这批问法是谁、什么时候、一次性导进来的"。
   */
  GEO_PROMPT_IMPORT: 'geo-prompt.import',
  /**
   * AI 生成候选问法（T6）。
   *
   * 记它而不是当成一次普通的查询：它是本项目唯一一处在 HTTP 路径上同步调 LLM 的接口，
   * 而 LLM 是按 token 计费的。「上周三是谁点了两百次生成」这个问题要能一句话捞出来。
   * **不落库**，所以它与 `geo-prompt.create` / `geo-prompt.import` 不重叠。
   */
  GEO_PROMPT_GENERATE: 'geo-prompt.generate',
  /** 新建 Prompt 集。 */
  GEO_PROMPT_SET_CREATE: 'geo-prompt.set-create',
  /** 修改 Prompt 集（只能改名）。 */
  GEO_PROMPT_SET_UPDATE: 'geo-prompt.set-update',
  /** 删除（软删）Prompt 集。 */
  GEO_PROMPT_SET_DELETE: 'geo-prompt.set-delete',

  // ── T6 GEO 跑批 ─────────────────────────────────────────────────────

  /**
   * 手动触发一次跑批（「立即刷新」按钮）。
   *
   * 这是商家侧唯一一个**按一下就会花钱**的动作：一次等于
   * `问法数 × 引擎数 × 采样数` 次真实的引擎调用，直接扣 `GEO_QUERY_MONTHLY`。
   * 「这个月的额度是怎么在三天里用光的」这个问题，答案就在这条记录里。
   *
   * 定时触发（`geo-run-schedule` cron）**不记审计**：审计记的是「谁做了什么」，
   * 而 cron 没有「谁」；它的执行记录在 `CronRun` 里。
   */
  GEO_RUN_TRIGGER: 'geo-run.trigger',

  // ── T5 GEO 引擎（平台域） ───────────────────────────────────────────
  //
  // 这一批全都是**平台运营**的动作，落 `PlatformAuditLog` 而不是租户的 `AuditLog`。
  // 每一条都记，一条不省：这张表控制的是平台花多少钱（单价）、跑不跑得动
  // （限速、超时）、以及所有租户的查询能不能成（密钥），而它们都是「改一个数字」
  // 这种在 diff 里毫不起眼的操作。

  /** 新接一个引擎。 */
  GEO_ENGINE_CREATE: 'geo-engine.create',
  /** 改引擎配置（名称 / 模型 / 单价 / 限速 / 超时）。**不含密钥**，密钥另有一条。 */
  GEO_ENGINE_UPDATE: 'geo-engine.update',
  /**
   * 启用一个引擎。
   *
   * 与 `geo-engine.update` 分开，且与 `disable` 再分成两条：启停是唯一一个
   * **立刻影响全平台跑批**的开关。「上周五是谁把通义停掉的、为什么全平台的数据
   * 断了三天」这个问题要能 `where action = 'geo-engine.disable'` 一句话捞出来，
   * 合进 update 的话只能翻 payload 猜。
   */
  GEO_ENGINE_ENABLE: 'geo-engine.enable',
  /** 停用一个引擎。存量品牌的 engineCodes 不变，跑批时跳过它。 */
  GEO_ENGINE_DISABLE: 'geo-engine.disable',
  /**
   * 换了密钥。
   *
   * 单独记而不是并进 `geo-engine.update`：密钥是这张表里唯一一个**换错了会让
   * 全平台的查询在几分钟内全部失败**的字段，而失败现象（AUTH 错误）与
   * 「厂商那边出故障了」长得一模一样。有这条记录，第一件要排除的事就能一秒钟排除。
   *
   * 审计的 payload 里**不会有明文**：`@Audit` 默认 `redactBody: true`，
   * 而且 service 那边收到的就是整包对象、落库前就加密了。
   */
  GEO_ENGINE_CREDENTIAL_UPDATE: 'geo-engine.credential-update',
  /**
   * 平台运营手动测了一次。
   *
   * 记它有两个理由：它**会真的花钱**（一次真实的引擎调用，计入厂商账单但不进
   * 任何租户的 `GeoUsageLedger`），以及「这把 key 最后一次被验证是什么时候」
   * 在排障时是第一个要问的问题。
   */
  GEO_ENGINE_TEST: 'geo-engine.test',

  // ── T7 GEO 告警 / 报表 / 平台重跑 ───────────────────────────────────

  /**
   * 新建一条告警规则。
   *
   * 告警规则是**会主动往外发东西**的配置：一条阈值配错的规则会每天给店主发短信。
   * 「上周五谁把可见度阈值从 10% 调成 1% 的」这个问题只能靠审计回答——
   * 规则表上只有当前值，没有历史。
   */
  GEO_ALERT_RULE_CREATE: 'geo-alert.rule-create',
  /** 修改告警规则（阈值 / 通道 / 启停）。 */
  GEO_ALERT_RULE_UPDATE: 'geo-alert.rule-update',
  /**
   * 删除告警规则（软删）。
   *
   * 与「新建」分开记，而不是合成一个 `geo-alert.rule-change`：
   * 「告警为什么停了」与「告警为什么变吵了」是两个不同的排查方向，
   * 合在一起之后只能靠翻 payload 区分。
   */
  GEO_ALERT_RULE_DELETE: 'geo-alert.rule-delete',

  // ── 商家自带引擎密钥 ─────────────────────────────────────────────────
  //
  // 与平台侧 `GEO_ENGINE_*` 系列命名区分（`_TENANT_` 中缀），因为它们落的是
  // 租户的 `AuditLog` 而不是 `PlatformAuditLog`，是完全不同的两张表、两个
  // 排查场景——一个是「平台运营改了谁的账单参数」，一个是「这家店谁配错了
  // 自己的密钥导致查询全部失败」。

  /** 新配一把商家自带的引擎密钥。 */
  GEO_ENGINE_CREDENTIAL_TENANT_CREATE: 'geo-engine-credential.create',
  /** 换密钥（整包替换）。 */
  GEO_ENGINE_CREDENTIAL_TENANT_UPDATE: 'geo-engine-credential.update',
  /** 启停一条商家自带密钥配置。 */
  GEO_ENGINE_CREDENTIAL_TENANT_SET_ENABLED: 'geo-engine-credential.set-enabled',
  /** 删除（软删）一条商家自带密钥配置。 */
  GEO_ENGINE_CREDENTIAL_TENANT_DELETE: 'geo-engine-credential.delete',

  /**
   * 手动生成一份报表。
   *
   * 它是纯 DB 聚合（不调任何外部服务、不花钱），记它不是为了防滥用，
   * 而是因为报表 `payload` 是**生成那一刻的快照**：同一个周期生成两次
   * 可能得到两份不同的数字（中间补跑过），而「这份报告是谁什么时候出的」
   * 是对外发出去之后唯一能追溯的线索。
   */
  GEO_REPORT_GENERATE: 'geo-report.generate',

  /**
   * 【平台侧】把一次跑批里失败的结果重置并重新入队。
   *
   * **会花钱**：重置多少条 FAILED 结果，就会重新发起多少次真实的引擎调用，
   * 并再次扣那家租户的 `GEO_QUERY_MONTHLY`。平台运营在跑批监控页按的这一下
   * 花的是平台与租户两边的钱，必须留痕。
   */
  GEO_RUN_PLATFORM_RETRY: 'geo-run.platform-retry',

  /**
   * 发起一次「先诊断后付费」编排（`POST /brands/:id/diagnose`）。
   *
   * 会花钱（可能触发一次 AI 生成问法 + 一次跑批，两者都消耗真实配额），
   * 且是新用户接触这个产品的第一个动作，留痕对排查"为什么这个品牌配额用这么快"
   * 与"新用户转化链路第一步卡在哪"都有用。
   */
  GEO_DIAGNOSIS_TRIGGER: 'geo-diagnosis.trigger',

  /** 新建商品。 */
  GOODS_CREATE: 'goods.create',
  /** 修改商品。 */
  GOODS_UPDATE: 'goods.update',
  /** 删除（软删）商品。 */
  GOODS_DELETE: 'goods.delete',

  // ── T1-7 平台管理面 ─────────────────────────────────────────────────

  /** 新建平台管理员。 */
  PLATFORM_ADMIN_CREATE: 'platform-admin.create',
  /** 修改平台管理员（名字 / 角色）。 */
  PLATFORM_ADMIN_UPDATE: 'platform-admin.update',
  /** 启用平台管理员。 */
  PLATFORM_ADMIN_ENABLE: 'platform-admin.enable',
  /** 停用平台管理员。 */
  PLATFORM_ADMIN_DISABLE: 'platform-admin.disable',
  /** 平台运营重置某个管理员的口令（区别于框架自带的「本人改密」动作）。 */
  PLATFORM_ADMIN_RESET_PASSWORD: 'platform-admin.reset-password',
  /** 平台管理员给自己开一份新的 MFA TOTP 密钥（T3-4，开关位，登录时未强制校验，见 platform-mfa.service.ts）。 */
  PLATFORM_ADMIN_MFA_ENABLE: 'platform-admin.mfa-enable',
  /** 平台管理员校验一枚 MFA 一次性码。 */
  PLATFORM_ADMIN_MFA_VERIFY: 'platform-admin.mfa-verify',

  /** 死信重放（T3-4）：把一条重试耗尽的任务原样重新入队。 */
  JOB_DEAD_LETTER_REPLAY: 'job.dead-letter-replay',

  /** 续期（延长 planExpireAt）。T1-5 之后它已经改走 `PlanOrderService.fulfill()` 单一路径，动作码不变。 */
  TENANT_RENEW: 'tenant.renew',
  /** 更换套餐（不改到期日）。 */
  TENANT_CHANGE_PLAN: 'tenant.change-plan',
  /** 平台运营重置店主登录口令。 */
  TENANT_RESET_OWNER_PASSWORD: 'tenant.reset-owner-password',

  /**
   * 【高危】平台运营开通新店时，**跳过「一号多店必须验原口令」**直接绑定一个已有账号（T1-8）。
   *
   * 与 `tenant.create` 分开记，而不是塞进它的 `after` 里：这一条是本框架唯一一处
   * 「有人可以不验口令就把一家店挂到别人账号下」，它必须能被单独 `where action = ...`
   * 捞出来做定期巡检。合进 `tenant.create` 的话，它会淹没在每天几十条正常开店里。
   *
   * `@taizan/provision` 本身不给 source 开这个口子（开了「一条路」就名存实亡），
   * 它是 apps/api 侧的适配层，安全性全部建立在「事后查得出是谁按的」上面。
   */
  TENANT_CREATE_ATTACH_EXISTING: 'tenant.create-attach-existing',

  /** 新建套餐。 */
  PLAN_CREATE: 'plan.create',
  /** 修改套餐（价格 / 配额 / 功能）。 */
  PLAN_UPDATE: 'plan.update',
  /** 套餐上架（ENABLED）。 */
  PLAN_PUBLISH: 'plan.publish',
  /** 套餐下架（DISABLED，存量租户不受影响）。 */
  PLAN_UNPUBLISH: 'plan.unpublish',
  /** 套餐归档（ARCHIVED，永不再售）。 */
  PLAN_ARCHIVE: 'plan.archive',
  /** 调整套餐展示排序。 */
  PLAN_SORT: 'plan.sort',

  // ── T1-5 平台收费闭环 ───────────────────────────────────────────────

  /**
   * 套餐订单兑现（钱变成权益：延长 planExpireAt）。
   *
   * 框架侧已经有 `plan-order.mark-paid`（线下核销这个**动作**）与 `plan-order.refund`，
   * 但没有「兑现」本身——而在线支付那条路上根本没有「运营点了标记已付」这个动作，
   * 却同样发生了兑现。两者分开记，审计页才回答得了「这家店的到期日是被谁、
   * 通过哪条路径改成今天这个值的」。
   */
  PLAN_ORDER_FULFILL: 'plan-order.fulfill',
  /** 商家自助下单 / 平台运营代下单（只落 PENDING，不动权益）。 */
  PLAN_ORDER_CREATE: 'plan-order.create',
  /**
   * 支付回调对套餐订单的处理结果。
   *
   * 只有**不予兑现**的那两条分支会用到它（订单不存在、金额不符）——两者都是
   * 「钱到账了但系统拒绝发货」，也都是重推不会自愈的永久性错误。成功那条走
   * `PLAN_ORDER_FULFILL`，两者分开才看得出「这笔钱最后到底怎么了」。
   */
  PLAN_ORDER_CALLBACK: 'plan-order.callback',

  /** 新建角色预设。 */
  ROLE_PRESET_CREATE: 'role-preset.create',
  /** 修改角色预设。 */
  ROLE_PRESET_UPDATE: 'role-preset.update',
  /** 删除角色预设（builtin 禁止）。 */
  ROLE_PRESET_DELETE: 'role-preset.delete',

  // ── T1-9 商家侧管理面 ───────────────────────────────────────────────
  //
  // 框架内置的 `AUDIT_ACTIONS` 里已经有 `staff.invite` / `staff.remove` /
  // `staff.role-change` / `staff.owner-transfer` 四条，控制器上直接用那四条。
  // 下面补的是框架没有、而这个应用真的会做的动作。

  /** 停用员工（区别于框架内置的 `staff.remove`「移出店铺」——停用保留成员关系）。 */
  STAFF_DISABLE: 'staff.disable',
  /** 启用员工。 */
  STAFF_ENABLE: 'staff.enable',

  /** 商家新建自定义角色。与平台侧的 `role-preset.*`（角色**模板**）是两回事。 */
  ROLE_CREATE: 'role.create',
  /** 商家修改角色（改名 / 改权限点）。 */
  ROLE_UPDATE: 'role.update',
  /** 商家删除角色（软删；内置角色与仍被引用的角色删不掉）。 */
  ROLE_DELETE: 'role.delete',

  /**
   * 员工标记一条平台公告已读。
   *
   * 记它是因为公告里可能有「X 月 X 日起调价」这类**需要被告知**的内容，
   * 而「他到底看没看到」在事后会被追问。`AnnouncementRead` 那张表本身就存了
   * 首次已读时间，这条审计记的是「这个动作是从哪个 IP、哪条 traceId 上发生的」——
   * 两者不重复：回执是状态，审计是行为。
   */
  ANNOUNCEMENT_READ: 'announcement.read',

  /** 员工改自己的资料（显示名 / 头像）。 */
  PROFILE_UPDATE: 'profile.update',
  /**
   * 员工改自己的密码。
   *
   * 与框架内置的 `platform-admin.change-password`（平台管理员改密）分开，
   * 也与 `tenant.reset-owner-password`（平台运营**替**店主重置）分开：
   * 「本人改的」和「别人替他改的」在事后是完全不同的两件事。
   */
  PROFILE_CHANGE_PASSWORD: 'profile.change-password',

  /** 新建公告（草稿）。 */
  ANNOUNCEMENT_CREATE: 'announcement.create',
  /** 修改公告。 */
  ANNOUNCEMENT_UPDATE: 'announcement.update',
  /** 公告下线（转 ARCHIVED，保留内容与已读回执）。 */
  ANNOUNCEMENT_UNPUBLISH: 'announcement.unpublish',
  /** 删除公告（仅限从未发布过的 DRAFT）。 */
  ANNOUNCEMENT_DELETE: 'announcement.delete',
})

/**
 * 框架 + 业务的合集，给审计查询页做「动作码 → 中文名」下拉用。
 *
 * 两边 key 撞名会被下面的断言抓住：撞名的后果是审计页把两种完全不同的操作显示成同一件事。
 */
export const ALL_AUDIT_ACTIONS = Object.freeze({ ...AUDIT_ACTIONS, ...APP_AUDIT_ACTIONS })

function assertNoActionCollision(): void {
  const framework = new Set<string>(Object.values(AUDIT_ACTIONS))
  const collisions = Object.entries(APP_AUDIT_ACTIONS)
    .filter(([, value]) => framework.has(value))
    .map(([key, value]) => `${key}=${value}`)
  if (collisions.length > 0) {
    throw new Error(
      `[@taizan/api] 业务审计动作与框架内置动作撞码：${collisions.join(', ')}。` +
        '换一个模块段前缀（业务动作建议带自己的模块名）。',
    )
  }
}

assertNoActionCollision()
