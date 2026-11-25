import { useEffect } from 'react'
import { useAgentMessagesStore } from '../components/Terminal/AgentMessages'
import { localAgentPaneLocation } from '../lib/localPaneShells'
import { focusTabPane } from '../lib/paneFocus'
import { useTerminalStore } from '../stores/terminalStore'
import { toast, useToastStore } from '../stores/toastStore'

export function useAgentEscalations(isLocked: boolean) {
  useEffect(() => {
    const subscribe = window.electronAPI.onAgentEscalation
    if (isLocked || !subscribe) return
    const noticeIds = new Set<string>()
    const unsubscribe = subscribe(({ id, shellId, title, label }) => {
      const store = useToastStore.getState()
      const visible = new Set(store.toasts.map(item => item.id))
      for (const noticeId of noticeIds) {
        if (!visible.has(noticeId)) noticeIds.delete(noticeId)
      }
      const noticeId = store.addToast({
        type: 'warning', title, message: label, duration: 0,
        action: {
          label: '그 칸으로 가기',
          run: () => {
            const { snapshot, panes } = useAgentMessagesStore.getState()
            const agent = snapshot.agents.find(item => item.id === id && item.shellId === shellId && item.active)
            const terminal = useTerminalStore.getState()
            const location = agent && localAgentPaneLocation(terminal.terminals.get(panes[shellId]), agent)
            if (location) focusTabPane(terminal.focusTerminal, location.tabId, location.pane)
            else toast.info('에이전트 칸을 찾지 못했습니다')
          }
        }
      })
      noticeIds.add(noticeId)
    })
    return () => {
      unsubscribe()
      for (const id of noticeIds) useToastStore.getState().removeToast(id)
    }
  }, [isLocked])
}
