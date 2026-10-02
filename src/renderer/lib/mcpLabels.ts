import type { McpAlertLevel, McpAuditOutcome, McpRiskLevel } from '../types'

const MIN_PORT = 1024
const MAX_PORT = 65535
const TOKEN_EDGE = 4
const TOKEN_MASK = '•'.repeat(12)

export const RISK_LABELS: Record<McpRiskLevel, string> = {
  low: '낮음',
  medium: '중간',
  danger: '위험',
  forbidden: '차단'
}

export const OUTCOME_LABELS: Record<McpAuditOutcome, string> = {
  executed: '실행',
  approved: '허용 후 실행',
  denied: '거부',
  expired: '미응답(만료)',
  cancelled: '취소',
  blocked: '차단',
  failed: '실패'
}

export const ALERT_LEVEL_OPTIONS: { value: McpAlertLevel; label: string; description: string }[] = [
  { value: 'danger', label: '위험만 (기본)', description: '서버 상태를 바꾸는 명령과 처음 보는 명령만 확인합니다.' },
  { value: 'medium', label: '중간 이상', description: '비밀 정보 경로 읽기, 전체 탐색, 외부 요청도 확인합니다.' },
  { value: 'all', label: '모든 명령', description: 'ls 같은 조회 명령까지 모두 확인합니다.' }
]

export function maskToken(token: string): string {
  if (token.length <= TOKEN_EDGE * 2) return '••••'
  return `${token.slice(0, TOKEN_EDGE)}${TOKEN_MASK}${token.slice(-TOKEN_EDGE)}`
}

/** The register command as shown on screen; the main process hides both while the app is locked */
export function maskRegisterCommand(command: string, token: string, shownToken: string): string {
  if (!command || !token) return '••••'
  return command.split(token).join(shownToken)
}

export function parsePort(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const port = Number(trimmed)
  return port >= MIN_PORT && port <= MAX_PORT ? port : null
}

export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

export function formatAuditTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// Characters that are invisible, or that look like an ordinary space, or that change how the text
// around them is laid out. Shown as tokens so nobody approves text that reads differently from what it is.
//   controls: C0/C1 except \n and \t
//   invisible: soft hyphen, combining grapheme joiner, Hangul and other fillers, Mongolian selectors,
//              zero-width characters, word joiner and invisible operators, variation selectors, BOM,
//              interlinear annotation marks, tag characters
//   layout: bidi marks, embeddings, overrides and isolates, line and paragraph separators
//   space look-alikes: no-break space, ogham space, en/em and other fixed spaces, ideographic space, braille blank
const HIDDEN_CHARS = new RegExp(
  '[' +
  '\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F' +
  '\\u00AD\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180E\\u200B-\\u200D\\u2060-\\u2064\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB' +
  '\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}' +
  '\\u061C\\u200E\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u206F' +
  '\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u2800\\u3000' +
  ']',
  'gu'
)

const token = (char: string): string => `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`

/** Replace invisible or deceptive characters with visible ⟨U+XXXX⟩ tokens */
export function revealHiddenChars(text: string): { text: string; hasHidden: boolean } {
  let hasHidden = false
  const revealed = text.replace(HIDDEN_CHARS, (char) => {
    hasHidden = true
    return token(char)
  })
  return { text: revealed, hasHidden }
}

/**
 * A file path for the approval dialog. A path is one line, so a line break or a tab in it is as
 * suspicious as a hidden character, and so is a blank at either end ("/etc/hosts " is another file).
 */
export function revealPath(path: string): { text: string; hasHidden: boolean } {
  const revealed = revealHiddenChars(path)
  const text = revealed.text
    .replace(/[\n\t]/g, token)
    .replace(/^ +| +$/g, (blanks) => token(' ').repeat(blanks.length))
  return { text, hasHidden: revealed.hasHidden || text !== revealed.text }
}
