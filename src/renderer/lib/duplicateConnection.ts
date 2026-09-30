import type { TerminalInfo } from '../stores/terminalStore'
import type { SSHConnectConfig } from '../hooks/useSSH'

/**
 * Connect config for opening another tab to the same server as `terminal`.
 * Returns null when the tab has no stored config (e.g. a popped-out tab moved back).
 * The tab's current color and title win over the originals so the new tab looks the same.
 */
export function getDuplicateConfig(terminal: TerminalInfo | null | undefined): SSHConnectConfig | null {
  if (!terminal?.connectConfig) return null
  return {
    ...terminal.connectConfig,
    color: terminal.color ?? terminal.connectConfig.color,
    sessionName: terminal.title ?? terminal.connectConfig.sessionName
  }
}
