import { useState } from 'react'
import { GEO_DASHBOARD_DAYS, type GeoDashboardDays } from '../../../api/geo-dashboard'

/**
 * 「近 7/30/90 天」周期选择器的状态。看板页自己的档位状态收在 `useGeoDashboard`
 * 里（换档位要联动四条请求），这个更轻的版本给只需要一个档位、自己另外拉数据
 * 的页面用（引用来源、告警——它们的数据获取归各自的 hook，不需要再重复一份）。
 */
export function useDaysOption(initial: GeoDashboardDays = GEO_DASHBOARD_DAYS[0]) {
  const [days, setDays] = useState<GeoDashboardDays>(initial)
  return { days, setDays }
}
