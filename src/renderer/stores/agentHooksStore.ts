import { create } from 'zustand'
import { AGENT_HOOKS_CHANGED, AGENT_HOOKS_KEY, readAgentHooksPrefs, type AgentHooksChange, type AgentHooksPrefs } from '../lib/agentHooksPrefs'
import { toast } from './toastStore'

// What main said about the CLIs' hooks (docs/plan/2026-11-24-agent-state-via-official-signals.md, T11):
// `codexMode` 'disabled' means Codex's hooks are left out (`묻지 않기`, or Continue without trusting).

type AgentHooksConfigure = (request: AgentHooksPrefs & { resetCodexDecline?: true }) => Promise<{ success: boolean; codexMode?: string } | undefined>

interface AgentHooksState {
  codexMode: string | null
  /** Bumped when a change main could not apply was put back: the settings screen reads the switch again */
  reverted: number
}

export const useAgentHooksStore = create<AgentHooksState>(() => ({ codexMode: null, reverted: 0 }))

/**
 * main could not write its hook files (a rename failing on Windows): the stored switch goes back to what
 * main still has, so the screen does not show off while the agents still get hooks (review 27)
 */
function putBack(previous: AgentHooksPrefs) {
  try { localStorage.setItem(AGENT_HOOKS_KEY, JSON.stringify(previous)) } catch { /* the screen still follows below */ }
  useAgentHooksStore.setState(state => ({ reverted: state.reverted + 1 }))
  toast.error('에이전트 상태 알림 설정을 바꾸지 못했습니다', '잠시 후 다시 시도해 주세요.')
}

/** Sends the switch to main when the window starts and on change; once per window. Returns the cleanup. */
export function startAgentHooks(): () => void {
  // Optional until main's IPC lands (codex-4, T11)
  const api = window.electronAPI as { agentHooksConfigure?: AgentHooksConfigure }
  if (typeof api.agentHooksConfigure !== 'function') return () => {}
  // What main has now: the last value it took (the start-up send sets it)
  let applied: AgentHooksPrefs | null = null
  const configure = ({ prefs, resetCodexDecline }: AgentHooksChange, startUp = false) => {
    const request = resetCodexDecline ? { enabled: prefs.enabled, resetCodexDecline } : { enabled: prefs.enabled }
    const previous = applied
    void api.agentHooksConfigure?.(request).then(result => {
      if (result?.success) {
        applied = { enabled: prefs.enabled }
        useAgentHooksStore.setState({ codexMode: result.codexMode ?? null })
      } else if (result && !startUp && previous && previous.enabled !== prefs.enabled) {
        putBack(previous)
      }
    }, () => {})
  }
  // The start-up send never resets Codex's decline
  configure({ prefs: readAgentHooksPrefs() }, true)
  const onChange = (event: Event) => configure((event as CustomEvent<AgentHooksChange>).detail)
  window.addEventListener(AGENT_HOOKS_CHANGED, onChange)
  return () => window.removeEventListener(AGENT_HOOKS_CHANGED, onChange)
}
