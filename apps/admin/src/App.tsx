import { useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useRoutes, type RouteObject } from 'react-router-dom'
import { AppShell, LoginPage, RequireAuth, buildRoutes, readReturnTo } from '@taizan/admin-ui'
import { captchaSvgToDataUrl, fetchCaptcha } from './api/captcha'
import NotFoundPage from './pages/NotFoundPage'
import InviteAcceptPage from './pages/invite/InviteAcceptPage'
import { componentMap } from './routes/component-map'
import { useSession } from './session'

export default function App() {
  const token = useSession((s) => s.token)
  const status = useSession((s) => s.status)
  const menus = useSession((s) => s.menus)
  const bootstrap = useSession((s) => s.bootstrap)
  const location = useLocation()

  // 登录页图形验证码：复用官网注册页那套后端能力（见 `api/captcha.ts`）。只在
  // 登录页挂载时才需要一张图，这里没条件挂载（路由树整个是 useRoutes 拼出来的一次性
  // 数组，不方便按当前路由挂/卸 effect），代价是登录页之外的路由也会白拉一张验证码
  // 图——免登录接口、`lookup` 限流档很宽松，换来的是逻辑不用按路由分叉，可接受。
  const [captchaId, setCaptchaId] = useState<string>()
  const [captchaImageUrl, setCaptchaImageUrl] = useState<string>()
  const refreshCaptcha = () => {
    fetchCaptcha()
      .then((c) => {
        setCaptchaId(c.id)
        setCaptchaImageUrl(captchaSvgToDataUrl(c.svg))
      })
      .catch(() => {
        setCaptchaId(undefined)
        setCaptchaImageUrl(undefined)
      })
  }
  useEffect(() => {
    refreshCaptcha()
  }, [])

  // 刷新页面后 token 还在（store 初值就是从 localStorage 读的），但其余字段是空的：补一次 bootstrap。
  useEffect(() => {
    if (token && status === 'idle') void bootstrap()
  }, [token, status, bootstrap])

  // 服务端下发的菜单树（`apps/api/src/registry/menus.ts` 的 `ADMIN_MENUS`，T1-9 已经
  // 补齐了工作台/员工/角色/账单/审计/公告/个人设置这七个框架菜单）→ 路由。
  // 不传 notFound，兜底路由统一由下面拼出的完整数组末尾追加一次。
  const menuRoutes = useMemo(() => buildRoutes(menus, componentMap), [menus])

  const routes = useMemo<RouteObject[]>(
    () => [...menuRoutes, { path: '*', element: <NotFoundPage /> }],
    [menuRoutes],
  )

  return useRoutes([
    {
      path: '/login',
      element: (
        <LoginPage
          config={{
            title: '商家后台登录',
            homePath: readReturnTo(location.search) ?? '/',
            showCaptcha: true,
            captchaId,
            captchaImageUrl,
            onRefreshCaptcha: refreshCaptcha,
          }}
        />
      ),
    },
    // 员工邀请落地页：免登录，被邀请人此刻可能连账号都没有，不能挂在 <RequireAuth> 下面。
    { path: '/invites/:token', element: <InviteAcceptPage /> },
    {
      element: (
        <RequireAuth>
          <AppShell billingPath="/billing">
            <Outlet />
          </AppShell>
        </RequireAuth>
      ),
      children: routes,
    },
  ])
}
