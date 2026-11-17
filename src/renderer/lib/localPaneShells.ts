// The shells of a local terminal tab's split panes. The tab's first pane is the tab's own shell
// (same id as the tab); every other pane gets a shell of its own here. The shells live in the main
// process and outlive the pane's element, so they are kept by tab and pane: a pane drawn again
// attaches to the same shell, and a shell is closed only when its pane leaves the split or its
// tab closes.

import type { PaneId } from './splitTree'

export type LocalPaneShell = { ok: true; id: string } | { ok: false; error: string }

const opening = new Map<string, Promise<LocalPaneShell>>()
const opened = new Map<string, string>()
const keyOf = (tabId: string, pane: PaneId) => `${tabId}\n${pane}`

/** The pane's shell, opened on first ask (asked twice at once, it is still opened once) */
export function ensureLocalPaneShell(tabId: string, pane: PaneId): Promise<LocalPaneShell> {
  const key = keyOf(tabId, pane)
  const pending = opening.get(key)
  if (pending) return pending
  // Told apart from a later open for the same pane (closed and split again meanwhile)
  const holder: { promise?: Promise<LocalPaneShell> } = {}
  const isStillWanted = () => opening.get(key) === holder.promise
  holder.promise = (async (): Promise<LocalPaneShell> => {
    try {
      const result = await window.electronAPI.localShellOpen?.({ cols: 80, rows: 24 })
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
