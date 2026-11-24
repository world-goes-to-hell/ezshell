/**
 * One DOM node per tab that holds the tab's content for as long as the tab exists.
 *
 * The tab's React tree (terminal, split shells, DB view) is rendered into this node through a portal from
 * one fixed place in App, and the layout only decides where the node is attached (TabSlot). Going from a
 * single screen to split panes and back therefore moves a DOM node instead of unmounting the tab: before
 * this, every such change rebuilt the tab, which closed the shells split inside it and opened new ones.
 */

const hosts = new Map<string, HTMLDivElement>()
const slots = new Map<string, HTMLDivElement>()

export function tabHost(tabId: string): HTMLDivElement {
  let host = hosts.get(tabId)
  if (!host) {
    host = document.createElement('div')
    // display: contents (globals.css): the content lays out as a direct child of the slot
    host.className = 'tab-host'
    hosts.set(tabId, host)
  }
  return host
}

/** The tab's node if it has one already (does not make one) */
export const existingTabHost = (tabId: string): HTMLDivElement | undefined => hosts.get(tabId)

/** A regular layout change can replace the slot while a live preview has the host. */
export function placeTabHost(tabId: string, slot: HTMLDivElement): void {
  slots.set(tabId, slot)
  const host = tabHost(tabId)
  if (!isTabHostPreviewed(tabId) && host.parentElement !== slot) slot.append(host)
}

export function isTabHostPreviewed(tabId: string): boolean {
  return hosts.get(tabId)?.hasAttribute('data-preview') ?? false
}

export function previewTabHost(tabId: string, slot: HTMLDivElement): () => void {
  const host = tabHost(tabId)
  host.setAttribute('data-preview', '')
  slot.append(host)
  return () => {
    if (hosts.get(tabId) !== host || host.parentElement !== slot) return
    host.removeAttribute('data-preview')
    const normalSlot = slots.get(tabId)
    if (normalSlot) normalSlot.append(host)
    else host.remove()
  }
}

/** Forget the nodes of tabs that no longer exist */
export function dropTabHostsExcept(liveTabIds: Iterable<string>) {
  const live = new Set(liveTabIds)
  for (const [tabId, host] of hosts) {
    if (!live.has(tabId)) {
      host.remove()
      hosts.delete(tabId)
      slots.delete(tabId)
    }
  }
}
