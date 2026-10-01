import { describe, it, expect, beforeEach } from 'vitest'
import { confirmDialog, useConfirmStore } from './confirmStore'

const answer = (value: boolean) => useConfirmStore.getState().answer(value)

describe('confirmDialog', () => {
  beforeEach(() => useConfirmStore.setState({ request: null }))

  it('shows the request and resolves with the answer', async () => {
    const pending = confirmDialog({ title: '세션 이동', message: '옮길까요?', confirmLabel: '이동' })

    expect(useConfirmStore.getState().request?.title).toBe('세션 이동')
    answer(true)

    await expect(pending).resolves.toBe(true)
    expect(useConfirmStore.getState().request).toBeNull()
  })

  it('resolves false when cancelled', async () => {
    const pending = confirmDialog({ title: '삭제', message: '지울까요?', confirmLabel: '삭제', danger: true })
    answer(false)

    await expect(pending).resolves.toBe(false)
  })

  it('cancels a question still open when a new one is asked', async () => {
    const first = confirmDialog({ title: 'A', message: 'a', confirmLabel: '확인' })
    const second = confirmDialog({ title: 'B', message: 'b', confirmLabel: '확인' })

    await expect(first).resolves.toBe(false)
    expect(useConfirmStore.getState().request?.title).toBe('B')
    answer(true)
    await expect(second).resolves.toBe(true)
  })

  it('ignores an answer when nothing is asked', () => {
    expect(() => answer(true)).not.toThrow()
  })
})
