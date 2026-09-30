export type NameValidation = { ok: true; name: string } | { ok: false; error: string }

interface ValidateOptions {
  /** Local Windows paths: forbid \ : * ? " < > |, trailing dots and reserved device names */
  windowsRules: boolean
  existingNames: string[]
  /** The entry being renamed; it may keep its name or change only its case */
  currentName?: string
}

const WINDOWS_FORBIDDEN = /[\\/:*?"<>|]/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Validate and normalize (trim) a name typed for rename / new folder */
export function validateNewName(input: string, { windowsRules, existingNames, currentName }: ValidateOptions): NameValidation {
  const name = input.trim()
  if (!name) return { ok: false, error: '이름을 입력하세요.' }
  if (name === '.' || name === '..') return { ok: false, error: '사용할 수 없는 이름입니다.' }
  if (name.includes('/') || name.includes('\0')) return { ok: false, error: '이름에 / 문자는 사용할 수 없습니다.' }

  if (windowsRules) {
    if (WINDOWS_FORBIDDEN.test(name)) return { ok: false, error: '다음 문자는 사용할 수 없습니다: \\ / : * ? " < > |' }
    if (name.endsWith('.')) return { ok: false, error: '이름은 마침표로 끝날 수 없습니다.' }
    if (WINDOWS_RESERVED.test(name)) return { ok: false, error: 'Windows 예약어라 사용할 수 없는 이름입니다.' }
  }

  // Windows disks are case-insensitive; remote (Unix) file systems are not
  const normalize = (value: string) => (windowsRules ? value.toLowerCase() : value)
  const isSelf = currentName !== undefined && normalize(currentName) === normalize(name)
  if (!isSelf && existingNames.some(existing => normalize(existing) === normalize(name))) {
    return { ok: false, error: '같은 이름의 항목이 이미 있습니다.' }
  }
  return { ok: true, name }
}
