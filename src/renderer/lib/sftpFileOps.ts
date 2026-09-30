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

/** Parent folder of `dirPath`, or null at the root. Windows paths stay on their own drive. */
export function parentPath(dirPath: string, side: PaneSide): string | null {
  if (side === 'local' && isWindowsPath(dirPath)) {
    const parts = dirPath.split('\\').filter(Boolean)
    if (parts.length <= 1) return null
    return parts.length === 2 ? `${parts[0]}\\` : parts.slice(0, -1).join('\\')
  }
  const parts = dirPath.split('/').filter(Boolean)
  if (parts.length === 0) return null
  return parts.length === 1 ? '/' : `/${parts.slice(0, -1).join('/')}`
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

interface MoveParams {
  side: PaneSide
  /** Folder the entries are listed in */
  dirPath: string
  names: string[]
  /** Folder to move them into (a child folder or the parent) */
  targetDir: string
}

export interface MoveDeps {
  confirm: (message: string) => boolean
  /** Move one entry into `targetDir` keeping its name; throws with a readable message on failure */
  move: (sourcePath: string, targetDir: string) => Promise<void>
}

const normalizeDir = (dirPath: string) => (dirPath.length > 1 ? dirPath.replace(/[\\/]+$/, '') : dirPath)
const samePathOnSide = (a: string, b: string, side: PaneSide) => (side === 'local' && isWindowsPath(a)
  ? normalizeDir(a).toLowerCase() === normalizeDir(b).toLowerCase()
  : normalizeDir(a) === normalizeDir(b))

/** Default move for each pane: SFTP rename on the server, local-move IPC on this PC. */
export function moveDepsFor(side: PaneSide, sessionId: string): MoveDeps {
  return {
    confirm: (message) => window.confirm(message),
    move: async (sourcePath, targetDir) => {
      if (side === 'remote') {
        const name = sourcePath.split('/').pop() ?? ''
        try {
          await window.electronAPI.sftpRename(sessionId, sourcePath, joinChildPath(targetDir, name, 'remote'))
        } catch (error) {
          throw new Error(describeRemoteError(error))
        }
        return
      }
      if (!window.electronAPI.localMove) throw new Error('앱을 다시 시작한 뒤 사용할 수 있습니다')
      const result = await window.electronAPI.localMove(sourcePath, targetDir)
      if (!result.success) throw new Error(result.error)
    }
  }
}

export interface MoveResult {
  /** Names that were moved out of the current folder */
  moved: string[]
  failed: number
}

/**
 * Move entries of the current folder into `targetDir` after confirmation (drag and drop onto a folder).
 * Keeps going when one entry fails and reports failures together.
 */
export async function moveEntries({ side, dirPath, names, targetDir }: MoveParams, deps: MoveDeps): Promise<MoveResult> {
  const nothing: MoveResult = { moved: [], failed: 0 }
  const sources = names
    .map(name => ({ name, path: joinChildPath(dirPath, name, side) }))
    .filter(source => !samePathOnSide(source.path, targetDir, side))
  if (sources.length === 0 || samePathOnSide(dirPath, targetDir, side)) return nothing

  const where = side === 'remote' ? '원격 서버' : '로컬 PC'
  const listed = sources.slice(0, MAX_NAMES_IN_CONFIRM).map(source => `  - ${source.name}`)
  const more = sources.length > MAX_NAMES_IN_CONFIRM ? [`  외 ${sources.length - MAX_NAMES_IN_CONFIRM}개`] : []
  const message = [`${where}의 ${sources.length}개 항목을 옮깁니다.`, '', ...listed, ...more, '', `대상 폴더: ${targetDir}`].join('\n')
  if (!deps.confirm(message)) return nothing

  const failures: string[] = []
  const moved: string[] = []
  for (const source of sources) {
    try {
      await deps.move(source.path, targetDir)
      moved.push(source.name)
    } catch (error) {
      failures.push(`${source.name}: ${messageOf(error)}`)
    }
  }

  if (failures.length > 0) {
    toast.error(`${failures.length}개 항목 이동 실패`, failures.slice(0, 3).join('\n'))
  }
  if (moved.length > 0) toast.success('이동 완료', `${moved.length}개 항목을 옮겼습니다`)
  return { moved, failed: failures.length }
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
