import { defineConfig } from 'vitest/config'

// 「AI可见度诊断」向导（`src/pages/geo/GeoDiagnosis*`）起，这里第一次出现要渲染 DOM
// 的页面级测试，换成 jsdom（`component-map.spec.ts` 那种纯数据对账不需要 DOM，
// 但 jsdom 环境跑纯逻辑测试没有额外代价，不用为它单独拆一份 node 环境的配置）。
// 与 `apps/site/vitest.config.ts` 同一套 setupFiles 约定。
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // CI runner 冷启动时 AntD + jsdom 的首次渲染较慢，不是用例逻辑问题，统一在
    // 配置层放宽超时（与 `packages/admin-ui/vitest.config.ts` 同一条注释）。
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
