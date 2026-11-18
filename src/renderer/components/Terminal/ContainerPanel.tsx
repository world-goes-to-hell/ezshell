import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  RiRefreshLine, RiCloseFill, RiFileList3Line, RiTerminalBoxLine, RiFileCopyLine, RiRestartLine, RiStopCircleLine, RiPlayCircleLine, RiSearchLine
} from 'react-icons/ri'
import { toast } from '../../stores/toastStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { insertIntoSession } from '../../lib/terminalInputTargets'
import {
  containerCommand, isRunning, publishedPorts, CONTAINER_AUTO_REFRESH_MS,
  type ContainerAction, type ContainerInfo, type ContainerListResult
} from '../../lib/containers'
import { searchTerms, orderBySearch } from '../../lib/containerSearch'
import './ContainerPanel.css'

// The search of each tab, kept while the app runs: closing and opening the panel keeps it
const searches = new Map<string, string>()

interface ContainerPanelProps {
  sessionId: string
  onClose: () => void
}

const PREFS_KEY = 'containerPanelPrefs'
interface Prefs { showAll: boolean; autoRefresh: boolean }

function loadPrefs(): Prefs {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null')
    if (!value || typeof value !== 'object') return { showAll: false, autoRefresh: false }
    const { showAll, autoRefresh } = value as Record<string, unknown>
    return { showAll: showAll === true, autoRefresh: autoRefresh === true }
  } catch {
    return { showAll: false, autoRefresh: false }
  }
}

/**
 * Docker containers of the tab's server. The server is asked when the panel opens and when the
 * user presses 새로고침 (or every 10 seconds with 자동 새로고침 on, while the window is visible):
 * the app does not poll a server on its own. Actions that change a container are only typed on the
 * terminal's input line; the user presses Enter.
 */
