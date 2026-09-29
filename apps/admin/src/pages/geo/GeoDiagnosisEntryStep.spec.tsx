import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as brandApiModule from '../../api/geo-brand'
import * as diagnosisApiModule from '../../api/geo-diagnosis'
import GeoDiagnosisEntryStep from './GeoDiagnosisEntryStep'

vi.mock('../../api/geo-brand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/geo-brand')>()
  return { ...actual, useGeoBrandApi: vi.fn(), useGeoEngineOptionApi: vi.fn() }
})
vi.mock('../../api/geo-diagnosis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/geo-diagnosis')>()
  return { ...actual, useGeoDiagnosisApi: vi.fn() }
})

const createBrand = vi.fn()
const triggerDiagnosis = vi.fn()
const listEngines = vi.fn()

describe('GeoDiagnosisEntryStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(brandApiModule.useGeoBrandApi).mockReturnValue({
      create: createBrand,
    } as unknown as ReturnType<typeof brandApiModule.useGeoBrandApi>)
    vi.mocked(brandApiModule.useGeoEngineOptionApi).mockReturnValue({ list: listEngines })
    vi.mocked(diagnosisApiModule.useGeoDiagnosisApi).mockReturnValue({
      trigger: triggerDiagnosis,
    } as unknown as ReturnType<typeof diagnosisApiModule.useGeoDiagnosisApi>)
    listEngines.mockResolvedValue([
      { code: 'mock', name: 'Mock（联调用）', vendor: 'taizan', accessType: 'API' },
    ])
  })

  it('引擎清单拉到后自动全选；填完品牌名提交会先建品牌再触发诊断，成功后回调 onTriggered', async () => {
    createBrand.mockResolvedValue({ id: 'brand-1', name: '太赞' })
    triggerDiagnosis.mockResolvedValue({
      runId: 'run-1',
      brandId: 'brand-1',
      promptsGenerated: 5,
      plannedQueries: 5,
      reusedExistingPrompts: false,
    })
    const onTriggered = vi.fn()

    render(<GeoDiagnosisEntryStep onTriggered={onTriggered} />)

    fireEvent.change(screen.getByLabelText('品牌名'), { target: { value: '太赞' } })
    // 引擎清单是异步拉的，等它落地并自动全选之后再提交，否则会撞上「至少选一个引擎」的校验。
    await waitFor(() => expect(listEngines).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: /开始诊断/ }))

    await waitFor(() => expect(onTriggered).toHaveBeenCalled())
    expect(onTriggered).toHaveBeenCalledWith(
      '太赞',
      expect.objectContaining({ runId: 'run-1', plannedQueries: 5 }),
    )
    expect(createBrand).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '太赞',
        engineCodes: ['mock'],
        sampleSize: 1,
        status: 'ACTIVE',
        refreshFreq: 'WEEKLY',
      }),
    )
    expect(triggerDiagnosis).toHaveBeenCalledWith('brand-1', { promptCount: 10 })
  })

  it('没填品牌名时点「开始诊断」不提交（前端校验拦住）', async () => {
    render(<GeoDiagnosisEntryStep onTriggered={vi.fn()} />)
    await waitFor(() => expect(listEngines).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: /开始诊断/ }))

    expect(await screen.findByText('请填品牌名')).toBeInTheDocument()
    expect(createBrand).not.toHaveBeenCalled()
    expect(triggerDiagnosis).not.toHaveBeenCalled()
  })

  it('平台没有启用任何引擎时给出提示', async () => {
    listEngines.mockResolvedValue([])
    render(<GeoDiagnosisEntryStep onTriggered={vi.fn()} />)

    expect(
      await screen.findByText('平台还没有启用任何引擎，暂时没法发起诊断，请联系平台管理员'),
    ).toBeInTheDocument()
  })
})
