// Reading a key press as a shortcut binding (settings > 단축키), and checking a binding before it
// is saved. Bindings are stored the way the defaults are written: ['Ctrl', 'Shift', 'P'].
// "Ctrl" is the app's main modifier: the Control key on Windows and Linux, the Command key on
// macOS (lib/shortcutModifiers.ts), so a saved binding means the same thing on every system.

export interface KeyPress {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type CaptureResult =
  /** Only modifier keys are down so far: keep waiting */
  | { kind: 'waiting' }
  | { kind: 'keys'; keys: string[] }
  | { kind: 'invalid'; reason: string }

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS'])

/** Keys named by their place on the keyboard, so the Korean input mode ('ㅔ' for P) does not matter */
const CODE_KEYS: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Backquote: '`', Minus: '-', Equal: '+', Tab: 'Tab',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert'
}

/** The binding's main key for a key press, or null for a key that cannot be bound (Enter, Space, Esc...) */
export function mainKeyOf(press: Pick<KeyPress, 'key' | 'code'>): string | null {
  const { code } = press
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return CODE_KEYS[code] ?? null
}

const isFunctionKey = (key: string) => /^F([1-9]|1[0-9]|2[0-4])$/.test(key)

/** Clipboard and edit keys: taken by the terminal, the editors and (on macOS) the menu */
const RESERVED_WITH_CTRL = new Set(['C', 'V', 'X', 'A', 'Z'])
/** macOS menu and system keys with Command */
const RESERVED_ON_MAC = new Set(['Q', 'H', 'M'])

/** Modifiers first, in a fixed order, then the key */
export function normalizeKeys(keys: readonly string[]): string[] {
  const has = (name: string) => keys.some(key => key.toLowerCase() === name)
  const main = keys.filter(key => !['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd', 'command'].includes(key.toLowerCase()))
  return [
    ...(has('ctrl') || has('control') || has('meta') || has('cmd') || has('command') ? ['Ctrl'] : []),
    ...(has('alt') ? ['Alt'] : []),
    ...(has('shift') ? ['Shift'] : []),
    ...main.slice(0, 1).map(key => (key.length === 1 ? key.toUpperCase() : key))
  ]
}

export const sameBinding = (a: readonly string[], b: readonly string[]): boolean =>
  normalizeKeys(a).join('+') === normalizeKeys(b).join('+')

/** Why a binding cannot be used, or null when it can */
export function bindingProblem(keys: readonly string[], isMac: boolean): string | null {
  const normal = normalizeKeys(keys)
  const main = normal[normal.length - 1]
  const hasCtrl = normal.includes('Ctrl')
  const hasAlt = normal.includes('Alt')
  if (!main || ['Ctrl', 'Alt', 'Shift'].includes(main)) return '글자나 숫자, 기능 키를 함께 눌러 주세요.'
  if (!hasCtrl && !hasAlt && !isFunctionKey(main)) {
    return isMac ? 'Command 나 Option 과 함께 누르거나 기능 키(F1~F12)를 쓰세요.' : 'Ctrl 이나 Alt 와 함께 누르거나 기능 키(F1~F12)를 쓰세요.'
  }
  if (hasCtrl && !hasAlt && !normal.includes('Shift') && RESERVED_WITH_CTRL.has(main)) {
    return '복사·붙여넣기·실행 취소에 쓰는 키라서 지정할 수 없습니다.'
  }
  if (isMac && hasCtrl && !hasAlt && !normal.includes('Shift') && RESERVED_ON_MAC.has(main)) {
    return 'macOS 가 쓰는 키(종료·가리기·최소화)라서 지정할 수 없습니다.'
  }
  return null
}

/** What a key press means while a binding is being recorded */
export function captureKeys(press: KeyPress, isMac: boolean): CaptureResult {
  if (MODIFIER_KEYS.has(press.key)) return { kind: 'waiting' }
  const main = mainKeyOf(press)
  if (!main) return { kind: 'invalid', reason: '이 키는 단축키로 쓸 수 없습니다.' }
  // macOS: Command is the main modifier. Control is the shell's, except with Tab (Cmd+Tab is the system's).
  let hasMain: boolean
  if (isMac) {
    if (main === 'Tab') {
      if (press.metaKey) return { kind: 'invalid', reason: 'Command+Tab 은 macOS 가 앱 전환에 씁니다. Control+Tab 을 쓰세요.' }
      hasMain = press.ctrlKey
    } else {
      if (press.ctrlKey) return { kind: 'invalid', reason: 'Control 은 터미널의 셸이 쓰는 키입니다. Command 와 함께 눌러 주세요.' }
      hasMain = press.metaKey
    }
  } else {
    if (press.metaKey) return { kind: 'invalid', reason: 'Windows 키는 단축키에 쓸 수 없습니다.' }
    hasMain = press.ctrlKey
  }
  const keys = normalizeKeys([...(hasMain ? ['Ctrl'] : []), ...(press.altKey ? ['Alt'] : []), ...(press.shiftKey ? ['Shift'] : []), main])
  const problem = bindingProblem(keys, isMac)
  return problem ? { kind: 'invalid', reason: problem } : { kind: 'keys', keys }
}

export interface BoundShortcut {
  id: string
  keys: string[]
  description: string
}

/** Another shortcut that already uses the binding */
export function findConflict(
  shortcuts: readonly BoundShortcut[],
  customBindings: Readonly<Record<string, string[]>>,
  id: string,
  keys: readonly string[]
): BoundShortcut | null {
  return shortcuts.find(shortcut => shortcut.id !== id && sameBinding(customBindings[shortcut.id] ?? shortcut.keys, keys)) ?? null
}

/** Saved custom bindings; anything that is not a list of key names per shortcut id is dropped */
export function parseCustomBindings(raw: string | null | undefined, knownIds: readonly string[]): Record<string, string[]> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const result: Record<string, string[]> = {}
    for (const [id, keys] of Object.entries(value as Record<string, unknown>)) {
      if (!knownIds.includes(id) || !Array.isArray(keys) || keys.length === 0 || keys.length > 4) continue
      if (!keys.every(key => typeof key === 'string' && key.length > 0 && key.length <= 12)) continue
      result[id] = normalizeKeys(keys as string[])
    }
    return result
  } catch {
    return {}
  }
}
