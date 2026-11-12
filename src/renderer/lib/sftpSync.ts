// "SFTP 를 현재 폴더로": the folder the terminal is in, as a path the SFTP panel can open.
import { useTerminalStore } from '../stores/terminalStore'
import { useSftpStore } from '../stores/sftpStore'
import { toast } from '../stores/toastStore'

/** The SFTP panel of that tab goes to the folder when it hears this (detail: { sessionId, path }) */
export const SFTP_GOTO_EVENT = 'ezshell:sftp-goto'

/**
 * The terminal's folder is read from the prompt or the window title, where the home folder is `~`.
 * Returns null when it is not a path SFTP can open (unknown, or `~` without knowing the home folder).
 */
export function resolveTerminalPath(terminalPath: string | undefined, home: string | null): string | null {
  const path = terminalPath?.trim()
  if (!path) return null
  if (path.startsWith('/')) return path
  if (path !== '~' && !path.startsWith('~/')) return null
  if (!home || !home.startsWith('/')) return null
  const rest = path.slice(1).replace(/^\/+/, '')
  return rest ? `${home.replace(/\/+$/, '')}/${rest}` : home
}

function showInSftp(sessionId: string, path: string): void {
  const sftp = useSftpStore.getState()
  if (sftp.isOpen(sessionId)) {
    window.dispatchEvent(new CustomEvent(SFTP_GOTO_EVENT, { detail: { sessionId, path } }))
  } else {
    // The panel loads the stored path when it opens
    sftp.setRemotePath(sessionId, path)
    sftp.setOpen(sessionId, true)
  }
}

/** Opens the tab's SFTP panel (if needed) at an absolute folder path */
export async function openSftpAt(sessionId: string, path: string): Promise<void> {
  try {
    await window.electronAPI.sftpOpen(sessionId)
    showInSftp(sessionId, path)
  } catch (error) {
    toast.error('SFTP 를 열지 못했습니다', error instanceof Error ? error.message : String(error))
  }
}

/** Opens the tab's SFTP panel (if needed) at the folder its terminal is in */
export async function syncSftpToTerminal(sessionId: string): Promise<void> {
  const terminalPath = useTerminalStore.getState().terminals.get(sessionId)?.currentPath
  if (!terminalPath) {
    toast.info('현재 폴더를 알 수 없습니다', '프롬프트에 경로가 보이지 않는 셸입니다. cd 로 이동한 뒤 다시 해 보세요.')
    return
  }
  try {
    await window.electronAPI.sftpOpen(sessionId)
    const home = terminalPath.startsWith('~') ? await window.electronAPI.sftpRealpath?.(sessionId, '.') ?? null : null
    const path = resolveTerminalPath(terminalPath, home)
    if (!path) {
      toast.info('현재 폴더를 알 수 없습니다', `터미널 경로: ${terminalPath}`)
      return
    }
    showInSftp(sessionId, path)
  } catch (error) {
    toast.error('SFTP 를 열지 못했습니다', error instanceof Error ? error.message : String(error))
  }
}
