// Whether agents report their state through the CLIs' own hooks (docs/plan/2026-11-24-agent-state-via-official-signals.md,
// user decision 4: a switch in Settings > MCP > 에이전트 메시지). Kept in localStorage and sent to main when the
// app starts and on change, like the idle agent settings (lib/agentIdlePrefs.ts).

export const AGENT_HOOKS_KEY = 'agentHooks'
export const AGENT_HOOKS_CHANGED = 'ezshell:agent-hooks-changed'

export interface AgentHooksPrefs {
  enabled: boolean
}

export const DEFAULT_AGENT_HOOKS: AgentHooksPrefs = { enabled: true }

export function parseAgentHooksPrefs(raw: string | null): AgentHooksPrefs {
  if (!raw) return DEFAULT_AGENT_HOOKS
  try {
    const value = JSON.parse(raw) as Partial<AgentHooksPrefs> | null
    if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') return DEFAULT_AGENT_HOOKS
    return { enabled: value.enabled }
  } catch {
    return DEFAULT_AGENT_HOOKS
  }
}

export function readAgentHooksPrefs(): AgentHooksPrefs {
  try { return parseAgentHooksPrefs(localStorage.getItem(AGENT_HOOKS_KEY)) } catch { return DEFAULT_AGENT_HOOKS }
}

/** What AGENT_HOOKS_CHANGED carries */
export interface AgentHooksChange {
  prefs: AgentHooksPrefs
  /**
   * The user turned the switch back on in the settings: main forgets Codex's `묻지 않기` so the next run asks
   * again. Never on the start-up send, a backup import or the same value sent again (they would undo
   * the user's decline each time the app starts).
   */
  resetCodexDecline?: true
}

export function writeAgentHooksPrefs(prefs: AgentHooksPrefs, { resetCodexDecline = false } = {}): void {
  try { localStorage.setItem(AGENT_HOOKS_KEY, JSON.stringify(prefs)) } catch { /* kept for this run only */ }
  const detail: AgentHooksChange = resetCodexDecline ? { prefs, resetCodexDecline: true } : { prefs }
  window.dispatchEvent(new CustomEvent(AGENT_HOOKS_CHANGED, { detail }))
}

/** A value from the UI settings backup (lib/uiSettingsApply.ts): never resets Codex's decline */
export function applyImportedAgentHooks(raw: string): void {
  writeAgentHooksPrefs(parseAgentHooksPrefs(raw))
}
