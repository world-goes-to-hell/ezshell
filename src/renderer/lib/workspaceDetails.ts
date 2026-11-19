// Small rules of the workspace panel's file tree and Git views (components/Workspace/WorkspaceDetails.tsx).
import type { WorkspaceGitFileKind } from '../types'

const MEDIA = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'pdf'])

/** Images and PDFs open in the preview; everything else in the editor */
export function isMediaFile(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 && MEDIA.has(base.slice(dot + 1).toLowerCase())
}

/** A path relative to the panel's root, with forward slashes */
export const joinRelative = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name)

export type DiffLineKind = 'hunk' | 'add' | 'remove' | 'context' | 'note'

/** How a line of a unified diff is drawn */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'remove'
  if (line.startsWith('\\')) return 'note'
  return 'context'
}

export const FILE_KIND_LABELS: Record<WorkspaceGitFileKind, string> = {
  modified: '수정', added: '추가', deleted: '삭제', renamed: '이름 바꿈', copied: '복사', conflict: '충돌', untracked: '새 파일'
}

/** The one-letter mark of a change, as Git shows it */
export const FILE_KIND_MARKS: Record<WorkspaceGitFileKind, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', conflict: 'U', untracked: 'U'
}

/** The last part of a path and the folder before it, for a short row */
export function splitPath(file: string): { name: string; folder: string } {
  const index = file.lastIndexOf('/')
  return index < 0 ? { name: file, folder: '' } : { name: file.slice(index + 1), folder: file.slice(0, index) }
}
