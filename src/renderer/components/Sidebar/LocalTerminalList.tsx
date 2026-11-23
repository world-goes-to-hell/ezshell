import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react'
import { RiAddLine, RiArrowDownSLine, RiArrowRightSLine, RiCloseLine, RiComputerLine, RiDatabase2Line, RiFolderAddLine, RiGlobalLine, RiRefreshLine, RiServerLine } from 'react-icons/ri'
import { useTerminalStore, type TerminalInfo } from '../../stores/terminalStore'
import { useSessionStore, type Session } from '../../stores/sessionStore'
import type { SessionTabGroup } from '../../lib/sessionTabs'
import { useProjectServers } from '../../hooks/useProjectServers'
import { TAB_DROP_TAKEN_EVENT, linkServer, projectKeyOf, readProjectServers, sessionFromDrop, unlinkServer, writeProjectServers } from '../../lib/localProjectServers'
import { LOCAL_PANE_STORAGE_KEY, clampPaneHeight, parseLocalPanePrefs, visibleTerminalId, type LocalPanePrefs } from '../../lib/localTerminalPane'
import { isSplitTree, paneIds } from '../../lib/splitTree'
import { PaneLayoutBadge } from './PaneLayoutBadge'
import { LocalSessionAgents } from './LocalSessionAgents'
import { focusTabPane, focusedPaneOf } from '../../lib/paneFocus'
import { useLocalProjects } from '../../hooks/useLocalProjects'
import { assignTabs, folderLabel, pathKey } from '../../lib/localWorkspaceTree'
import { readFoldedNodes, readLocalProjects, writeFoldedNodes, writeLocalProjects } from '../../lib/localProjectList'
import { confirmDialog } from '../../stores/confirmStore'
import { toast } from '../../stores/toastStore'
import { LocalProjectsTree, buildProjectNodes, type ProjectNode, type WorktreeNode, type WorktreeTab } from './LocalProjectsTree'
import { workTabsByWorktree } from '../../lib/tabGroups'
import { effectiveSessionColor } from '../../lib/sessionEffectiveColor'
import './LocalTerminalList.css'

const KEY_STEP = 30

interface LocalTerminalListProps {
  fillAvailableSpace?: boolean
  workingTabs: ReadonlySet<string>
  serverTabs: ReadonlyMap<string, ReadonlyMap<string, SessionTabGroup>>
  onOpen?: (button: HTMLButtonElement) => void
  onClose: (terminalId: string) => void
  /** Opens a local terminal in a worktree of the tree */
  onOpenFolder?: (cwd: string, workspaceLabel: string) => void
  /** Connects a saved session linked to a project when it has no tab open (as a press in the session list) */
  onConnectSession?: (session: Session, workGroup: string) => void
}

function readPrefs(): LocalPanePrefs {
  try {
    return parseLocalPanePrefs(localStorage.getItem(LOCAL_PANE_STORAGE_KEY))
  } catch {
    return { collapsed: false }
  }
}

