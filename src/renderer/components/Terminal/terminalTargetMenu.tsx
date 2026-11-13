import type { Terminal } from 'xterm'
import { RiEyeLine, RiFileEditLine, RiPulseLine, RiDownloadLine, RiFolderOpenLine, RiFileCopyLine, RiCornerDownRightLine } from 'react-icons/ri'
import { cleanName, needsHome, resolveName, splitPath, wordAtColumn, type TerminalCell } from '../../lib/terminalTarget'
import { EDIT_MAX_BYTES, canFollowFile } from '../../lib/remoteFileText'
import { openRemoteFileWindow } from '../../lib/remoteFileOpen'
import { openSftpAt } from '../../lib/sftpSync'
import { shellQuote } from '../../lib/terminalFind'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { formatBytes } from '../../lib/mcpLabels'
import { toast } from '../../stores/toastStore'
import type { TerminalMenuItem } from './TerminalContextMenu'
import { fileZoneOf } from './terminalFileZone'

/** A file or folder on the server that the right-clicked word names */
export interface TerminalTarget {
  path: string
  name: string
  isDirectory: boolean
  size: number
}

/** The logical line under a screen row (a line the terminal wrapped is put back together) as cells */
function cellsAt(terminal: Terminal, screenRow: number): { cells: TerminalCell[]; offset: number } | null {
  const buffer = terminal.buffer.active
  let first = buffer.viewportY + screenRow
  if (!buffer.getLine(first)) return null
  const clicked = first
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--
  const cells: TerminalCell[] = []
  let offset = 0
  for (let row = first; ; row++) {
    const line = buffer.getLine(row)
    if (!line || (row > first && !line.isWrapped)) break
    if (row === clicked) offset = cells.length
    for (let x = 0; x < terminal.cols; x++) {
      const cell = line.getCell(x)
      cells.push({ text: cell?.getChars() ?? '', width: cell?.getWidth() ?? 1 })
    }
  }
  return { cells, offset }
}

/**
 * The name the pointer is on: a selection of one line if there is one (names with spaces), otherwise
 * the word under the pointer. Null in a full-screen program (vim, htop) and on empty space.
 */
export function nameAtPointer(terminal: Terminal, clientX: number, clientY: number): string | null {
  if (terminal.buffer.active.type === 'alternate') return null
  // In a tab's main terminal a relative name counts only inside the file zone (output since the last cd)
  const zone = fileZoneOf(terminal)
  const allowed = (name: string | null, row: number): string | null => (name && (!zone || zone.allows(name, row)) ? name : null)
  const selection = terminal.getSelection()
  if (selection && !/[\r\n]/.test(selection.trim())) {
    return allowed(cleanName(selection), (terminal.getSelectionPosition()?.start.y ?? 1) - 1)
  }
  const screen = terminal.element?.querySelector('.xterm-screen')
  if (!screen) return null
  const box = screen.getBoundingClientRect()
  if (box.width === 0 || box.height === 0) return null
  const column = Math.floor((clientX - box.left) / (box.width / terminal.cols))
  const row = Math.floor((clientY - box.top) / (box.height / terminal.rows))
  if (column < 0 || column >= terminal.cols || row < 0 || row >= terminal.rows) return null
  const line = cellsAt(terminal, row)
  return line ? allowed(cleanName(wordAtColumn(line.cells, line.offset + column)), terminal.buffer.active.viewportY + row) : null
}

/** How long an answer about a path is reused (hovering a line asks about each of its words) */
const REMEMBER_MS = 60_000
const remembered = new Map<string, { at: number; target: TerminalTarget | null }>()
// The login folder of a session does not change: asked once, not for every word of a line
const homes = new Map<string, Promise<string | null>>()
const knownHomes = new Map<string, string>()

function homeOf(sessionId: string): Promise<string | null> {
  let home = homes.get(sessionId)
  if (!home) {
    home = Promise.resolve(window.electronAPI.sftpRealpath?.(sessionId, '.') ?? null)
      .then((path) => {
        if (path) knownHomes.set(sessionId, path)
        // A failed question is asked again next time
        else homes.delete(sessionId)
        return path
      })
      .catch(() => {
        homes.delete(sessionId)
        return null
      })
    homes.set(sessionId, home)
  }
  return home
}

