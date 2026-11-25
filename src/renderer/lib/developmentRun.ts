import { useEffect } from 'react'
import { create } from 'zustand'
import type { LocalDevelopmentRun } from '../types'
import { localTabShellIds } from './localPaneShells'
import { toast } from '../stores/toastStore'

type Runs = Record<string, LocalDevelopmentRun>
export const useDevelopmentRuns = create<{ runs: Runs }>(() => ({ runs: {} }))

export function useDevelopmentRunEvents(isLocked: boolean) {
  useEffect(() => {
    if (isLocked) return
    let active = true
    const changed = new Set<string>()
    const off = window.electronAPI.onLocalShellDevelopmentState?.(({ id, development }) => {
      changed.add(id)
      useDevelopmentRuns.setState(({ runs }) => {
        const next = { ...runs }
        if (development) next[id] = development
        else delete next[id]
        return { runs: next }
      })
    })
    void window.electronAPI.localShellList?.().then(shells => {
      if (!active) return
      useDevelopmentRuns.setState(({ runs }) => {
        const next: Runs = {}
        for (const { id, development } of shells) if (development && !changed.has(id)) next[id] = development
        for (const id of changed) if (runs[id]) next[id] = runs[id]
        return { runs: next }
      })
    }).catch(() => {})
    return () => { active = false; off?.() }
  }, [isLocked])
}

export function developmentRunsForTab(tabId: string, runs: Runs) {
  return localTabShellIds(tabId).filter(id => runs[id]).map(id => ({ id, run: runs[id] }))
}

export function developmentRunLabel({ status, exitCode }: Pick<LocalDevelopmentRun, 'status' | 'exitCode'>): string {
  switch (status) {
    case 'running': return '실행 중'
    case 'starting': return '시작 중'
    case 'stopping': return '중지 중'
    case 'exited': return exitCode === null ? '종료' : `종료 ${exitCode}`
  }
}

export function developmentRunPort(address: string | null): string {
  if (!address) return ''
  const url = new URL(address)
  return `:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
}

export async function changeDevelopmentRun(id: string, taskId: string, action: 'restart' | 'stop') {
  const title = action === 'restart' ? '개발 서버를 재기동하지 못했습니다' : '개발 서버를 중지하지 못했습니다'
  try {
    const result = await window.electronAPI.localProjectDevelopmentChange({ shellId: id, taskId, action })
    if (!result.success) toast.error(title, result.error)
  } catch { toast.error(title) }
}
