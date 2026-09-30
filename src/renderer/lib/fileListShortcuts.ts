/** Windows Explorer style shortcuts for the SFTP file lists */
export type FileListShortcut =
  | 'rename'
  | 'delete'
  | 'newFolder'
  | 'refresh'
  | 'back'
  | 'forward'
  | 'up'
  | 'first'
  | 'last'
  | 'clearSelection'
  | 'focusPath'
  | 'selectAll'
  /** App-wide shortcuts (terminal search, close tab) that make no sense on a file list */
  | 'swallow'

export interface ShortcutKeyEvent {
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

interface Binding {
  /** Matched against `key` for named keys, `code` for letters (layout / IME independent) */
  key?: string
  code?: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  action: FileListShortcut
}

const BINDINGS: Binding[] = [
  { key: 'F2', action: 'rename' },
  { key: 'Delete', action: 'delete' },
  { key: 'F5', action: 'refresh' },
  { key: 'Home', action: 'first' },
  { key: 'End', action: 'last' },
  { key: 'Escape', action: 'clearSelection' },
  { key: 'ArrowLeft', alt: true, action: 'back' },
  { key: 'ArrowRight', alt: true, action: 'forward' },
  { key: 'ArrowUp', alt: true, action: 'up' },
  { code: 'KeyN', ctrl: true, shift: true, action: 'newFolder' },
  { code: 'KeyL', ctrl: true, action: 'focusPath' },
  { code: 'KeyA', ctrl: true, action: 'selectAll' },
  { code: 'KeyF', ctrl: true, action: 'swallow' },
  { code: 'KeyW', ctrl: true, action: 'swallow' }
]

const matches = (binding: Binding, event: ShortcutKeyEvent) =>
  (binding.key ? event.key === binding.key : event.code === binding.code) &&
  Boolean(binding.ctrl) === (event.ctrlKey || event.metaKey) &&
  Boolean(binding.shift) === event.shiftKey &&
  Boolean(binding.alt) === event.altKey

export function resolveFileListShortcut(event: ShortcutKeyEvent): FileListShortcut | null {
  return BINDINGS.find(binding => matches(binding, event))?.action ?? null
}
