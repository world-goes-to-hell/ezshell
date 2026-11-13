import { useEffect, useState, type FormEvent } from 'react'
import { OracleClientSetup } from './OracleClientSetup'
import * as Dialog from '@radix-ui/react-dialog'
import { RiCheckboxCircleLine, RiDatabase2Line, RiDeleteBinLine, RiLoader4Line, RiPlugLine, RiShieldCheckLine } from 'react-icons/ri'
import { useSessionStore } from '../../stores/sessionStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { DEFAULT_PORTS, endpointProblem, isConnectable, removeSavedConnection, upsertSavedConnection, type ConnectableEngine } from '../../lib/dbChoices'
import type { DbCredentials, DbEndpoint, SavedDbConnection } from '../../types/db'

export interface DbConnectTarget {
  /** The tab whose SSH connection carries the tunnel */
  sessionId: string
  sessionName: string
  /** Sidebar session the account can be saved with (null for quick connects) */
  savedSessionId: string | null
  /** Found or saved database server; null = typed in by the user */
  endpoint: DbEndpoint | null
  /** The saved account being used or edited; null = a new account */
  saved: SavedDbConnection | null
}

type Engine = ConnectableEngine
type Busy = null | 'test' | 'connect' | 'save'
type Outcome = { kind: 'error'; text: string } | { kind: 'ok'; text: string } | null

/** What the dialog says while it works (a login through the tunnel can take several seconds) */
const BUSY_TEXT: Record<Exclude<Busy, null>, string> = {
  connect: 'DB 에 접속하는 중입니다. SSH 연결로 터널을 열고 로그인합니다.',
  test: '연결을 확인하는 중입니다.',
  save: '저장하는 중입니다.'
}

interface DbConnectDialogProps {
  target: DbConnectTarget
  onClose: () => void
}

/**
 * Account form for a database reached through the tab's SSH server. One server may have several
 * saved accounts (a name tells them apart). "연결 테스트" logs in once and closes again; "접속" logs in
 * and opens the DB window; saving keeps the account with the session, encrypted with the session data.
 */
