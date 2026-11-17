/**
 * One DOM node per tab that holds the tab's content for as long as the tab exists.
 *
 * The tab's React tree (terminal, split shells, DB view) is rendered into this node through a portal from
 * one fixed place in App, and the layout only decides where the node is attached (TabSlot). Going from a
 * single screen to split panes and back therefore moves a DOM node instead of unmounting the tab: before
 * this, every such change rebuilt the tab, which closed the shells split inside it and opened new ones.
 */

const hosts = new Map<string, HTMLDivElement>()

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

/** Forget the nodes of tabs that no longer exist */
export function dropTabHostsExcept(liveTabIds: Iterable<string>) {
  const live = new Set(liveTabIds)
  for (const [tabId, host] of hosts) {
    if (!live.has(tabId)) {
      host.remove()
      hosts.delete(tabId)
    }
  }
}
