// "원래 대화로 가기" in a pinned answer window (AgentChat/PinnedReplyWindow.tsx): main brings this window
// forward and names the shell; its pane comes to the front, as a chat.
import { useEffect } from 'react'
import { focusTabPane } from '../lib/paneFocus'
import { MAIN_PANE } from '../lib/splitTree'
import { tabHost } from '../lib/tabHosts'
import { useAgentChatStore } from '../stores/agentChatStore'
import { useTerminalStore } from '../stores/terminalStore'
import { useAgentMessagesStore } from '../components/Terminal/AgentMessages'
import { toast } from '../stores/toastStore'

export function usePinnedReplyGo(): void {
  useEffect(() => window.electronAPI.onPinnedReplyGo?.((shellId) => {
    const tabId = useAgentMessagesStore.getState().panes[shellId]
    if (!tabId || !useTerminalStore.getState().terminals.has(tabId)) {
      toast.info('대화를 찾지 못했습니다', '그 에이전트의 셸이 닫혔습니다.')
      return
    }
    const pane = tabHost(tabId).querySelector<HTMLElement>(`[data-local-shell-id="${CSS.escape(shellId)}"]`)
    focusTabPane(useTerminalStore.getState().focusTerminal, tabId, pane?.dataset.pane ?? MAIN_PANE)
    void useAgentChatStore.getState().show(shellId)
  }), [])
}
