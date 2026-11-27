// The account menu's "이 대화를 이어서": main copies this pane's Claude conversation to the other account
// and opens a shell resuming it there; the pane gets that shell in place of the old one and stays a chat
// if it was one (docs/plan/2026-11-27-claude-account-switch-in-place.md).

import { useTerminalStore } from '../stores/terminalStore'
import { isChatShown } from '../stores/agentChatStore'
import { getLocalPaneShellId } from './localPaneShells'
import { MAIN_PANE, paneIds, type PaneId } from './splitTree'
import { swapPaneShell } from './agentSessionDrop'
import { queueChatView } from './pendingChatViews'

const PANE_CHANGED = '칸의 셸이 바뀌었습니다. 다시 시도해 주세요.'

function paneOf(shellId: string): { tabId: string; pane: PaneId } | undefined {
  for (const [tabId, tab] of useTerminalStore.getState().terminals) {
    if (!tab.local) continue
    const pane = (tab.splitTree ? paneIds(tab.splitTree) : [MAIN_PANE]).find(id => getLocalPaneShellId(tabId, id) === shellId)
    if (pane) return { tabId, pane }
  }
  return undefined
}

export async function continueUnderClaudeProfile(shellId: string, profileId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const switchInPlace = window.electronAPI.claudeProfileSwitchInPlace
  if (!switchInPlace) return { ok: false, error: '앱을 다시 시작한 뒤에 쓸 수 있습니다.' }
  const place = paneOf(shellId)
  if (!place) return { ok: false, error: PANE_CHANGED }
  const chat = isChatShown(shellId)
  const result = await swapPaneShell(place.tabId, { pane: place.pane, shellId }, () => switchInPlace({ shellId, profileId }), PANE_CHANGED)
  if (!result.ok) return result
  if (chat) queueChatView(place.tabId, place.pane)
  return { ok: true }
}
