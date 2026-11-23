import { create } from 'zustand'

// Claude's AskUserQuestion per shell: answered in the terminal instead of the card (the user chose it, or
// the keys stopped), and the card's answer on its way. Keyed by the question's item id: Claude's dialog
// changes its prompt as it moves between questions, the item stays the same.
export type AskSending = { itemId: string; state: 'sending' | 'sent' }

interface AskQuestionState {
  inTerminal: ReadonlyMap<string, string>
  sending: ReadonlyMap<string, AskSending>
  answerInTerminal: (shellId: string, itemId: string) => void
  setSending: (shellId: string, value: AskSending | null) => void
  clearAll: () => void
}

const withEntry = <V>(map: ReadonlyMap<string, V>, key: string, value: V | null) => {
  const next = new Map(map)
  if (value === null) next.delete(key)
  else next.set(key, value)
  return next
}

export const useAskQuestionStore = create<AskQuestionState>(set => ({
  inTerminal: new Map(),
  sending: new Map(),
  answerInTerminal: (shellId, itemId) => set(state => ({ inTerminal: withEntry(state.inTerminal, shellId, itemId), sending: withEntry(state.sending, shellId, null) })),
  setSending: (shellId, value) => set(state => ({ sending: withEntry(state.sending, shellId, value) })),
  clearAll: () => set({ inTerminal: new Map(), sending: new Map() })
}))
