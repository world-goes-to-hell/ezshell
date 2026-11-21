import { useLayoutEffect, useRef } from 'react'
import { placeTabHost } from '../../lib/tabHosts'

interface TabSlotProps {
  tabId: string
  className: string
}

/** The place in the layout where a tab's content shows: attaches the tab's own node (lib/tabHosts.ts) */
export function TabSlot({ tabId, className }: TabSlotProps) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (ref.current) placeTabHost(tabId, ref.current)
    // No cleanup: the node stays where it is until another slot takes it or the tab closes. Detaching
    // here would leave the content out of the document between two layouts.
  }, [tabId])

  return <div ref={ref} className={className} />
}
