import { useCallback, useState } from 'react'

/**
 * 「一个抽屉的开关 + 它打开时携带的那点上下文」。
 *
 * ## 为什么把 `useState` 收进这个文件
 *
 * admin-ui 的纪律是「页面里不出现 `useState` / `useEffect`」（蓝图 §5.2）。
 * 那条纪律针对的是**数据获取与业务状态**——它们一旦散进页面，就会出现两份真源
 * （列表里一份、抽屉里一份），而两份真源之间的不同步是后台最常见的一类 bug。
 *
 * 但「抽屉开着还是关着」不是业务状态，它是纯粹的视图状态，没有第二个真源可漂。
 * 把它写在页面里的问题只有一个：那行 `useState` 会让后来的人以为「这里可以放
 * useState」，于是下一个人把列表数据也放了进去。所以做法是**封装而不是消灭**——
 * 有一个带名字的 hook，页面里就没有裸的 `useState`，而这段逻辑还能被复用。
 *
 * @typeParam T - 打开抽屉时携带的上下文类型（如「正在编辑哪个品牌」）
 */
export interface DrawerState<T> {
  open: boolean
  /** 打开时携带的上下文；关着时为 `null` */
  context: T | null
  openWith: (context: T) => void
  close: () => void
}

/**
 * 造一个抽屉开关。
 *
 * `close()` **不清空 `context`**：antd 的 `<Drawer>` 有关闭动画，清空之后动画期间
 * 内容会先变成空白再滑走，看起来像闪了一下。需要真的清空时用 `destroyOnClose`
 * 让 antd 自己在动画结束后卸载子树。
 */
export function useDrawerState<T>(): DrawerState<T> {
  const [context, setContext] = useState<T | null>(null)
  const [open, setOpen] = useState(false)

  const openWith = useCallback((next: T) => {
    setContext(next)
    setOpen(true)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
  }, [])

  return { open, context, openWith, close }
}
