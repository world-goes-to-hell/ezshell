/**
 * Files dropped on the app from the OS file manager, and where they are on this PC.
 * Electron 32 removed `File.path`; the preload's getPathForFile (webUtils) gives the path instead.
 * `file.path` is read first so the app keeps working on Electron 28, where the preload cannot always
 * tell (a File that crossed the context bridge may have lost it).
 */

interface DroppedFile {
  name: string
}

export interface DroppedPaths {
  paths: { name: string; localPath: string }[]
  /** Files whose place on this PC could not be told: they are not uploaded */
  missing: number
}

export function droppedFilePaths(files: readonly DroppedFile[], getPathForFile?: (file: File) => string): DroppedPaths {
  const paths: DroppedPaths['paths'] = []
  let missing = 0
  for (const file of files) {
    const own = (file as { path?: unknown }).path
    let localPath = typeof own === 'string' ? own : ''
    if (!localPath && typeof getPathForFile === 'function') {
      try {
        localPath = getPathForFile(file as unknown as File) || ''
      } catch {
        localPath = ''
      }
    }
    if (localPath) paths.push({ name: file.name, localPath })
    else missing += 1
  }
  return { paths, missing }
}

/** The line shown after a drop: never "done" for files that were not sent */
export function dropUploadStatus(queued: number, missing: number): string {
  if (queued === 0) return '업로드 실패: 파일의 위치를 알 수 없습니다'
  if (missing > 0) return `${queued}개 파일 업로드 시작 · ${missing}개는 위치를 알 수 없어 제외`
  return `${queued}개 파일 업로드 시작`
}

/** Images the chat attaches as pictures (as its 이미지 첨부 button does); other dropped files go in as paths */
export const CHAT_IMAGE_FILE = /\.(png|jpe?g)$/i

/**
 * What a drop on a local terminal types: the files' paths on one line, quoted where the shell would split or
 * read them, then a space (2026-11-27 user request). The same quoting as a pasted screenshot's path
 * (src/ipc/localTerminalClipboard.js saveImage), which Claude Code and Codex take as an attachment. A path
 * with a control character is left out: a line break in it would press Enter.
 */
export function terminalDropText(paths: readonly string[], platform: 'win32' | 'posix' = 'win32'): string {
  const quoted = paths
    .filter(item => item && !/[\x00-\x1f\x7f]/.test(item))
    .map(item => platform === 'win32'
      ? (/[\s'&()$!;`,{}@#]/.test(item) ? `'${item.replace(/'/g, "''")}'` : item)
      : (/[^\w./-]/.test(item) ? `'${item.replace(/'/g, "'\\''")}'` : item))
  return quoted.length ? quoted.join(' ') + ' ' : ''
}
