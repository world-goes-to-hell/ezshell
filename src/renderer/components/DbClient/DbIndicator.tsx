import { Fragment, useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiAddLine, RiDatabase2Line, RiCheckLine, RiKey2Line, RiUserAddLine } from 'react-icons/ri'
import { useTerminalStore } from '../../stores/terminalStore'
import { useSessionStore } from '../../stores/sessionStore'
import { accountTitle, buildGroups, type DbGroup } from '../../lib/dbChoices'
import { DbConnectDialog, type DbConnectTarget } from './DbConnectDialog'
import type { DiscoveredDb, SavedDbConnection } from '../../types/db'
import './DbClient.css'

const AUTO_KEY = 'dbDiscoveryAuto'

function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'off'
  } catch {
    return true
  }
}

function writeAuto(isOn: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, isOn ? 'on' : 'off')
  } catch {
    // Only a convenience
  }
}

/**
 * Status bar entry of the DB client for the active tab: the database servers found on its server and
 * the accounts saved with its session, grouped by server (one server may have several accounts, e.g.
 * one per database). Discovery runs once per connection in main (ports and process names only).
 */
export function DbIndicator() {
  // A DB tab in front: the list is about the SSH tab its tunnel rides on
  const activeId = useTerminalStore(state => {
    const active = state.activeTerminalId ? state.terminals.get(state.activeTerminalId) : undefined
    return active?.db ? active.db.sshSessionId : state.activeTerminalId
  })
  const terminal = useTerminalStore(state => (activeId ? state.terminals.get(activeId) : undefined))
  const savedSessionId = terminal?.connectConfig?.savedSessionId
  const savedSession = useSessionStore(state => (savedSessionId ? state.sessions.find(s => s.id === savedSessionId) : undefined))
  const [foundBySession, setFoundBySession] = useState<Record<string, DiscoveredDb[]>>({})
  const [isAuto, setIsAuto] = useState(readAuto)
  const [target, setTarget] = useState<DbConnectTarget | null>(null)
  const isConnected = terminal?.connected === true

  const discover = (sessionId: string): void => {
    void window.electronAPI.dbDiscover?.(sessionId).then(result => {
      if (result?.success) setFoundBySession(current => ({ ...current, [sessionId]: result.databases }))
    })
  }

  useEffect(() => {
    if (activeId && isConnected && isAuto) discover(activeId)
  }, [activeId, isConnected, isAuto])

  const found = activeId ? foundBySession[activeId] : undefined
  const groups = useMemo(() => buildGroups(found ?? [], savedSession?.dbConnections ?? []), [found, savedSession?.dbConnections])

  if (!activeId || !terminal || !isConnected || typeof window.electronAPI.dbDiscover !== 'function') return null

  const supportedCount = groups.filter(g => g.isSupported).length
  const sessionName = terminal.title || terminal.connectConfig?.sessionName || terminal.host

  const pick = (group: DbGroup | null, account: SavedDbConnection | null): void => {
    setTarget({
      sessionId: activeId,
      sessionName,
      savedSessionId: savedSession ? savedSession.id : null,
      endpoint: group?.endpoint ?? null,
      saved: account
    })
  }

  return (
    <>
      <DropdownMenu.Root onOpenChange={(isOpen) => { if (isOpen && !found) discover(activeId) }}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className={`db-indicator${supportedCount > 0 ? ' has-db' : ''}`} title="이 탭의 서버에서 DB 에 접속">
            <RiDatabase2Line size={14} aria-hidden="true" />
            <span>DB{supportedCount > 0 ? ` ${supportedCount}` : ''}</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="db-menu" side="top" align="start" sideOffset={6} collisionPadding={8}>
            <DropdownMenu.Label className="db-menu-label">
              {found === undefined ? '이 서버의 DB 를 찾는 중…' : `${sessionName} 의 DB · 읽기 전용으로 접속`}
            </DropdownMenu.Label>
            {groups.map((group, index) => (
              <Fragment key={group.key}>
                {index > 0 && <DropdownMenu.Separator className="db-menu-separator is-light" />}
                <div className="db-menu-group" role="presentation">
                  <RiDatabase2Line size={13} className="db-menu-icon" aria-hidden="true" />
                  <span className="db-menu-title">
                    {group.label}
                    {group.isGuess && <span className="db-menu-tag">추정</span>}
                    {!group.isSupported && <span className="db-menu-tag">지원 예정</span>}
                  </span>
                  <span className="db-menu-detail">{group.detail}</span>
                </div>
                {group.accounts.map(account => (
                  <DropdownMenu.Item key={account.id} className="db-menu-item is-account" disabled={!group.isSupported} onSelect={() => pick(group, account)}>
                    <RiKey2Line size={13} className="db-menu-icon is-saved" aria-label="저장된 계정" />
                    <span className="db-menu-account">{accountTitle(account)}</span>
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Item className="db-menu-item is-account" disabled={!group.isSupported} onSelect={() => pick(group, null)}>
                  <RiUserAddLine size={13} className="db-menu-icon" aria-hidden="true" />
                  <span className="db-menu-account is-muted">{group.accounts.length > 0 ? '다른 계정으로 접속…' : '계정 입력해서 접속…'}</span>
                </DropdownMenu.Item>
              </Fragment>
            ))}
            {found !== undefined && groups.length === 0 && (
              <div className="db-menu-empty">찾은 DB 가 없습니다. 내부망의 다른 DB 는 직접 추가하세요.</div>
            )}
            <DropdownMenu.Separator className="db-menu-separator" />
            <DropdownMenu.Item className="db-menu-item" onSelect={() => pick(null, null)}>
              <RiAddLine size={14} className="db-menu-icon" aria-hidden="true" />
              <span className="db-menu-title">직접 추가…</span>
            </DropdownMenu.Item>
            <DropdownMenu.CheckboxItem
              className="db-menu-item db-menu-check"
              checked={isAuto}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => {
                setIsAuto(checked)
                writeAuto(checked)
              }}
            >
              <span className="db-menu-icon">{isAuto && <RiCheckLine size={14} aria-hidden="true" />}</span>
              <span className="db-menu-detail">연결되면 자동으로 찾기 (포트·프로세스 목록만 봄)</span>
            </DropdownMenu.CheckboxItem>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {target && <DbConnectDialog target={target} onClose={() => setTarget(null)} />}
    </>
  )
}
