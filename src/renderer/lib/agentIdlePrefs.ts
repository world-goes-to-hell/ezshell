// How long an agent in a local shell may stay idle before it gives back its memory and before it is put
// to sleep (src/agentIdle.js). Kept in localStorage and sent to main when the app starts and on change.

export const AGENT_IDLE_KEY = 'agentIdle'
export const AGENT_IDLE_CHANGED = 'ezshell:agent-idle-changed'

export interface AgentIdlePrefs {
  /** Minutes before the CLI's working set goes back to Windows; 0 = off */
  trimMinutes: number
  /** Minutes before the CLI is closed and kept to resume; 0 = off */
  sleepMinutes: number
}

/** Giving back the working set loses nothing, so it is on; closing the CLI is the user's choice */
export const DEFAULT_AGENT_IDLE: AgentIdlePrefs = { trimMinutes: 10, sleepMinutes: 0 }
export const TRIM_CHOICES = [0, 5, 10, 30] as const
export const SLEEP_CHOICES = [0, 15, 30, 60, 120] as const

const choice = (value: unknown, choices: readonly number[], fallback: number) =>
  typeof value === 'number' && choices.includes(value) ? value : fallback

export function parseAgentIdlePrefs(raw: string | null): AgentIdlePrefs {
  if (!raw) return DEFAULT_AGENT_IDLE
  try {
    const value = JSON.parse(raw) as Partial<AgentIdlePrefs> | null
    if (!value || typeof value !== 'object') return DEFAULT_AGENT_IDLE
    return {
      trimMinutes: choice(value.trimMinutes, TRIM_CHOICES, DEFAULT_AGENT_IDLE.trimMinutes),
      sleepMinutes: choice(value.sleepMinutes, SLEEP_CHOICES, DEFAULT_AGENT_IDLE.sleepMinutes)
    }
  } catch {
    return DEFAULT_AGENT_IDLE
  }
}

export function readAgentIdlePrefs(): AgentIdlePrefs {
  try { return parseAgentIdlePrefs(localStorage.getItem(AGENT_IDLE_KEY)) } catch { return DEFAULT_AGENT_IDLE }
}

export function writeAgentIdlePrefs(prefs: AgentIdlePrefs): void {
  try { localStorage.setItem(AGENT_IDLE_KEY, JSON.stringify(prefs)) } catch { /* kept for this run only */ }
  window.dispatchEvent(new CustomEvent(AGENT_IDLE_CHANGED, { detail: prefs }))
}

/** "10분", "1시간", "2시간" */
export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}분`
  return minutes % 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes / 60}시간`
}