export function DbConnectDialog({ target, onClose }: DbConnectDialogProps) {
  const { saved, endpoint } = target
  const isTyped = endpoint === null
  const [engine, setEngine] = useState<Engine>(isConnectable(endpoint?.engine) ? endpoint.engine : 'mysql')
  const [host, setHost] = useState(endpoint?.host ?? '127.0.0.1')
  const [port, setPort] = useState(String(endpoint?.port ?? DEFAULT_PORTS.mysql))
  const [label, setLabel] = useState(saved?.label ?? '')
  const [user, setUser] = useState(saved?.user ?? '')
  const [password, setPassword] = useState(saved?.password ?? '')
  const [database, setDatabase] = useState(saved?.database ?? '')
  const updateSession = useSessionStore(state => state.updateSession)
  const saveToBackend = useSessionStore(state => state.saveToBackend)
  const session = useSessionStore(state => (target.savedSessionId ? state.sessions.find(s => s.id === target.savedSessionId) : undefined))
  const [isSaving, setIsSaving] = useState(Boolean(session))
  const [busy, setBusy] = useState<Busy>(null)
  const [outcome, setOutcome] = useState<Outcome>(null)
  // Seconds the current work has taken, shown once it is more than a moment
  const [busySeconds, setBusySeconds] = useState(0)
  useEffect(() => {
    setBusySeconds(0)
    if (busy === null) return
    const startedAt = Date.now()
    const timer = window.setInterval(() => setBusySeconds(Math.floor((Date.now() - startedAt) / 1000)), 500)
    return () => window.clearInterval(timer)
  }, [busy])

  const changeEngine = (next: Engine): void => {
    if (port === String(DEFAULT_PORTS[engine])) setPort(String(DEFAULT_PORTS[next]))
    setEngine(next)
  }

  /** The form as a request, or null after showing what is missing */
  const read = (): { chosen: DbEndpoint; credentials: DbCredentials } | null => {
    const problem = endpointProblem({ host, port }, user)
    if (problem) {
      setOutcome({ kind: 'error', text: problem })
      return null
    }
    return {
      chosen: { engine, host: host.trim(), port: Number(port) },
      credentials: { user: user.trim(), password, database: database.trim() }
    }
  }

  const storeAccounts = async (next: SavedDbConnection[]): Promise<void> => {
    if (!session) return
    updateSession(session.id, { dbConnections: next })
    await saveToBackend()
  }

  const accountOf = (chosen: DbEndpoint, credentials: DbCredentials): SavedDbConnection => ({
    id: saved?.id ?? crypto.randomUUID(),
    label: label.trim() || undefined,
    ...chosen,
    user: credentials.user,
    password: credentials.password,
    database: credentials.database || undefined
  })

  const runTest = async (): Promise<void> => {
    const request = read()
    if (!request) return
    setBusy('test')
    setOutcome(null)
    const result = await window.electronAPI.dbTest?.(target.sessionId, request.chosen, request.credentials)
    setBusy(null)
    if (!result) setOutcome({ kind: 'error', text: '앱을 다시 시작한 뒤에 사용할 수 있습니다.' })
    else if (!result.success) setOutcome({ kind: 'error', text: result.error })
    else {
      const guards = result.info.missingGuards.length ? ' · 일부 서버 측 제한 없음' : ''
      setOutcome({ kind: 'ok', text: `연결 성공 · ${result.info.product} ${result.info.version} · DB ${result.database || '(없음)'} · 읽기 전용 확인${guards}` })
    }
  }

  const saveOnly = async (): Promise<void> => {
    const request = read()
    if (!request || !session) return
    setBusy('save')
    await storeAccounts(upsertSavedConnection(session.dbConnections ?? [], accountOf(request.chosen, request.credentials)))
    setBusy(null)
    onClose()
  }

  const remove = async (): Promise<void> => {
    if (!session || !saved) return
    setBusy('save')
    await storeAccounts(removeSavedConnection(session.dbConnections ?? [], saved.id))
    setBusy(null)
    onClose()
  }

  const connect = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const request = read()
    if (!request) return
    setBusy('connect')
    setOutcome(null)
    let result: Awaited<ReturnType<NonNullable<typeof window.electronAPI.dbOpen>>> | undefined
    try {
      result = await window.electronAPI.dbOpen?.(target.sessionId, target.sessionName, request.chosen, request.credentials, 'tab')
    } catch (error) {
      setBusy(null)
      setOutcome({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
      return
    }
    if (!result) {
      setBusy(null)
      setOutcome({ kind: 'error', text: '앱을 다시 시작한 뒤에 사용할 수 있습니다.' })
      return
    }
    if (!result.success) {
      setBusy(null)
      setOutcome({ kind: 'error', text: result.error })
      return
    }
    if (result.dbId) openDbTab(result.dbId, `${result.info.product} · ${request.credentials.database || request.credentials.user}`, request.chosen.host, request.credentials.user)
    try {
      if (session && isSaving) {
        await storeAccounts(upsertSavedConnection(session.dbConnections ?? [], accountOf(request.chosen, request.credentials)))
      } else if (session && saved && !isSaving) {
        await storeAccounts(removeSavedConnection(session.dbConnections ?? [], saved.id))
      }
    } finally {
      onClose()
    }
  }

  /** A tab next to the current one, in the pane that has the focus (like a new SSH tab) */
  const openDbTab = (dbId: string, title: string, host: string, dbUser: string): void => {
    const store = useTerminalStore.getState()
    const id = `db:${dbId}`
    const accountLabel = label.trim() || undefined
    store.addTerminal(id, {
      id, host, username: dbUser, connected: true,
      title: accountLabel ? `${title} (${accountLabel})` : title,
      db: { dbId, sshSessionId: target.sessionId, label: accountLabel }
    })
    const { layout } = useTerminalStore.getState()
    if (layout.mode === 'split' && layout.activePaneType === 'secondary') {
      store.moveTerminalBetweenPanes(id, 'primary', 'secondary')
    }
  }

  const isBusy = busy !== null

  return (
    <Dialog.Root open onOpenChange={(isOpen) => { if (!isOpen && !isBusy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content db-connect-dialog" aria-describedby="db-connect-note">
          <Dialog.Title className="modal-title">
            <RiDatabase2Line size={18} aria-hidden="true" />
            {saved ? 'DB 계정' : 'DB 계정 추가'} · {target.sessionName}
          </Dialog.Title>
          <p id="db-connect-note" className="db-connect-note">
            <RiShieldCheckLine size={15} aria-hidden="true" />
            <span>이 탭의 SSH 연결을 거쳐 <strong>읽기 전용</strong>으로 접속합니다. DB 서버가 쓰기를 막고, 쿼리는 30초·1,000행까지입니다.</span>
          </p>
          <form onSubmit={(e) => void connect(e)} aria-busy={isBusy}>
            <fieldset className="db-connect-fields" disabled={isBusy}>
            <div className="form-row">
              <div className="form-group flex-1">
                <label htmlFor="db-engine">종류</label>
                <select id="db-engine" value={engine} disabled={!isTyped} onChange={(e) => changeEngine(e.target.value as Engine)}>
                  <option value="mysql">MySQL / MariaDB</option>
                  <option value="postgres">PostgreSQL</option>
                  <option value="mssql">SQL Server</option>
                  <option value="oracle">Oracle</option>
                </select>
              </div>
              <div className="form-group flex-1">
                <label htmlFor="db-label">계정 이름 (선택)</label>
                <input id="db-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="예: MBRIS 조회용" maxLength={60} />
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
              <label htmlFor="db-database">{engine === 'oracle' ? '서비스 이름 또는 SID' : '기본 DB (선택)'}</label>
              <input id="db-database" value={database} onChange={(e) => setDatabase(e.target.value)} spellCheck={false} required={engine === 'oracle'}
                placeholder={engine === 'oracle' ? '예: ORCL, XEPDB1 (꼭 넣어야 합니다)' : engine === 'postgres' ? '비우면 postgres DB · 접속 뒤 바꿀 수 있음' : engine === 'mssql' ? '비우면 계정의 기본 DB · 접속 뒤 바꿀 수 있음' : '비우면 접속 뒤 고를 수 있음'} />
            </div>
            <div className="form-group checkbox-group">
              <label>
                <input type="checkbox" checked={isSaving && Boolean(session)} disabled={!session} onChange={(e) => setIsSaving(e.target.checked)} />
                <span>{session ? '접속할 때 이 세션에 저장 (비밀번호 포함, 세션 파일과 함께 암호화)' : '저장한 세션에서만 계정을 저장할 수 있습니다'}</span>
              </label>
            </div>
            </fieldset>
            {busy && (
              <p className="db-connect-progress" role="status">
                <RiLoader4Line className="spinning" size={16} aria-hidden="true" />
                <span className="db-connect-progress-text">{BUSY_TEXT[busy]}</span>
                {busySeconds >= 2 && <span className="db-connect-progress-time">{busySeconds}초</span>}
              </p>
            )}
            {outcome && !busy && (
              <p className={outcome.kind === 'ok' ? 'db-connect-ok' : 'db-connect-error'} role={outcome.kind === 'ok' ? 'status' : 'alert'}>
                {outcome.kind === 'ok' && <RiCheckboxCircleLine size={14} aria-hidden="true" />} {outcome.text}
              </p>
            )}
            {engine === 'oracle' && (
              <OracleClientSetup
                isNeeded={outcome?.kind === 'error' && /NJS-138/.test(outcome.text)}
                isDisabled={Boolean(busy)}
                // Installed: the failure it explains is no longer the state of things
                onChanged={(status) => { if (status.isInstalled && !status.needsRestart) setOutcome(null) }}
              />
            )}
            <div className="modal-actions db-connect-actions">
              {saved && session && (
                <button type="button" className="btn-secondary modal-btn db-connect-delete" onClick={() => void remove()} disabled={isBusy} title="저장된 이 계정을 지웁니다">
                  <RiDeleteBinLine size={14} aria-hidden="true" /> 삭제
                </button>
              )}
              <button type="button" className="btn-secondary modal-btn db-connect-test" onClick={() => void runTest()} disabled={isBusy}>
                {busy === 'test' ? <RiLoader4Line className="spinning" size={14} aria-hidden="true" /> : <RiPlugLine size={14} aria-hidden="true" />} 연결 테스트
              </button>
              <span className="db-connect-spacer" />
              <button type="button" className="btn-secondary modal-btn" onClick={onClose} disabled={isBusy}>취소</button>
              {session && (
                <button type="button" className="btn-secondary modal-btn" onClick={() => void saveOnly()} disabled={isBusy} title="접속하지 않고 계정만 저장합니다">저장</button>
              )}
              <button type="submit" className="btn-primary modal-btn" disabled={isBusy}>
                {busy === 'connect' ? <><RiLoader4Line className="spinning" size={14} aria-hidden="true" /> 접속 중…</> : '접속'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
