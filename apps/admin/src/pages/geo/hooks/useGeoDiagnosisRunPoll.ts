import { useCallback, useEffect, useRef, useState } from 'react'
import { useGeoRunApi, type GeoRun } from '../../../api/geo-run'

/** 轮询间隔：跟 `geo-diagnosis.e2e-spec.ts` 里 `sleep(400)` 不是同一个量级——
 * 那是测试要的"尽快出结果"，这里是真实浏览器场景，没必要每 400ms 打一次接口。 */
const POLL_INTERVAL_MS = 3000

/** 轮询上限：3 秒 × 100 次 = 5 分钟。诊断编排是"新用户第一印象"，5 分钟还没出
 * 报表基本可以确定是队列侧卡住了，继续无限轮询只会让人以为页面卡死。 */
const MAX_ATTEMPTS = 100

/** {@link useGeoDiagnosisRunPoll} 的返回值。 */
export interface GeoDiagnosisRunPollState {
  /** 最近一次拉到的跑批；第一次请求还没回来时为 `null`。 */
  run: GeoRun | null
  /** 只在"一条都还没拉到"时为 `true`；轮询期间的后续请求不会把它拉回 `true`
   * ——那会让进度条在每一次轮询之间闪烁一次 loading。 */
  loading: boolean
  /** 超过 {@link MAX_ATTEMPTS} 次仍未拿到 `diagnosisReportId` 且不重试。 */
  timedOut: boolean
  /** `timedOut` 之后手动重新开始轮询（`attempts` 计数器归零）。 */
  retry: () => void
}

/**
 * 「诊断进行中」屏的轮询：反复读 `GET /runs/:id`，直到 `diagnosisReportId` 非空
 * （诊断报表已经生成，见 `geo-diagnosis.service.ts` 的 `finalizeReport`），
 * 或者到达轮询上限。
 *
 * ## 为什么不是 `setInterval`
 *
 * `setInterval` 会在"上一次请求还没回来"时又发一次，网络一卡顿就是一串并发请求
 * 后到先到地互相覆盖。这里用 `setTimeout` 递归：**上一次响应回来之后**才排下一次，
 * 天然不会有并发轮询——之所以要自己写而不是抄现成的 hook，是因为这个仓库里
 * （`apps/admin`/`apps/platform`/`packages/admin-ui`）目前没有任何页面轮询过异步任务，
 * 这是第一处，没有现成模式可复用。
 *
 * ## 为什么"到终态"不是停止轮询的条件
 *
 * 跑批到 `DONE`/`PARTIAL`/`FAILED` 之后，日聚合与诊断报表生成是**队列侧另一跳**
 * （见 `geo-diagnosis.e2e-spec.ts` 用例③④的分工：先等跑批终态，再继续等
 * `diagnosisReportId`），停在跑批终态会让页面在"报表其实还没生成好"的时候
 * 就以为诊断完成了。真正的完成信号只有 `diagnosisReportId` 非空这一个。
 */
export function useGeoDiagnosisRunPoll(runId: string | null): GeoDiagnosisRunPollState {
  const api = useGeoRunApi()
  const [run, setRun] = useState<GeoRun | null>(null)
  const [loading, setLoading] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [restartToken, setRestartToken] = useState(0)

  const apiRef = useRef(api)
  apiRef.current = api

  useEffect(() => {
    if (runId === null) return

    let alive = true
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    setRun(null)
    setLoading(true)
    setTimedOut(false)

    const scheduleNext = () => {
      attempts += 1
      if (attempts >= MAX_ATTEMPTS) {
        setTimedOut(true)
        return
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }

    const tick = () => {
      apiRef.current
        .get(runId)
        .then((detail) => {
          if (!alive) return
          setRun(detail)
          setLoading(false)
          if (detail.diagnosisReportId !== null) return
          scheduleNext()
        })
        .catch(() => {
          if (!alive) return
          setLoading(false)
          scheduleNext()
        })
    }

    tick()

    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [runId, restartToken])

  const retry = useCallback(() => setRestartToken((t) => t + 1), [])

  return { run, loading, timedOut, retry }
}

/**
 * {@link useGeoDiagnosisRunPoll} 之上包一层："报表就绪就调用 `onReportReady`"。
 *
 * 单独拆出来是为了让"报表就绪该做什么"这件事**不需要在组件的 render 阶段里做**——
 * `GeoDiagnosisProgressStep.tsx` 只管展示轮询结果，切屏这个副作用放在 `useEffect` 里
 * （直接在渲染函数体里调用父组件传下来的 setState 会触发 React 的
 * "Cannot update a component while rendering a different component" 警告）。
 */
export function useGeoDiagnosisProgress(
  runId: string | null,
  onReportReady: (reportId: string) => void,
): GeoDiagnosisRunPollState {
  const poll = useGeoDiagnosisRunPoll(runId)
  const callbackRef = useRef(onReportReady)
  callbackRef.current = onReportReady

  const reportId = poll.run?.diagnosisReportId ?? null
  useEffect(() => {
    if (reportId !== null) callbackRef.current(reportId)
  }, [reportId])

  return poll
}
