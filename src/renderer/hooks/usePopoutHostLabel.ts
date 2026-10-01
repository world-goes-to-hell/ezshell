import { useEffect, useState } from 'react'
import { formatHostLabel } from '../lib/popoutLabels'

/** "user@host" of the SSH session shown in a popped-out window, read from the main process */
export function usePopoutHostLabel(sessionId: string): string {
  const [label, setLabel] = useState('')

  useEffect(() => {
    let cancelled = false
    window.electronAPI.sshGetSessionInfo(sessionId)
      .then(info => { if (!cancelled) setLabel(formatHostLabel(info)) })
      .catch(() => { /* Title falls back to the session name only */ })
    return () => { cancelled = true }
  }, [sessionId])

  return label
}
