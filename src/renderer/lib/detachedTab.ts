import type { TerminalInfo } from '../stores/terminalStore'
import type { SSHConnectConfig } from '../hooks/useSSH'

/** What the main window keeps of a tab while it lives in its own window */
export interface DetachedTab {
  connectConfig?: SSHConnectConfig
  color?: string
}

/** What a popped-out window sends when it moves back */
export interface MergedTabData {
  sessionId: string
  title: string
  host: string
  username: string
}

/** The tab's color wins over the color it connected with, as in getDuplicateConfig. */
export function detachTab(terminal: TerminalInfo): DetachedTab {
  return {
    connectConfig: terminal.connectConfig,
    color: terminal.color ?? terminal.connectConfig?.color
  }
}

/**
 * The tab to add when a popped-out window moves back. The SSH connection lives in the main process,
 * so the tab is still connected. Without `detached` (the main window was reloaded meanwhile) the tab
 * has no color and cannot be duplicated.
 */
export function restoreMergedTab(data: MergedTabData, detached: DetachedTab | undefined): TerminalInfo {
  return {
    id: data.sessionId,
    host: data.host,
    username: data.username,
    title: data.title,
    connected: true,
    color: detached?.color,
    connectConfig: detached?.connectConfig
  }
}
