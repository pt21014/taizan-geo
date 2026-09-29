/**
 * 蓝图 §7 扩展点④ **注册菜单**：GEO 命名空间下的菜单，`src/registry/menus.ts` 汇总。
 *
 * ## 为什么是一个 `GEO` 目录而不是每个子模块各一个
 *
 * GEO 在 P0 之后会有 8 个页面（技术设计 §6.1：仪表盘 / 品牌 / Prompt / 跑批 / 结果 /
 * 引用 / 告警 / 报告）。每个子模块各起一个顶级目录的话，商家侧边栏会被 8 个
 * 单菜单目录塞满，而它们其实是同一件事的八个视角。一个目录一份 `sort`，
 * 子项之间的顺序在这一个文件里就排得清。
 *
 * T4 挂了品牌与 Prompt 两页，T6 追加「监测任务」与「回答明细」，后续任务继续往 `children` 里加。
 *
 * ## 每个 `MENU` 节点带两个裁剪依据
 *
 * - `permission`：这个人的角色里有没有这个权限点；
 * - `featureKey`：这家店的套餐里有没有这个功能项。
 *
 * 两者是「与」的关系，缺一个菜单就不下发。`componentKey` 只是一个 key，
 * 服务端不知道也不该知道前端的文件路径——`apps/admin/src/routes/component-map.ts`
 * 负责把 key 映射到组件，由 `menu-route-map.spec.ts`（spec 7）双向比对。
 *
 * @packageDocumentation
 */

import { type MenuDef } from '@taizan/contracts'

/** GEO 监测模块的菜单。 */
export const GEO_MENUS: readonly MenuDef[] = [
  {
    key: 'geo',
    title: 'GEO 监测',
    icon: 'RadarChartOutlined',
    type: 'DIR',
    side: 'ADMIN',
    // 排在工作台（10）之后、示例商品（20）之前：GEO 是这个应用的主业务。
    sort: 15,
    children: [
      {
        // 看板是这个目录的落地页，排最前。**没有 `featureKey`**：与「回答明细」
        // 同一个判据（`geo-dashboard.controller.ts` 文件头）——套餐到期之后商家
        // 仍然该看得到历史趋势，不然会以为半年的数据丢了。
        key: 'geo.dashboard',
        title: '可见度看板',
        path: '/geo',
        componentKey: 'GeoDashboard',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'geo-dashboard:view',
        sort: 5,
      },
      {
        key: 'geo.brand',
        title: '品牌管理',
        path: '/geo/brands',
        componentKey: 'GeoBrandList',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'geo-brand:list',
        featureKey: 'geo.monitor',
        sort: 10,
      },
      {
        // 按钮级菜单项：前端据它决定「新增品牌」按钮画不画。
        //
        // 它是 `geo` 目录的**兄弟节点**而不是 `geo.brand` 的子节点——
        // `defineMenus()` 明令「非 DIR 类型不能有 children」（一个 MENU 挂子节点，
        // 前端渲染成什么谁也说不清）。按钮和它所在的页面在树上是平级的，
        // 靠 key 的前缀（`geo.*`）表达归属。
        key: 'geo.brand.create',
        title: '新增品牌',
        type: 'BUTTON',
        side: 'ADMIN',
        permission: 'geo-brand:write',
        featureKey: 'geo.monitor',
        sort: 20,
      },
      {
        key: 'geo.prompt',
        title: 'Prompt 管理',
        path: '/geo/prompts',
        componentKey: 'GeoPromptList',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'geo-prompt:list',
        featureKey: 'geo.monitor',
        sort: 30,
      },
      {
        key: 'geo.prompt.create',
        title: '新增问法',
        type: 'BUTTON',
        side: 'ADMIN',
        permission: 'geo-prompt:write',
        featureKey: 'geo.monitor',
        sort: 40,
      },
      {
        // 按钮级菜单项：前端据它决定「AI 生成」按钮画不画。
        // 与「新增问法」分开，因为它们是两个权限点——见 `geo-prompt.permissions.ts`。
        key: 'geo.prompt.generate',
        title: 'AI 生成问法',
        type: 'BUTTON',
        side: 'ADMIN',
        permission: 'geo-prompt:generate',
        featureKey: 'geo.monitor',
        sort: 45,
      },
      {
        key: 'geo.run',
        title: '监测任务',
        path: '/geo/runs',
        componentKey: 'GeoRunList',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'geo-run:list',
        featureKey: 'geo.monitor',
        sort: 50,
      },
      {
        // 「立即刷新」是这个模块里唯一一个按一下就花钱的动作，所以它有自己的权限点，
        // 前端据这条决定按钮画不画。
        key: 'geo.run.trigger',
        title: '立即刷新',
        type: 'BUTTON',
        side: 'ADMIN',
        permission: 'geo-run:trigger',
        featureKey: 'geo.monitor',
        sort: 60,
      },
      {
        // 回答明细**不挂 `featureKey`**：它是纯只读页，而 `geo.monitor` 是
        // `writeOnly: true` 的降级闸门——套餐到期之后商家仍然该看得到历史回答
        // （不然他会以为半年的数据丢了）。挂上去的话这一页会在菜单里整个消失，
        // 那与闸门本身的语义相反。
        key: 'geo.result',
        title: '回答明细',
        path: '/geo/results',
        componentKey: 'GeoResultList',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'geo-result:view',
        sort: 70,
      },
      {
        // 与回答明细同判据：纯只读，不进 `geo.monitor`（`geo-citation.controller.ts` 文件头）。
        key: 'geo.citation',
        title: '引用来源',
        path: '/geo/citations',
        componentKey: 'GeoCitationList',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'geo-citation:view',
        sort: 75,
      },
      {
        // 规则列表本身不挂 `featureKey`：到期后已有规则与历史事件仍要看得见，
        // 只有「新增规则」这个写操作才进 `geo.monitor`（`geo-alert.controller.ts` 文件头）。
        key: 'geo.alert',
        title: '告警',
        path: '/geo/alerts',
        componentKey: 'GeoAlertRuleList',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'geo-alert:list',
        sort: 80,
      },
      {
        key: 'geo.alert.write',
        title: '新增告警规则',
        type: 'BUTTON',
        side: 'ADMIN',
        permission: 'geo-alert:write',
        featureKey: 'geo.monitor',
        sort: 85,
      },
      {
        // 与回答明细同判据：到期后仍该看得到已出报告；生成本身不花钱、不产生新的
        // 监测数据，`geo-report:generate` 也不进 `geo.monitor`（`geo-report.controller.ts` 文件头）。
        key: 'geo.report',
        title: '报表',
        path: '/geo/reports',
        componentKey: 'GeoReportList',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'geo-report:view',
        sort: 90,
      },
      {
        key: 'geo.report.generate',
        title: '生成报表',
        type: 'BUTTON',
        side: 'ADMIN',
        permission: 'geo-report:generate',
        sort: 95,
      },
    ],
  },
]

