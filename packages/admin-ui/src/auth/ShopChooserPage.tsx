import { useState } from 'react'
import { Alert, Button, Card, Empty, Input, Space, Tag, Typography } from 'antd'
import { CheckCircleFilled, CrownOutlined, SafetyOutlined, ShopOutlined } from '@ant-design/icons'
import type { ShopChoice } from '../session'

export interface ShopChooserPageProps {
  shops: ShopChoice[]
  /**
   * 选中一家店后调用，带 `tenantId` 再打一次 `login()`。第二个参数是这一屏重新填的
   * 图形验证码——登录接口每一次带密码的调用都强制要求验证码（见
   * `AdminAuthService.login()` 的 TSDoc），选店提交也不例外，第一次登录用掉的那张图
   * 已经一次性核销过了，不能复用。
   */
  onChoose: (shop: ShopChoice, captchaCode: string) => void | Promise<void>
  /** 返回登录页（换个账号） */
  onBack: () => void
  /** 正在进入哪一家（禁用其余卡片、显示 loading） */
  enteringTenantId?: string | null
  /** 这一屏重新换的验证码图（data URI），为空时还没加载出来 */
  captchaImageUrl?: string
  onRefreshCaptcha?: () => void
}

/**
 * 一号多店的选店页（蓝图 §5.2，形状搬自 xiaodian 的 `BrandChooserPage.tsx`，
 * 「多品牌」改成「多店」）。登录接口 `needChooseShop: true` 时展示，
 * 卡片本身不带经营数据——那是「全部店铺」那一屏（T3-2 范畴）的事，这里只解决
 * 「登录时选进哪一家」。
 */
export function ShopChooserPage({
  shops,
  onChoose,
  onBack,
  enteringTenantId,
  captchaImageUrl,
  onRefreshCaptcha,
}: ShopChooserPageProps) {
  const [entering, setEntering] = useState<string | null>(enteringTenantId ?? null)
  const [captchaCode, setCaptchaCode] = useState('')

  const choose = async (shop: ShopChoice) => {
    if (entering || !captchaCode.trim()) return
    setEntering(shop.tenantId)
    try {
      await onChoose(shop, captchaCode)
    } finally {
      setEntering(null)
      setCaptchaCode('')
      onRefreshCaptcha?.()
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f0f2f5', padding: '48px 24px' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 24 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            选择要进入的店铺
          </Typography.Title>
          <a onClick={onBack}>换个账号登录</a>
        </Space>

        {shops.length === 0 ? (
          <Empty description="名下暂无可进入的店铺" />
        ) : (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="进店前请先填一下图形验证码"
              description={
                <Space align="center" style={{ marginTop: 8 }}>
                  <Input
                    prefix={<SafetyOutlined />}
                    placeholder="图形验证码"
                    value={captchaCode}
                    onChange={(e) => setCaptchaCode(e.target.value)}
                    style={{ width: 160 }}
                  />
                  {captchaImageUrl && (
                    <img
                      src={captchaImageUrl}
                      onClick={onRefreshCaptcha}
                      style={{ height: 32, cursor: 'pointer', borderRadius: 6 }}
                      alt="图形验证码"
                    />
                  )}
                  <Button size="small" onClick={onRefreshCaptcha}>
                    换一张
                  </Button>
                </Space>
              }
            />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                gap: 16,
              }}
            >
              {shops.map((shop) => (
                <Card
                  key={shop.tenantId}
                  hoverable={captchaCode.trim().length > 0}
                  loading={entering === shop.tenantId}
                  onClick={() => void choose(shop)}
                  style={{ opacity: captchaCode.trim() ? 1 : 0.6 }}
                >
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Space>
                      <ShopOutlined />
                      <Typography.Text strong>{shop.name}</Typography.Text>
                      {shop.isOwner && (
                        <Tag color="gold" icon={<CrownOutlined />} bordered={false}>
                          店主
                        </Tag>
                      )}
                    </Space>
                    <Typography.Text type="secondary">{shop.slug}</Typography.Text>
                    {entering === shop.tenantId && (
                      <CheckCircleFilled style={{ color: '#52c41a' }} />
                    )}
                  </Space>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
