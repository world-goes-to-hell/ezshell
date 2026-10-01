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

// C0/C1 controls (except \n and \t), zero-width characters and bidi controls
const HIDDEN_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏⁠﻿‪-‮⁦-⁩]/g

/** Replace invisible or deceptive characters with visible ⟨U+XXXX⟩ tokens */
export function revealHiddenChars(text: string): { text: string; hasHidden: boolean } {
  let hasHidden = false
  const revealed = text.replace(HIDDEN_CHARS, (char) => {
    hasHidden = true
    return `⟨U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`
  })
  return { text: revealed, hasHidden }
}
