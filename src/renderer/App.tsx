import { Fragment, lazy, Suspense, useCallback, useEffect, useState, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { RiDatabase2Line, RiComputerLine, RiGlobalLine } from 'react-icons/ri'
import { Sidebar } from './components/Sidebar/Sidebar'
import { Footer } from './components/Footer/Footer'
import { McpApprovalDialog } from './components/Mcp/McpApprovalDialog'
import { useAppZoom } from './hooks/useAppZoom'
import { WindowZoom } from './components/Zoom/WindowZoom'
import { TitleBar } from './components/TitleBar/TitleBar'
import { TerminalPanel } from './components/Terminal/TerminalPanel'
import { SplitPaneTabBar } from './components/Terminal/SplitPaneTabBar'
import { TerminalWindow } from './components/Terminal/TerminalWindow'
import { TerminalWebLinkMenu } from './components/Terminal/TerminalWebLinkMenu'
import { SftpPanel } from './components/Sftp/SftpPanel'
import { SftpWindow } from './components/Sftp/SftpWindow'
import { ConnectModal, ConnectionConfig, DEFAULT_CONFIG } from './components/Modal/ConnectModal'
import { SessionImportDialog } from './components/Sidebar/SessionImportDialog'
import { WhatsNewDialog, BUNDLED_NOTES } from './components/WhatsNew/WhatsNewDialog'
import { notesToShow, recentNotes, type VersionNotes } from './lib/releaseNotes'
import type { SharedSession } from './lib/sessionShare'
import { QuickConnectModal, QuickConnectionConfig } from './components/Modal/QuickConnectModal'
import { LocalProjectDialog, type LocalProjectTerminal } from './components/Modal/LocalProjectDialog'
import { OPEN_LOCAL_TERMINAL_EVENT } from './lib/localProjectList'
import { typeWhenShellSettles } from './lib/gitLogin'
import { SessionPickerModal } from './components/Modal/SessionPickerModal'
import { NewTabMenu } from './components/Terminal/NewTabMenu'
import { TabWorktreeBadge } from './components/Terminal/TabWorktreeBadge'
import { AgentMessagesHost, AgentTabMessages, isAgentWorking, useAgentMessagesStore } from './components/Terminal/AgentMessages'
import { getDuplicateConfig } from './lib/duplicateConnection'
import { tabHost, dropTabHostsExcept, isTabHostPreviewed } from './lib/tabHosts'
import { perFrame } from './lib/throttle'
import { WorkOverview } from './components/Sidebar/WorkOverview'
import { TabSlot } from './components/Terminal/TabSlot'
import { findTabPane, isSshTab } from './lib/sessionTabs'
import { detachTab, restoreMergedTab, type DetachedTab } from './lib/detachedTab'
import { captureTerminalSnapshot, setPendingSnapshot } from './lib/terminalSnapshots'
import { SettingsModal } from './components/Settings/SettingsModal'
import { WelcomeScreen } from './components/MainContent/WelcomeScreen'
import { LockScreen } from './components/LockScreen/LockScreen'
import { ToastContainer } from './components/Toast'
import { toast } from './stores/toastStore'
import { usePaneDropOnTabs } from './hooks/usePaneDropOnTabs'
import { useTabDropOnPane, SCREEN_SPLIT_BAND_PX } from './hooks/useTabDropOnPane'
import { useAgentSessionDrop } from './hooks/useAgentSessionDrop'
import { sideWord } from './lib/paneDropZones'
import { MERGE_BLOCKED_TITLE, mergeChoices, type MergeChoice } from './lib/tabMerge'
import { mergeTabIntoPane } from './lib/tabToPane'
import { setRestoreSource } from './lib/updateInstall'
import { buildRestoreRecord, readRestoreRecord, reopenable, type RecordSource, type RestoreTab } from './lib/restoreTabs'
import { restoreTabs } from './lib/restoreTabsRun'
import { RestoreTabsBanner, type RestoreBannerState } from './components/Restore/RestoreTabsBanner'
import { closeLocalPaneShells, getLocalPaneShellId, localTabShellIds } from './lib/localPaneShells'
import { focusTabPane } from './lib/paneFocus'
import { MAIN_PANE, paneIds } from './lib/splitTree'
import type { LocalDevelopmentTask } from './types'
import { useTabGroups } from './hooks/useTabGroups'
import { localTerminalChoices } from './lib/tabGroups'
import { HandoffProjectsContext } from './components/AgentChat/HandoffProjectsContext'
import { useTabStripScroll } from './hooks/useTabStripScroll'
import { addScreenRefusal, dragDivider, evenSizes } from './lib/screenPanes'
import { TabGroupChips } from './components/Terminal/TabGroupChips'
import { agentKindsByShell, agentsOfLocalTab, openLocalWithAgents } from './lib/restoreAgents'
import { OPEN_CLAUDE_PROFILE_EVENT, useClaudeProfiles, type OpenClaudeProfile } from './lib/claudeProfiles'
import { useAgentScreenReturnStore } from './stores/agentScreenReturnStore'
import { useAgentUsageStore } from './stores/agentUsageStore'
import { UpdateNotification } from './components/Update/UpdateNotification'
import { CommandPalette } from './components/CommandPalette'
import { ProjectSearch, ProjectSearchKeys } from './components/ProjectSearch/ProjectSearch'
import { TabContextMenu } from './components/Terminal/TabContextMenu'
import { DevelopmentTabDots } from './components/Terminal/DevelopmentRunStatus'
import { changeDevelopmentRun, developmentRunsForTab, useDevelopmentRunEvents, useDevelopmentRuns } from './lib/developmentRun'
import { TabRenameDialog } from './components/Terminal/TabRenameDialog'
import { DUPLICATE_TAB_EVENT, OPEN_SNIPPET_MANAGER_EVENT } from './components/Terminal/useTerminalContextMenu'
import { CLOSE_TAB_EVENT } from './lib/paneGesture'
import { folderName, RESUME_AGENT_SESSION_EVENT, type ResumeAgentSessionRequest } from './lib/agentHistory'
import { adoptOrphanLocalShells, keptLocalShells, rememberLocalLayout } from './lib/localShellAdopt'
import { startAgentSleep } from './stores/agentSleepStore'
import { startAgentHooks } from './stores/agentHooksStore'
import { clearRunPresets, REVEAL_RUN_SHELL_EVENT, startRunPresets, type RevealRunShell } from './stores/runPresetStore'
import { RunCrashNotices } from './components/Sidebar/RunCrashNotices'
import { RunCommandConfirm } from './components/Sidebar/RunCommandConfirm'
import { firstErrorRow } from './lib/runPresets'
import { terminalWithin } from './lib/terminalPanes'
import { OPEN_SETTINGS_EVENT } from './lib/settingsNavigation'
import { startDesktopPointerEffects } from './lib/pointerDesktop'
import { LOCAL_PROJECT_SERVERS_EVENT, TAB_DROP_TAKEN_EVENT, linkServer, readProjectServers, writeProjectServers } from './lib/localProjectServers'
import { WorkspacePanel } from './components/Workspace/WorkspacePanel'
import { SnippetManager } from './components/Snippets/SnippetManager'
import { StatsDashboard } from './components/Modal/StatsDashboard'
import { BatchCommandModal } from './components/Modal/BatchCommandModal'
import { useSessionStore, type Session } from './stores/sessionStore'
import { useTerminalStore } from './stores/terminalStore'
import { useSftpStore } from './stores/sftpStore'
import { useThemeStore } from './stores/themeStore'
import { useCommandPaletteStore } from './stores/commandPaletteStore'
import { confirmDialog } from './stores/confirmStore'
import { useUIStore } from './stores/uiStore'
import { useSSH } from './hooks/useSSH'
import { toSSHConnectConfig } from './lib/sshConnectConfig'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { motion, AnimatePresence } from 'framer-motion'
import { tabVariants } from './lib/animation/variants'
import { useReducedMotion } from './hooks/useReducedMotion'
import { SPRINGS } from './lib/animation/config'
import { captureTabFlightSource, flyToTab } from './lib/animation/sessionTabFlight'
import { ConfirmDialogHost } from './components/Modal/ConfirmDialogHost'
import { HostKeyDialog } from './components/Modal/HostKeyDialog'
import { useSessionLogStore } from './stores/sessionLogStore'
import { isChatShown, useAgentChatStore } from './stores/agentChatStore'
import { useAskQuestionStore } from './stores/askQuestionStore'
import { useGitCommitStore } from './stores/gitCommitStore'
import { gitReads } from './lib/gitReadCache'
import { useSessionLogFeed } from './hooks/useSessionLogFeed'
import { useBrowserTabTitles } from './hooks/useBrowserTabTitles'
import { usePinnedReplyGo } from './hooks/usePinnedReplyGo'
import { useAgentEscalations } from './hooks/useAgentEscalations'
import { openSessionLogFolder, toggleSessionLog } from './lib/sessionLogActions'
import './styles/sessionLog.css'
import { McpActivityWindow } from './components/Mcp/McpActivityWindow'
import { reconnectFailureText } from './lib/connectionLost'
// Only the server file window uses the code editor: loaded there, not in the main window
const RemoteFileWindow = lazy(() => import('./components/RemoteFile/RemoteFileWindow').then(module => ({ default: module.RemoteFileWindow })))
// The editor and grid are loaded only in DB windows
const DbClientWindow = lazy(() => import('./components/DbClient/DbClientWindow').then(module => ({ default: module.DbClientWindow })))
const LocalTerminalTab = lazy(() => import('./components/Terminal/LocalTerminalTab'))
const DbTab = lazy(() => import('./components/DbClient/DbTab'))
const BrowserReview = lazy(() => import('./components/Browser/BrowserReview'))
const PinnedReplyWindow = lazy(() => import('./components/AgentChat/PinnedReplyWindow').then(module => ({ default: module.PinnedReplyWindow })))

interface SessionConnectionTarget {
  workGroup?: string
  /** A saved session opened from the tab strip is also added to that project's server list. */
  assignProject?: boolean
}

// Check if we're in a special window mode
function getWindowModeParams() {
  const params = new URLSearchParams(window.location.search)

  // Check for SFTP mode
  if (params.get('sftpMode') === 'true') {
    return {
      mode: 'sftp' as const,
      sessionId: params.get('sessionId') || '',
      localPath: decodeURIComponent(params.get('localPath') || ''),
      remotePath: decodeURIComponent(params.get('remotePath') || ''),
      title: decodeURIComponent(params.get('title') || '')
    }
  }

  // Check for Terminal mode
  if (params.get('terminalMode') === 'true') {
    return {
      mode: 'terminal' as const,
      sessionId: params.get('sessionId') || '',
      title: decodeURIComponent(params.get('title') || '')
    }
  }

  if (params.get('mcpActivityMode') === 'true') {
    return { mode: 'mcpActivity' as const }
  }

  if (params.get('remoteFileMode') === 'true') {
    return { mode: 'remoteFile' as const }
  }

  if (params.get('pinnedReplyMode') === 'true') {
    return { mode: 'pinnedReply' as const }
  }

  if (params.get('dbMode') === 'true') {
    return { mode: 'db' as const, dbId: params.get('dbId') || '' }
  }

  return null
}

function App() {
  // A split pane dropped on a tab strip becomes a tab of its own
  usePaneDropOnTabs()
  // Check for special window modes
  const windowParams = getWindowModeParams()

  // Popped-out windows render their own toast area (copy confirmations, errors)
  if (windowParams?.mode === 'sftp') {
    return (
      <>
        <SftpWindow
          sessionId={windowParams.sessionId}
          initialLocalPath={windowParams.localPath}
          initialRemotePath={windowParams.remotePath}
          sessionTitle={windowParams.title}
        />
        <WindowZoom kind="sftp" />
        <ToastContainer />
        <ConfirmDialogHost />
      </>
    )
  }

  if (windowParams?.mode === 'remoteFile') {
    return (
      <>
        <Suspense fallback={null}>
          <RemoteFileWindow />
        </Suspense>
        <WindowZoom kind="remoteFile" />
        <ToastContainer />
        <ConfirmDialogHost />
      </>
    )
  }

  if (windowParams?.mode === 'db') {
    return (
      <>
        <Suspense fallback={null}>
          <DbClientWindow dbId={windowParams.dbId} />
        </Suspense>
        <WindowZoom kind="db" />
        <ToastContainer />
      </>
    )
  }

  // An agent answer pinned out of the chat view (AgentChat/PinnedReplyWindow.tsx)
  if (windowParams?.mode === 'pinnedReply') {
    return (
      <>
        <Suspense fallback={null}>
          <PinnedReplyWindow />
        </Suspense>
        <WindowZoom kind="pinnedReply" />
        <ToastContainer />
      </>
    )
  }

  if (windowParams?.mode === 'mcpActivity') {
    return (
      <>
        <McpActivityWindow />
        <WindowZoom kind="mcpActivity" />
        <ToastContainer />
      </>
    )
  }

  if (windowParams?.mode === 'terminal') {
    return (
      <>
        <TerminalWindow
          sessionId={windowParams.sessionId}
          title={windowParams.title}
        />
        <WindowZoom kind="terminal" />
        <TerminalWebLinkMenu />
        <ToastContainer />
        <ConfirmDialogHost />
      </>
    )
  }
  const [connectTarget, setConnectTarget] = useState<SessionConnectionTarget | null>(null)
  const [quickConnectModalOpen, setQuickConnectModalOpen] = useState(false)
  const [localProjectMode, setLocalProjectMode] = useState<'add' | 'open' | null>(null)
  const [sessionPickerTarget, setSessionPickerTarget] = useState<SessionConnectionTarget | null>(null)
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)
  const [snippetManagerOpen, setSnippetManagerOpen] = useState(false)
  const [statsDashboardOpen, setStatsDashboardOpen] = useState(false)
  const [batchModalOpen, setBatchModalOpen] = useState(false)
  const [editSession, setEditSession] = useState<ConnectionConfig | null>(null)
  const [duplicateSource, setDuplicateSource] = useState<ConnectionConfig | null>(null)
  const [duplicateTitle, setDuplicateTitle] = useState<string | undefined>(undefined)
  // "텍스트로 세션 추가": the folder to add into (null = closed)
  const [importTarget, setImportTarget] = useState<{ folderId?: string } | null>(null)
  // "업데이트 내용": notes to show, and whether closing records them as seen (automatic opening only)
  const [whatsNew, setWhatsNew] = useState<{ entries: VersionNotes[]; markSeen: boolean } | null>(null)
  const [defaultFolderId, setDefaultFolderId] = useState<string | undefined>(undefined)
  const [isLocked, setIsLocked] = useState(true)
  const [hasMasterPassword, setHasMasterPassword] = useState(false)
  const [isCheckingLock, setIsCheckingLock] = useState(true)
  const [isLockScreenReady, setIsLockScreenReady] = useState(false)
  const markLockScreenReady = useCallback(() => setIsLockScreenReady(true), [])

  // Initialize theme on mount
  const initializeTheme = useThemeStore(state => state.initializeTheme)
  useEffect(() => {
    initializeTheme()
  }, [initializeTheme])

  const reducedMotion = useReducedMotion()

  // Tabs whose terminal output is being written to a log file
  useSessionLogFeed()
  // Browser tabs take the name of the page they show
  useBrowserTabTitles()
  // "원래 대화로 가기" in a pinned answer window
  usePinnedReplyGo()
  useAgentEscalations(isLocked)
  useDevelopmentRunEvents(isLocked)
  const developmentRuns = useDevelopmentRuns(state => state.runs)
  const sessionLogFiles = useSessionLogStore(state => state.files)

  // Tab drag state
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [dropZone, setDropZone] = useState<'left' | 'right' | 'top' | 'bottom' | 'popout' | null>(null)
  const terminalAreaRef = useRef<HTMLDivElement>(null)
  // Color and connect config of tabs popped out to their own window, restored when they merge back
  const detachedTabsRef = useRef(new Map<string, DetachedTab>())
  const tabClosePending = useRef(false)
  const readRestoreSource = useCallback((): RecordSource => {
    const { terminals, layout, activeTerminalId } = useTerminalStore.getState()
    const sftp = useSftpStore.getState()
    const usage = useAgentUsageStore.getState().byShell
    const kinds = agentKindsByShell()
    const profiles = new Map(useAgentMessagesStore.getState().snapshot.agents.flatMap(agent =>
      agent.active && agent.shellId && agent.claudeProfileId ? [[agent.shellId, agent.claudeProfileId] as const] : []))
    return {
      terminals, layout, activeId: activeTerminalId,
      sftpPathOf: tabId => sftp.isOpen(tabId) ? sftp.remotePath(tabId) : null,
      detached: Array.from(detachedTabsRef.current.values()),
      // The agent sessions in a local tab's panes, so a restart can resume them (lib/restoreAgents.ts)
      agentsOf: tabId => agentsOfLocalTab(tabId, terminals.get(tabId), usage, kinds, isChatShown, profiles)
    }
  }, [])
  const [splitPaneDraggingTabId, setSplitPaneDraggingTabId] = useState<string | null>(null)
  // A tab dragged onto a pane of another tab of the same session becomes a pane of that tab.
  // From the single tab strip the edges of the terminal area mean "split the screen" (drop zones below).
  const tabDropTaken = useRef(false)
  // The edge bands belong to the screen split, never to merging into a pane: at four screens (or the other
  // direction) a drop there is refused with the reason instead of merging (that merge was the complaint)
  const tabDropHover = useTabDropOnPane(draggingTabId ?? splitPaneDraggingTabId, draggingTabId !== null || splitPaneDraggingTabId !== null, tabDropTaken)
  const mergeHover = tabDropHover?.kind === 'merge' ? tabDropHover : null
  // A tab dropped in an edge band where no screen can be added: why (shown when the drag ends)
  const screenRefusal = useRef<string | null>(null)
  const overTabStrip = tabDropHover?.kind === 'order' || mergeHover?.onTab === true
  useEffect(() => {
    if (!overTabStrip) return
    setDropZone(null)
    screenRefusal.current = null
  }, [overTabStrip])
  // A past session dragged from the agent history panel onto a tab strip or a local terminal pane
  const agentDropHover = useAgentSessionDrop()
  // A tab dropped on a local project in the sidebar (linked as its server) stays where it is
  useEffect(() => {
    const onTaken = () => { tabDropTaken.current = true }
    // The tab's own dragend (handleTabDragEnd) has read the mark by now; a drag from the split view's
    // tab strip does not clear it, and a leftover mark would swallow the next drag
    const onDragEnd = () => { setTimeout(() => { tabDropTaken.current = false }) }
    window.addEventListener(TAB_DROP_TAKEN_EVENT, onTaken)
    window.addEventListener('dragend', onDragEnd)
    return () => {
      window.removeEventListener(TAB_DROP_TAKEN_EVENT, onTaken)
      window.removeEventListener('dragend', onDragEnd)
    }
  }, [])

  // Context menu state
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 })
  const [contextMenuTabId, setContextMenuTabId] = useState<string | null>(null)
  const [renamingTab, setRenamingTab] = useState<{ id: string; title: string } | null>(null)
  const [isSettingsLoaded, setIsSettingsLoaded] = useState(false)

  // Split pane resize state
  // The divider being dragged (between screen i and i + 1); the shares live in the layout
  const [resizingDivider, setResizingDivider] = useState<number | null>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)

  // Split pane session selector dropdown
  const [splitDropdownOpen, setSplitDropdownOpen] = useState<'primary' | 'secondary' | null>(null)
  const splitDropdownRef = useRef<HTMLDivElement>(null)

  const { sessions, isLoading: areSessionsLoading, loadFromBackend, addSession, updateSession } = useSessionStore()
  const startupScreenReady = !isCheckingLock && (isLocked
    ? isLockScreenReady
    : isSettingsLoaded && !areSessionsLoading)
  useEffect(() => {
    if (!startupScreenReady) return
    // Leave one frame for the committed screen to paint while the main window is still hidden.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => window.electronAPI?.startupReady?.())
    })
    return () => cancelAnimationFrame(frame)
  }, [startupScreenReady])
  const {
    terminals,
    activeTerminalId,
    setActiveTerminal,
    removeTerminal,
    setFontSize,
    setFontFamily,
    layout,
    setActivePaneTerminal,
    setActivePaneType,
    closeSplit,
    moveTerminalBetweenPanes,
    setPaneSizes
  } = useTerminalStore()
  // The single tab strip scrolls sideways when its tabs do not fit (design review D5)
  const tabStripRef = useTabStripScroll(activeTerminalId)
  // The tab strip shows one work at a time (hooks/useTabGroups.ts)
  const groupView = useTabGroups(!isLocked)
  const { projects: localProjects, groups: localGroups } = groupView
  useEffect(() => {
    if (isLocked) return
    const tabGroups = localGroups.flatMap(({ key, label, tabIds }) =>
      tabIds.filter(id => {
        const tab = terminals.get(id)
        return tab && !tab.local && !tab.db
      }).map(id => ({ id, key, label })))
    const sendWorkspace = () => {
      const links = readProjectServers()
      const projectServers = localProjects.map(({ key }) => ({ key, sessionIds: links[key] ?? [] }))
      window.electronAPI.remoteAccessSetProjects?.(localProjects, tabGroups, projectServers)
    }
    sendWorkspace()
    window.addEventListener(LOCAL_PROJECT_SERVERS_EVENT, sendWorkspace)
    return () => window.removeEventListener(LOCAL_PROJECT_SERVERS_EVENT, sendWorkspace)
  }, [isLocked, localProjects, localGroups, terminals])
  const shownTabs = new Set(groupView.shownIds)
  const shownSplitPanes = layout.mode === 'split' ? layout.panes.map(pane => {
    const terminalIds = pane.terminalIds.filter(id => shownTabs.has(id))
    // A screen can still hold tabs of another work. Use the same visible tab for its strip and content.
    const activeTerminalId = pane.activeTerminalId && shownTabs.has(pane.activeTerminalId)
      ? pane.activeTerminalId : terminalIds[0] ?? null
    return { terminalIds, activeTerminalId }
  }) : []
  const { isOpen, setOpen } = useSftpStore()
  const { connect, disconnect } = useSSH()
  const { zenMode, toggleZenMode, browserTabMaxWidth } = useUIStore()

  // SFTP state for active terminal
  const sftpOpen = activeTerminalId ? isOpen(activeTerminalId) : false

  // Load app settings from file
  const loadSettings = async () => {
    try {
      const settings = await window.electronAPI.loadSettings()
      if (settings.terminalFontSize) {
        setFontSize(settings.terminalFontSize)
      }
      if (settings.terminalFontFamily) {
        setFontFamily(settings.terminalFontFamily)
      }
      setIsSettingsLoaded(true)
    } catch (error) {
      console.error('Failed to load settings:', error)
      setIsSettingsLoaded(true) // Set to true even on error to prevent infinite loading
    }
  }

  // Closed tabs: drop the DOM node that held their content
  useEffect(() => {
    dropTabHostsExcept(terminals.keys())
  }, [terminals])

  // A new tab opens in the pane that has focus. The store always adds it to the primary pane, so a
  // tab that just appeared there while the secondary pane is the focused one is moved over. (This is
  // what the + menu of the secondary pane, the sidebar and the session picker rely on.)
  const knownTabIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    const added = Array.from(terminals.keys()).filter(id => !knownTabIds.current.has(id))
    knownTabIds.current = new Set(terminals.keys())
    const current = useTerminalStore.getState().layout
    const focused = current.activePane
    if (current.mode !== 'split' || !focused) return
    for (const id of added) {
      if (current.panes[0]?.terminalIds.includes(id)) moveTerminalBetweenPanes(id, 0, focused)
    }
  }, [terminals, moveTerminalBetweenPanes])

  // Check master password status on mount
  useEffect(() => {
    const checkLockStatus = async () => {
      try {
        const hasPwd = await window.electronAPI.hasMasterPassword()
        setHasMasterPassword(hasPwd)

        if (hasPwd) {
          const { locked } = await window.electronAPI.isAppLocked()
          setIsLocked(locked)
          if (!locked) {
            await Promise.all([loadSettings(), loadFromBackend()])
          } else {
            // When locked, mark settings as loaded (will load after unlock)
            setIsSettingsLoaded(true)
          }
        } else {
          // No master password set yet, show setup screen
          setIsLocked(true)
          setIsSettingsLoaded(true)
        }
      } catch (error) {
        console.error('Failed to check lock status:', error)
        setIsSettingsLoaded(true)
      } finally {
        setIsCheckingLock(false)
      }
    }

    checkLockStatus()

    // Global SSH data listener - dispatches to individual terminals
    window.electronAPI.onSshData((data: { sessionId: string; data: string }) => {
      useTerminalStore.getState().dispatchSshData(data.sessionId, data.data)
    })

    // Listen for SSH closed events
    window.electronAPI.onSshClosed((data: { sessionId: string }) => {
      // Mark as disconnected (don't remove terminal to allow reconnection)
      const { setDisconnected } = useTerminalStore.getState()
      setDisconnected(data.sessionId)
    })

    // Listen for SSH reconnection events
    window.electronAPI.onSshReconnecting((data: { sessionId: string; attempt: number; maxAttempts: number }) => {
      const { setReconnecting } = useTerminalStore.getState()
      setReconnecting(data.sessionId, data.attempt, data.maxAttempts)
    })

    window.electronAPI.onSshReconnected((data: { sessionId: string }) => {
      const { setConnected } = useTerminalStore.getState()
      setConnected(data.sessionId)
    })

    window.electronAPI.onSshReconnectFailed((data: { sessionId: string; message?: string }) => {
      const { setDisconnected } = useTerminalStore.getState()
      setDisconnected(data.sessionId, reconnectFailureText(data.message))
    })

    // Listen for terminal merge events (when popped-out terminal merges back)
    window.electronAPI.onTerminalMerge((data: { sessionId: string; title: string; host: string; username: string; snapshot?: string }) => {
      // Screen of the popped-out window, drawn by the tab's terminal before new output
      if (data.snapshot) setPendingSnapshot(data.sessionId, data.snapshot)
      const { addTerminal, setActiveTerminal } = useTerminalStore.getState()
      // Read without deleting: this effect has no cleanup, so StrictMode registers the listener twice
      // and both calls must see the entry. It is dropped when the tab is closed.
      addTerminal(data.sessionId, restoreMergedTab(data, detachedTabsRef.current.get(data.sessionId)))
      setActiveTerminal(data.sessionId)
    })
  }, [])

  // Zen mode: double-ESC to exit
  const lastEscRef = useRef(0)
  useEffect(() => {
    if (!zenMode) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const now = Date.now()
        if (now - lastEscRef.current < 500) {
          toggleZenMode()
          lastEscRef.current = 0
        } else {
          lastEscRef.current = now
        }
      }
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [zenMode, toggleZenMode])

  // Close split dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (splitDropdownOpen && splitDropdownRef.current && !splitDropdownRef.current.contains(e.target as Node)) {
        setSplitDropdownOpen(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [splitDropdownOpen])

  // Dragging a divider: only its two neighbouring screens change (lib/screenPanes.ts dragDivider)
  useEffect(() => {
    if (resizingDivider === null) return
    // One update (one render of the whole layout) per frame, however many mouse moves arrive
    const apply = perFrame((ratio: number) => {
      const { layout: current, setPaneSizes: setSizes } = useTerminalStore.getState()
      setSizes(dragDivider(current.sizes, resizingDivider, ratio))
    })
    const handleMouseMove = (e: MouseEvent) => {
      const container = splitContainerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      apply(layout.direction === 'horizontal' ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height)
    }
    const handleMouseUp = () => {
      apply.cancel()
      setResizingDivider(null)
      document.body.classList.remove('resizing')
      window.dispatchEvent(new Event('resize'))
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', handleMouseMove, true)
    window.addEventListener('mouseup', handleMouseUp, true)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove, true)
      window.removeEventListener('mouseup', handleMouseUp, true)
    }
  }, [resizingDivider, layout.direction])

  // Handle terminal zoom from main process (Ctrl+/-/0 intercepted at Electron level)
  useEffect(() => {
    const cleanup = window.electronAPI.onTerminalZoom?.((direction: string) => {
      if (direction === 'in') {
        useTerminalStore.getState().increaseFontSize()
      } else if (direction === 'out') {
        useTerminalStore.getState().decreaseFontSize()
      } else if (direction === 'reset') {
        useTerminalStore.getState().resetFontSize()
      }
    })
    return () => { cleanup?.() }
  }, [])

  // Ctrl + mouse wheel → app zoom (프로그램 전체 확대/축소)
  useAppZoom()

  const handleUnlock = async () => {
    const loadingSessions = loadFromBackend()
    setIsLocked(false)
    setHasMasterPassword(true)
    setIsSettingsLoaded(false) // Reset to false before loading
    await Promise.all([loadSettings(), loadingSessions])
  }

  // Keyboard shortcuts handler
  useKeyboardShortcuts({
    openCommandPalette: () => {
      useCommandPaletteStore.getState().toggle()
    },
    newConnection: () => {
      handleNewConnection()
    },
    openSettings: () => {
      handleOpenSettings()
    },
    openSnippetManager: () => {
      handleOpenSnippetManager()
    },
    toggleFullscreen: async () => {
      await window.electronAPI.toggleFullscreen()
    },
    lockApp: async () => {
      if (hasMasterPassword) {
        await window.electronAPI.lockApp(buildRestoreRecord(readRestoreSource()))
        setIsLocked(true)
      }
    },
    closeCurrentTerminal: () => {
      if (activeTerminalId) {
        void requestCloseTabs([activeTerminalId])
      }
    },
    zoomIn: () => {
      useTerminalStore.getState().increaseFontSize()
    },
    zoomOut: () => {
      useTerminalStore.getState().decreaseFontSize()
    },
    resetZoom: () => {
      useTerminalStore.getState().resetFontSize()
    },
    clearTerminal: () => {
      window.dispatchEvent(new CustomEvent('terminal-clear'))
    },
    toggleSftp: () => {
      handleToggleSftp()
    },
    toggleZenMode: () => {
      toggleZenMode()
    },
    nextTab: () => {
      const terminalIds = groupView.shownIds
      if (terminalIds.length === 0) return
      const currentIdx = activeTerminalId ? terminalIds.indexOf(activeTerminalId) : -1
      const nextIdx = (currentIdx + 1) % terminalIds.length
      setActiveTerminal(terminalIds[nextIdx])
    },
    prevTab: () => {
      const terminalIds = groupView.shownIds
      if (terminalIds.length === 0) return
      const currentIdx = activeTerminalId ? terminalIds.indexOf(activeTerminalId) : 0
      const prevIdx = (currentIdx - 1 + terminalIds.length) % terminalIds.length
      setActiveTerminal(terminalIds[prevIdx])
    },
    jumpToTab1: () => {
      const terminalIds = groupView.shownIds
      if (terminalIds.length > 0) setActiveTerminal(terminalIds[0])
    },
    jumpToTab2: () => {
      const terminalIds = groupView.shownIds
      if (terminalIds.length > 1) setActiveTerminal(terminalIds[1])
    },
    jumpToTab3: () => {
      const terminalIds = groupView.shownIds
      if (terminalIds.length > 2) setActiveTerminal(terminalIds[2])
    },
    jumpToTab4: () => {
      const terminalIds = groupView.shownIds
      if (terminalIds.length > 3) setActiveTerminal(terminalIds[3])
    },
    jumpToTab5: () => {
      const terminalIds = groupView.shownIds
      if (terminalIds.length > 4) setActiveTerminal(terminalIds[4])
    },
    jumpToTab6: () => {
      const terminalIds = groupView.shownIds
      if (terminalIds.length > 5) setActiveTerminal(terminalIds[5])
    },
    jumpToTab7: () => {
      const terminalIds = groupView.shownIds
      if (terminalIds.length > 6) setActiveTerminal(terminalIds[6])
    },
    jumpToTab8: () => {
      const terminalIds = groupView.shownIds
      if (terminalIds.length > 7) setActiveTerminal(terminalIds[7])
    },
    jumpToTab9: () => {
      const terminalIds = groupView.shownIds
      if (terminalIds.length > 8) setActiveTerminal(terminalIds[8])
    }
  }, !isLocked)

  const handleConnect = async (config: ConnectionConfig, { workGroup, assignProject }: SessionConnectionTarget = {}) => {
    // Get effective color (session color or folder color chain)
    const getFolderEffectiveColor = (folderId: string): string | undefined => {
      const { folders } = useSessionStore.getState()
      const folder = folders.find(f => f.id === folderId)
      if (!folder) return undefined
      if (folder.backgroundColor) return folder.backgroundColor
      if (folder.parentId) return getFolderEffectiveColor(folder.parentId)
      return undefined
    }

    let effectiveColor = config.backgroundColor
    if (!effectiveColor && config.folderId) {
      effectiveColor = getFolderEffectiveColor(config.folderId)
    }

    // Save session first if requested (regardless of connection result)
    const savedSessionId = config.saveSession ? persistSession(config) : config.id

    // Then attempt connection
    const result = await connect({ ...toSSHConnectConfig({ ...config, id: savedSessionId }, effectiveColor), workGroup })
    if (result.success && assignProject && savedSessionId && workGroup && groupView.projects.some(project => project.key === workGroup)) {
      const current = readProjectServers()
      const linked = linkServer(current, workGroup, savedSessionId)
      if (linked !== current && (!linked[workGroup]?.includes(savedSessionId) || !writeProjectServers(linked))) {
        toast.error('서버 목록을 저장하지 못했습니다', '로컬 작업에 세션을 묶지 못했습니다.')
      }
    }
    return result
  }

  /**
   * Add or update the sidebar session for this config and write it to disk.
   * Returns the session id; a brand-new session gets its id here so a connection
   * started right after can carry it (path bookmarks etc.).
   */
  const persistSession = (config: ConnectionConfig): string => {
    const savedSessionId = config.id ?? crypto.randomUUID()
    const sessionData = {
      name: config.name || `${config.username}@${config.host}`,
      host: config.host,
      port: config.port,
      username: config.username,
      authType: config.authType,
      password: config.password,
      privateKeyPath: config.privateKeyPath,
      passphrase: config.passphrase,
      folderId: config.folderId,
      icon: config.icon,
      backgroundColor: config.backgroundColor,
      connectTimeout: config.connectTimeout,
      keepaliveInterval: config.keepaliveInterval,
      autoReconnect: config.autoReconnect,
      postConnectScript: config.postConnectScript,
      mcpEnabled: config.mcpEnabled === true,
      suRoot: config.suRoot === true,
      suPassword: config.suPassword,
      useJumpHost: config.useJumpHost,
      jumpHost: config.jumpHost,
      jumpPort: config.jumpPort,
      jumpUsername: config.jumpUsername,
      jumpAuthType: config.jumpAuthType,
      jumpPassword: config.jumpPassword,
      jumpPrivateKeyPath: config.jumpPrivateKeyPath,
      jumpPassphrase: config.jumpPassphrase
    }

    if (config.id) {
      // 기존 세션 업데이트
      updateSession(config.id, sessionData)
    } else {
      // 새 세션 추가
      addSession({ ...sessionData, id: savedSessionId })
    }
    useSessionStore.getState().saveToBackend()
    return savedSessionId
  }

  // Edit/duplicate modal "저장": save the session without connecting
  const handleSaveSession = (config: ConnectionConfig) => {
    persistSession(config)
    const name = config.name || `${config.username}@${config.host}`
    toast.success('저장됨', config.id ? `${name} 세션을 수정했습니다` : `${name} 세션을 등록했습니다`)
  }

  const handleQuickConnect = async (session: Session, source?: HTMLElement, target?: SessionConnectionTarget) => {
    // Get effective color (session color or folder color chain)
    const getFolderEffectiveColor = (folderId: string): string | undefined => {
      const { folders } = useSessionStore.getState()
      const folder = folders.find(f => f.id === folderId)
      if (!folder) return undefined
      if (folder.backgroundColor) return folder.backgroundColor
      if (folder.parentId) return getFolderEffectiveColor(folder.parentId)
      return undefined
    }

    let effectiveColor = session.backgroundColor
    if (!effectiveColor && session.folderId) {
      effectiveColor = getFolderEffectiveColor(session.folderId)
    }

    const { icon: _icon, ...connection } = session
    const result = await handleConnect({
      ...connection,
      backgroundColor: effectiveColor,
      saveSession: false
    }, target)
    if (source && result.success && result.sessionId) {
      const origin = captureTabFlightSource(source.querySelector('.session-name'), source.closest('.session-list'))
      if (origin) void flyToTab(origin, result.sessionId)
    }
    return result
  }

  const openNewConnection = (target: SessionConnectionTarget, folderId?: string) => {
    setEditSession(null)
    setDuplicateSource(null)
    setDefaultFolderId(folderId)
    setConnectTarget(target)
  }

  const handleNewConnection = () => openNewConnection({})
  const handleAddSession = (folderId?: string) => openNewConnection({}, folderId)

  const handleEditSession = (session: any) => {
    setDuplicateSource(null)
    setEditSession(session)
    setConnectTarget({})
  }

  // Open the new-connection form prefilled from an existing session; saving creates a new session
  const handleDuplicateSession = (session: any) => {
    const baseName = session.name || `${session.username}@${session.host}`
    setEditSession(null)
    setDefaultFolderId(undefined)
    setDuplicateSource({ ...session, id: undefined, name: `${baseName} - 복제됨`, saveSession: true, mcpEnabled: false })
    setDuplicateTitle(undefined)
    setConnectTarget({})
  }

  // A session from shared text opens the new-connection form, where passwords and keys are entered
  const handleOpenSharedSession = (shared: SharedSession, folderId?: string) => {
    setEditSession(null)
    setDefaultFolderId(undefined)
    setDuplicateSource({ ...DEFAULT_CONFIG, ...shared, id: undefined, folderId: folderId ?? '', saveSession: true, mcpEnabled: false })
    setDuplicateTitle('공유받은 세션 추가')
    setConnectTarget({})
  }

  // "탭 복제" in a terminal's right-click menu
  useEffect(() => {
    const onDuplicate = (event: Event) => { void handleDuplicateTab((event as CustomEvent<string>).detail) }
    const onSnippets = () => setSnippetManagerOpen(true)
    // An Alt+drag scribble over the only pane of a tab (lib/paneGesture.ts)
    const onCloseTab = (event: Event) => {
      const id = (event as CustomEvent<unknown>).detail
      if (typeof id === 'string' && useTerminalStore.getState().terminals.has(id)) void requestCloseTabs([id])
    }
    window.addEventListener(DUPLICATE_TAB_EVENT, onDuplicate)
    window.addEventListener(OPEN_SNIPPET_MANAGER_EVENT, onSnippets)
    window.addEventListener(CLOSE_TAB_EVENT, onCloseTab)
    return () => {
      window.removeEventListener(DUPLICATE_TAB_EVENT, onDuplicate)
      window.removeEventListener(OPEN_SNIPPET_MANAGER_EVENT, onSnippets)
      window.removeEventListener(CLOSE_TAB_EVENT, onCloseTab)
    }
  })

  // Open another tab to the same server as `terminalId`, reusing the config it connected with
  const handleDuplicateTab = async (terminalId: string | null) => {
    const config = getDuplicateConfig(terminalId ? terminals.get(terminalId) : null)
    if (!config) {
      toast.error('복제할 수 없음', '이 탭의 접속 정보를 찾을 수 없습니다')
      return
    }
    await connect(config)
  }

  const handleOpenQuickConnect = () => {
    setQuickConnectModalOpen(true)
  }

  const handleQuickConnectSubmit = async (config: QuickConnectionConfig, saveSession: boolean) => {
    const fullConfig: ConnectionConfig = {
      ...config,
      name: `${config.username}@${config.host}`,
      saveSession: saveSession,
      icon: 'server'
    }
    await handleConnect(fullConfig)
  }

  const closeTerminal = (sessionId: string) => {
    const terminal = useTerminalStore.getState().getTerminal(sessionId)
    if (!terminal) return
    detachedTabsRef.current.delete(sessionId)
    if (terminal.browser) {
      window.electronAPI.browserReviewClose(sessionId)
      removeTerminal(sessionId)
      return
    }
    const db = terminal.db
    if (db) {
      // A DB tab: only its database connection closes, the SSH tab stays
      void window.electronAPI.dbClose?.(db.dbId)
      removeTerminal(sessionId)
      return
    }
    const local = terminal.local
    if (local) {
      // The shells of its split panes go with the tab
      closeLocalPaneShells(sessionId)
      window.electronAPI.localShellClose?.(local.shellId ?? sessionId)
      removeTerminal(sessionId)
      return
    }
    disconnect(sessionId)
  }

  const requestCloseTabs = async (sessionIds: readonly string[]) => {
    if (tabClosePending.current) return
    const targets = sessionIds.map(id => ({ id, shells: localTabShellIds(id) }))
    const localTargets = targets.filter(target => target.shells.length > 0)
    if (localTargets.length === 0) {
      sessionIds.forEach(closeTerminal)
      return
    }

    tabClosePending.current = true
    try {
      const hasWorkingAgent = window.electronAPI.localShellHasWorkingAgent
      const working = hasWorkingAgent && (await Promise.all(localTargets.map(({ shells }) =>
        hasWorkingAgent(shells).catch(() => false)
      ))).some(Boolean)
      const shellIds = new Set(localTargets.flatMap(target => target.shells))
      const agents = useAgentMessagesStore.getState().snapshot.agents.filter(agent => agent.active && shellIds.has(agent.shellId))
      if (working || agents.length > 0) {
        const activity = working || agents.some(isAgentWorking) ? '작업 중인' : '실행 중인'
        const title = sessionIds.length === 1 ? '탭 닫기' : '여러 탭 닫기'
        const confirmed = await confirmDialog({
          title,
          message: `${activity} 에이전트 세션이 있습니다. 탭을 닫으면 해당 세션이 종료됩니다. 닫을까요?`,
          confirmLabel: title,
          danger: true
        })
        if (!confirmed) return
      }

      if (targets.some(({ id, shells }) => {
        const current = localTabShellIds(id)
        return current.length !== shells.length || current.some(shell => !shells.includes(shell))
      })) {
        toast.info('다시 확인해 주세요', '닫으려는 탭에 열려 있는 세션이 바뀌었습니다.')
        return
      }
      sessionIds.forEach(closeTerminal)
    } finally {
      tabClosePending.current = false
    }
  }

  const addLocalTerminalTab = useCallback((result: { id: string; name: string; cwd?: string }, workspaceLabel?: string, pane?: number) => {
    const store = useTerminalStore.getState()
    const count = Array.from(store.terminals.values()).filter(info => info.local).length
    store.addTerminal(result.id, {
      id: result.id, host: '이 PC', username: '', connected: true,
      // Never the agent's name: the panes of the tab may run other agents or plain shells
      title: workspaceLabel
        ? workspaceLabel
        : (count === 0 ? result.name : `${result.name} (${count + 1})`),
      local: { shell: result.name, cwd: result.cwd, workspaceLabel }
    })
    const { layout: current } = useTerminalStore.getState()
    const targetPane = pane ?? current.activePane
    if (current.mode === 'split' && targetPane !== null && current.panes[targetPane]) {
      if (targetPane > 0) store.moveTerminalBetweenPanes(result.id, 0, targetPane)
      if (pane !== undefined) store.focusTerminal(result.id)
    }
    return result.id
  }, [])

  useEffect(() => window.electronAPI.onLocalAgentRequestOpened(opened => {
    addLocalTerminalTab(opened, opened.workspaceLabel)
  }), [addLocalTerminalTab])

  // A terminal of this PC as a new tab (the shell runs in the main process)
  const handleOpenLocalTerminal = async ({ cwd, agent, workspaceLabel, resume, restoring, claudeProfileId }: Partial<LocalProjectTerminal> & {
    resume?: string; restoring?: true; claudeProfileId?: string
  } = {}, pane?: number): Promise<string | null> => {
    const result = await window.electronAPI.localShellOpen?.({ cols: 80, rows: 24, cwd, agent, resume, restoring, claudeProfileId })
    if (!result || !result.success) {
      toast.error('로컬 터미널을 열지 못했습니다', result ? result.error : '앱을 다시 시작해 주세요.')
      return null
    }
    return addLocalTerminalTab(result, workspaceLabel, pane)
  }

  const unlockedOnce = !isLocked && !isCheckingLock
  useEffect(() => {
    if (!unlockedOnce) return
    void useClaudeProfiles.getState().load().catch(() => {})
    const open = async (event: Event) => {
      const { profileId, shellId } = (event as CustomEvent<OpenClaudeProfile>).detail
      const current = useTerminalStore.getState()
      const active = current.activeTerminalId ? current.terminals.get(current.activeTerminalId) : undefined
      try {
        const cwd = (shellId ? await window.electronAPI.localShellCurrentDirectory(shellId) : null) ?? active?.local?.cwd
        const result = await window.electronAPI.localShellOpen?.({
          cols: 80, rows: 24, agent: 'claude', cwd, claudeProfileId: profileId, reuseClaudeProfile: true
        })
        if (!result?.success) {
          toast.error('Claude 계정을 열지 못했습니다', result?.error ?? '앱을 다시 시작해 주세요.')
          return
        }
        if (result.reused) {
          const store = useTerminalStore.getState()
          for (const [tabId, tab] of store.terminals) {
            if (!tab.local) continue
            const pane = (tab.splitTree ? paneIds(tab.splitTree) : [MAIN_PANE])
              .find(id => getLocalPaneShellId(tabId, id) === result.id)
            if (pane) {
              focusTabPane(store.focusTerminal, tabId, pane)
              if (shellId && !isChatShown(result.id) && !useAgentScreenReturnStore.getState().returns.has(result.id)) {
                void useAgentChatStore.getState().show(result.id)
              }
              return
            }
          }
        }
        addLocalTerminalTab(result, folderName(result.cwd ?? null) || undefined)
      } catch {
        toast.error('Claude 계정을 열지 못했습니다')
      }
    }
    window.addEventListener(OPEN_CLAUDE_PROFILE_EVENT, open)
    return () => window.removeEventListener(OPEN_CLAUDE_PROFILE_EVENT, open)
  }, [addLocalTerminalTab, unlockedOnce])

  const startDevelopmentTask = async (folder: string, task: LocalDevelopmentTask) => {
    try {
      const result = await window.electronAPI.localProjectDevelopmentStart({
        folder, id: task.id, cols: 80, rows: 24, includeSource: task.includeSource, install: Boolean(task.installCommand)
      })
      if (!result.success) {
        toast.error('개발 서버를 기동하지 못했습니다', result.error)
        return
      }
      useDevelopmentRuns.setState(({ runs }) => runs[result.id] ? { runs } : { runs: { ...runs, [result.id]: result.development } })
      const store = useTerminalStore.getState()
      for (const [tabId, tab] of store.terminals) {
        if (!tab.local) continue
        const panes = tab.splitTree ? paneIds(tab.splitTree) : [MAIN_PANE]
        const pane = panes.find(id => getLocalPaneShellId(tabId, id) === result.id)
        if (pane) {
          focusTabPane(store.focusTerminal, tabId, pane)
          return
        }
      }
      addLocalTerminalTab(result, result.label)
    } catch {
      toast.error('개발 서버를 기동하지 못했습니다')
    }
  }

  // A run preset's server (the card's 로그 / ▶, the crash notice): its tab to the front, made from main's
  // shell list when the server has none yet (an agent started it, or the tab was closed); with an error
  // line, scrolled to the first line that has it
  const revealRunShellTab = async ({ shellId, label, errorLine }: RevealRunShell) => {
    const findPane = () => {
      const store = useTerminalStore.getState()
      for (const [tabId, tab] of store.terminals) {
        if (!tab.local) continue
        const pane = (tab.splitTree ? paneIds(tab.splitTree) : [MAIN_PANE]).find(id => getLocalPaneShellId(tabId, id) === shellId)
        if (pane) return { tabId, pane }
      }
      return null
    }
    let found = findPane()
    if (!found) {
      const shells = await window.electronAPI.localShellList?.().catch(() => undefined)
      const shell = shells?.find(item => item.id === shellId && !item.exited)
      if (!shell) {
        toast.error('서버의 터미널을 찾지 못했습니다', label)
        return
      }
      addLocalTerminalTab({ id: shell.id, name: shell.name, cwd: shell.cwd ?? undefined }, label)
      found = findPane()
    }
    if (!found) return
    focusTabPane(useTerminalStore.getState().focusTerminal, found.tabId, found.pane)
    if (!errorLine) return
    // After the tab is laid out and its terminal holds the screen
    window.setTimeout(() => {
      const host = document.querySelector(`[data-local-shell-id="${CSS.escape(shellId)}"] .local-terminal-host`)
      const terminal = host ? terminalWithin(host) : null
      if (!terminal) return
      const buffer = terminal.buffer.active
      const rows = Array.from({ length: buffer.length }, (_, row) => {
        const line = buffer.getLine(row)
        return { text: line?.translateToString(true) ?? '', wrapped: line?.isWrapped ?? false }
      })
      const row = firstErrorRow(rows, errorLine)
      if (row === null) return
      terminal.scrollToLine(Math.max(0, row - 2))
      terminal.select(0, row, terminal.cols)
    }, 120)
  }
  // openSettingsTab: the settings window at a tab (SettingsModal picks it)
  useEffect(() => {
    const onOpen = () => setSettingsModalOpen(true)
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen)
  }, [])
  const revealRunShellRef = useRef(revealRunShellTab)
  revealRunShellRef.current = revealRunShellTab
  useEffect(() => {
    const onReveal = (event: Event) => void revealRunShellRef.current((event as CustomEvent<RevealRunShell>).detail)
    window.addEventListener(REVEAL_RUN_SHELL_EVENT, onReveal)
    return () => window.removeEventListener(REVEAL_RUN_SHELL_EVENT, onReveal)
  }, [])

  // The + menu's local terminal: in the work's folder (its worktree), or in the front tab's folder below it
  const localFoldersFor = (pane?: number) => {
    const front = pane === undefined ? useTerminalStore.getState().activeTerminalId : shownSplitPanes[pane]?.activeTerminalId ?? null
    const folder = groupView.localFolder(front)
    return localTerminalChoices(folder, folder ? groupView.worktreeForFolder(folder)?.path : undefined)
  }
  const handleOpenLocalFromTabStrip = (pane?: number, where: 'root' | 'here' = 'root') => {
    const folders = localFoldersFor(pane)
    void handleOpenLocalTerminal({ cwd: where === 'here' ? folders.here ?? folders.root : folders.root }, pane)
  }

  const addBrowserTab = useCallback((id: string, pane?: number) => {
    const store = useTerminalStore.getState()
    const targetPane = pane ?? store.layout.activePane ?? 0
    store.addTerminal(id, {
      id, host: '', username: '', connected: true, title: '브라우저',
      browser: { group: groupView.activeGroup, cwd: groupView.localFolder(store.activeTerminalId) }
    })
    if (targetPane > 0 && store.layout.panes[targetPane]) {
      store.moveTerminalBetweenPanes(id, 0, targetPane)
      store.focusTerminal(id)
    }
  }, [groupView.activeGroup])

  useEffect(() => window.electronAPI.onBrowserReviewLinkOpened(id => addBrowserTab(id)), [addBrowserTab])

  const handleOpenBrowser = async (pane?: number) => {
    try {
      const result = await window.electronAPI.browserReviewOpen()
      if (!result.success) {
        toast.error('브라우저 열기', result.error)
        return
      }
      addBrowserTab(result.id, pane)
    } catch {
      toast.error('브라우저 열기', '브라우저 탭을 열 수 없습니다.')
    }
  }

  // "이어서 실행" in the work panel's conversations: main resolves the key to the session's folder and agent
  useEffect(() => {
    const onResume = (event: Event) => {
      const { key, agent, label } = (event as CustomEvent<ResumeAgentSessionRequest>).detail
      void handleOpenLocalTerminal({ resume: key, agent, workspaceLabel: label || undefined })
    }
    window.addEventListener(RESUME_AGENT_SESSION_EVENT, onResume)
    return () => window.removeEventListener(RESUME_AGENT_SESSION_EVENT, onResume)
  })
  useEffect(() => {
    const onOpen = (event: Event) => {
      const { cwd, agent, workspaceLabel, input } = (event as CustomEvent<Partial<LocalProjectTerminal> & { input?: string } | null>).detail ?? {}
      void handleOpenLocalTerminal({ cwd, agent, workspaceLabel }).then(tabId => {
        // A command typed in for the user to run (the Git login of a nested repository, lib/gitLogin.ts): no Enter
        const shellId = tabId && typeof input === 'string' && !agent ? getLocalPaneShellId(tabId, MAIN_PANE) : null
        if (shellId) void typeWhenShellSettles(shellId, input!)
      })
    }
    window.addEventListener(OPEN_LOCAL_TERMINAL_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_LOCAL_TERMINAL_EVENT, onOpen)
  })

  const handleOpenSidebarLocalTerminal = async (button: HTMLButtonElement) => {
    const origin = useTerminalStore.getState().terminals.size === 0 ? captureTabFlightSource(button) : null
    const tabId = await handleOpenLocalTerminal()
    if (origin && tabId) void flyToTab(origin, tabId)
  }

  useEffect(() => {
    const clearUpdateSource = setRestoreSource(readRestoreSource)
    const offClose = window.electronAPI.onRestoreTabsBeforeClose?.(() => buildRestoreRecord(readRestoreSource()))
    return () => {
      clearUpdateSource()
      offClose?.()
    }
  }, [readRestoreSource])

  // The page going away (a reload included): which shell sits in which pane, for the page that comes next
  useEffect(() => {
    window.addEventListener('pagehide', rememberLocalLayout)
    return () => window.removeEventListener('pagehide', rememberLocalLayout)
  }, [])

  // Once, after the first unlock: local shells still running from before a window reload come back as tabs
  const orphanShellsCheckedRef = useRef(false)
  const [orphanShellsAdopted, setOrphanShellsAdopted] = useState(false)
  useEffect(() => {
    if (isLocked || isCheckingLock || orphanShellsCheckedRef.current) return
    orphanShellsCheckedRef.current = true
    void adoptOrphanLocalShells().then(({ count, afterUpdate }) => {
      if (count > 0) {
        toast.info('로컬 터미널을 다시 열었습니다', afterUpdate
          ? `업데이트하는 동안 셸 ${count}개가 끊기지 않고 계속 실행되었습니다`
          : `화면을 다시 불러오기 전에 실행 중이던 셸 ${count}개`)
      }
      setOrphanShellsAdopted(true)
    })
  }, [isLocked, isCheckingLock])

  // Idle agents of local shells: main gets the settings, panes show the ones asleep (src/agentIdle.js)
  useEffect(() => (unlockedOnce ? startAgentSleep() : undefined), [unlockedOnce])
  // Whether agents report their state through the CLIs' hooks: main gets the switch (T11)
  useEffect(() => (unlockedOnce ? startAgentHooks() : undefined), [unlockedOnce])
  // Run presets of the local projects: their state changes and crash notices (docs/plan/2026-11-25-local-project-run.md)
  useEffect(() => (unlockedOnce ? startRunPresets() : undefined), [unlockedOnce])
  useEffect(() => (unlockedOnce ? startDesktopPointerEffects() : undefined), [unlockedOnce])

  const [restoreBanner, setRestoreBanner] = useState<RestoreBannerState | null>(null)
  const [restoreReady, setRestoreReady] = useState(false)
  const restoreCheckedRef = useRef(false)
  // Once, after the first unlock: the main process gives the record only once and removes it
  useEffect(() => {
    // After the shells kept through an update came back as tabs: the notice leaves those out
    if (isLocked || isCheckingLock || areSessionsLoading || !orphanShellsAdopted || restoreCheckedRef.current
      || typeof window.electronAPI.restoreTabsTake !== 'function') return
    restoreCheckedRef.current = true
    window.electronAPI.restoreTabsTake()
      .then((taken) => {
        const record = taken ? readRestoreRecord(taken.record) : null
        const offered = record && (reopenable(record, keptLocalShells()).length > 0 || record.tabs.some(tab => tab.kind === 'quick'))
        if (record && offered) setRestoreBanner({ phase: 'ask', record, source: taken?.source ?? 'update' })
      })
      .catch(() => { /* nothing to offer */ })
      .finally(() => setRestoreReady(true))
  }, [isLocked, isCheckingLock, areSessionsLoading, orphanShellsAdopted])

  useEffect(() => {
    const send = window.electronAPI.restoreTabsCheckpoint
    if (!restoreReady || !orphanShellsAdopted || !unlockedOnce || typeof send !== 'function') return
    let timer: number | undefined
    let lastRecord: string | undefined
    const schedule = () => {
      if (timer !== undefined) return
      timer = window.setTimeout(() => {
        timer = undefined
        const record = buildRestoreRecord(readRestoreSource())
        const text = JSON.stringify(record)
        if (text === lastRecord) return
        lastRecord = text
        send(record)
      }, 500)
    }
    const unsubscribe = [
      useTerminalStore.subscribe((current, before) => {
        if (current.terminals !== before.terminals || current.layout !== before.layout || current.activeTerminalId !== before.activeTerminalId) schedule()
      }),
      useSftpStore.subscribe(schedule),
      useAgentUsageStore.subscribe(schedule),
      useAgentMessagesStore.subscribe((current, before) => {
        if (current.snapshot.agents !== before.snapshot.agents) schedule()
      }),
      useAgentChatStore.subscribe((current, before) => {
        if (current.chats !== before.chats) schedule()
      })
    ]
    schedule()
    return () => {
      window.clearTimeout(timer)
      unsubscribe.forEach(off => off())
    }
  }, [restoreReady, orphanShellsAdopted, unlockedOnce, readRestoreSource])

  const handleRestoreTabs = async () => {
    if (restoreBanner?.phase !== 'ask') return
    const { record } = restoreBanner
    const total = reopenable(record, keptLocalShells()).length
    setRestoreBanner({ phase: 'running', done: 0, total })
    const outcome = await restoreTabs(record, {
      openSaved: async (savedSessionId, workGroup) => {
        const session = useSessionStore.getState().sessions.find(s => s.id === savedSessionId)
        if (!session) return { error: '세션 목록에 없는 세션입니다 (지워졌을 수 있습니다).' }
        const result = await handleQuickConnect(session, undefined, { workGroup })
        return result.success && result.sessionId ? { id: result.sessionId } : { error: result.error || '연결하지 못했습니다.' }
      },
      openLocal: (tab) => openLocalWithAgents(tab, handleOpenLocalTerminal, undefined, undefined, true),
      onProgress: (done) => setRestoreBanner({ phase: 'running', done, total }),
      // A local shell that went on through the update came back with its tab already
      keptTabOf: (shellId) => {
        if (!keptLocalShells().has(shellId)) return null
        for (const [id, info] of useTerminalStore.getState().terminals) if (info.local && (info.local.shellId ?? id) === shellId) return id
        return null
      }
    })
    setRestoreBanner(outcome.failed.length === 0 && outcome.quick.length === 0 ? null : { phase: 'done', outcome })
    if (outcome.failed.length === 0) toast.success('탭을 다시 열었습니다', `이전에 열려 있던 탭 ${outcome.opened}개`)
  }

  // A quick connect from before the update: the connect dialog with its login filled in (no password was kept)
  const handleRestoreQuick = (tab: Extract<RestoreTab, { kind: 'quick' }>) => {
    setEditSession(null)
    setDuplicateSource({
      ...DEFAULT_CONFIG, id: undefined, name: tab.title || `${tab.username}@${tab.host}`,
      host: tab.host, port: tab.port, username: tab.username,
      authType: tab.authType ?? 'password', privateKeyPath: tab.privateKeyPath ?? '',
      saveSession: false, mcpEnabled: false
    })
    setDuplicateTitle('업데이트 전에 열려 있던 연결')
    setConnectTarget({ workGroup: tab.workGroup })
  }

  /** The content of a terminal, browser, or DB tab. */
  const renderTabContent = (sessionId: string, isActive: boolean, onActivate: () => void, onClose: () => void, borderColor?: string) => {
    if (terminals.get(sessionId)?.browser) {
      return (
        <Suspense fallback={null}>
          <BrowserReview
            tabId={sessionId}
            isVisible={isActive && shownTabs.has(sessionId) && !draggingTabId && !splitPaneDraggingTabId}
            onActivate={onActivate}
          />
        </Suspense>
      )
    }
    const db = terminals.get(sessionId)?.db
    if (db) {
      return (
        <Suspense fallback={null}>
          <DbTab terminalId={sessionId} dbId={db.dbId} label={db.label} />
        </Suspense>
      )
    }
    if (terminals.get(sessionId)?.local) {
      return (
        <HandoffProjectsContext.Provider value={groupView.projects}>
          <Suspense fallback={null}>
            <LocalTerminalTab terminalId={sessionId} isActive={isActive} onActivate={onActivate} />
          </Suspense>
        </HandoffProjectsContext.Provider>
      )
    }
    return <TerminalPanel sessionId={sessionId} isActive={isActive} onActivate={onActivate} onClose={onClose} borderColor={borderColor} />
  }

  // First start after an update: once unlocked, show what changed since the last version seen
  const whatsNewCheckedRef = useRef(false)
  useEffect(() => {
    if (isLocked || whatsNewCheckedRef.current || typeof window.electronAPI.whatsNewState !== 'function') return
    whatsNewCheckedRef.current = true
    window.electronAPI.whatsNewState()
      .then(state => {
        const entries = notesToShow({ ...state, available: BUNDLED_NOTES })
        if (entries.length > 0) setWhatsNew({ entries, markSeen: true })
        else if (state.previous !== state.current) void window.electronAPI.whatsNewSeen()
      })
      .catch(() => { /* not shown this time */ })
  }, [isLocked])

  const closeWhatsNew = () => {
    if (whatsNew?.markSeen) void window.electronAPI.whatsNewSeen()
    setWhatsNew(null)
  }

  // Command palette "업데이트 내용 보기": the last ten versions' notes, without changing the record
  const handleOpenWhatsNew = async () => {
    const current = await window.electronAPI.getAppVersion()
    const entries = recentNotes(current, BUNDLED_NOTES)
    if (entries.length > 0) setWhatsNew({ entries, markSeen: false })
    else toast.info('업데이트 내용 없음', `${current} 버전의 업데이트 내용이 없습니다`)
  }

  // Query results must not stay behind the lock screen: main closes the connections, the tabs go too
  useEffect(() => {
    if (!isLocked) return
    const { terminals: current, removeTerminal: remove } = useTerminalStore.getState()
    for (const [id, info] of current) {
      if (info.db || info.browser) remove(id)
    }
    // Agent conversations too (main stops following the transcripts): the panes show their terminals
    useAgentChatStore.getState().clearAll()
    useAskQuestionStore.getState().clearAll()
    // The run presets' states and crash notices (main keeps the presets)
    clearRunPresets()
    useGitCommitStore.getState().clearAll()
    // The workspace panel's kept Git answers (paths, commit subjects)
    gitReads.clear()
  }, [isLocked])

  useEffect(() => {
    if (isLocked) return
    return window.electronAPI.onAgentChatCapture?.(useAgentChatStore.getState().applyCapture)
  }, [isLocked])

  // Codex hooks turned off (`묻지 않기` on the review bar, or Continue without trusting): told once here,
  // not by each pane. Optional until main's IPC lands (codex-4, T9)
  useEffect(() => {
    const api = window.electronAPI as { onCodexHooksDeclined?: (callback: () => void) => () => void }
    return api.onCodexHooksDeclined?.(() => toast.info('Codex 훅을 쓰지 않습니다.', '설정 > MCP > 에이전트 메시지에서 다시 켤 수 있습니다.'))
  }, [])

  const handleToggleSftp = () => {
    if (activeTerminalId && isSshTab(terminals.get(activeTerminalId))) {
      setOpen(activeTerminalId, !sftpOpen)
    }
  }

  const terminalArray = Array.from(terminals.entries())
  const hasTerminals = terminalArray.length > 0

  const activeTerminal = activeTerminalId ? terminals.get(activeTerminalId) : undefined
  const activeDuplicateLabel = getDuplicateConfig(activeTerminal)
    ? activeTerminal?.title || `${activeTerminal?.username}@${activeTerminal?.host}`
    : null

  // Which pane shows the tab on a split screen (null on a single screen)
  /** The screen (index) of a tab while the screen is split */
  const paneOfTab = (tabId: string): number | null => findTabPane(layout, tabId)

  const workSelector = <TabGroupChips view={groupView} onAddWork={() => setLocalProjectMode('add')} />
  const tabConnectionActions = {
    onPickSession: () => setSessionPickerTarget({ workGroup: groupView.activeGroup ?? undefined, assignProject: true }),
    onNewSession: () => openNewConnection({ workGroup: groupView.activeGroup ?? undefined, assignProject: true })
  }

  // The + menu of a split pane: the same menu as the single tab bar, about that pane's active tab.
  // Pressing it focuses the pane, and a new tab goes to the focused pane (effect below).
  const renderPaneNewTabMenu = (pane: number) => {
    const paneActiveId = shownSplitPanes[pane]?.activeTerminalId ?? null
    const paneTerminal = paneActiveId ? terminals.get(paneActiveId) : undefined
    const label = getDuplicateConfig(paneTerminal) ? paneTerminal?.title || `${paneTerminal?.username}@${paneTerminal?.host}` : null
    return (
      <NewTabMenu
        triggerClassName="split-pane-btn"
        duplicateLabel={label}
        onDuplicate={() => void handleDuplicateTab(paneActiveId)}
        {...tabConnectionActions}
        onLocalTerminal={where => handleOpenLocalFromTabStrip(pane, where)}
        localFolders={localFoldersFor(pane)}
        onOpenBrowser={() => void handleOpenBrowser(pane)}
      />
    )
  }

  // Layout state
  const splitWithSession = useTerminalStore(state => state.splitWithSession)

  // Tab drag handlers
  const handleTabDragStart = (e: React.DragEvent, sessionId: string) => {
    setDraggingTabId(sessionId)
    e.dataTransfer.setData('text/plain', sessionId)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleTabDragEnd = async () => {
    // Another target handled this drop before dragend (strip, pane or sidebar project).
    if (tabDropTaken.current) {
      tabDropTaken.current = false
      setDraggingTabId(null)
      setDropZone(null)
      return
    }
    const sessionId = draggingTabId
    const terminal = sessionId ? terminals.get(sessionId) : null

    // A DB tab dropped outside moves to its own DB window (the connection stays)
    if (dropZone === 'popout' && sessionId && (terminal?.local || terminal?.browser)) {
      // These tabs live in the workspace.
    } else if (dropZone === 'popout' && sessionId && terminal?.db) {
      const result = await window.electronAPI.dbDetach?.(terminal.db.dbId)
      if (result?.success) removeTerminal(sessionId)
    } else if (dropZone === 'popout' && sessionId && terminal) {
      const title = terminal.title || `${terminal.username}@${terminal.host}`
      detachedTabsRef.current.set(sessionId, detachTab(terminal))
      // Take the screen before the tab's terminal is disposed so the new window continues from it
      const snapshot = captureTerminalSnapshot(sessionId) ?? undefined
      // Remove terminal from main window first (this unregisters the SSH data handler)
      removeTerminal(sessionId)
      // Open new window - it will register its own handler
      await window.electronAPI.openTerminalWindow(sessionId, title, snapshot)
      // Output that reached this window between the capture and the new window taking over is neither in
      // the snapshot nor in the new window. Drop it: kept here, it would be replayed after the newer screen
      // on merge back and show up out of order.
      useTerminalStore.getState().discardSshDataBuffer(sessionId)
    }

    // Check if dropped in a split zone - only the dragged tab moves to the new pane
    if (sessionId && dropZone && ['left', 'right', 'top', 'bottom'].includes(dropZone)) {
      const direction = (dropZone === 'right' || dropZone === 'left') ? 'horizontal' : 'vertical'

      // Always use the dragged sessionId - it moves to the new split pane
      // Other tabs stay in the primary pane
      if (dropZone === 'right' || dropZone === 'bottom') {
        // Dragged to right/bottom: dragged tab goes to secondary pane
        splitWithSession(sessionId, direction, 'secondary')
      } else {
        // Dragged to left/top: dragged tab goes to primary pane (others move to secondary)
        splitWithSession(sessionId, direction, 'primary')
      }
    }

    setDraggingTabId(null)
    setDropZone(null)
  }

  const handleTerminalAreaDragOver = (e: React.DragEvent) => {
    const fromScreenStrip = !draggingTabId && splitPaneDraggingTabId !== null
    if (!draggingTabId && !fromScreenStrip) return
    // Need at least 2 terminals to split
    if (terminalArray.length < 2) {
      setDropZone(null)
      return
    }
    e.preventDefault()

    const rect = terminalAreaRef.current?.getBoundingClientRect()
    if (!rect) return

    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const width = rect.width
    const height = rect.height

    // A band along each edge: inside it the pointer is over a pane, where the tab merges into that tab
    // (hooks/useTabDropOnPane.ts) on the side it chooses
    const horizontalThreshold = Math.min(SCREEN_SPLIT_BAND_PX, width * 0.3)
    const verticalThreshold = Math.min(SCREEN_SPLIT_BAND_PX, height * 0.3)

    const zone = x < horizontalThreshold ? 'left' : x > width - horizontalThreshold ? 'right'
      : y < verticalThreshold ? 'top' : y > height - verticalThreshold ? 'bottom' : null
    screenRefusal.current = null
    if (zone && layout.mode === 'split') {
      // A split screen grows only at the two ends of its direction, up to four screens
      const refusal = addScreenRefusal(layout, zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical')
      if (refusal) {
        screenRefusal.current = refusal
        setDropZone(null)
        return
      }
    }
    if (fromScreenStrip && !zone) {
      setDropZone(null)
      return
    }
    setDropZone(zone)
  }

  // A tab dragged from a screen's strip: dropped in an edge band, it gets a new screen at that end
  const handleScreenTabDragEnd = () => {
    const sessionId = splitPaneDraggingTabId
    const zone = dropZone
    const refusal = screenRefusal.current
    screenRefusal.current = null
    setSplitPaneDraggingTabId(null)
    setDropZone(null)
    if (tabDropTaken.current) {
      tabDropTaken.current = false
      return
    }
    if (refusal) {
      toast.info('화면을 더 나눌 수 없습니다', refusal)
      return
    }
    if (!sessionId || !zone || zone === 'popout') return
    splitWithSession(sessionId, zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical', zone === 'left' || zone === 'top' ? 'primary' : 'secondary')
  }

  const handleTerminalAreaDragLeave = (e: React.DragEvent) => {
    // Check if actually leaving the terminal area (not entering a child)
    const rect = terminalAreaRef.current?.getBoundingClientRect()
    if (rect) {
      const x = e.clientX
      const y = e.clientY
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        setDropZone('popout')
      }
    }
  }

  const handleTerminalAreaDrop = (e: React.DragEvent) => {
    e.preventDefault()
    // Drop handling is done in handleTabDragEnd
  }

  const handleOpenSettings = () => {
    setSettingsModalOpen(true)
  }

  const handleOpenSnippetManager = () => {
    setSnippetManagerOpen(true)
  }

  // Context menu handlers
  const handleTabContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    setContextMenuPosition({ x: e.clientX, y: e.clientY })
    setContextMenuTabId(sessionId)
    setContextMenuOpen(true)
  }

  const handleCloseContextMenu = () => {
    setContextMenuOpen(false)
    setContextMenuTabId(null)
  }

  const handleContextCloseTab = () => {
    if (contextMenuTabId) {
      void requestCloseTabs([contextMenuTabId])
    }
  }

  // "칸으로 병합" in the tab's menu: a blocked choice tells why instead of doing nothing
  const handleContextMergeInto = (choice: MergeChoice) => {
    const sourceId = contextMenuTabId
    if (!sourceId) return
    if (choice.blocked) {
      toast.warning(MERGE_BLOCKED_TITLE, choice.blocked)
      return
    }
    void mergeTabIntoPane(sourceId, choice.id)
      .then((result) => { if (!result.ok) toast.warning(MERGE_BLOCKED_TITLE, result.error) })
      .catch(() => toast.error('탭을 병합하지 못했습니다', '잠시 후 다시 시도해 주세요.'))
  }

  const handleContextCloseOthers = () => {
    if (contextMenuTabId) {
      void requestCloseTabs([...terminals.keys()].filter(id => id !== contextMenuTabId))
    }
  }

  const handleContextCloseToLeft = () => {
    if (contextMenuTabId) {
      const terminalIds = Array.from(terminals.keys())
      const currentIndex = terminalIds.indexOf(contextMenuTabId)
      if (currentIndex > 0) {
        void requestCloseTabs(terminalIds.slice(0, currentIndex))
      }
    }
  }

  const handleContextCloseToRight = () => {
    if (contextMenuTabId) {
      const terminalIds = Array.from(terminals.keys())
      const currentIndex = terminalIds.indexOf(contextMenuTabId)
      if (currentIndex !== -1) {
        void requestCloseTabs(terminalIds.slice(currentIndex + 1))
      }
    }
  }

  const handleContextDuplicate = () => {
    if (contextMenuTabId) {
      const terminal = terminals.get(contextMenuTabId)
      if (terminal) {
        void handleDuplicateTab(contextMenuTabId)
      }
    }
  }

  const handleContextRename = () => {
    if (!contextMenuTabId) return
    const tab = terminals.get(contextMenuTabId)
    if (tab) setRenamingTab({ id: contextMenuTabId, title: tab.title || `${tab.username}@${tab.host}` })
  }

  const handleContextSplitHorizontal = () => {
    if (contextMenuTabId && terminalArray.length >= 2) {
      const otherTerminals = terminalArray.filter(([id]) => id !== contextMenuTabId)
      if (otherTerminals.length > 0) {
        splitWithSession(otherTerminals[0][0], 'horizontal', 'secondary')
      }
    }
  }

  const handleContextSplitVertical = () => {
    if (contextMenuTabId && terminalArray.length >= 2) {
      const otherTerminals = terminalArray.filter(([id]) => id !== contextMenuTabId)
      if (otherTerminals.length > 0) {
        splitWithSession(otherTerminals[0][0], 'vertical', 'secondary')
      }
    }
  }

  const handleContextToggleLog = () => {
    if (!contextMenuTabId) return
    const tab = terminals.get(contextMenuTabId)
    toggleSessionLog(contextMenuTabId, tab ? (tab.title || `${tab.username}@${tab.host}`) : '')
  }

  const contextDevelopment = contextMenuTabId ? developmentRunsForTab(contextMenuTabId, developmentRuns) : []
  const developmentActions = contextDevelopment.flatMap(({ id, run }) => {
    if (run.status === 'starting' || run.status === 'stopping') return []
    const suffix = contextDevelopment.length > 1 ? ` · ${run.label}` : ''
    return [
      { label: `재기동${suffix}`, action: 'restart' as const, onSelect: (): void => { void changeDevelopmentRun(id, run.taskId, 'restart') } },
      ...(run.status === 'running' ? [{ label: `중지${suffix}`, action: 'stop' as const, onSelect: (): void => { void changeDevelopmentRun(id, run.taskId, 'stop') } }] : [])
    ]
  })

  // Show loading while checking lock status
  if (isCheckingLock) {
    return (
      <div className="app-container">
        <TitleBar onSettingsClick={handleOpenSettings} />
        <div className="app-main" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: 'var(--text-muted)' }}>Loading...</span>
        </div>
        <SettingsModal open={settingsModalOpen} onOpenChange={setSettingsModalOpen} />
      </div>
    )
  }

  // Show lock screen if locked
  if (isLocked) {
    return (
      <div className="app-container">
        <TitleBar onSettingsClick={handleOpenSettings} />
        <LockScreen hasMasterPassword={hasMasterPassword} onUnlock={handleUnlock} onReady={markLockScreenReady} />
        <SettingsModal open={settingsModalOpen} onOpenChange={setSettingsModalOpen} />
      </div>
    )
  }

  return (
    <div className="app-container">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <TitleBar onSettingsClick={handleOpenSettings} />
      <div className={`app-main ${zenMode ? 'zen-mode' : ''}`}>
        {zenMode && (
          <div className="zen-mode-indicator">
            Zen Mode · ESC×2로 해제 · Ctrl+Shift+Z
          </div>
        )}
        <Sidebar
          tabGroupView={groupView}
          onNewConnection={handleNewConnection}
          onQuickConnect={handleQuickConnect}
          onConnectProjectSession={(session, workGroup) => void handleQuickConnect(session, undefined, { workGroup })}
          onEditSession={handleEditSession}
          onDuplicateSession={handleDuplicateSession}
          onOpenQuickConnect={handleOpenQuickConnect}
          onAddSession={handleAddSession}
          onImportSession={(folderId) => setImportTarget({ folderId })}
          onLocalTerminal={button => void handleOpenSidebarLocalTerminal(button)}
          onLocalFolder={(cwd, workspaceLabel) => void handleOpenLocalTerminal({ cwd, workspaceLabel })}
          onStartDevelopmentTask={(folder, task) => void startDevelopmentTask(folder, task)}
          onCloseTerminal={closeTerminal}
        />
        <main className="main-area" id="main-content" style={{ '--browser-tab-max-width': `${browserTabMaxWidth}px` } as CSSProperties}>
          {restoreBanner && (
            <RestoreTabsBanner
              state={restoreBanner}
              onRestore={() => void handleRestoreTabs()}
              onClose={() => setRestoreBanner(null)}
              onReconnect={handleRestoreQuick}
            />
          )}
          {!isSettingsLoaded ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <span style={{ color: 'var(--text-muted)' }}>Loading settings...</span>
            </div>
          ) : hasTerminals ? (
            <>
              {layout.mode !== 'split' && (
                <div className="terminal-tabs terminal-tab-header">
                  {workSelector}
                  <div ref={tabStripRef} className="terminal-tab-items" role="group" aria-label="열린 탭">
                    <AnimatePresence initial={false} mode="popLayout">
                      {terminalArray.filter(([sessionId]) => shownTabs.has(sessionId)).map(([sessionId, terminal]) => (
                        <motion.div
                          key={sessionId}
                          data-tab-id={sessionId}
                          data-browser-tab={terminal.browser ? '' : undefined}
                          className={`terminal-tab ${sessionId === activeTerminalId ? 'active' : ''} ${terminal.hasActivity ? 'has-activity' : ''} ${draggingTabId === sessionId ? 'dragging' : ''}`}
                          onClick={() => setActiveTerminal(sessionId)}
                          onContextMenu={(e) => handleTabContextMenu(e, sessionId)}
                          draggable
                          // motion.div treats onDragStart/onDragEnd as its own gesture props
                          // and never forwards them to the DOM, so use the capture variants
                          onDragStartCapture={(e) => handleTabDragStart(e, sessionId)}
                          onDragEndCapture={handleTabDragEnd}
                          variants={reducedMotion ? undefined : tabVariants}
                          initial="hidden"
                          animate="visible"
                          exit="exit"
                          layout={!reducedMotion}
                          transition={SPRINGS.snappy}
                          style={sessionId === activeTerminalId && terminal.color ? {
                            borderColor: terminal.color,
                            backgroundColor: `${terminal.color}20`,
                            color: terminal.color,
                            boxShadow: `inset 0 -2px 0 ${terminal.color}`
                          } : undefined}
                        >
                          {terminal.color && (
                            <span
                              className="tab-color-dot"
                              style={{ backgroundColor: terminal.color }}
                            />
                          )}
                          {terminal.db && <RiDatabase2Line size={13} className="tab-db-icon" aria-label="DB" />}
                          {terminal.local && <RiComputerLine size={13} className="tab-local-icon" aria-label="로컬" />}
                          {terminal.browser && <RiGlobalLine size={13} className="tab-local-icon" aria-hidden />}
                          <span data-tab-label title={terminal.title || `${terminal.username}@${terminal.host}`}>{terminal.title || `${terminal.username}@${terminal.host}`}</span>
                          {terminal.local && <DevelopmentTabDots tabId={sessionId} />}
                          {terminal.local?.cwd && <TabWorktreeBadge cwd={terminal.local.cwd} worktree={groupView.worktreeForFolder(terminal.local.cwd)} />}
                          {terminal.local && <AgentTabMessages tabId={sessionId} />}
                          {sessionId in sessionLogFiles && <span className="tab-log-indicator" role="img" aria-label="로그 저장 중" title={`로그 저장 중: ${sessionLogFiles[sessionId]}`} />}
                          {terminal.hasActivity && <span className="activity-indicator" />}
                          <motion.button
                            className="tab-close"
                            aria-label="탭 닫기"
                            onClick={(e) => { e.stopPropagation(); void requestCloseTabs([sessionId]) }}
                            whileHover={reducedMotion ? undefined : { scale: 1.1 }}
                            whileTap={reducedMotion ? undefined : { scale: 0.9 }}
                          >×</motion.button>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                  {/* Outside the strip that scrolls: always in reach however many tabs are open */}
                  <div className="terminal-tab-add">
                    <NewTabMenu
                      duplicateLabel={activeDuplicateLabel}
                      onDuplicate={() => void handleDuplicateTab(activeTerminalId)}
                      {...tabConnectionActions}
                      onLocalTerminal={where => handleOpenLocalFromTabStrip(undefined, where)}
                      localFolders={localFoldersFor()}
                      onOpenBrowser={() => void handleOpenBrowser()}
                    />
                  </div>
                </div>
              )}
              <div
                ref={terminalAreaRef}
                className={`terminal-area ${draggingTabId ? 'drag-active' : ''}`}
                onDragOver={handleTerminalAreaDragOver}
                onDragLeave={handleTerminalAreaDragLeave}
                onDrop={handleTerminalAreaDrop}
              >
                {/* Drop zone indicators (also while dragging from a screen's strip: that adds a screen) */}
                {(draggingTabId || splitPaneDraggingTabId) && (
                  <>
                    <div className={`drop-zone drop-zone-left ${dropZone === 'left' ? 'active' : ''}`} />
                    <div className={`drop-zone drop-zone-right ${dropZone === 'right' ? 'active' : ''}`} />
                    <div className={`drop-zone drop-zone-top ${dropZone === 'top' ? 'active' : ''}`} />
                    <div className={`drop-zone drop-zone-bottom ${dropZone === 'bottom' ? 'active' : ''}`} />
                  </>
                )}
                {layout.mode === 'split' && layout.panes.length > 1 ? (
                  <div ref={splitContainerRef} className={`split-view-container ${layout.direction} ${resizingDivider !== null ? 'resizing' : ''}`}>
                    {/* Up to four screens, each with its tab strip; a divider between each two (lib/screenPanes.ts).
                        primary / secondary stay as classes of the first two for styles and tests written for two. */}
                    {layout.panes.map((pane, index) => {
                      const { terminalIds, activeTerminalId: activeId } = shownSplitPanes[index]
                      const isFocused = layout.activePane === index
                      const color = isFocused && activeId ? terminals.get(activeId)?.color : undefined
                      return (
                        <Fragment key={`screen-${index}`}>
                          {index > 0 && (
                            <div
                              className={`split-divider ${layout.direction}`}
                              data-divider={index - 1}
                              onMouseDown={(e) => { e.preventDefault(); setResizingDivider(index - 1) }}
                              onDoubleClick={() => setPaneSizes(evenSizes(layout.panes.length))}
                              title="드래그로 크기 조절 · 더블클릭으로 모든 화면을 같은 크기로"
                            />
                          )}
                          <div
                            className={`split-pane ${index === 0 ? 'primary' : index === 1 ? 'secondary' : 'extra'} ${isFocused ? 'active-pane' : ''}`}
                            data-screen={index}
                            onMouseDown={() => setActivePaneType(index)}
                            style={{ flex: layout.sizes[index] ?? 1 / layout.panes.length, ...(color ? { outlineColor: color } : {}) }}
                          >
                            <SplitPaneTabBar
                              paneType={index === 0 ? 'primary' : 'secondary'}
                              workSelector={index === 0 ? workSelector : undefined}
                              terminalIds={terminalIds}
                              activeTerminalId={activeId}
                              isActivePane={isFocused}
                              onTabSelect={(terminalId) => {
                                setActivePaneTerminal(index, terminalId)
                                setActivePaneType(index)
                              }}
                              onTabClose={terminalId => void requestCloseTabs([terminalId])}
                              onTabContextMenu={handleTabContextMenu}
                              newTabMenu={renderPaneNewTabMenu(index)}
                              worktreeForFolder={groupView.worktreeForFolder}
                              onUnsplit={index === 0 ? closeSplit : undefined}
                              onSftpToggle={activeId && isSshTab(terminals.get(activeId)) ? () => setOpen(activeId, !isOpen(activeId)) : undefined}
                              sftpOpen={activeId ? isOpen(activeId) : false}
                              onPaneFocus={() => setActivePaneType(index)}
                              onTabDragStart={(id) => setSplitPaneDraggingTabId(id)}
                              onTabDragEnd={handleScreenTabDragEnd}
                              draggingTabId={splitPaneDraggingTabId}
                            />
                            <div className="split-pane-content">
                              {pane.terminalIds.map(terminalId => (
                                <TabSlot
                                  key={terminalId}
                                  tabId={terminalId}
                                  className={`terminal-wrapper ${terminalId === activeId ? 'visible' : 'hidden'}`}
                                />
                              ))}
                              {activeId && isOpen(activeId) && <SftpPanel sessionId={activeId} />}
                            </div>
                          </div>
                        </Fragment>
                      )
                    })}
                  </div>
                ) : (
                  terminalArray.map(([sessionId]) => (
                    <TabSlot
                      key={sessionId}
                      tabId={sessionId}
                      className={`terminal-wrapper ${sessionId === activeTerminalId ? 'visible' : 'hidden'}`}
                    />
                  ))
                )}
                {/* Every tab's content, rendered here once and shown through its TabSlot above. This place does
                    not depend on the layout, so single <-> split never unmounts a tab (lib/tabHosts.ts).
                    It is inside .terminal-area on purpose: React events from the content go up this React
                    tree, not the DOM, and the tab drag-and-drop handlers are on .terminal-area. */}
                {terminalArray.map(([sessionId, terminal]) => {
                  const pane = paneOfTab(sessionId)
                  const paneState = pane === null ? null : shownSplitPanes[pane]
                  return createPortal(
                    <div className="tab-host-content" onMouseDown={pane !== null ? () => {
                      if (!isTabHostPreviewed(sessionId)) setActivePaneType(pane)
                    } : undefined}>
                    {pane !== null
                      ? renderTabContent(
                          sessionId,
                          sessionId === paneState?.activeTerminalId,
                          () => {
                            setActivePaneTerminal(pane, sessionId)
                            setActivePaneType(pane)
                          },
                          () => void requestCloseTabs([sessionId]),
                          terminal.color
                        )
                      : renderTabContent(
                          sessionId,
                          sessionId === activeTerminalId,
                          () => setActiveTerminal(sessionId),
                          () => void requestCloseTabs([sessionId]),
                          terminal.color
                        )}
                    </div>,
                    tabHost(sessionId),
                    sessionId
                  )
                })}
              </div>
              {/* The SFTP button is in the terminal's header (TerminalPanel), not in a bar under it */}
              {sftpOpen && activeTerminalId && layout.mode !== 'split' && (
                <SftpPanel sessionId={activeTerminalId} />
              )}
            </>
          ) : (
            <>
              <div className="terminal-tabs">
                <NewTabMenu
                  duplicateLabel={null}
                  onDuplicate={() => {}}
                  {...tabConnectionActions}
                  onLocalTerminal={() => void handleOpenLocalTerminal()}
                  onOpenBrowser={() => void handleOpenBrowser()}
                />
              </div>
              <WelcomeScreen
                showNewConnection={!areSessionsLoading && sessions.length === 0}
                onNewConnection={handleNewConnection}
              />
            </>
          )}
        </main>
        {!zenMode && <WorkspacePanel />}
      </div>
      <Footer />
      <WorkOverview groupView={groupView} />
      <McpApprovalDialog />
      <ConfirmDialogHost />
      <TerminalWebLinkMenu />
      <HostKeyDialog />

      <ConnectModal
        open={connectTarget !== null}
        onOpenChange={open => { if (!open) setConnectTarget(null) }}
        onConnect={config => void handleConnect(config, connectTarget ?? undefined)}
        onSave={handleSaveSession}
        editSession={editSession}
        duplicateFrom={duplicateSource}
        duplicateTitle={duplicateTitle}
        defaultFolderId={defaultFolderId}
      />

      {importTarget && (
        <SessionImportDialog
          folderId={importTarget.folderId}
          onClose={() => setImportTarget(null)}
          onOpenSession={handleOpenSharedSession}
        />
      )}

      <SessionPickerModal
        open={sessionPickerTarget !== null}
        onOpenChange={open => { if (!open) setSessionPickerTarget(null) }}
        onSelect={session => void handleQuickConnect(session, undefined, sessionPickerTarget ?? undefined)}
      />

      <QuickConnectModal
        open={quickConnectModalOpen}
        onOpenChange={setQuickConnectModalOpen}
        onConnect={handleQuickConnectSubmit}
      />
      {localProjectMode && (
        <LocalProjectDialog
          mode={localProjectMode}
          onClose={() => setLocalProjectMode(null)}
          onOpenTerminal={async options => Boolean(await handleOpenLocalTerminal(options))}
        />
      )}
      <AgentMessagesHost currentGroup={groupView.activeGroup} projects={groupView.projects} />

      <SettingsModal
        open={settingsModalOpen}
        onOpenChange={setSettingsModalOpen}
      />

      {/* Shift twice, Ctrl+Shift+F: files of the local tab's project (docs/plan/2026-11-26-project-search.md) */}
      <ProjectSearchKeys />
      <ProjectSearch />
      <CommandPalette
        onNewConnection={handleNewConnection}
        onQuickConnect={handleQuickConnect}
        onOpenSettings={handleOpenSettings}
        onOpenSnippetManager={handleOpenSnippetManager}
        onOpenWhatsNew={() => void handleOpenWhatsNew()}
        onOpenBatch={() => setBatchModalOpen(true)}
        onOpenStats={() => setStatsDashboardOpen(true)}
        onOpenLocalProject={() => setLocalProjectMode('open')}
      />

      {whatsNew && <WhatsNewDialog entries={whatsNew.entries} onClose={closeWhatsNew} />}

      {snippetManagerOpen && (
        <SnippetManager onClose={() => setSnippetManagerOpen(false)} />
      )}

      <StatsDashboard open={statsDashboardOpen} onClose={() => setStatsDashboardOpen(false)} />

      <BatchCommandModal open={batchModalOpen} onClose={() => setBatchModalOpen(false)} />

      <TabContextMenu
        isOpen={contextMenuOpen}
        position={contextMenuPosition}
        tabId={contextMenuTabId || ''}
        onClose={handleCloseContextMenu}
        onCloseTab={handleContextCloseTab}
        onCloseOthers={handleContextCloseOthers}
        onCloseToLeft={handleContextCloseToLeft}
        onCloseToRight={handleContextCloseToRight}
        onDuplicate={handleContextDuplicate}
        onRename={handleContextRename}
        onSplitHorizontal={handleContextSplitHorizontal}
        onSplitVertical={handleContextSplitVertical}
        isLogging={contextMenuTabId !== null && contextMenuTabId in sessionLogFiles}
        isTerminal={!contextMenuTabId || isSshTab(terminals.get(contextMenuTabId))}
        onToggleLog={handleContextToggleLog}
        onOpenLogFolder={openSessionLogFolder}
        mergeChoices={contextMenuTabId ? mergeChoices(terminals, contextMenuTabId) : undefined}
        onMergeInto={handleContextMergeInto}
        developmentActions={developmentActions}
      />
      {renamingTab && (
        <TabRenameDialog
          title={renamingTab.title}
          onClose={() => setRenamingTab(null)}
          onSave={title => {
            useTerminalStore.getState().updateTerminalTitle(renamingTab.id, title)
            setRenamingTab(null)
          }}
        />
      )}
      {agentDropHover && (
        <div className={`tab-merge-marker agent-drop-marker${agentDropHover.blocked ? ' is-blocked' : ''}${agentDropHover.onTab ? ' on-tab' : ''}${agentDropHover.replacement ? ' is-replacing' : ''}`} style={agentDropHover.box} role="status">
          <span>{agentDropHover.blocked ?? (!agentDropHover.targetId ? '여기에 놓으면 새 탭에서 이어서 실행'
            : agentDropHover.replacement ? '여기에 놓으면 기존 셸을 바꾸고 이어서 실행'
            : agentDropHover.place?.isVacant ? '여기에 놓으면 이 빈 자리에서 이어서 실행'
            : agentDropHover.place?.side ? `여기에 놓으면 이 칸의 ${sideWord(agentDropHover.place.side)}에서 이어서 실행` : '여기에 놓으면 이 탭의 새 칸에서 이어서 실행')}</span>
        </div>
      )}
        {tabDropHover?.kind === 'order' && <div className="tab-order-marker" style={tabDropHover.box} aria-hidden="true" />}
        {mergeHover && (
        <div className={`tab-merge-marker${mergeHover.blocked ? ' is-blocked' : ''}${mergeHover.onTab ? ' on-tab' : ''}`} style={mergeHover.box} role="status">
            <span style={mergeHover.onTab ? { left: Math.min(0, Math.max(8 - mergeHover.box.left, innerWidth - mergeHover.box.left - 368)) } : undefined}>
              {mergeHover.blocked ?? (mergeHover.place?.isVacant ? '여기에 놓으면 이 빈 자리로 병합'
            : mergeHover.place?.side ? `여기에 놓으면 이 칸의 ${sideWord(mergeHover.place.side)}에 병합` : '여기에 놓으면 이 탭의 칸으로 병합')}</span>
        </div>
      )}

      <ToastContainer />
      <RunCrashNotices />
      <RunCommandConfirm />
      <UpdateNotification />
    </div>
  )
}

export default App