const remembering = (sessionId: string, path: string): { at: number; target: TerminalTarget | null } | undefined => {
  const known = remembered.get(`${sessionId}\n${path}`)
  return known && Date.now() - known.at < REMEMBER_MS ? known : undefined
}

/**
 * What is already known about a name, without asking the server: the target, null (not a file
 * there), or undefined when the server has to be asked.
 */
export function knownTarget(sessionId: string, name: string, cwd: string | undefined): TerminalTarget | null | undefined {
  const home = needsHome(name, cwd) ? knownHomes.get(sessionId) : null
  if (home === undefined) return undefined
  const path = resolveName(name, cwd, home)
  if (!path || path === '/') return null
  return remembering(sessionId, path)?.target
}

/** What the server said about a path, asked again only after a while */
async function statTarget(sessionId: string, path: string): Promise<TerminalTarget | null> {
  const key = `${sessionId}\n${path}`
  const known = remembering(sessionId, path)
  if (known) return known.target
  const stat = await window.electronAPI.sftpStat?.(sessionId, path)
  const target = stat && (stat.isFile || stat.isDirectory)
    ? { path, name: splitPath(path).name, isDirectory: stat.isDirectory, size: stat.size }
    : null
  if (remembered.size > 2000) remembered.clear()
  remembered.set(key, { at: Date.now(), target })
  return target
}

/**
 * Asks the server whether the name is a file or folder there (one SFTP stat). `cwd` is the folder
 * the terminal is in, as read from its prompt. Null when it is not, or cannot be known.
 */
export async function findTarget(sessionId: string, name: string, cwd: string | undefined): Promise<TerminalTarget | null> {
  try {
    await window.electronAPI.sftpOpen(sessionId)
    const home = needsHome(name, cwd) ? await homeOf(sessionId) : null
    const path = resolveName(name, cwd, home)
    if (!path || path === '/') return null
    return await statTarget(sessionId, path)
  } catch {
    return null
  }
}

async function download(sessionId: string, target: TerminalTarget): Promise<void> {
  const chosen = await window.electronAPI.selectDownloadPath(target.name)
  if (!chosen?.success || !chosen.path) return
  toast.info('다운로드 중', target.name)
  try {
    await window.electronAPI.sftpDownload(sessionId, target.path, chosen.path)
    toast.success('다운로드 완료', chosen.path)
  } catch (err) {
    toast.error('다운로드 실패', err instanceof Error ? err.message : String(err))
  }
}

/** What the menu's first lines say about the target */
export function targetHint(target: TerminalTarget): string {
  return target.isDirectory ? '폴더' : `파일 · ${formatBytes(target.size)}`
}

/**
 * The menu items for a file or folder named in the terminal: the same actions as its row in the
 * SFTP list. `then` wraps an action so the keyboard goes back to the terminal afterwards.
 */
export function targetItems(sessionId: string, sessionName: string, target: TerminalTarget, terminal: Terminal, then: (action: () => void) => () => void): TerminalMenuItem[] {
  const { folder } = splitPath(target.path)
  const copyPath: TerminalMenuItem = { label: '경로 복사', icon: RiFileCopyLine, onSelect: then(() => void copyToClipboard(target.path)) }
  if (target.isDirectory) {
    return [
      { label: 'SFTP 에서 열기', icon: RiFolderOpenLine, onSelect: then(() => void openSftpAt(sessionId, target.path)) },
      // Typed into the input line, not run: the user presses Enter
      { label: '이 폴더로 이동 (cd 입력)', icon: RiCornerDownRightLine, onSelect: then(() => terminal.paste(`cd ${shellQuote(target.path)}`)) },
      copyPath
    ]
  }
  const open = (mode: 'preview' | 'edit' | 'tail') => () => void openRemoteFileWindow(sessionId, sessionName, folder, target.name, mode)
  return [
    { label: '미리보기', icon: RiEyeLine, onSelect: open('preview') },
    ...(target.size <= EDIT_MAX_BYTES ? [{ label: '편집', icon: RiFileEditLine, onSelect: open('edit') }] : []),
    ...(canFollowFile(target.name) ? [{ label: '실시간 보기', icon: RiPulseLine, onSelect: open('tail') }] : []),
    { label: '다운로드', icon: RiDownloadLine, onSelect: then(() => void download(sessionId, target)) },
    { label: 'SFTP 에서 위치 열기', icon: RiFolderOpenLine, onSelect: then(() => void openSftpAt(sessionId, folder)) },
    copyPath
  ]
}
