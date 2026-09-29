import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 平台超管后台（T3-4）。dev 端口固定 5175（`apps/admin` 用 5174 附近的另一个端口，
 * 两个后台不该抢端口）；`/api` 代理到 `apps/api` 的 3000，接口路径里已经带了完整的
 * `/api/platform/...` 前缀，这里的 baseURL 留空即可（见 `src/session.ts`）。
 */
export default defineConfig(({ command }) => ({
  // 生产挂载在 https://www.example.com/platform 子路径下；本地 dev 仍走根路径，
  // 不然 `pnpm dev` 打开 http://localhost:5175 会变成要求先手动加 /platform/。
  base: command === 'build' ? '/platform/' : '/',
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5175,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}))
