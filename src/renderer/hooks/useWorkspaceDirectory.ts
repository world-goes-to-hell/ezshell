import { useEffect, useState } from 'react'
import { useTerminalStore } from '../stores/terminalStore'
import { visibleTerminalId } from '../lib/localTerminalPane'
import { getLocalPaneShellId } from '../lib/localPaneShells'
import { MAIN_PANE } from '../lib/splitTree'
import { pathKey } from '../lib/localWorkspaceTree'

const SAMPLE_MS = 1600

export function useWorkspaceDirectory(enabled: boolean) {
  const [focused, setFocused] = useState<{ tabId: string; pane: string } | null>(null)
  // Keep the last terminal focus when the user clicks a control in the workspace itself.
  useEffect(() => {
    const remember = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return
      const { localTabId, pane } = target.closest<HTMLElement>('[data-local-tab-id][data-pane]')?.dataset ?? {}
      if (!localTabId || !pane) return
      setFocused(previous => previous?.tabId === localTabId && previous.pane === pane ? previous : { tabId: localTabId, pane })
    }
    const onFocus = (event: FocusEvent) => remember(event.target)
    remember(document.activeElement)
    document.addEventListener('focusin', onFocus)
    return () => document.removeEventListener('focusin', onFocus)
  }, [])

  const shellId = useTerminalStore(state => {
    const tabId = visibleTerminalId(state.layout, state.activeTerminalId)
    if (!tabId) return null
    const terminal = state.terminals.get(tabId)
    if (!terminal?.local) return null
    const pane = focused?.tabId === tabId ? focused.pane : MAIN_PANE
    return getLocalPaneShellId(tabId, pane) ?? terminal.local.shellId ?? tabId
  })
  const [sample, setSample] = useState<{ shellId: string; folder: string | null } | null>(null)
  useEffect(() => {
    if (!enabled || !shellId) return
    let active = true
    let timer: number
    const read = async () => {
      const folder = await window.electronAPI.localShellCurrentDirectory?.(shellId).catch(() => null) ?? null
      if (!active) return
      setSample(previous => previous?.shellId === shellId && previous.folder === folder ? previous : { shellId, folder })
      timer = window.setTimeout(read, SAMPLE_MS)
    }
    void read()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [enabled, shellId])

  const current = sample?.shellId === shellId ? sample : null
  // While the folder of a newly focused shell is read, the folder shown stays: the files and Git views
  // would otherwise unmount and read everything again, even when the new shell is in the same folder
  // The same folder written another way (case, a trailing slash) by another shell counts as the same
  const [shown, setShown] = useState<string | null>(null)
  const sampled = current?.folder ?? null
  const sameAsShown = Boolean(shown && sampled && pathKey(shown) === pathKey(sampled))
  useEffect(() => {
    if (current && !sameAsShown) setShown(sampled)
  }, [current, sampled, sameAsShown])
  const folder = !shellId ? null : current ? (sameAsShown ? shown : sampled) : shown
  return { shellId, folder, isLoading: Boolean(shellId && !current && !shown) }
}
