import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RiRefreshLine, RiSearchLine } from 'react-icons/ri'
import type { AgentHistorySession } from '../../types'
import { useTerminalStore } from '../../stores/terminalStore'
import { AGENT_LABELS, CONTENT_SEARCH_MIN_LENGTH, RESUME_AGENT_SESSION_EVENT, folderName, relativeTime, withContentMatches, type ResumeAgentSessionRequest } from '../../lib/agentHistory'
import { matchName } from '../../lib/containerSearch'
import { visibleTerminalId } from '../../lib/localTerminalPane'
import { pathKey } from '../../lib/localWorkspaceTree'
import { AgentHistoryDetail, type DetailState } from './AgentHistoryDetail'
import { endAgentSessionDrag, startAgentSessionDrag } from '../../lib/agentSessionDrop'
import { AGENT_PROVIDER_ICONS } from '../ui/agentProviderIcons'
import './AgentHistory.css'

const MINUTE = 60_000
/** Typing pauses this long before the conversations are searched (each search reads the transcripts) */
const CONTENT_SEARCH_DELAY_MS = 400
const NO_HITS: ReadonlyMap<string, string> = new Map()

export function AgentHistoryPanel() {
  const terminal = useTerminalStore(state => {
    const id = visibleTerminalId(state.layout, state.activeTerminalId)
    return id ? state.terminals.get(id) : undefined
  })
  const local = terminal?.local
  if (!terminal || !local?.cwd) {
    return <p className="agent-history-note">프로젝트의 로컬 터미널을 선택하면 대화 기록을 볼 수 있습니다.</p>
  }
  return <ProjectHistory key={pathKey(local.cwd)} shellId={local.shellId ?? terminal.id} />
}

