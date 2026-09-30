import type { FileItem } from '../stores/sftpStore'
import { toast } from '../stores/toastStore'

export type PaneSide = 'local' | 'remote'

const MAX_NAMES_IN_CONFIRM = 5

export const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path)

export function joinChildPath(dirPath: string, name: string, side: PaneSide): string {
  if (side === 'local' && isWindowsPath(dirPath)) {
    return dirPath.endsWith('\\') ? `${dirPath}${name}` : `${dirPath}\\${name}`
  }
  return dirPath === '/' ? `/${name}` : `${dirPath.replace(/\/+$/, '')}/${name}`
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// SFTP v3 servers report most rename / mkdir failures as a bare "Failure"
function describeRemoteError(error: unknown): string {
  const message = messageOf(error)
  if (/permission/i.test(message)) return '권한이 없습니다'
  if (/no such file/i.test(message)) return '대상을 찾을 수 없습니다'
  if (/failure/i.test(message)) return '같은 이름이 이미 있거나 권한이 없습니다'
  return message
}

interface RenameParams {
  side: PaneSide
  sessionId: string
  dirPath: string
  oldName: string
  newName: string
}

/** Rename one entry in the pane's current folder. Returns true on success. */
export async function renameEntry({ side, sessionId, dirPath, oldName, newName }: RenameParams): Promise<boolean> {
  const oldPath = joinChildPath(dirPath, oldName, side)
  const newPath = joinChildPath(dirPath, newName, side)
  try {
    if (side === 'local') {
      const result = await window.electronAPI.localRename(oldPath, newPath)
      if (!result.success) {
        toast.error('이름 바꾸기 실패', result.error)
        return false
      }
    } else {
      await window.electronAPI.sftpRename(sessionId, oldPath, newPath)
    }
    return true
  } catch (error) {
    toast.error('이름 바꾸기 실패', side === 'remote' ? describeRemoteError(error) : messageOf(error))
    return false
  }
}

interface CreateFolderParams {
  side: PaneSide
  sessionId: string
  dirPath: string
  name: string
}

export async function createFolder({ side, sessionId, dirPath, name }: CreateFolderParams): Promise<boolean> {
  const folderPath = joinChildPath(dirPath, name, side)
  try {
    if (side === 'local') {
      const result = await window.electronAPI.localMkdir(folderPath)
      if (!result.success) {
        toast.error('새 폴더 만들기 실패', result.error)
        return false
      }
    } else {
      await window.electronAPI.sftpMkdir(sessionId, folderPath)
    }
    return true
  } catch (error) {
    toast.error('새 폴더 만들기 실패', side === 'remote' ? describeRemoteError(error) : messageOf(error))
    return false
  }
}

/**
 * Move the selected local entries to the Recycle Bin after confirmation.
 * Returns true when anything moved so the caller can refresh.
 */
export async function trashLocalSelection(dirPath: string, selectedNames: Set<string>, files: FileItem[]): Promise<boolean> {
  const targets = files.filter(file => selectedNames.has(file.name))
  if (targets.length === 0) {
    toast.info('삭제할 항목 선택', '로컬 목록에서 삭제할 항목을 먼저 선택하세요')
    return false
  }

  const listed = targets.slice(0, MAX_NAMES_IN_CONFIRM).map(file => `  - ${file.name}${file.type === 'directory' ? '\\' : ''}`)
  const more = targets.length > MAX_NAMES_IN_CONFIRM ? [`  외 ${targets.length - MAX_NAMES_IN_CONFIRM}개`] : []
  const message = [`로컬 PC의 ${targets.length}개 항목을 휴지통으로 이동합니다.`, '', ...listed, ...more].join('\n')
  if (!confirm(message)) return false

  try {
    const result = await window.electronAPI.localTrash(targets.map(file => joinChildPath(dirPath, file.name, 'local')))
    if (result.failures.length === 0) {
      toast.success('휴지통으로 이동', `${result.trashed}개 항목을 휴지통으로 옮겼습니다`)
    } else {
      const details = result.failures.slice(0, 3).map(f => `${f.path.split(/[\\/]/).pop()}: ${f.error}`)
      toast.error(`${result.failures.length}개 항목 삭제 실패`, details.join('\n'))
    }
    return result.trashed > 0
  } catch (error) {
    toast.error('휴지통 이동 실패', messageOf(error))
    return false
  }
}

/** "새 폴더", then "새 폴더 (2)", "새 폴더 (3)"... like Explorer */
export function nextFolderName(existingNames: string[], base = '새 폴더'): string {
  const taken = new Set(existingNames.map(name => name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}
