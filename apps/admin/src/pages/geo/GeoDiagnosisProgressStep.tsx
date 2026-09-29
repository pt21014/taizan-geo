import { Alert, Button, Card, Progress, Steps, Typography } from 'antd'
import type { GeoDiagnosisTriggerResult } from '../../api/geo-diagnosis'
import type { GeoRun } from '../../api/geo-run'
import { useGeoDiagnosisProgress } from './hooks/useGeoDiagnosisRunPoll'

/** {@link GeoDiagnosisProgressStep} 的入参。 */
export interface GeoDiagnosisProgressStepProps {
  brandName: string
  trigger: GeoDiagnosisTriggerResult
  onReportReady: (reportId: string) => void
}

/**
 * 三个阶段的当前下标：0=生成问法（进这一屏之前已经做完，恒为已完成起点）、
 * 1=多引擎查询中、2=生成诊断报告中。
 *
 * 只用现有的 `GeoRun.status`/`diagnosisReportId` 判断，**不编造后端没有的中间状态**——
 * 设计稿 `screen-progress.jsx` 画了「①确认问法 ②查询中 ③解析提及与引用中 ④生成报告」
 * 四个阶段，但后端没有区分"解析中"与"生成报告中"（两者都发生在
 * `GeoDailyAggregateHandler` 收口之后的同一跳队列任务里），这里合并成一个阶段。
 */
function stageIndexOf(run: GeoRun | null): 1 | 2 {
  if (run === null) return 1
  const finished = run.doneQueries + run.failedQueries
  const querying = run.totalQueries === 0 || finished < run.totalQueries
  if (querying && run.status !== 'DONE' && run.status !== 'PARTIAL' && run.status !== 'FAILED') return 1
  return 2
}

/**
 * 「AI可见度诊断」向导 · 屏 3：诊断进行中——轮询跑批状态，分阶段展示进度。
 *
 * 对齐设计稿 `screen-progress.jsx` 的"非黑箱等待"意图（分阶段 + 实时查询计数），
 * 但阶段数量与文案按真实可拿到的信号收窄了（见 {@link stageIndexOf}），
 * 也没有编造设计稿里那个"预计还需 6-10 分钟"的估时——那是抓不到的数字，
 * 编一个不如不说。
 */
export default function GeoDiagnosisProgressStep({
  brandName,
  trigger,
  onReportReady,
}: GeoDiagnosisProgressStepProps) {
  // 报表就绪（`diagnosisReportId` 非空）时，`useGeoDiagnosisProgress` 会在 effect 里调
  // `onReportReady` 切到报告屏——这一屏此后还会渲染最后一次（`onReportReady` 是
  // 异步生效的 setState），但下一次渲染上一层就已经换成 `GeoDiagnosisReportStep`了。
  const poll = useGeoDiagnosisProgress(trigger.runId, onReportReady)

  const stageIdx = stageIndexOf(poll.run)
  const total = poll.run?.totalQueries ?? trigger.plannedQueries
  const done = (poll.run?.doneQueries ?? 0) + (poll.run?.failedQueries ?? 0)

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <Typography.Title level={3}>诊断进行中</Typography.Title>
      <Typography.Paragraph type="secondary">
        「{brandName}」的诊断已在后台运行，可以离开这个页面，完成后回来刷新即可看到报告。
      </Typography.Paragraph>

      <Card style={{ marginBottom: 16 }}>
        <Typography.Text>
          {trigger.reusedExistingPrompts
            ? '本次复用了这个品牌已有的问法，'
            : `已自动生成并导入 ${trigger.promptsGenerated} 条测试问法，`}
          规划 {trigger.plannedQueries} 次查询。
        </Typography.Text>
      </Card>

      <Card>
        <Steps
          direction="vertical"
          size="small"
          current={stageIdx}
          items={[
            { title: '生成测试问法', description: '已完成', status: 'finish' },
            {
              title: '多引擎查询中',
              description:
                stageIdx === 1 ? (
                  <>
                    正在向 AI 引擎逐一提问，已完成 {done}/{total}
                    <Progress
                      percent={total === 0 ? 0 : Math.round((done / total) * 100)}
                      size="small"
                      status={poll.run?.status === 'FAILED' ? 'exception' : undefined}
                      style={{ maxWidth: 300, marginTop: 4 }}
                    />
                  </>
                ) : (
                  '已完成'
                ),
            },
            {
              title: '生成诊断报告',
              description:
                stageIdx === 2
                  ? '正在汇总回答、生成结论摘要与内容优化建议…'
                  : '等多引擎查询完成后开始',
            },
          ]}
        />

        {poll.run?.status === 'FAILED' && stageIdx === 2 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 16 }}
            message="这次查询全部失败了，报告仍会生成，但可能提示暂无数据"
            description="常见原因是引擎密钥失效或网络不通，可以去「监测任务」看失败详情。"
          />
        )}

        {poll.timedOut && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 16 }}
            message="等了比较久还没出结果"
            description="可以再等一会儿手动重试，或者去「监测任务」看这次跑批的详细状态。"
            action={
              <Button size="small" onClick={poll.retry}>
                重新检查
              </Button>
            }
          />
        )}
      </Card>
    </div>
  )
}
