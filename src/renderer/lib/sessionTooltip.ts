// Text for the session hover card in the sidebar (components/Sidebar/SessionTooltip.tsx).
// Secrets (passwords, passphrases, key file paths, post-connect scripts) are never shown.

import type { Folder, Session } from '../stores/sessionStore'

export const DEFAULT_SSH_PORT = 22

export interface SessionDetail {
  label: string
  value: string
}

export function formatAddress(username: string | undefined, host: string, port?: number): string {
  const user = username ? `${username}@` : ''
  const suffix = port && port !== DEFAULT_SSH_PORT ? `:${port}` : ''
  return `${user}${host}${suffix}`
}

/** "개발 / 생물다양성" for nested folders; stops on a missing parent or a cycle */
export function folderPath(folderId: string | undefined, folders: Folder[]): string | undefined {
  if (!folderId) return undefined
  const byId = new Map(folders.map(f => [f.id, f]))
  const names: string[] = []
  const seen = new Set<string>()
  let current = byId.get(folderId)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    names.unshift(current.name)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return names.length > 0 ? names.join(' / ') : undefined
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatRelativeTime(iso: string, now: number): string | undefined {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return undefined
  const diff = Math.max(0, now - time)
  if (diff < MINUTE) return '방금 전'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}분 전`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}시간 전`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}일 전`
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function buildSessionDetails(
  session: Session,
  folders: Folder[],
  lastConnectedAt: string | undefined,
  now: number
): SessionDetail[] {
  const details: SessionDetail[] = []
  const path = folderPath(session.folderId, folders)
  if (path) details.push({ label: '폴더', value: path })

  details.push({ label: '인증', value: session.authType === 'privateKey' ? '키 파일' : '비밀번호' })

  if (session.useJumpHost && session.jumpHost) {
    details.push({ label: '점프 호스트', value: formatAddress(session.jumpUsername, session.jumpHost, session.jumpPort) })
  }
  if (session.suRoot) details.push({ label: '로그인 후', value: 'root 로 전환 (su -)' })

  const dbCount = session.dbConnections?.length ?? 0
  if (dbCount > 0) details.push({ label: 'DB 계정', value: `${dbCount}개 저장됨` })

  if (session.autoReconnect) details.push({ label: '재연결', value: '자동' })

  const last = lastConnectedAt ? formatRelativeTime(lastConnectedAt, now) : undefined
  if (last) details.push({ label: '최근 접속', value: last })

  return details
}