function writePrefs(prefs: LocalPanePrefs) {
  try {
    localStorage.setItem(LOCAL_PANE_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Not remembered this time; the pane still works
  }
}

/** A browser, SSH or DB tab's name as its tab shows it */
function otherTabName({ title, host, username, browser, db }: TerminalInfo) {
  if (browser) return title || '브라우저'
  if (db) return db.label || title || 'DB'
  return title || (username && host ? `${username}@${host}` : host) || '세션'
}

function localTabName({ title, local }: TerminalInfo) {
  const workspace = local?.workspaceLabel
  if (workspace && (title === `${workspace} · Codex` || title === `${workspace} · Claude Code`)) return workspace
  return title || '로컬 터미널'
}

/**
 * Local work below the session list: the registered work folders with their worktrees and the local
 * terminals open in each (with their agents), then the other local terminals. When empty, the docked
 * sidebar shows the actions in its header. The list grows to its rows or a manually set height.
 */
export function LocalTerminalList({ fillAvailableSpace = false, workingTabs, serverTabs, onOpen, onClose, onOpenFolder, onConnectSession }: LocalTerminalListProps) {
  const terminals = useTerminalStore(state => state.terminals)
  const visibleId = useTerminalStore(state => visibleTerminalId(state.layout, state.activeTerminalId))
  const focusTerminal = useTerminalStore(state => state.focusTerminal)
  const [prefs, setPrefs] = useState<LocalPanePrefs>(readPrefs)
  const paneRef = useRef<HTMLDivElement>(null)
  // `height` is the latest dragged value: the pointer-up handler may still belong to the render before it
  const drag = useRef<{ startY: number; startHeight: number; height?: number } | null>(null)

  const locals = useMemo(
    () => Array.from(terminals.entries()).filter(([, terminal]) => terminal.local),
    [terminals]
  )
  const { projects, refresh } = useLocalProjects()
  const nodes = useMemo(() => buildProjectNodes(projects), [projects])
  const worktreePaths = useMemo(() => nodes.flatMap(node => node.worktrees.map(tree => tree.path)), [nodes])
  const assignment = useMemo(() => assignTabs(
    locals.map(([id, terminal]) => ({ id, cwd: terminal.local?.cwd })),
    worktreePaths
  ), [locals, worktreePaths])
  // Saved SSH sessions linked to each project ("서버"), kept across restarts (lib/localProjectServers)
  const servers = useProjectServers()
  // The browser, SSH and DB tabs of each project's work, under a worktree like its terminals
  // (2026-11-20 user request: they were in the work's tab strip but not in its tree)
  const workTabs = useMemo(() => workTabsByWorktree(
    [...terminals.keys()], terminals,
    nodes.map(node => ({ key: projectKeyOf(node), name: node.name, worktrees: node.worktrees.map(tree => tree.path) })),
  ), [terminals, nodes])
  const tabOrder = useMemo(() => new Map([...terminals.keys()].map((id, index) => [id, index])), [terminals])

  const [folded, setFolded] = useState<ReadonlySet<string>>(readFoldedNodes)
  const toggleFold = (key: string) => {
    const next = new Set(folded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setFolded(next)
    writeFoldedNodes(next)
  }

  const sessions = useSessionStore(state => state.sessions)
  const folders = useSessionStore(state => state.folders)
  // The color the user gave a session (or its folder), as in the session list: a bar and the icon
  const colorStyle = (color: string | undefined) => (color ? { '--server-color': color } as CSSProperties : undefined)

  const linkDropped = (project: ProjectNode, text: string) => {
    const isTab = !text.startsWith('session:') && terminals.has(text)
    // The tab was dropped here: App must not pop it out into a window when the drag ends
    if (isTab) window.dispatchEvent(new Event(TAB_DROP_TAKEN_EVENT))
    const found = sessionFromDrop(text, terminals, new Set(sessions.map(session => session.id)))
    if (!found) return
    if ('error' in found) {
      toast.error('서버로 묶지 못했습니다', found.error)
      return
    }
    const key = projectKeyOf(project)
    const current = readProjectServers()
    const name = sessions.find(session => session.id === found.sessionId)?.name || '세션'
    if (current[key]?.includes(found.sessionId)) {
      toast.info('이미 묶여 있습니다', `${name} · ${project.name}`)
      return
    }
    if (!writeProjectServers(linkServer(current, key, found.sessionId))) toast.error('서버로 묶지 못했습니다', '목록을 저장하지 못했습니다.')
  }

  const unlink = (project: ProjectNode, sessionId: string) => {
    writeProjectServers(unlinkServer(readProjectServers(), projectKeyOf(project), sessionId))
  }

  const openServer = (session: Session, workGroup: string, group: SessionTabGroup | undefined) => {
    const tab = group?.connected[0] ?? group?.disconnected[0]
    if (tab) focusTerminal(tab.id)
    else onConnectSession?.(session, workGroup)
  }

  const renderServers = (project: ProjectNode) => {
    const workGroup = projectKeyOf(project)
    // A server whose tab is open is listed in its worktree with the other tabs; here only the ones to
    // connect (2026-11-20 user report: the open SSH tab showed twice)
    const listed = new Set(project.worktrees.flatMap(tree => workTabs.get(tree.path) ?? []))
    const isListed = (session: Session) => {
      const group = serverTabs.get(workGroup)?.get(session.id)
      return [...(group?.connected ?? []), ...(group?.disconnected ?? [])].some(tab => listed.has(tab.id))
    }
    const linked = (servers[workGroup] ?? [])
      .map(id => sessions.find(session => session.id === id))
      .filter((session): session is Session => !!session && !isListed(session))
    if (linked.length === 0) return null
    return (
      <div className="local-servers">
        <div className="local-servers-title">서버</div>
        <ul className="local-servers-list" aria-label={`${project.name} 의 서버`}>
          {linked.map(session => {
            const group = serverTabs.get(workGroup)?.get(session.id)
            const connected = group?.connected.length ?? 0
            const disconnected = group?.disconnected.length ?? 0
            const state = connected > 0 ? 'is-on' : disconnected > 0 ? 'is-off' : ''
            const name = session.name || session.host
            const current = group?.connected.some(tab => tab.id === visibleId)
              || group?.disconnected.some(tab => tab.id === visibleId)
            return (
              <li key={session.id} className={`local-server${current ? ' is-current' : ''}`} data-session-id={session.id}
                style={colorStyle(effectiveSessionColor(session, folders))}>
                <button type="button" className="local-server-open" onClick={() => openServer(session, workGroup, group)}
                  aria-current={current || undefined}
                  title={connected + disconnected > 0 ? `${name} 탭으로 이동` : `${name} 에 접속`}>
                  <RiServerLine size={14} className="local-server-icon" aria-hidden="true" />
                  <span className="local-server-name">{name}</span>
                  <span className={`local-server-dot ${state}`} aria-hidden="true" />
                  {connected + disconnected > 1 && <span className="local-server-count">{connected + disconnected}</span>}
                </button>
                <button type="button" className="local-server-unlink" onClick={() => unlink(project, session.id)}
                  title="이 프로젝트에서 빼기" aria-label={`${name} 을 ${project.name} 에서 빼기`}>
                  <RiCloseLine size={14} />
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  const openWorktree = (project: ProjectNode, worktree: WorktreeNode) => {
    const open = assignment.byWorktree.get(worktree.path)
    if (open?.length) {
      focusTerminal(open[0])
      return
    }
    onOpenFolder?.(worktree.path, worktree.branch ? `${project.name} · ${worktree.branch}` : folderLabel(worktree.path))
  }

  // Only the registration goes: the folders, their open terminals and the linked servers stay (adding the
  // folder again brings the servers back, they are kept by the project key)
  const removeProject = async (project: ProjectNode) => {
    const confirmed = await confirmDialog({
      title: '로컬 작업 목록에서 빼기',
      message: `‘${project.name}’ 작업을 목록에서 뺄까요?\n필요하면 작업 폴더를 다시 등록할 수 있습니다.`,
      confirmLabel: '목록에서 빼기',
      danger: true
    })
    if (!confirmed) return

    const gone = new Set(project.folders.map(pathKey))
    const current = readLocalProjects()
    const remaining = current.filter(folder => !gone.has(pathKey(folder)))
    if (remaining.length === current.length) return
    if (!writeLocalProjects(remaining)) {
      toast.error('목록에서 빼지 못했습니다', '작업 폴더 목록을 저장하지 못했습니다.')
      return
    }
    toast.info('목록에서 뺐습니다', `${project.name} · 폴더와 열린 터미널은 그대로입니다. + 로 다시 더할 수 있습니다.`)
  }

  const addFolder = async () => {
    try {
      const result = await window.electronAPI.selectLocalFolder()
      if (!result.success) return
      const current = readLocalProjects()
      if (!writeLocalProjects([result.path, ...current.filter(item => item !== result.path)])) {
        toast.error('작업 폴더를 더하지 못했습니다', '목록을 저장하지 못했습니다.')
      }
    } catch {
      toast.error('작업 폴더를 더하지 못했습니다', '폴더 선택 창을 열지 못했습니다.')
    }
  }

  const update = useCallback((next: LocalPanePrefs, persist: boolean) => {
    setPrefs(next)
    if (persist) writePrefs(next)
  }, [])

  // The list area both lists share (the pane's parent)
  const containerHeight = () => paneRef.current?.parentElement?.clientHeight ?? 0

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !paneRef.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startY: event.clientY, startHeight: paneRef.current.getBoundingClientRect().height }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    // Dragging up makes the pane taller
    const height = clampPaneHeight(drag.current.startHeight - (event.clientY - drag.current.startY), containerHeight())
    drag.current.height = height
    update({ collapsed: false, height }, false)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const { height } = drag.current
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    // A press without movement is not a resize: the height stays automatic
    if (height !== undefined) writePrefs({ collapsed: false, height })
  }

  // Back to "as tall as the rows"
  const resetHeight = () => update({ collapsed: prefs.collapsed }, true)

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const current = paneRef.current?.getBoundingClientRect().height ?? 0
    const height = clampPaneHeight(current + (event.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP), containerHeight())
    update({ collapsed: false, height }, true)
  }

  const isEmpty = locals.length === 0 && projects.length === 0

  const tabsOf = (path: string): WorktreeTab[] => [...(assignment.byWorktree.get(path) ?? []), ...(workTabs.get(path) ?? [])]
    .sort((a, b) => (tabOrder.get(a) ?? 0) - (tabOrder.get(b) ?? 0))
    .flatMap(id => {
      const terminal = terminals.get(id)
      if (!terminal) return []
      const kind: WorktreeTab['kind'] = terminal.local ? 'local' : terminal.browser ? 'browser' : terminal.db ? 'db' : 'ssh'
      return [{ id, kind, name: kind === 'local' ? localTabName(terminal) : otherTabName(terminal), connected: terminal.connected, working: workingTabs.has(id) }]
    })

  const closeLocalTab = async (id: string, name: string) => {
    const local = terminals.get(id)?.local
    if (!local) return

    const confirmed = await confirmDialog({
      title: '로컬 터미널 탭 닫기',
      message: `‘${name}’ 탭을 닫을까요?\n이 탭에 열려 있는 세션이 모두 종료됩니다.`,
      confirmLabel: '모두 종료',
      danger: true
    })
    if (!confirmed) return

    const current = useTerminalStore.getState().terminals.get(id)?.local
    if (!current) return
    if ((current.shellId ?? id) !== (local.shellId ?? id)) {
      toast.info('다시 확인해 주세요', '탭의 기본 세션이 바뀌었습니다.')
      return
    }
    onClose(id)
  }

  const renderTabActions = (id: string, name: string) => {
    const tree = terminals.get(id)?.splitTree
    return (
      <>
        {tree && isSplitTree(tree) && paneIds(tree).length > 1 && (
          <PaneLayoutBadge tabId={id} tabName={name} tree={tree} currentPane={() => focusedPaneOf(id)} onPick={pane => focusTabPane(focusTerminal, id, pane)} />
        )}
        <button type="button" className="local-terms-close" onClick={() => void closeLocalTab(id, name)} title="탭과 열린 세션 모두 닫기" aria-label={`${name} 닫기`}>
          <RiCloseLine size={15} />
        </button>
      </>
    )
  }

  const renderTab = (id: string, label?: string) => {
    const terminal = terminals.get(id)
    if (!terminal) return null
    if (!terminal.local) {
      // A browser, SSH or DB tab of the work: goes to the tab, closes as its tab does
      const name = otherTabName(terminal)
      const Icon = terminal.browser ? RiGlobalLine : terminal.db ? RiDatabase2Line : RiServerLine
      // An SSH or DB tab keeps its session's color (the saved session now, else the color it opened with)
      const savedId = terminal.connectConfig?.savedSessionId
      const color = terminal.browser ? undefined
        : effectiveSessionColor(savedId ? sessions.find(session => session.id === savedId) : undefined, folders) ?? terminal.color
      return (
        <li key={id} className="local-terms-item" data-work-tab-id={id} style={colorStyle(color)}>
          <div className={`local-terms-row ${id === visibleId ? 'is-current' : ''}`}>
            <button type="button" className="local-terms-open" onClick={() => focusTerminal(id)} title={`${name} 탭으로 이동`}>
              <Icon size={15} className="local-terms-icon" />
              <span className="local-terms-name">{name}</span>
              {!terminal.browser && <span className={`local-terms-dot ${terminal.connected ? 'is-on' : 'is-off'}`} aria-hidden="true" />}
            </button>
            <button type="button" className="local-terms-close" onClick={() => onClose(id)} title="탭 닫기" aria-label={`${name} 닫기`}>
              <RiCloseLine size={15} />
            </button>
          </div>
        </li>
      )
    }
    const name = localTabName(terminal)
    return (
      <li key={id} className="local-terms-item" data-local-session-id={id}>
        <div className={`local-terms-row ${id === visibleId ? 'is-current' : ''}`}>
          <button type="button" className="local-terms-open" onClick={() => focusTerminal(id)} title={`${name} 탭으로 이동`}>
            <RiComputerLine size={15} className="local-terms-icon" />
            <span className="local-terms-name">{label ?? name}</span>
            <span className={`local-terms-dot ${terminal.connected ? 'is-on' : ''}`} aria-hidden="true" />
          </button>
          {renderTabActions(id, label ?? name)}
        </div>
        <LocalSessionAgents tabId={id} />
      </li>
    )
  }

  const isCollapsed = !fillAvailableSpace && (isEmpty || prefs.collapsed)
  const collapsedWithWork = isCollapsed && workingTabs.size > 0
  const isSized = !fillAvailableSpace && prefs.height !== undefined && !isCollapsed
  const CollapseIcon = isCollapsed ? RiArrowRightSLine : RiArrowDownSLine

  return (
    <div
      ref={paneRef}
      className={`local-terms ${isSized ? 'is-sized' : ''} ${isCollapsed ? 'is-collapsed' : ''} ${fillAvailableSpace ? 'is-full' : ''}`}
      style={isSized ? { height: prefs.height } : undefined}
    >
      {!fillAvailableSpace && !isEmpty && (
        <div
          className="local-terms-divider"
          role="separator"
          aria-orientation="horizontal"
          aria-label="로컬 터미널 목록 높이"
          tabIndex={0}
          title="끌어서 높이 조절 · 두 번 누르면 자동 높이"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={resetHeight}
          onKeyDown={handleKeyDown}
        />
      )}
      <div className="local-terms-header">
        {!fillAvailableSpace && (isEmpty ? (
          <span className="local-terms-title"><RiComputerLine size={16} aria-hidden="true" />로컬 작업</span>
        ) : (
          <button
            type="button"
            className="local-terms-toggle"
            data-agent-work={collapsedWithWork ? 'working' : undefined}
            aria-description={collapsedWithWork ? '작업 중인 에이전트 있음' : undefined}
            onClick={() => update({ ...prefs, collapsed: !prefs.collapsed }, true)}
            aria-expanded={!isCollapsed}
            title={isCollapsed ? '로컬 작업 펼치기' : '로컬 작업 접기'}
          >
            <CollapseIcon size={16} />
            <span>로컬 작업</span>
            {locals.length > 0 && <span className="local-terms-count" title={`열린 로컬 터미널 ${locals.length}개`}>{locals.length}</span>}
          </button>
        ))}
        {projects.length > 0 && (
          <button type="button" className="local-terms-btn" onClick={refresh} title="워크트리 다시 읽기" aria-label="워크트리 다시 읽기">
            <RiRefreshLine size={15} />
          </button>
        )}
        <button type="button" className="local-terms-btn" onClick={() => void addFolder()} title="작업 폴더 추가" aria-label="작업 폴더 추가">
          <RiFolderAddLine size={15} />
        </button>
        {onOpen && (
          <button type="button" className="local-terms-btn" onClick={event => onOpen(event.currentTarget)} title="새 로컬 터미널" aria-label="새 로컬 터미널">
            <RiAddLine size={16} />
          </button>
        )}
      </div>
      {!isCollapsed && (
        <div className="local-terms-scroll">
          {isEmpty && <div className="session-list-empty"><p>등록된 작업 폴더와 열린 터미널이 없습니다</p></div>}
          {nodes.length > 0 && (
            <LocalProjectsTree
              nodes={nodes}
              folded={folded}
              onToggleFold={toggleFold}
              tabsOf={tabsOf}
              currentTabId={visibleId}
              renderTab={renderTab}
              renderTabActions={renderTabActions}
              onOpenWorktree={openWorktree}
              renderServers={renderServers}
              onDropOnProject={linkDropped}
              onRemoveProject={removeProject}
            />
          )}
          {assignment.others.length > 0 && (
            <>
              {nodes.length > 0 && <div className="local-terms-group">다른 로컬 터미널</div>}
              <ul className="local-terms-list">
                {assignment.others.map(id => renderTab(id))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
