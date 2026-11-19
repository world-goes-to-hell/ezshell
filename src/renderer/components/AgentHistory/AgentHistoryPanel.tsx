import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RiRefreshLine, RiSearchLine } from 'react-icons/ri'
import type { AgentHistorySession } from '../../types'
import { useTerminalStore } from '../../stores/terminalStore'
import { AGENT_LABELS, CONTENT_SEARCH_MIN_LENGTH, RESUME_AGENT_SESSION_EVENT, folderName, relativeTime, withContentMatches, type AgentHistoryScope, type ResumeAgentSessionRequest } from '../../lib/agentHistory'
import { matchName } from '../../lib/containerSearch'
import { AgentHistoryDetail, type DetailState } from './AgentHistoryDetail'
import { endAgentSessionDrag, startAgentSessionDrag } from '../../lib/agentSessionDrop'
import { AGENT_PROVIDER_ICONS } from '../Sidebar/LocalSessionAgents'
import './AgentHistory.css'

const MINUTE = 60_000
/** Typing pauses this long before the conversations are searched (each search reads the transcripts) */
const CONTENT_SEARCH_DELAY_MS = 400
const NO_HITS: ReadonlyMap<string, string> = new Map()

interface Project {
  label: string
  roots: string[]
}

/** The folder of the local terminal tab in front, or null (SSH tabs are on another machine) */
function activeLocalFolder(): string | null {
  const { terminals, activeTerminalId } = useTerminalStore.getState()
  const info = activeTerminalId ? terminals.get(activeTerminalId) : undefined
  if (!info?.local) return null
  return info.local.cwd ?? info.currentPath ?? null
}

/** The Git repository (with its worktrees) the folder belongs to, or the folder itself */
async function projectOf(folder: string): Promise<Project> {
  try {
    const result = await window.electronAPI.localProjectInspect(folder)
    if (result.success && result.repo) {
      return { label: folderName(result.repo.root), roots: [result.repo.root, ...result.repo.worktrees.map(tree => tree.path)] }
    }
  } catch { /* fall back to the folder */ }
  return { label: folderName(folder), roots: [folder] }
}

