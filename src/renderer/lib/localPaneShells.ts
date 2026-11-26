// The shells of a local terminal tab's split panes. The tab's first pane is the tab's own shell
// (same id as the tab); every other pane gets a shell of its own here. The shells live in the main
// process and outlive the pane's element, so they are kept by tab and pane: a pane drawn again
// attaches to the same shell, and a shell is closed only when its pane leaves the split or its
// tab closes.

import { MAIN_PANE, paneIds, type PaneId } from './splitTree'
import { agentPaneLocation } from './agentIdentity'
import type { AgentMessageSession, LocalAgent } from '../types'
import { useTerminalStore, type TerminalInfo } from '../stores/terminalStore'

export type LocalPaneShell = { ok: true; id: string } | { ok: false; error: string }

const opening = new Map<string, Promise<LocalPaneShell>>()
const opened = new Map<string, string>()
const keyOf = (tabId: string, pane: PaneId) => `${tabId}\n${pane}`

export const hasLocalPaneShell = (tabId: string, pane: PaneId): boolean => opened.has(keyOf(tabId, pane))

/** Reads the current shell without opening a pane. A promoted main shell can have its own ID. */
export function getLocalPaneShellId(tabId: string, pane: PaneId): string | undefined {
  const local = useTerminalStore.getState().terminals.get(tabId)?.local
  if (!local) return undefined
  return pane === MAIN_PANE ? local.shellId ?? tabId : opened.get(keyOf(tabId, pane))
}

export function localTabShellIds(tabId: string): string[] {
  const tab = useTerminalStore.getState().getTerminal(tabId)
  if (!tab?.local) return []
  const panes = tab.splitTree ? paneIds(tab.splitTree) : [MAIN_PANE]
  return panes.map(pane => getLocalPaneShellId(tabId, pane)).filter((id): id is string => id !== undefined)
}

export function localAgentPaneLocation(tab: TerminalInfo | undefined, agent: AgentMessageSession) {
  if (!tab || !agent.active) return undefined
  return agentPaneLocation(tab, agent.shellId, pane => getLocalPaneShellId(tab.id, pane))
}

/** The pane's shell, opened on first ask (asked twice at once, it is still opened once) */
// A pane of a tab opened again after a restart, whose agent starts again: its conversation (the key of
// that session in the agent history, which main checks against the transcripts) or the same agent fresh
export interface PaneStart {
  agent: LocalAgent
  resume?: string
  restoring?: true
  claudeProfileId?: string
}
const pendingStart = new Map<string, PaneStart>()

/** The next shell of this pane starts that agent (resuming its conversation when given) instead of a plain shell */
export function queuePaneStart(tabId: string, pane: PaneId, start: PaneStart): void {
  pendingStart.set(keyOf(tabId, pane), start)
}

export function ensureLocalPaneShell(tabId: string, pane: PaneId): Promise<LocalPaneShell> {
  const key = keyOf(tabId, pane)
  const pending = opening.get(key)
  if (pending) return pending
  // Told apart from a later open for the same pane (closed and split again meanwhile)
  const holder: { promise?: Promise<LocalPaneShell> } = {}
  const isStillWanted = () => opening.get(key) === holder.promise
  holder.promise = (async (): Promise<LocalPaneShell> => {
    try {
      const cwd = useTerminalStore.getState().terminals.get(tabId)?.local?.cwd
      const start = pendingStart.get(key)
      pendingStart.delete(key)
      const openWith = (extra: object) => window.electronAPI.localShellOpen?.({ cols: 80, rows: 24, cwd, ...extra })
      let result = await openWith(start ?? {})
      // The conversation could not be resumed (its transcript is gone): the same agent fresh, then a plain shell
      if (start?.resume && result && !result.success) {
        const { resume: _resume, ...fresh } = start
        result = await openWith(fresh)
      }
      if (start && result && !result.success) result = await openWith({})
      if (!result) return { ok: false, error: '앱을 다시 시작해 주세요.' }
      if (!result.success) return { ok: false, error: result.error }
      // The pane was closed while the shell was opening: nobody will use it
      if (!isStillWanted()) {
        window.electronAPI.localShellClose?.(result.id)
        return { ok: false, error: '칸이 닫혔습니다.' }
      }
      opened.set(key, result.id)
      return { ok: true, id: result.id }
    } catch {
      return { ok: false, error: '로컬 셸을 열지 못했습니다.' }
    }
  })()
  const open = holder.promise
  opening.set(key, open)
  // A failed open is forgotten so the pane's retry asks again
  void open.then((result) => {
    if (!result.ok && opening.get(key) === open) opening.delete(key)
  })
  return open
}

/** A shell that already runs (a local terminal tab merged into this pane) becomes the pane's shell */
export function adoptLocalPaneShell(tabId: string, pane: PaneId, shellId: string): void {
  const key = keyOf(tabId, pane)
  opened.set(key, shellId)
  opening.set(key, Promise.resolve({ ok: true, id: shellId }))
}

/** Forgets a pane's shell without closing it (the shell became a tab) and gives its id */
export function releaseLocalPaneShell(tabId: string, pane: PaneId): string | null {
  const key = keyOf(tabId, pane)
  const id = opened.get(key) ?? null
  opened.delete(key)
  opening.delete(key)
  return id
}

/** Closes the tab's pane shells that are not in `keep` (all of them when the tab closes) */
export function closeLocalPaneShells(tabId: string, keep: readonly PaneId[] = []): void {
  const prefix = `${tabId}\n`
  const kept = new Set(keep.map(pane => keyOf(tabId, pane)))
  for (const key of [...opening.keys()]) {
    if (!key.startsWith(prefix) || kept.has(key)) continue
    const id = opened.get(key)
    if (id) window.electronAPI.localShellClose?.(id)
    opened.delete(key)
    // An open still on its way sees it was dropped and closes its shell itself
    opening.delete(key)
  }
}
