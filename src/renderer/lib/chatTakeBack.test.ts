import { describe, expect, it, vi } from 'vitest'
import type { AgentChatItem } from '../types'
import { chatLinesToTakeBack, draftWithTakenBack, takeBackQueued } from './chatTakeBack'

const wait = () => Promise.resolve()

describe('which chat lines are eligible for recovery', () => {
  const accepted: AgentChatItem = { id: 'user:1', kind: 'user', text: '작업을 확인해 줘', time: 10, sentAt: 9 }
  const partial: AgentChatItem = { id: 'partial', kind: 'assistant', text: '확인하고 있습니다', time: 11 }
  const queued = { id: 'outgoing:1', text: '이어지는 질문', time: 12, hasImage: false, queued: true }
  const queuedItem: AgentChatItem = { id: queued.id, kind: 'user', text: queued.text, time: queued.time }

  it('finds the active question after the transcript replaced its echo and an answer started', () => {
    expect(chatLinesToTakeBack([accepted, partial], [], [])).toEqual({ queued: false, lines: [
      { id: accepted.id, text: accepted.text, sentAt: accepted.sentAt, optimistic: false }
    ] })
  })

  it('uses only waiting chat lines when there is a queue', () => {
    expect(chatLinesToTakeBack([accepted, partial, queuedItem], [queued], [])).toEqual({ queued: true, lines: [
      { id: queued.id, text: queued.text, sentAt: queued.time, optimistic: true }
    ] })
  })

  it('recognizes a queued Codex question already recorded by the CLI', () => {
    const recorded = { ...queuedItem, id: 'UserMessage:2', sentAt: queued.time }
    expect(chatLinesToTakeBack([accepted, partial, recorded], [], [recorded.id])).toEqual({ queued: true, lines: [
      { id: recorded.id, text: queued.text, sentAt: queued.time, optimistic: false }
    ] })
  })

  it('does not copy an old interrupted turn, a terminal message, a command or an attachment', () => {
    const ended: AgentChatItem = { id: 'notice:1', kind: 'notice', interrupted: true, time: 13 }
    for (const latest of [ended, { ...accepted, sentAt: undefined }, { ...accepted, text: '/compact' }, { ...accepted, hasImage: true }]) {
      expect(chatLinesToTakeBack([accepted, partial, latest], [], []).lines).toEqual([])
    }
  })
})

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
