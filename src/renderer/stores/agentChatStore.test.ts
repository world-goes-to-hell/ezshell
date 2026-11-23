import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isUnconfirmedSend, useAgentChatStore } from './agentChatStore'

const shellId = 'local:1'
const store = useAgentChatStore.getState
const chat = () => store().chats.get(shellId)!
const check = (idle = true) => store().checkSendConfirmations(shellId, idle)
const unconfirmed = () => chat().echoes.filter(echo => isUnconfirmedSend(chat(), echo)).map(echo => echo.id)

function load(transcriptId = 'transcript-1') {
  store().applyFrame({ shellId, reset: true, state: 'live', scope: 'view-scope', transcriptId, items: [] })
}

function send(text: string, queued = false, imageIds: string[] = []) {
  const id = store().echoSend(shellId, text, imageIds.map(() => new Blob(['image'])), queued, imageIds)
  store().acceptSend(shellId, id)
  return id
}

beforeEach(async () => {
  vi.stubGlobal('window', { electronAPI: { agentChatOpen: async () => ({ ok: true }) } })
  vi.useFakeTimers({ now: 100_000 })
  await store().show(shellId)
})

afterEach(() => {
  store().clearAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('chat delivery confirmation', () => {
  it('waits for send acknowledgement, then marks an unmatched idle message after 15 seconds', () => {
    load()
    const id = store().echoSend(shellId, '확인해 줘', [])
    vi.advanceTimersByTime(20_000)
    expect(check()).toBeUndefined()
    expect(unconfirmed()).toEqual([])

    store().acceptSend(shellId, id)
    expect(check()).toBe(135_000)
    vi.advanceTimersByTime(14_999)
    expect(check()).toBe(135_000)
    expect(unconfirmed()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(check()).toBeUndefined()
    expect(unconfirmed()).toEqual([id])
    expect(chat().reply).toBeNull()
  })

  it('waits through the active turn and the transcript grace period after idle', () => {
    load()
    const id = send('다음 질문', true)
    expect(check(false)).toBeUndefined()
    vi.advanceTimersByTime(180_000)
    expect(unconfirmed()).toEqual([])
    expect(check()).toBe(295_000)
    vi.advanceTimersByTime(14_999)
    expect(unconfirmed()).toEqual([])
    vi.advanceTimersByTime(1)
    check()
    expect(unconfirmed()).toEqual([id])
  })

  it('restarts the idle window when a send that looked idle starts a turn', () => {
    load()
    const id = send('첫 질문')
    expect(check()).toBe(115_000)
    vi.advanceTimersByTime(50)
    expect(check(false)).toBeUndefined()
    vi.advanceTimersByTime(20_000)
    expect(check(false)).toBeUndefined()
    expect(unconfirmed()).toEqual([])

    expect(check()).toBe(135_050)
    vi.advanceTimersByTime(14_999)
    check()
    expect(unconfirmed()).toEqual([])
    vi.advanceTimersByTime(1)
    check()
    expect(unconfirmed()).toEqual([id])
  })

  it('waits for a back-to-back send accepted before the working status arrived', () => {
    load()
    const first = send('첫 글')
    const second = send('둘째 글')
    check()
    check(false)
    vi.advanceTimersByTime(20_000)
    store().applyFrame({ shellId, items: [{ id: 'recorded-first', kind: 'user', time: 100_010, text: '첫 글' }] })
    expect(chat().echoes.map(echo => echo.id)).toEqual([second])
    expect(chat().items.find(item => item.id === first)).toBeUndefined()
    expect(unconfirmed()).toEqual([])

    check()
    vi.advanceTimersByTime(14_999)
    store().applyFrame({ shellId, items: [{ id: 'recorded-second', kind: 'user', time: Date.now(), text: '둘째 글' }] })
    vi.advanceTimersByTime(1)
    expect(check()).toBeUndefined()
    expect(unconfirmed()).toEqual([])
  })

  it('starts the clock only once an unknown or starting agent becomes idle', () => {
    load()
    const id = send('시작 중에 보낸 글')
    expect(check(false)).toBeUndefined()
    vi.advanceTimersByTime(20_000)
    expect(check()).toBe(135_000)
    vi.advanceTimersByTime(15_000)
    check()
    expect(unconfirmed()).toEqual([id])
  })

  it('replaces a marked echo with the late, normalized transcript record', () => {
    load()
    const id = send('한 줄 ✅\n둘째 줄')
    check()
    vi.advanceTimersByTime(15_000)
    check()
    expect(unconfirmed()).toEqual([id])

    const logged = { id: 'recorded', kind: 'user' as const, time: Date.now(), text: '한 줄 둘째 줄' }
    store().applyFrame({ shellId, items: [logged] })
    expect(chat().items).toEqual([{ ...logged, sentAt: 100_000 }])
    expect(unconfirmed()).toEqual([])
  })

  it('uses the same bubble and waits again after a successful manual retry', () => {
    load()
    const id = send('사진 확인', false, ['image-id'])
    check()
    vi.advanceTimersByTime(15_000)
    check()
    expect(unconfirmed()).toEqual([id])

    store().acceptSend(shellId, id, true)
    expect(check(false)).toBeUndefined()
    expect(unconfirmed()).toEqual([])
    expect(chat().items.map(item => item.id)).toEqual([id])
    expect(chat().echoes[0].delivery?.imageIds).toEqual(['image-id'])
    expect(check()).toBe(130_000)
  })

  it('confirms the exact retry bubble when main returns a freshly recorded message', () => {
    load()
    const first = send('같은 글')
    const second = send('같은 글')
    check()
    vi.advanceTimersByTime(15_000)
    check()
    const logged = { id: 'from-preflight', kind: 'user' as const, time: Date.now(), text: '같은 글' }
    store().confirmSend(shellId, second, logged)
    expect(unconfirmed()).toEqual([first])
    expect(chat().items.filter(item => item.id === logged.id)).toHaveLength(1)
    expect(chat().items.some(item => item.id === second)).toBe(false)
  })

  it('skips slash commands, image-only sends and a missing transcript', () => {
    store().applyFrame({ shellId, state: 'waiting' })
    const pending = send('기록에 남을 글')
    send('/compact')
    send('', false, ['image-id'])
    vi.advanceTimersByTime(20_000)
    expect(check()).toBeUndefined()
    expect(unconfirmed()).toEqual([])

    load()
    expect(check()).toBe(135_000)
    vi.advanceTimersByTime(15_000)
    check()
    expect(unconfirmed()).toEqual([pending])
    store().applyFrame({ shellId, state: 'waiting' })
    expect(unconfirmed()).toEqual([])
  })

  it('keeps a send across closing and reopening its transcript, then drops it on a new transcript', async () => {
    load()
    const id = store().echoSend(shellId, '보류', [])
    store().hide(shellId)
    store().acceptSend(shellId, id)
    vi.advanceTimersByTime(15_000)
    await store().show(shellId)
    load()
    check()
    expect(unconfirmed()).toEqual([])
    vi.advanceTimersByTime(15_000)
    check()
    expect(unconfirmed()).toEqual([id])

    load('different-transcript')
    expect(chat().items).toEqual([])
    expect(unconfirmed()).toEqual([])
  })
})