/**
 * GEO 在**平台超管后台**（`side: 'PLATFORM'`）的菜单。
 *
 * ## 为什么是一个平铺的 `MENU` 而不是一个目录
 *
 * 平台侧的菜单树目前全是平铺的一级项（管理员 / 租户 / 套餐 / 订单 / …，
 * 见 `modules/platform/platform.menus.ts`）。GEO 在 P0 之后平台侧一共三页
 * （引擎、用量、跑批监控，技术设计 §6.2），T5 先落引擎这一页。等三页齐了再
 * 决定要不要收成一个 `GEO` 目录——**为一个菜单项先建一个目录**会让侧边栏多一层
 * 点击，而那一层此刻什么也没多装。
 *
 * ## 为什么没有 `permission`
 *
 * 与 `registry/menus.ts` 里那条「死信队列」同一个判据：T1-7 那批平台控制器上
 * 一个 `@RequirePermission` 都没挂（理由见 `platform.permissions.ts`——平台侧的
 * 角色体系还没定下来）。菜单挂一个接口上并不存在的权限点，只会让
 * `pruneMenus` 把它永远裁掉，表现是「这一页凭空消失了」。
 *
 * 商家侧那条只读接口的权限点 `geo-engine:list` **不在这里**——它属于
 * `side: 'ADMIN'`，而且它没有页面（是品牌表单里的一个下拉框）。
 *
 * ## `sort: 90`
 *
 * 排在死信队列（80）之后：平台侧的排序是「先看钱和人（5–70），再看基础设施
 * （80 死信、90 GEO 引擎）」。引擎配置是接入期改一次、之后几个月不动的东西。
 */
export const GEO_PLATFORM_MENUS: readonly MenuDef[] = [
  {
    key: 'platform-geo-engine',
    title: 'GEO 引擎',
    icon: 'ApiOutlined',
    type: 'MENU',
    side: 'PLATFORM',
    path: '/geo/engines',
    componentKey: 'PlatformGeoEngineList',
    sort: 90,
  },
  {
    // T8：技术设计 §6.2 三页齐了。没有 `permission`——与引擎那条同判据，
    // 这批平台控制器一个 `@RequirePermission` 都没挂（理由见 `geo-usage.permissions.ts`）。
    key: 'platform-geo-usage',
    title: 'GEO 用量',
    icon: 'BarChartOutlined',
    type: 'MENU',
    side: 'PLATFORM',
    path: '/geo/usage',
    componentKey: 'PlatformGeoUsage',
    sort: 91,
  },
  {
    key: 'platform-geo-runs',
    title: 'GEO 跑批监控',
    icon: 'ThunderboltOutlined',
    type: 'MENU',
    side: 'PLATFORM',
    path: '/geo/runs',
    componentKey: 'PlatformGeoRunMonitor',
    sort: 92,
  },
]
