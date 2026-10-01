import type { FileItem } from '../stores/sftpStore'
import { toast } from '../stores/toastStore'
import { confirmDialog } from '../stores/confirmStore'

const MAX_NAMES_IN_CONFIRM = 5

function joinRemotePath(basePath: string, name: string): string {
  return basePath === '/' ? `/${name}` : `${basePath.replace(/\/+$/, '')}/${name}`
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // SFTP rmdir only removes empty directories; servers report that as a generic failure
  if (/failure|not empty/i.test(message)) return '폴더가 비어 있지 않거나 삭제 권한이 없습니다'
  if (/permission/i.test(message)) return '삭제 권한이 없습니다'
  if (/no such file/i.test(message)) return '이미 없는 항목입니다'
  return message
}

/**
 * Delete the selected remote entries after confirmation.
 * Files are unlinked; folders are removed only when empty (SFTP rmdir semantics).
 * Returns true when anything was deleted so the caller can refresh the listing.
 */
export async function deleteRemoteSelection(
  sessionId: string,
  remotePath: string,
  selectedNames: Set<string>,
  files: FileItem[]
): Promise<boolean> {
  const targets = files.filter(file => selectedNames.has(file.name) && file.name !== '..')
  if (targets.length === 0) {
    toast.info('삭제할 항목 선택', '원격 목록에서 삭제할 파일을 먼저 선택하세요')
    return false
  }

  const listed = targets.slice(0, MAX_NAMES_IN_CONFIRM).map(file => `  - ${file.name}${file.type === 'directory' ? '/' : ''}`)
  const more = targets.length > MAX_NAMES_IN_CONFIRM ? [`  외 ${targets.length - MAX_NAMES_IN_CONFIRM}개`] : []
  const hasFolder = targets.some(file => file.type === 'directory')
  const message = [
    `원격 서버에서 ${targets.length}개 항목을 삭제합니다. 되돌릴 수 없습니다.`,
    '',
    ...listed,
    ...more,
    ...(hasFolder ? ['', '폴더는 비어 있을 때만 삭제됩니다.'] : [])
  ].join('\n')
  if (!(await confirmDialog({ title: '원격 파일 삭제', message, confirmLabel: '삭제', danger: true }))) return false

  const failures: string[] = []
  let deleted = 0
  // Sequential on purpose: one SFTP channel, and a clear per-item error
  for (const file of targets) {
    try {
      await window.electronAPI.sftpDelete(sessionId, joinRemotePath(remotePath, file.name), file.type === 'directory')
      deleted++
    } catch (error) {
      failures.push(`${file.name}: ${describeError(error)}`)
    }
  }

  if (failures.length === 0) {
    toast.success('삭제 완료', `${deleted}개 항목을 삭제했습니다`)
  } else {
    toast.error(`${failures.length}개 항목 삭제 실패`, failures.slice(0, 3).join('\n'))
  }
  return deleted > 0
}
