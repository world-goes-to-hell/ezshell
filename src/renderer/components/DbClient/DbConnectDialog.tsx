import { useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiDatabase2Line, RiLoader4Line, RiShieldCheckLine } from 'react-icons/ri'
import { useSessionStore } from '../../stores/sessionStore'
import { DEFAULT_PORTS, endpointProblem, removeSavedConnection, upsertSavedConnection } from '../../lib/dbChoices'
import type { DbEndpoint, SavedDbConnection } from '../../types/db'

export interface DbConnectTarget {
  /** The tab whose SSH connection carries the tunnel */
  sessionId: string
  sessionName: string
  /** Sidebar session the account can be saved with (null for quick connects) */
  savedSessionId: string | null
  /** Found or saved database; null = typed in by the user */
  endpoint: DbEndpoint | null
  saved: SavedDbConnection | null
}

type Engine = 'mysql' | 'postgres'

interface DbConnectDialogProps {
  target: DbConnectTarget
  onClose: () => void
}

/**
 * Account form for a database reached through the tab's SSH server. Connecting checks the account
 * at once (main opens the DB window only when the login worked); saving keeps it with the session,
 * encrypted with the other session data.
 */
export function DbConnectDialog({ target, onClose }: DbConnectDialogProps) {
  const { saved, endpoint } = target
  const isTyped = endpoint === null
  const [engine, setEngine] = useState<Engine>(endpoint?.engine === 'postgres' ? 'postgres' : 'mysql')
  const [host, setHost] = useState(endpoint?.host ?? '127.0.0.1')
  const [port, setPort] = useState(String(endpoint?.port ?? DEFAULT_PORTS.mysql))
  const [user, setUser] = useState(saved?.user ?? '')
  const [password, setPassword] = useState(saved?.password ?? '')
  const [database, setDatabase] = useState(saved?.database ?? '')
  const [isSaving, setIsSaving] = useState(saved !== null)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const updateSession = useSessionStore(state => state.updateSession)
  const saveToBackend = useSessionStore(state => state.saveToBackend)
  const session = useSessionStore(state => (target.savedSessionId ? state.sessions.find(s => s.id === target.savedSessionId) : undefined))

  const changeEngine = (next: Engine): void => {
    if (port === String(DEFAULT_PORTS[engine])) setPort(String(DEFAULT_PORTS[next]))
    setEngine(next)
  }

  const storeAccounts = async (next: SavedDbConnection[]): Promise<void> => {
    if (!session) return
    updateSession(session.id, { dbConnections: next })
    await saveToBackend()
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const problem = endpointProblem({ host, port }, user)
    if (problem) {
      setError(problem)
      return
    }
    const chosen: DbEndpoint = { engine, host: host.trim(), port: Number(port) }
    setIsBusy(true)
    setError(null)
    const result = await window.electronAPI.dbOpen?.(target.sessionId, target.sessionName, chosen, { user: user.trim(), password, database: database.trim() })
    setIsBusy(false)
    if (!result) {
      setError('앱을 다시 시작한 뒤에 사용할 수 있습니다.')
      return
    }
    if (!result.success) {
      setError(result.error)
      return
    }
    if (session && isSaving) {
      const account: SavedDbConnection = {
        id: saved?.id ?? crypto.randomUUID(),
        ...chosen,
        user: user.trim(),
        password,
        database: database.trim() || undefined
      }
      await storeAccounts(upsertSavedConnection(session.dbConnections ?? [], account))
    } else if (session && saved && !isSaving) {
      await storeAccounts(removeSavedConnection(session.dbConnections ?? [], saved.id))
    }
    onClose()
  }

  return (
    <Dialog.Root open onOpenChange={(isOpen) => { if (!isOpen && !isBusy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content db-connect-dialog" aria-describedby="db-connect-note">
          <Dialog.Title className="modal-title">
            <RiDatabase2Line size={18} aria-hidden="true" />
            DB 접속 · {target.sessionName}
          </Dialog.Title>
          <p id="db-connect-note" className="db-connect-note">
            <RiShieldCheckLine size={15} aria-hidden="true" />
            <span>이 탭의 SSH 연결을 거쳐 <strong>읽기 전용</strong>으로 접속합니다. DB 서버가 쓰기를 막고, 쿼리는 30초·1,000행까지입니다.</span>
          </p>
          <form onSubmit={(e) => void submit(e)}>
            <div className="form-row">
              <div className="form-group flex-1">
                <label htmlFor="db-engine">종류</label>
                <select id="db-engine" value={engine} disabled={!isTyped} onChange={(e) => changeEngine(e.target.value as Engine)}>
                  <option value="mysql">MySQL / MariaDB</option>
                  <option value="postgres">PostgreSQL</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group flex-1">
                <label htmlFor="db-host">호스트 (SSH 서버에서 본 주소)</label>
                <input id="db-host" value={host} disabled={!isTyped} onChange={(e) => setHost(e.target.value)} spellCheck={false} />
              </div>
              <div className="form-group db-port-field">
                <label htmlFor="db-port">포트</label>
                <input id="db-port" value={port} disabled={!isTyped} inputMode="numeric" onChange={(e) => setPort(e.target.value)} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group flex-1">
                <label htmlFor="db-user">사용자</label>
                <input id="db-user" value={user} autoFocus onChange={(e) => setUser(e.target.value)} spellCheck={false} autoComplete="off" />
              </div>
              <div className="form-group flex-1">
                <label htmlFor="db-password">비밀번호</label>
                <input id="db-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="db-database">데이터베이스 (선택)</label>
              <input id="db-database" value={database} onChange={(e) => setDatabase(e.target.value)} spellCheck={false}
                placeholder={engine === 'postgres' ? '비우면 사용자 이름과 같은 DB' : '비우면 접속 뒤 고를 수 있음'} />
            </div>
            <div className="form-group checkbox-group">
              <label>
                <input type="checkbox" checked={isSaving && Boolean(session)} disabled={!session} onChange={(e) => setIsSaving(e.target.checked)} />
                <span>{session ? '이 세션에 저장 (비밀번호 포함, 세션 파일과 함께 암호화)' : '저장한 세션에서만 계정을 저장할 수 있습니다'}</span>
              </label>
            </div>
            {error && <p className="db-connect-error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary modal-btn" onClick={onClose} disabled={isBusy}>취소</button>
              <button type="submit" className="btn-primary modal-btn" disabled={isBusy}>
                {isBusy ? <><RiLoader4Line className="spinning" size={14} aria-hidden="true" /> 접속 중…</> : '접속'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
