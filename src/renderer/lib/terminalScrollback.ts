const STORAGE_KEY = 'ezshell.terminalScrollback'
export const TERMINAL_SCROLLBACK_OPTIONS = [1000, 2000, 5000, 10000, 25000, 50000] as const
export const DEFAULT_TERMINAL_SCROLLBACK = 10000

export function readTerminalScrollback(): number {
  try {
    const rows = Number(localStorage.getItem(STORAGE_KEY))
    return TERMINAL_SCROLLBACK_OPTIONS.find(option => option === rows) ?? DEFAULT_TERMINAL_SCROLLBACK
  } catch {
    return DEFAULT_TERMINAL_SCROLLBACK
  }
}

export function saveTerminalScrollback(value: string): number {
  const rows = TERMINAL_SCROLLBACK_OPTIONS.find(option => String(option) === value) ?? DEFAULT_TERMINAL_SCROLLBACK
  localStorage.setItem(STORAGE_KEY, String(rows))
  return rows
}
