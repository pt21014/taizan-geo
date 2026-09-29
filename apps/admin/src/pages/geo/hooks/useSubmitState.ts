import { useCallback, useState } from 'react'

/** {@link useSubmitState} 的返回值。 */
export interface SubmitState {
  submitting: boolean
  /**
   * 跑一次提交：期间 `submitting` 为 `true`，无论成功失败都会复位。
   *
   * 异常**原样抛出**（不吞）：错误提示由 `session.request` 的错误码分流统一负责
   * （1440301 去续费、1540301 配额超限…），在这里再 catch 一次只会多出一套文案。
   */
  run: (task: () => Promise<void>) => Promise<void>
}

/**
 * 「提交中」这一个布尔位。
 *
 * 手写抽屉（导入、Prompt 集管理）用不上 `useCrudForm`——它们不是「新建/编辑一条
 * 记录」——但都需要防重复点击。把这行 `useState` 收进一个 hook，页面文件里就没有
 * 裸的 `useState`（admin-ui 纪律，蓝图 §5.2），理由与 `useDrawerState` 相同：
 * 禁的是「数据获取与业务状态散进视图」，而"按钮转不转圈"没有第二个真源可漂。
 */
export function useSubmitState(): SubmitState {
  const [submitting, setSubmitting] = useState(false)

  const run = useCallback(async (task: () => Promise<void>) => {
    setSubmitting(true)
    try {
      await task()
    } finally {
      setSubmitting(false)
    }
  }, [])

  return { submitting, run }
}
