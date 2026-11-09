// Text handling of the server file window: line endings kept as the file had them, and labels.

export type LineEnding = 'lf' | 'crlf' | 'mixed' | 'none'

/** Which line breaks the text uses. A lone \r (old Mac files) counts as mixed. */
export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) || []).length
  const lf = (text.match(/\n/g) || []).length - crlf
  const cr = (text.match(/\r/g) || []).length - crlf
  if (crlf === 0 && lf === 0 && cr === 0) return 'none'
  if (cr > 0 || (crlf > 0 && lf > 0)) return 'mixed'
  return crlf > 0 ? 'crlf' : 'lf'
}

/** The editor works with \n only. */
export function toEditorText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Back to the file's own line breaks: a CRLF file stays CRLF; anything else is saved with \n. */
export function fromEditorText(text: string, ending: LineEnding): string {
  return ending === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

export const LINE_ENDING_LABELS: Record<LineEnding, string> = {
  lf: 'LF',
  crlf: 'CRLF',
  mixed: '섞임 → LF',
  none: 'LF'
}

export function fileNameOf(remotePath: string): string {
  const parts = remotePath.split('/').filter(Boolean)
  return parts[parts.length - 1] || remotePath
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 2026-11-05 15:12:00 */
export function formatClock(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Whether the server file window should open a file for editing or only show it. */
export function canEditFile(file: { isDirectory?: boolean; size?: number }, maxBytes: number): boolean {
  return !file.isDirectory && (file.size ?? 0) <= maxBytes
}

export const EDIT_MAX_BYTES = 5 * 1024 * 1024

// Shown as an image or PDF in the file window (src/remoteFiles/fileKind.js), so never followed as a log
const MEDIA_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'pdf'])

/** Whether "실시간 보기" fits the file: any file the window shows as text. */
export function canFollowFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot <= 0 || !MEDIA_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}
