import { toast } from '../stores/toastStore'
import type { RemoteFileMode } from '../types'

/** "/var/log" + "app.log" → "/var/log/app.log" (the root folder has no extra slash) */
export function joinRemotePath(folder: string, name: string): string {
  return `${folder.replace(/\/+$/, '')}/${name}`
}

/** Open a server file in its own window, from an SFTP list. */
export async function openRemoteFileWindow(sessionId: string, sessionName: string, folder: string, fileName: string, mode: RemoteFileMode): Promise<void> {
  const open = window.electronAPI.openRemoteFile
  if (typeof open !== 'function') {
    toast.warning('앱을 다시 시작해 주세요', '업데이트 후 다시 시작해야 파일 창을 열 수 있습니다.')
    return
  }
  const result = await open(sessionId, sessionName, joinRemotePath(folder, fileName), mode)
  if (!result.success) toast.error('파일 창을 열지 못했습니다', result.error)
}
