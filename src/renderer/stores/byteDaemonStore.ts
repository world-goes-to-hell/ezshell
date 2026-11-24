import { create } from 'zustand'
import {
  PRODUCERS, buy as buyProducer, claimAway as claimAwayReward, clickValue, earn, parseSave, rateOf, settle, spend,
  type ByteDaemonSave, type ProducerId
} from '../lib/byteDaemon'

// The Byte Daemon mini game (docs/plan/2026-11-24-byte-daemon-mini-game.md). Nothing here runs on its
// own: the open popover calls tick(), and a closed one is caught up from the time on the next open.

const STORAGE_KEY = 'byteDaemon'
const SAVE_EVERY_MS = 2000
const LOG_LINES = 3

export type ByteDaemonView = 'home' | 'bugs' | 'typing' | 'deploy'
export type BestKey = keyof ByteDaemonSave['best']

export interface GameLogLine {
  id: number
  text: string
  kind: 'plain' | 'ok' | 'new'
}

interface ByteDaemonState {
  save: ByteDaemonSave
  open: boolean
  view: ByteDaemonView
  log: GameLogLine[]
  setOpen: (open: boolean) => void
  setView: (view: ByteDaemonView) => void
  /** Add production up to now (the open popover calls this) */
  tick: () => void
  /** A click on the daemon; returns the bytes it gave */
  click: () => number
  claimAway: () => void
  buy: (id: ProducerId) => void
  /** Bytes won in a game */
  reward: (amount: number, text: string) => void
  /** Take a stake from the bytes; false when there is not enough */
  stake: (amount: number) => boolean
  /** Keep the best result of a game; true when it is a new best */
  record: (key: BestKey, value: number) => boolean
  setHidden: (hidden: boolean) => void
  pushLog: (text: string, kind?: GameLogLine['kind']) => void
}

function load(): ByteDaemonSave {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    // Storage unavailable (private window, blocked site data): play without saving
  }
  return parseSave(raw, Date.now())
}

let lastWrite = 0
let pending: ReturnType<typeof setTimeout> | null = null

function write(save: ByteDaemonSave) {
  lastWrite = Date.now()
  if (pending) clearTimeout(pending)
  pending = null
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(save))
  } catch {
    // Not saved: the game goes on in memory
  }
}

/** Save at most every two seconds; the last change is always written */
function persist(save: ByteDaemonSave, now = false) {
  if (now || Date.now() - lastWrite >= SAVE_EVERY_MS) return write(save)
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => write(useByteDaemonStore.getState().save), SAVE_EVERY_MS)
}

/** 이 or 가 after a Korean name, by its last syllable */
const subject = (name: string) => {
  const code = name.charCodeAt(name.length - 1) - 0xac00
  return code >= 0 && code <= 11171 && code % 28 !== 0 ? '이' : '가'
}

let logSeq = 0

export const useByteDaemonStore = create<ByteDaemonState>((set, get) => {
  const change = (next: ByteDaemonSave, now = false) => {
    set({ save: next })
    persist(next, now)
  }
  return {
    save: load(),
    open: false,
    view: 'home',
    log: [],
    setOpen: (open) => {
      if (open === get().open) return
      if (open) {
        set({ open: true })
        get().tick()
        return
      }
      // Closing leaves a game: nothing keeps running
      set({ open: false, view: 'home' })
      persist(get().save, true)
    },
    setView: (view) => set({ view }),
    tick: () => {
      const { save } = get()
      const next = settle(save, Date.now())
      if (next !== save) change(next)
    },
    click: () => {
      const { save } = get()
      const amount = clickValue(rateOf(save.owned))
      change(earn(save, amount))
      return amount
    },
    claimAway: () => change(claimAwayReward(get().save), true),
    buy: (id) => {
      const { save } = get()
      const next = buyProducer(save, id)
      if (!next) return
      change(next, true)
      const producer = PRODUCERS.find(p => p.id === id)
      if (producer && save.owned[id] === 0) get().pushLog(`★ ${producer.name}${subject(producer.name)} 합류했습니다!`, 'new')
    },
    reward: (amount, text) => {
      change(earn(get().save, amount), true)
      get().pushLog(text, 'ok')
    },
    stake: (amount) => {
      const next = spend(get().save, amount)
      if (!next) return false
      change(next, true)
      return true
    },
    record: (key, value) => {
      const { save } = get()
      if (!(value > save.best[key])) return false
      change({ ...save, best: { ...save.best, [key]: value } }, true)
      return true
    },
    setHidden: (hidden) => change({ ...get().save, hidden }, true),
    pushLog: (text, kind = 'plain') => set(state => ({ log: [{ id: ++logSeq, text, kind }, ...state.log].slice(0, LOG_LINES) }))
  }
})

if (typeof window !== 'undefined') {
  // A reload or quit while the popover is open keeps the last bytes
  window.addEventListener('pagehide', () => {
    if (pending) write(useByteDaemonStore.getState().save)
  })
}
