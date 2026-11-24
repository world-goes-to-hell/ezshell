import { useEffect, useRef } from 'react'
import { APPROVAL_END_VISIBLE_RATIO, isApprovalEndVisible } from '../../lib/approvalArming'

export function McpApprovalEnd({ onSeen }: { onSeen: () => void }) {
  const endRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const end = endRef.current
    if (!end) return
    // With the viewport as root, both the inner scroller and the dialog body can clip the marker.
    const observer = new IntersectionObserver(entries => {
      if (endRef.current !== end || !entries.some(isApprovalEndVisible)) return
      observer.disconnect()
      onSeen()
    }, { root: null, threshold: [APPROVAL_END_VISIBLE_RATIO, 1] })
    observer.observe(end)
    return () => observer.disconnect()
  }, [onSeen])

  return <span aria-hidden="true" className="mcp-approval-end" ref={endRef} />
}
