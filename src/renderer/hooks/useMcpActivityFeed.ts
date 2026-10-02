import { useEffect } from 'react'
import { useMcpActivityStore } from '../stores/mcpActivityStore'

/** Keeps the MCP activity store in sync with the main process. Mount once. */
export function useMcpActivityFeed(): void {
  useEffect(() => {
    const api = window.electronAPI
    if (typeof api?.onMcpActivity !== 'function' || typeof api?.mcpListActivity !== 'function') return
    const { mergeSnapshot, upsert, appendOutput } = useMcpActivityStore.getState()
    // Ids updated by a live event during this subscription; only those may be newer than the snapshot
    const liveIds = new Set<string>()
    let isMounted = true
    // Subscribe first so nothing that happens during the snapshot request is missed
    const off = api.onMcpActivity((item) => {
      liveIds.add(item.id)
      upsert(item)
    })
    // Missing in an app that was not restarted after an update; the finished item still carries the output
    const offOutput = typeof api.onMcpActivityOutput === 'function'
      ? api.onMcpActivityOutput(({ id, parts }) => appendOutput(id, parts))
      : () => {}
    api.mcpListActivity()
      .then((result) => { if (isMounted && result.success) mergeSnapshot(result.items, liveIds) })
      .catch(() => { /* the live feed still works */ })
    return () => {
      isMounted = false
      off()
      offOutput()
    }
  }, [])
}
