import { useSftpStore } from '../stores/sftpStore'
import { useTerminalStore } from '../stores/terminalStore'

/**
 * The docked SFTP panel and its popped-out window are one panel in two places: opening the window hides
 * the docked panel (SftpPanel's "새 창으로 열기"), and when the window closes, by its close button or
 * its "병합" button, the docked panel comes back showing the folders the window was last in.
 * Installed once in the main window (main.tsx); other windows never get the event.
 */
export function installSftpWindowReturn() {
  const api = window.electronAPI
  if (typeof api?.onSftpWindowClosed !== 'function') return
  api.onSftpWindowClosed(({ sessionId, localPath, remotePath }) => {
    // The tab may have been closed while the window was open: nothing to return to
    if (!useTerminalStore.getState().terminals.has(sessionId)) return
    const store = useSftpStore.getState()
    if (localPath) store.setLocalPath(sessionId, localPath)
    if (remotePath) store.setRemotePath(sessionId, remotePath)
    // Empty lists make the panel read both folders again when it opens (its lists were last read
    // before the window took over, possibly in other folders)
    store.setLocalFiles(sessionId, [])
    store.setRemoteFiles(sessionId, [])
    store.setOpen(sessionId, true)
  })
}
