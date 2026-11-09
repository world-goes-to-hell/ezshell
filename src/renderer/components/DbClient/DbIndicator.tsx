import { useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiAddLine, RiDatabase2Line, RiCheckLine, RiKey2Line } from 'react-icons/ri'
import { useTerminalStore } from '../../stores/terminalStore'
import { useSessionStore } from '../../stores/sessionStore'
import { buildChoices, type DbChoice } from '../../lib/dbChoices'
import { DbConnectDialog, type DbConnectTarget } from './DbConnectDialog'
import type { DiscoveredDb } from '../../types/db'
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
 * Status bar entry of the DB client for the active tab: the databases found on its server and the
 * accounts saved with its session. Discovery runs once per connection in main (ports and process
 * names only); with "자동으로 찾기" off it runs when the list is opened.
 */
export function DbIndicator() {
  const activeId = useTerminalStore(state => state.activeTerminalId)
  const terminal = useTerminalStore(state => (state.activeTerminalId ? state.terminals.get(state.activeTerminalId) : undefined))
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
  const choices = useMemo(() => buildChoices(found ?? [], savedSession?.dbConnections ?? []), [found, savedSession?.dbConnections])

  if (!activeId || !terminal || !isConnected || typeof window.electronAPI.dbDiscover !== 'function') return null

  const supportedCount = choices.filter(c => c.isSupported).length
  const sessionName = terminal.title || terminal.connectConfig?.sessionName || terminal.host

  const pick = (choice: DbChoice | null): void => {
    setTarget({
      sessionId: activeId,
      sessionName,
      savedSessionId: savedSession ? savedSession.id : null,
      endpoint: choice?.endpoint ?? null,
      saved: choice?.saved ?? null
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
            {choices.map(choice => (
              <DropdownMenu.Item
                key={choice.key}
                className="db-menu-item"
                disabled={!choice.isSupported}
                onSelect={() => pick(choice)}
              >
                {choice.saved ? <RiKey2Line size={14} className="db-menu-icon is-saved" aria-label="저장된 계정" /> : <RiDatabase2Line size={14} className="db-menu-icon" aria-hidden="true" />}
                <div className="db-menu-text">
                  <span className="db-menu-title">
                    {choice.label}
                    {choice.isGuess && <span className="db-menu-tag">추정</span>}
                    {!choice.isSupported && <span className="db-menu-tag">지원 예정</span>}
                  </span>
                  <span className="db-menu-detail">{choice.detail}</span>
                </div>
              </DropdownMenu.Item>
            ))}
            {found !== undefined && choices.length === 0 && (
              <div className="db-menu-empty">찾은 DB 가 없습니다. 내부망의 다른 DB 는 직접 추가하세요.</div>
            )}
            <DropdownMenu.Separator className="db-menu-separator" />
            <DropdownMenu.Item className="db-menu-item" onSelect={() => pick(null)}>
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
