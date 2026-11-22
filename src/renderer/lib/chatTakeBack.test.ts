import { describe, expect, it, vi } from 'vitest'
import { draftWithTakenBack, takeBackQueued } from './chatTakeBack'

const wait = () => Promise.resolve()

describe('taking queued chat lines back after Esc', () => {
  it('asks again until the CLI has put the lines back in its composer', async () => {
    const take = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'empty' })
      .mockResolvedValueOnce({ ok: false, reason: 'different' })
      .mockResolvedValueOnce({ ok: true })
    await expect(takeBackQueued(take, ['질문'], { wait })).resolves.toBe(true)
    expect(take).toHaveBeenCalledTimes(3)
    expect(take).toHaveBeenCalledWith(['질문'])
  })

  it('stops at an answer that will not change', async () => {
    const take = vi.fn().mockResolvedValue({ ok: false, reason: 'not-cleared' })
    await expect(takeBackQueued(take, ['질문'], { wait })).resolves.toBe(false)
    expect(take).toHaveBeenCalledTimes(1)
  })

  it('gives up after its tries (the agent had already read the line)', async () => {
    const take = vi.fn().mockResolvedValue({ ok: false, reason: 'empty' })
    await expect(takeBackQueued(take, ['질문'], { wait, tries: 4 })).resolves.toBe(false)
    expect(take).toHaveBeenCalledTimes(4)
  })

  it('does nothing without lines or when the call fails', async () => {
    const take = vi.fn().mockRejectedValue(new Error('no handler'))
    await expect(takeBackQueued(take, [], { wait })).resolves.toBe(false)
    expect(take).not.toHaveBeenCalled()
    await expect(takeBackQueued(take, ['질문'], { wait })).resolves.toBe(false)
  })

  it('puts the lines before what is being typed', () => {
    expect(draftWithTakenBack(['첫 질문', '둘째 질문'], '쓰던 글')).toBe('첫 질문\n둘째 질문\n쓰던 글')
    expect(draftWithTakenBack(['첫 질문'], '  ')).toBe('첫 질문')
  })
})
