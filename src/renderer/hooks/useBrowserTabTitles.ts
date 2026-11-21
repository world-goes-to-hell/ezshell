import { useEffect } from 'react'
import { useTerminalStore } from '../stores/terminalStore'
import { BROWSER_TAB_DEFAULT_TITLE, nextBrowserTabTitle, pageTabTitle } from '../lib/browserTabTitle'

/** Browser tabs take the name of the page they show (main reports the title with the tab's state) */
export function useBrowserTabTitles(): void {
  useEffect(() => {
    const listen = window.electronAPI?.onBrowserReviewState
    if (typeof listen !== 'function') return
    // What was last set per tab: a tab showing something else was renamed by the user
    const lastAuto = new Map<string, string>()
    const off = listen((id, state) => {
      const store = useTerminalStore.getState()
      const tab = store.terminals.get(id)
      if (!tab?.browser) {
        lastAuto.delete(id)
        return
      }
      // The tab clips its label in CSS so its full page title can still appear in the tooltip.
      const next = nextBrowserTabTitle(tab.title ?? BROWSER_TAB_DEFAULT_TITLE, lastAuto.get(id), pageTabTitle(state, Infinity))
      if (next === null) return
      lastAuto.set(id, next)
      store.updateTerminalTitle(id, next)
    })
    return off
  }, [])
}