/** Past Claude Code and Codex sessions of this PC. Lists again each time the tab is shown. */
export function AgentHistoryPanel({ isActive }: { isActive: boolean }) {
  const [sessions, setSessions] = useState<AgentHistorySession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<AgentHistoryScope>('project')
  const [project, setProject] = useState<Project | null>(null)
  const [showEmpty, setShowEmpty] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, DetailState>>({})
  const [now, setNow] = useState(() => Date.now())
  const request = useRef(0)
  // Sessions whose questions or answers hold every word: key → one-line excerpt (from the main process)
  const [contentHits, setContentHits] = useState<{ query: string; hits: ReadonlyMap<string, string> } | null>(null)
  const [isSearchingContent, setIsSearchingContent] = useState(false)

  const load = useCallback(async () => {
    const id = ++request.current
    setIsLoading(true)
    const folder = activeLocalFolder()
    const [result, nextProject] = await Promise.all([
      window.electronAPI.agentHistoryList?.() ?? Promise.resolve({ success: false as const, error: '앱을 다시 시작해 주세요.' }),
      folder ? projectOf(folder) : Promise.resolve(null)
    ]).catch(() => [{ success: false as const, error: '에이전트 기록을 읽지 못했습니다.' }, null] as const)
    if (id !== request.current) return
    setIsLoading(false)
    setProject(nextProject)
    setNow(Date.now())
    if (!result.success) {
      setError(result.error)
      return
    }
    setError(null)
    setSessions(result.sessions)
    // A row whose transcript changed reads its detail again when it is opened
    setDetails({})
  }, [])

  // The work panel stays open beside the terminals: the scope follows the tab in front. Listing again
  // is cheap (main reads only the transcripts that changed).
  const activeTerminalId = useTerminalStore(state => state.activeTerminalId)
  const activeFolder = useTerminalStore(activeLocalFolder)
  useEffect(() => {
    if (isActive) void load()
  }, [isActive, activeTerminalId, activeFolder, load])

  useEffect(() => {
    if (!isActive) return
    const timer = setInterval(() => setNow(Date.now()), MINUTE)
    return () => clearInterval(timer)
  }, [isActive])

  const openDetail = async (key: string) => {
    if (expanded === key) {
      setExpanded(null)
      return
    }
    setExpanded(key)
    if (details[key]?.status === 'ready') return
    setDetails(current => ({ ...current, [key]: { status: 'loading' } }))
    const result = await window.electronAPI.agentHistoryDetail?.(key).catch(() => null)
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
    if (!isActive || !sessions || trimmed.length < CONTENT_SEARCH_MIN_LENGTH || !window.electronAPI.agentHistorySearch) {
      setContentHits(null)
      setIsSearchingContent(false)
      return
    }
    let isCurrent = true
    setIsSearchingContent(true)
    const timer = window.setTimeout(() => {
      void window.electronAPI.agentHistorySearch?.(trimmed).then(result => {
        if (!isCurrent) return
        setIsSearchingContent(false)
        if (result.success) setContentHits({ query: trimmed, hits: new Map(result.matches.map(match => [match.key, match.snippet])) })
      }, () => { if (isCurrent) setIsSearchingContent(false) })
    }, CONTENT_SEARCH_DELAY_MS)
    return () => {
      isCurrent = false
      window.clearTimeout(timer)
    }
  }, [query, sessions, isActive])

  // Excerpts belong to the query they were found for
  const hits = contentHits && contentHits.query === query.trim() ? contentHits.hits : NO_HITS
  const words = useMemo(() => [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))], [query])
  const effectiveScope: AgentHistoryScope = project ? scope : 'all'
  const shown = useMemo(() => withContentMatches(sessions ?? [], {
    query, roots: effectiveScope === 'project' && project ? project.roots : null, showEmpty
  }, hits), [sessions, query, effectiveScope, project, showEmpty, hits])
  const hiddenEmpty = useMemo(() => (sessions ?? []).filter(session => !session.hasPrompt).length, [sessions])

  return (
    <div className="agent-history">
      <header className="agent-history-header">
        <div className="agent-history-search">
          <RiSearchLine size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="제목, 폴더, 브랜치, 모델, 대화 내용으로 찾기"
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
          <div className="agent-history-scope" role="group" aria-label="범위">
            <button type="button" className={`mcp-activity-view-btn${effectiveScope === 'project' ? ' is-active' : ''}`}
              aria-pressed={effectiveScope === 'project'} disabled={!project} onClick={() => setScope('project')}
              title={project ? `${project.label} 의 세션 (워크트리 포함)` : '로컬 터미널 탭이 앞에 있을 때 그 프로젝트의 세션만 볼 수 있습니다'}>
              {project ? project.label : '이 프로젝트'}
            </button>
            <button type="button" className={`mcp-activity-view-btn${effectiveScope === 'all' ? ' is-active' : ''}`}
              aria-pressed={effectiveScope === 'all'} onClick={() => setScope('all')}>
              전체
            </button>
          </div>
          <span className="agent-history-count">
            {sessions ? `${shown.length}개 표시 · 전체 ${sessions.length}개` : ''}
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
          {sessions.length === 0 ? '이 PC 에서 실행한 Claude Code·Codex 세션이 없습니다.' : '조건에 맞는 세션이 없습니다.'}
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
                  <span className="agent-history-title">{session.title || '(질문 없음)'}</span>
                  <span className="agent-history-time" title={new Date(session.updated).toLocaleString('ko-KR')}>{relativeTime(session.updated, now)}</span>
                </span>
                <span className="agent-history-meta">
                  <span title={session.cwd ?? undefined}>{folderName(session.cwd) || '폴더 모름'}</span>
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
              {isOpen && <AgentHistoryDetail session={session} state={details[session.key]} onResume={resume} />}
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
