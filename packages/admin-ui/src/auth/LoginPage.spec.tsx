import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { withSession } from '../test/fixtures'
import { LoginPage } from './LoginPage'

/**
 * T3-4：`identifierField` 让平台超管后台（用户名登录）能直接复用这个组件，
 * 不必再像 `apps/platform` 历史版本那样本地重写一份「形状兼容」的登录页
 * （见 `apps/platform/README.md`「admin-ui 需要扩展的点」①）。
 */
describe('<LoginPage>', () => {
  it('默认（identifierField 缺省）：渲染手机号字段，login() 收到 phone 参数', async () => {
    const login = vi.fn().mockResolvedValue(null)
    const user = userEvent.setup()

    render(withSession(<LoginPage />, { login }))

    expect(screen.getByLabelText('手机号')).toBeInTheDocument()
    expect(screen.queryByLabelText('用户名')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('手机号'), '13900000001')
    await user.type(screen.getByLabelText('密码'), 'pwd123')
    await user.click(screen.getByRole('button', { name: /登\s*录/ }))

    // 后两个参数是 tenantId/captcha：这次没配 `showCaptcha`，`config.captchaId` 缺省，
    // `onFinish` 因此把 captcha 传成 undefined——同「必须给验证码」的后端约定并不矛盾，
    // 那道闸门在服务端，这里只断言 `LoginPage` 把值原样透传给了 `login()`。
    expect(login).toHaveBeenCalledWith('13900000001', 'pwd123', undefined, undefined)
  })

  it("identifierField: 'username'：渲染用户名字段（无手机号正则），login() 收到 username 参数", async () => {
    const login = vi.fn().mockResolvedValue(null)
    const user = userEvent.setup()

    render(withSession(<LoginPage config={{ identifierField: 'username' }} />, { login }))

    expect(screen.getByLabelText('用户名')).toBeInTheDocument()
    expect(screen.queryByLabelText('手机号')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('用户名'), 'admin')
    await user.type(screen.getByLabelText('密码'), 'admin123')
    await user.click(screen.getByRole('button', { name: /登\s*录/ }))

    expect(login).toHaveBeenCalledWith('admin', 'admin123', undefined, undefined)
  })

  it('showCaptcha 打开时：填完验证码提交，login() 收到 {id, code}，失败后自动换一张图', async () => {
    const login = vi.fn().mockRejectedValue(new Error('验证码不对'))
    const onRefreshCaptcha = vi.fn()
    const user = userEvent.setup()

    render(
      withSession(
        <LoginPage
          config={{
            showCaptcha: true,
            captchaId: 'cap-1',
            captchaImageUrl: 'data:image/svg+xml;base64,AAAA',
            onRefreshCaptcha,
          }}
        />,
        { login },
      ),
    )

    await user.type(screen.getByLabelText('手机号'), '13900000001')
    await user.type(screen.getByLabelText('密码'), 'pwd123')
    await user.type(screen.getByPlaceholderText('请输入验证码'), '1234')
    await user.click(screen.getByRole('button', { name: /登\s*录/ }))

    expect(login).toHaveBeenCalledWith('13900000001', 'pwd123', undefined, {
      id: 'cap-1',
      code: '1234',
    })
    // 一次性核销：无论成败，用过的那张图都已经作废，都该换一张——这里断言失败路径。
    expect(onRefreshCaptcha).toHaveBeenCalled()
  })

  it('passwordLabel 可覆盖口令输入框的 label（平台超管后台历史上一直叫「口令」）', () => {
    render(withSession(<LoginPage config={{ passwordLabel: '口令' }} />))

    expect(screen.getByLabelText('口令')).toBeInTheDocument()
    expect(screen.queryByLabelText('密码')).not.toBeInTheDocument()
  })
})