function ProjectHistory({ shellId }: { shellId: string }) {
  const [sessions, setSessions] = useState<AgentHistorySession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [showEmpty, setShowEmpty] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, DetailState>>({})
  const [now, setNow] = useState(() => Date.now())
  const request = useRef(0)
  // Sessions whose questions or answers hold every word: key → one-line excerpt (from the main process)
  const [contentHits, setContentHits] = useState<{ query: string; hits: ReadonlyMap<string, string> } | null>(null)
  const [isSearchingContent, setIsSearchingContent] = useState(false)

  const load = useCallback(async (keepDetails = false) => {
    const id = ++request.current
    setIsLoading(true)
    const result = await window.electronAPI.agentHistoryList?.(shellId).catch(() => null)
    if (id !== request.current) return
    setIsLoading(false)
    setNow(Date.now())
    if (!result?.success) {
      setSessions(null)
      setError(result?.error ?? '에이전트 기록을 읽지 못했습니다.')
      return
    }
    setError(null)
    setProject(result.project)
    setSessions(result.sessions)
    // A row whose transcript changed reads its detail again when it is opened
    if (!keepDetails) setDetails({})
  }, [shellId])

  // The work panel stays open beside the terminals: the scope follows the tab in front. Listing again
  // is cheap (main reads only the transcripts that changed).
  useEffect(() => {
    const stopRoles = window.electronAPI.onAgentHistoryRolesChanged?.(() => void load(true))
    void load()
    return () => {
      stopRoles?.()
      request.current++
    }
  }, [load])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE)
    return () => clearInterval(timer)
  }, [])

  const openDetail = async (key: string) => {
    if (expanded === key) {
      setExpanded(null)
      return
    }
    setExpanded(key)
    if (details[key]?.status === 'ready') return
    setDetails(current => ({ ...current, [key]: { status: 'loading' } }))
    const result = await window.electronAPI.agentHistoryDetail?.(shellId, key).catch(() => null)
    setDetails(current => ({
      ...current,
      [key]: result?.success
        ? { status: 'ready', detail: { firstPrompt: result.firstPrompt, turns: result.turns, turnsUnavailable: result.turnsUnavailable } }
        : { status: 'error', message: result && !result.success ? result.error : '세션 기록을 읽지 못했습니다.' }
    }))
  }

  const resume = (session: AgentHistorySession) => {
    const detail: ResumeAgentSessionRequest = { key: session.key, agent: session.agent, label: folderName(session.cwd) }
    window.dispatchEvent(new CustomEvent(RESUME_AGENT_SESSION_EVENT, { detail }))
  }

  // The conversations are searched in the main process a moment after typing stops, and again when the
  // list was read again (a newer search stops the older one there)
  useEffect(() => {
    const trimmed = query.trim()
    if (!sessions || trimmed.length < CONTENT_SEARCH_MIN_LENGTH || !window.electronAPI.agentHistorySearch) {
      setContentHits(null)
      setIsSearchingContent(false)
      return
    }
    let isCurrent = true
    setIsSearchingContent(true)
    const timer = window.setTimeout(() => {
      void window.electronAPI.agentHistorySearch?.(shellId, trimmed).then(result => {
        if (!isCurrent) return
        setIsSearchingContent(false)
        if (result.success) setContentHits({ query: trimmed, hits: new Map(result.matches.map(match => [match.key, match.snippet])) })
      }, () => { if (isCurrent) setIsSearchingContent(false) })
    }, CONTENT_SEARCH_DELAY_MS)
    return () => {
      isCurrent = false
      window.clearTimeout(timer)
    }
  }, [query, sessions, shellId])

  // Excerpts belong to the query they were found for
  const hits = contentHits && contentHits.query === query.trim() ? contentHits.hits : NO_HITS
  const words = useMemo(() => [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))], [query])
  const shown = useMemo(() => withContentMatches(sessions ?? [], { query, showEmpty }, hits), [sessions, query, showEmpty, hits])
  const hiddenEmpty = useMemo(() => (sessions ?? []).filter(session => !session.hasPrompt).length, [sessions])

  return (
    <div className="agent-history">
      <header className="agent-history-header">
        <div className="agent-history-search">
          <RiSearchLine size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="제목, 역할, 폴더, 브랜치, 모델, 대화 내용으로 찾기"
            aria-label="에이전트 기록 찾기"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              // Esc clears the search first; the next one closes the panel
              if (event.key === 'Escape' && query) {
                event.preventDefault()
                setQuery('')
              }
            }}
          />
        </div>
        <div className="agent-history-bar">
          <span className="agent-history-project" title={project}>{project}</span>
          <span className="agent-history-count">
            {sessions ? `${shown.length}개 표시 · 프로젝트 ${sessions.length}개` : ''}
          </span>
          <button type="button" className="mcp-icon-btn" onClick={() => void load()} disabled={isLoading} aria-label="에이전트 기록 새로 고침" title="새로 고침">
            <RiRefreshLine size={16} className={isLoading ? 'agent-history-spin' : undefined} />
          </button>
        </div>
        {isSearchingContent && <p className="agent-history-searching" role="status">대화 내용 찾는 중…</p>}
      </header>

      {error && <p className="agent-history-note is-error">{error}</p>}
      {!sessions && !error && <p className="agent-history-note">기록을 찾는 중…</p>}
      {sessions && shown.length === 0 && !isSearchingContent && (
        <p className="agent-history-note">
          {sessions.length === 0 ? '이 프로젝트에 대화 기록이 없습니다.' : '조건에 맞는 세션이 없습니다.'}
        </p>
      )}

      <ul className="agent-history-list">
        {shown.map(session => {
          const isOpen = expanded === session.key
          return (
            <li key={session.key} className={`agent-history-item${isOpen ? ' is-open' : ''}`}>
              <button
                type="button"
                className="agent-history-row"
                aria-expanded={isOpen}
                onClick={() => void openDetail(session.key)}
                // A pane's center replaces its shell; the edge adds a split.
                draggable
                onDragStart={(event) => startAgentSessionDrag(event, { key: session.key, agent: session.agent, label: folderName(session.cwd) })}
                onDragEnd={endAgentSessionDrag}
                title="누르면 내용 보기 · 로컬 셸 가운데에 놓으면 교체, 가장자리에 놓으면 분할"
              >
                <span className="agent-history-line">
                  {(() => {
                    const ProviderIcon = AGENT_PROVIDER_ICONS[session.agent]
                    return (
                      <span className={`agent-history-agent is-${session.agent}`} role="img" aria-label={AGENT_LABELS[session.agent]} title={AGENT_LABELS[session.agent]}>
                        <ProviderIcon size={14} />
                      </span>
                    )
                  })()}
                  {session.role && <span className="agent-history-session-role" title={session.role}>{session.role}</span>}
                  <span className="agent-history-title">{session.title || '(질문 없음)'}</span>
                  <span className="agent-history-time" title={new Date(session.updated).toLocaleString('ko-KR')}>{relativeTime(session.updated, now)}</span>
                </span>
                <span className="agent-history-meta">
                  <span title={session.cwd ?? undefined}>{folderName(session.cwd) || '폴더 모름'}</span>
                  {session.claudeProfileName && <span>{session.claudeProfileName}</span>}
                  {session.branch && <span className="agent-history-branch">{session.branch}</span>}
                </span>
                {hits.has(session.key) && (
                  <span className="agent-history-snippet" title="대화 내용에서 찾은 부분">
                    {(matchName(hits.get(session.key) ?? '', words) ?? [{ text: hits.get(session.key) ?? '', isMatch: false }]).map((part, i) => (
                      part.isMatch ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>
                    ))}
                  </span>
                )}
              </button>
              {isOpen && <AgentHistoryDetail session={session} state={details[session.key]} shellId={shellId} onResume={resume} />}
            </li>
          )
        })}
      </ul>

      {hiddenEmpty > 0 && (
        <label className="agent-history-empty-toggle">
          <input type="checkbox" checked={showEmpty} onChange={event => setShowEmpty(event.target.checked)} />
          질문이 없는 세션 {hiddenEmpty}개도 보기
        </label>
      )}
    </div>
  )
}
