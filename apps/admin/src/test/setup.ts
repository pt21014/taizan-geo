import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// vitest.config.ts 没开 `test.globals`，@testing-library/react 的自动清理依赖全局 `afterEach`
// 探测不到就不会生效——不手动接一遍的话，上一个用例渲染的 DOM 会串到下一个用例里。
// 与 `apps/site/src/test/setup.ts` 同一条注释。
afterEach(cleanup)

// jsdom 不实现 `window.matchMedia`，antd 的一些组件（如 `Grid`/响应式 hooks）会调用它——
// 不 polyfill 的话渲染时直接抛错，不是用例逻辑问题。
if (typeof window !== 'undefined' && window.matchMedia === undefined) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// jsdom 不实现 `window.scrollTo`，与 `apps/site/src/test/setup.ts` 同一条注释。
if (typeof window !== 'undefined') {
  window.scrollTo = (() => undefined) as typeof window.scrollTo
}