export function ContainerPanel({ sessionId, onClose }: ContainerPanelProps) {
  const [result, setResult] = useState<ContainerListResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [query, setQuery] = useState(() => searches.get(sessionId) ?? '')
  const isAlive = useRef(true)

  const changeQuery = (value: string) => {
    setQuery(value)
    if (value) searches.set(sessionId, value)
    else searches.delete(sessionId)
  }

  const load = useCallback(async (showAll: boolean) => {
    if (typeof window.electronAPI.containerList !== 'function') {
      setResult({ kind: 'error', message: '앱을 다시 시작한 뒤에 쓸 수 있습니다.' })
      return
    }
    setIsLoading(true)
    try {
      const answer = await window.electronAPI.containerList(sessionId, showAll)
      if (!isAlive.current) return
      // Another request for this tab was still running: its answer is the one to show
      if (answer.kind === 'busy') return
      setResult(answer)
      setLoadedAt(Date.now())
    } catch {
      if (isAlive.current) setResult({ kind: 'error', message: '컨테이너 목록을 읽지 못했습니다.' })
    } finally {
      if (isAlive.current) setIsLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    isAlive.current = true
    return () => { isAlive.current = false }
  }, [])

  useEffect(() => {
    void load(prefs.showAll)
  }, [load, prefs.showAll])

  useEffect(() => {
    if (!prefs.autoRefresh) return
    const timer = window.setInterval(() => {
      // A hidden window is not being looked at: no reason to ask the server
      if (!document.hidden) void load(prefs.showAll)
    }, CONTAINER_AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [prefs.autoRefresh, prefs.showAll, load])

  const updatePrefs = (patch: Partial<Prefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch }
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
      return next
    })
  }

  const typeCommand = (action: ContainerAction, container: ContainerInfo) => {
    const command = containerCommand(action, container.name)
    if (!command || !insertIntoSession(sessionId, command)) {
      toast.error('컨테이너', '명령을 입력줄에 넣지 못했습니다.')
      return
    }
    toast.info('입력줄에 넣었습니다', '확인하고 Enter 를 눌러 실행하세요.')
  }

  const copyName = async (container: ContainerInfo) => {
    try {
      await navigator.clipboard.writeText(container.name)
      toast.success('복사했습니다', container.name)
    } catch {
      toast.error('컨테이너', '복사하지 못했습니다.')
    }
  }

  const openLog = async (container: ContainerInfo) => {
    if (typeof window.electronAPI.containerLogOpen !== 'function') {
      toast.error('컨테이너', '앱을 다시 시작한 뒤에 쓸 수 있습니다.')
      return
    }
    try {
      const tab = useTerminalStore.getState().terminals.get(sessionId)
      const tabName = tab ? (tab.title || `${tab.username}@${tab.host}`) : ''
      const opened = await window.electronAPI.containerLogOpen(sessionId, tabName, container.name)
      if (!opened.success) toast.error('로그를 열지 못했습니다', opened.error)
    } catch {
      toast.error('컨테이너', '로그 창을 열지 못했습니다.')
    }
  }

  const containers = result?.kind === 'list' ? result.containers : []
  const terms = useMemo(() => searchTerms(query), [query])
  // Matching containers first (marked), every other one below in its usual order
  const rows = useMemo(() => orderBySearch(containers, terms), [containers, terms])
  const matchCount = rows.filter(row => row.parts).length

  return (
    <motion.div
      className="container-panel"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.2 }}
      role="region"
      aria-label="도커 컨테이너"
    >
      <div className="monitor-header">
        <span className="monitor-title">컨테이너{result?.kind === 'list' ? ` ${containers.length}` : ''}</span>
        <div className="monitor-actions">
          <button className="monitor-action-btn" onClick={() => void load(prefs.showAll)} disabled={isLoading} title="새로고침" aria-label="새로고침">
            <RiRefreshLine size={16} className={isLoading ? 'spinning' : undefined} />
          </button>
          <button className="monitor-action-btn" onClick={onClose} title="닫기" aria-label="닫기">
            <RiCloseFill size={16} />
          </button>
        </div>
      </div>

      <div className="container-options">
        <label className="container-option">
          <input type="checkbox" checked={prefs.showAll} onChange={(event) => updatePrefs({ showAll: event.target.checked })} />
          중지된 것도 보기
        </label>
        <label className="container-option" title="패널이 열려 있고 창이 보이는 동안 10초마다 다시 묻습니다">
          <input type="checkbox" checked={prefs.autoRefresh} onChange={(event) => updatePrefs({ autoRefresh: event.target.checked })} />
          자동 새로고침
        </label>
      </div>

      <div className="container-search">
        <RiSearchLine size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); changeQuery('') } }}
          placeholder="이름 검색 · 여러 개는 공백이나 쉼표로"
          aria-label="컨테이너 이름 검색"
          spellCheck={false}
        />
        {terms.length > 0 && result?.kind === 'list' && (
          <span className={`container-search-count${matchCount === 0 ? ' is-none' : ''}`}>{matchCount}개 일치</span>
        )}
      </div>

      <div className="container-body">
        {!result && <p className="container-note">불러오는 중...</p>}
        {result?.kind === 'no-docker' && <p className="container-note">이 서버에는 도커가 없습니다.</p>}
        {result?.kind === 'no-permission' && (
          <p className="container-note">이 계정은 도커를 쓸 권한이 없습니다. 서버에서 계정을 `docker` 그룹에 넣어야 합니다.</p>
        )}
        {result?.kind === 'error' && <p className="container-note container-note-error">{result.message}</p>}
        {result?.kind === 'list' && containers.length === 0 && (
          <p className="container-note">{prefs.showAll ? '컨테이너가 없습니다.' : '실행 중인 컨테이너가 없습니다.'}</p>
        )}
        {terms.length > 0 && result?.kind === 'list' && matchCount === 0 && containers.length > 0 && (
          <p className="container-note">
            일치하는 컨테이너가 없습니다.{prefs.showAll ? '' : ' 중지된 컨테이너는 `중지된 것도 보기` 를 켜야 찾습니다.'}
          </p>
        )}
        {rows.map(({ item: container, parts }, index) => {
          const running = isRunning(container)
          const ports = publishedPorts(container.ports)
          // The first container that does not match starts "the others" when something matched
          const startsOthers = matchCount > 0 && index === matchCount
          return (
            <div key={container.id || container.name} className={`container-row${running ? '' : ' is-stopped'}${parts ? ' is-match' : ''}${startsOthers ? ' starts-others' : ''}`}>
              <div className="container-row-head">
                <span className={`container-dot${running ? ' is-running' : ''}`} aria-hidden="true" />
                <span className="container-name" title={container.name}>
                  {parts ? parts.map((part, i) => (part.isMatch ? <mark key={i} className="container-name-mark">{part.text}</mark> : <span key={i}>{part.text}</span>)) : container.name}
                </span>
              </div>
              <div className="container-meta" title={container.image}>{container.image}</div>
              <div className="container-meta">
                {container.status}{ports ? ` · ${ports}` : ''}
              </div>
              <div className="container-actions">
                <button type="button" className="container-action" onClick={() => void openLog(container)} title="이 컨테이너의 로그를 새 창에서 봅니다">
                  <RiFileList3Line size={14} /> 로그
                </button>
                {running && (
                  <button type="button" className="container-action" onClick={() => typeCommand('shell', container)} title="docker exec 명령을 입력줄에 넣습니다 (실행은 Enter)">
                    <RiTerminalBoxLine size={14} /> 셸
                  </button>
                )}
                <button type="button" className="container-action" onClick={() => void copyName(container)} title="이름 복사">
                  <RiFileCopyLine size={14} /> 이름
                </button>
                <button type="button" className="container-action" onClick={() => typeCommand('restart', container)} title="docker restart 명령을 입력줄에 넣습니다 (실행은 Enter)">
                  <RiRestartLine size={14} /> 재시작
                </button>
                {running ? (
                  <button type="button" className="container-action" onClick={() => typeCommand('stop', container)} title="docker stop 명령을 입력줄에 넣습니다 (실행은 Enter)">
                    <RiStopCircleLine size={14} /> 중지
                  </button>
                ) : (
                  <button type="button" className="container-action" onClick={() => typeCommand('start', container)} title="docker start 명령을 입력줄에 넣습니다 (실행은 Enter)">
                    <RiPlayCircleLine size={14} /> 시작
                  </button>
                )}
              </div>
            </div>
          )
        })}
        {result?.kind === 'list' && result.truncated && <p className="container-note">컨테이너가 많아 앞의 200개만 보여 줍니다.</p>}
      </div>

      {loadedAt !== null && (
        <div className="container-foot">
          {new Date(loadedAt).toLocaleTimeString('ko-KR', { hour12: false })} 기준 · 셸·재시작·중지는 입력줄에 넣기만 합니다
        </div>
      )}
    </motion.div>
  )
}
