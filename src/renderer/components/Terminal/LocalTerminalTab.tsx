import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { throttle, REFIT_INTERVAL_MS } from '../../lib/throttle'
import { readTerminalScrollback } from '../../lib/terminalScrollback'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { RiToolsLine, RiLayoutColumnLine, RiSplitCellsHorizontal, RiSplitCellsVertical, RiLayoutGridLine, RiCloseLine, RiChat3Line, RiHistoryLine, RiRestartLine } from 'react-icons/ri'
import { useThemeStore } from '../../stores/themeStore'
import { FOLLOW_APP_CHAT_THEME, chatAppearance } from '../../themes/chatThemes'
import { useTerminalStore } from '../../stores/terminalStore'
import { toast } from '../../stores/toastStore'
import { confirmDialog } from '../../stores/confirmStore'
import { restartLocalPaneShell } from '../../lib/localShellRestart'
import { copyToClipboard, enableCopyOnSelect, isPasteShortcut } from '../../lib/terminalClipboard'
import { createRightClickFilter } from '../../lib/rightClickReports'
import { MAIN_PANE, singlePane, layoutOf, paneIds, equalize, paneBox, type PaneId } from '../../lib/splitTree'
import { closeTabPane } from '../../lib/paneToTab'
import { ensureLocalPaneShell, getLocalPaneShellId, closeLocalPaneShells } from '../../lib/localPaneShells'
import { TerminalContextMenu, MENU_SEPARATOR, type TerminalMenuGroup } from './TerminalContextMenu'
import { commonTerminalItems } from './terminalMenuCommon'
import { attachLogHighlight, type LogHighlight } from './terminalLogHighlight'
import { attachTerminalWebLinks } from './terminalWebLinks'
import { PaneArrival, SplitChrome, PANE_DIVIDER_PX } from './SplitChrome'
import { AgentPaneMessages, isAgentWorking, useAgentMessagesStore } from './AgentMessages'
import { agentNewlineFor } from '../../lib/agentNewline'
import { AgentPaneUsage } from '../AgentUsage/AgentUsageMeters'
import { AgentChatCover } from '../AgentChat/AgentChatCover'
import { AgentSleepCover } from '../AgentChat/AgentSleepCover'
import { AgentScreenReturnBar } from '../AgentChat/AgentScreenReturnBar'
import { CodexHookReviewBar } from '../AgentChat/CodexHookReviewBar'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { useShortcutsStore } from '../../stores/shortcutsStore'
import { matchesBinding } from '../../lib/shortcutMatch'
import { shortcutLabel } from '../../lib/shortcutModifiers'
import { isAgentChatProvider, shellAgentOf } from '../../lib/agentChatItems'
import { buildLocalInsertSequence } from '../../lib/commandCapture'
import { useTerminalCommandHistory } from '../../hooks/useTerminalCommandHistory'
import { CommandHistoryPanel } from './CommandHistoryPanel'
import { isTabHostPreviewed } from '../../lib/tabHosts'
import { focusPaneInput } from '../../lib/paneFocus'
import { answerableAskItem, askTakenToTerminal } from '../../lib/askQuestion'
import { hasTypedInput } from '../../lib/terminalReplies'
import { registerTerminalPane } from '../../lib/terminalPanes'
import { useAskQuestionStore } from '../../stores/askQuestionStore'
import './LocalTerminalTab.css'

/** Shows a shell as a chat when an agent runs in it; says why not otherwise */
function showChat(shellId: string): void {
  if (!chatAgentOf(shellId)) {
    toast.info('채팅으로 볼 수 없습니다', '이 셸에서 채팅을 지원하는 에이전트가 돌고 있지 않습니다.')
    return
  }
  void useAgentChatStore.getState().show(shellId)
}

/** The agent CLI running in a local shell that the chat view can show, or null */
const chatAgentOf = (shellId: string) => {
  const kind = shellAgentOf(useAgentMessagesStore.getState().snapshot.agents, shellId)?.kind
  return isAgentChatProvider(kind) ? kind : null
}

interface LocalTerminalTabProps {
  /** The tab's stable id, including when a split shell takes over the main pane */
  terminalId: string
  isActive: boolean
  onActivate: () => void
}

const fontStack = (family: string): string => `"${family}", Consolas, "D2Coding", monospace`
/** A pane is not split when a half would be smaller than this (columns / rows of text) */
const MIN_PANE_COLS = 20
const MIN_PANE_ROWS = 5
const refit = () => requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))

interface LocalShellViewProps {
  tabId: string
  pane: PaneId
  /** The shell in the main process this pane shows */
  shellId: string
  /** The tab is in front and this is its first pane: it takes the keyboard */
  takesFocus: boolean
  style?: CSSProperties
}

/**
 * One shell of this PC (src/localShell.js) drawn in a pane. The shell outlives the element: drawn
 * again (tab moved, layout changed) it asks for the output so far and continues.
 */
function LocalShellView({ tabId, pane, shellId, takesFocus, style }: LocalShellViewProps) {
  const paneRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  // The chat view covers the terminal: its error/warning tints are not drawn meanwhile
  const logHighlightRef = useRef<LogHighlight | null>(null)
  const coveredRef = useRef(false)
  const fitRef = useRef<FitAddon | null>(null)
  const pasteRef = useRef<(() => void) | undefined>(undefined)
  const [exit, setExit] = useState<{ code: number | null } | null>(null)
  // A development server started from a run preset: restarted there (실행 구성), not as a plain shell
  const [development, setDevelopment] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [inboxDraftBlocked, setInboxDraftBlocked] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [usageActions, setUsageActions] = useState<HTMLSpanElement | null>(null)
  const agentWork = useAgentMessagesStore(state => {
    const agent = state.snapshot.agents.find(item => item.shellId === shellId)
    if (!agent) return undefined
    return !exit && isAgentWorking(agent) ? 'working' : 'idle'
  })
  const chatAgent = useAgentMessagesStore(() => chatAgentOf(shellId))
  const isChat = useAgentChatStore(state => state.chats.has(shellId))
  const chatThemeId = useThemeStore(state => isChat ? state.chatThemeId : undefined)
  const customThemes = useThemeStore(state => isChat ? state.customThemes : undefined)
  const followedTheme = useThemeStore(state => isChat && state.chatThemeId === FOLLOW_APP_CHAT_THEME ? state.getCurrentTheme() : undefined)
  const chatTheme = useMemo(() => chatThemeId ? chatAppearance(chatThemeId, customThemes ?? [], followedTheme) : undefined,
    [chatThemeId, customThemes, followedTheme])
  const chatKind = useAgentChatStore(state => state.chats.get(shellId)?.kind)
  const antigravity = (chatKind ?? chatAgent) === 'antigravity'
  const terminalApproval = useAgentChatStore(state => {
    const chat = state.chats.get(shellId)
    const approval = chat?.state !== 'ended' ? chat?.approval : null
    return approval?.terminalOnly ?? (approval?.usesTerminalInput ? 'question' : null)
  })
  // Claude's AskUserQuestion goes on the chat's own card (AskQuestionCard) unless the user took it to the terminal
  const answerableAskId = useAgentChatStore(state => {
    const chat = state.chats.get(shellId)
    return chat?.kind === 'claude' && chat.state !== 'ended' ? answerableAskItem(chat.items, chat.approval)?.id ?? null : null
  })
  const askInTerminal = useAskQuestionStore(state => state.inTerminal.get(shellId))
  const inlineQuestion = !exit && terminalApproval !== null && (!answerableAskId || askInTerminal === answerableAskId)
  const hasSpeedControls = isChat && (chatKind ?? chatAgent) === 'codex' && !!window.electronAPI.agentChatToggleSpeed
  const fontSize = useTerminalStore(state => state.fontSize)
  const fontFamily = useTerminalStore(state => state.fontFamily)
  const tab = useTerminalStore(state => state.terminals.get(tabId))
  const splitTerminalPane = useTerminalStore(state => state.splitTerminalPane)
  const setSplitTree = useTerminalStore(state => state.setSplitTree)
  const tabName = tab?.title ?? '로컬 터미널'
  const isPowerShell = /^win/i.test(navigator.platform)
  const commandHistory = useTerminalCommandHistory(shellId, 'main', (data) => {
    window.electronAPI.localShellWrite?.(shellId, data)
  }, {
    canUse: () => !exit && !isChat && !chatAgentOf(shellId),
    allowInlinePrediction: isPowerShell,
    insertSequence: (command, terminal) => terminal.buffer.active.type === 'normal'
      ? buildLocalInsertSequence(command, terminal.buffer.active, isPowerShell)
      : null
  })

  const fit = (): void => {
    const terminal = terminalRef.current
    const addon = fitRef.current
    if (!terminal || !addon) return
    try {
      addon.fit()
      window.electronAPI.localShellResize?.(shellId, terminal.cols, terminal.rows)
    } catch {
      // The element has no size yet (hidden tab)
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setExit(null)
    setDevelopment(false)
    const { fontSize: size, fontFamily: family } = useTerminalStore.getState()
    const terminal = new Terminal({
      theme: useThemeStore.getState().getTerminalTheme(),
      fontSize: size,
      fontFamily: fontStack(family),
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'bar',
      scrollback: readTerminalScrollback(),
      allowProposedApi: true
    })
    const addon = new FitAddon()
    terminal.loadAddon(addon)
    terminal.open(host)
    // Found by its pane (lib/terminalPanes.ts): an Alt+drag that closes the pane reads its screen first
    const unregisterPane = registerTerminalPane(host, terminal)
    attachTerminalWebLinks(terminal)
    terminalRef.current = terminal
    fitRef.current = addon
    const detachCommandHistory = commandHistory.attach(terminal)
    const disableCopyOnSelect = enableCopyOnSelect(terminal)
    const logHighlight = attachLogHighlight(terminal)
    logHighlight.setPaused(coveredRef.current)
    logHighlightRef.current = logHighlight

    let isDisposed = false
    let deferredInput: string[] | null = null
    const write = (data: string) => window.electronAPI.localShellWrite?.(shellId, data)
    // Typing into Claude's question dialog here keeps that question in the terminal until it is answered:
    // the card would start over at its first question while the dialog has moved on. Only what the user
    // typed or pasted: xterm's own focus reports (sent when the pane loses focus to the chat or another
    // pane), mouse reports and query answers would take the card away without a key pressed.
    const keepAskInTerminal = (data: string) => {
      if (!hasTypedInput(data)) return
      const chat = useAgentChatStore.getState().chats.get(shellId)
      if (chat?.kind !== 'claude' || chat.state === 'ended') return
      const asks = useAskQuestionStore.getState()
      const itemId = askTakenToTerminal(chat.items, chat.approval, asks.inTerminal.get(shellId))
      if (itemId) asks.answerInTerminal(shellId, itemId)
    }
    const sendInput = (data: string) => {
      keepAskInTerminal(data)
      commandHistory.handleData(data)
      write(data)
    }
    const startComposing = () => window.electronAPI.localShellComposing?.(shellId, true)
    const endComposing = () => window.electronAPI.localShellComposing?.(shellId, false)
    host.addEventListener('compositionstart', startComposing, true)
    host.addEventListener('compositionend', endComposing, true)
    const readClipboard = window.electronAPI.localShellClipboard
    const paste = async () => {
      if (!readClipboard || isDisposed || deferredInput) return
      deferredInput = []
      let text = ''
      try {
        const result = await readClipboard(shellId)
        if (result.success) text = result.text
        else if (!isDisposed) toast.error('붙여넣기 실패', result.error)
      } catch {
        if (!isDisposed) toast.error('붙여넣기 실패', '클립보드에 접근할 수 없습니다.')
      } finally {
        // A following Enter must reach the shell after the clipboard contents.
        const queued = deferredInput
        deferredInput = null
        if (!isDisposed) {
          if (text) terminal.paste(text)
          queued.forEach(sendInput)
        }
      }
    }
    pasteRef.current = readClipboard ? () => void paste() : undefined
    const onNativePaste = (event: ClipboardEvent) => {
      if (!readClipboard || !Array.from(event.clipboardData?.items ?? []).some(item => item.type.startsWith('image/'))) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void paste()
    }
    host.addEventListener('paste', onNativePaste, true)
    terminal.attachCustomKeyEventHandler((event) => {
      // The chat view's key, pressed in the terminal (the app-wide handler skips the terminal's text box)
      if (matchesBinding(event, useShortcutsStore.getState().getEffectiveKeys('toggle-agent-chat'))) {
        if (event.type === 'keydown') {
          event.preventDefault()
          if (!event.repeat) {
            if (useAgentChatStore.getState().chats.has(shellId)) showTerminal()
            else showChat(shellId)
          }
        }
        return false
      }
      // Shift+Enter adds a line in Claude Code / Codex (xterm would send the same Enter key as plain Enter)
      const newline = agentNewlineFor(event, () => useAgentMessagesStore.getState().snapshot.agents
        .some(agent => agent.active && agent.shellId === shellId && (agent.kind === 'claude' || agent.kind === 'codex')))
      if (newline) {
        if (event.type === 'keydown') {
          event.preventDefault()
          if (deferredInput) deferredInput.push(newline)
          else write(newline)
        }
        return false
      }
      // Ctrl+C with a selection copies instead of interrupting
      if (event.ctrlKey && event.key === 'c' && event.type === 'keydown') {
        const selection = terminal.getSelection()
        if (selection) {
          void copyToClipboard(selection)
          return false
        }
      }
      if (isPasteShortcut(event)) {
        if (readClipboard) {
          event.preventDefault()
          if (!event.repeat) void paste()
        }
        return false
      }
      if (commandHistory.handleKeyEvent(event)) return false
      return true
    })
    // The right button opens the app's menu: not reported to the agent too (Codex pastes on it)
    const withoutRightClick = createRightClickFilter()
    terminal.onData((raw) => {
      const data = withoutRightClick(raw)
      if (!data) return
      if (deferredInput) deferredInput.push(data)
      else sendInput(data)
    })

    // Output sent before the answer to `attach` is already part of that answer, so it is not drawn twice
    let isAttached = false
    const stopData = window.electronAPI.onLocalShellData?.(({ id, data }) => {
      if (id === shellId && isAttached) terminal.write(data)
    })
    const stopExit = window.electronAPI.onLocalShellExit?.(({ id, exitCode }) => {
      if (id === shellId) setExit({ code: exitCode })
    })
    let receivedDevelopment = false
    const stopDevelopment = window.electronAPI.onLocalShellDevelopmentState?.(({ id, development }) => {
      if (id !== shellId || !development) return
      receivedDevelopment = true
      setDevelopment(true)
      if (development.status === 'starting' || development.status === 'running') setExit(null)
      if (development.status === 'exited') setExit({ code: development.exitCode })
    })
    let receivedInboxDraft = false
    const stopInboxDraft = window.electronAPI.onLocalShellInboxDraft?.(({ id, blocked }) => {
      if (id !== shellId) return
      receivedInboxDraft = true
      setInboxDraftBlocked(blocked)
    })
    void window.electronAPI.localShellAttach?.(shellId).then((state) => {
      if (isDisposed) return
      isAttached = true
      if (!state) {
        setExit({ code: null })
        return
      }
      if (state.backlog) terminal.write(state.backlog)
      if (state.development) setDevelopment(true)
      if (!receivedInboxDraft) setInboxDraftBlocked(Boolean(state.inboxDraftBlocked))
      if (state.exited && !receivedDevelopment) setExit({ code: state.exitCode })
    })

    const onTheme = (): void => { terminal.options.theme = useThemeStore.getState().getTerminalTheme() }
    window.addEventListener('theme-changed', onTheme)
    // A reflow per frame while a divider is dragged made resizing stutter: refit at intervals
    const refit = throttle(() => { if (!isDisposed) fit() }, REFIT_INTERVAL_MS)
    const observer = new ResizeObserver(() => refit())
    observer.observe(host)

    return () => {
      isDisposed = true
      pasteRef.current = undefined
      host.removeEventListener('compositionstart', startComposing, true)
      host.removeEventListener('compositionend', endComposing, true)
      endComposing()
      host.removeEventListener('paste', onNativePaste, true)
      stopData?.()
      stopExit?.()
      stopDevelopment?.()
      stopInboxDraft?.()
      window.removeEventListener('theme-changed', onTheme)
      observer.disconnect()
      refit.cancel()
      disableCopyOnSelect()
      logHighlight.dispose()
      if (logHighlightRef.current === logHighlight) logHighlightRef.current = null
      detachCommandHistory()
      unregisterPane()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellId])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.fontSize = fontSize
    terminal.options.fontFamily = fontStack(fontFamily)
    const timer = window.setTimeout(fit, 10)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize, fontFamily])

  useEffect(() => {
    if (!takesFocus) return
    const timer = window.setTimeout(() => {
      fit()
      const element = paneRef.current
      // A click may already have focused a different shell in this tab.
      if (element && !isTabHostPreviewed(tabId) && !element.parentElement?.contains(document.activeElement)) {
        focusPaneInput(element)
      }
    }, 30)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takesFocus, tabId])

  const showTerminal = () => {
    useAgentChatStore.getState().hide(shellId)
    window.setTimeout(() => terminalRef.current?.focus(), 0)
  }

  useLayoutEffect(() => {
    const pane = paneRef.current
    if (pane && isChat && !inlineQuestion && hostRef.current?.contains(document.activeElement)) focusPaneInput(pane)
  }, [inlineQuestion, isChat])

  // Under the chat view the terminal is hidden (but for a question answered in it): no tints, no reading
  // its screen every frame; back on the terminal they are drawn again
  useEffect(() => {
    const covered = isChat && !inlineQuestion
    coveredRef.current = covered
    logHighlightRef.current?.setPaused(covered)
  }, [inlineQuestion, isChat])

  const restart = async (): Promise<void> => {
    if (restarting || development) return
    // An agent (or anything else) running in it ends with the old shell
    if (!exit && agentWork !== undefined && !await confirmDialog({
      title: '터미널 재시작',
      message: '이 셸에서 에이전트가 돌고 있습니다. 재시작하면 에이전트가 끝나고 같은 폴더에서 새 셸이 열립니다.',
      confirmLabel: '재시작',
      danger: true
    })) return
    setRestarting(true)
    try {
      const result = await restartLocalPaneShell(tabId, pane, shellId)
      if (!result.ok) toast.error('터미널을 재시작하지 못했습니다', result.error)
    } finally {
      setRestarting(false)
    }
  }

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }

  const then = (action: () => void) => () => {
    action()
    if (!isChat) window.setTimeout(() => terminalRef.current?.focus(), 0)
  }

  const getSplitMenu = (): TerminalMenuGroup | null => {
    const terminal = terminalRef.current
    if (!terminal) return null
    const tree = tab?.splitTree ?? singlePane()
    const isSplit = tab?.isSplit === true
    const isTooNarrow = Math.floor(terminal.cols / 2) < MIN_PANE_COLS
    const isTooShort = Math.floor(terminal.rows / 2) < MIN_PANE_ROWS
    return {
      label: '분할',
      icon: RiLayoutColumnLine,
      items: [
        {
          label: isTooNarrow ? '좌우 분할 (칸이 좁습니다)' : '좌우 분할',
          icon: RiSplitCellsHorizontal,
          disabled: isTooNarrow,
          onSelect: then(() => splitTerminalPane(tabId, pane, 'row'))
        },
        {
          label: isTooShort ? '상하 분할 (칸이 낮습니다)' : '상하 분할',
          icon: RiSplitCellsVertical,
          disabled: isTooShort,
          onSelect: then(() => splitTerminalPane(tabId, pane, 'col'))
        },
        MENU_SEPARATOR,
        { label: '칸 크기 균등화', icon: RiLayoutGridLine, disabled: !isSplit, onSelect: then(() => { setSplitTree(tabId, equalize(tree)); refit() }) },
        // Another shell becomes the main one when closing the tab's first pane.
        {
          label: '이 칸 닫기',
          icon: RiCloseLine,
          disabled: !isSplit,
          onSelect: () => {
            void closeTabPane(tabId, pane).then((result) => {
              if (result.ok) refit()
              else toast.error('칸을 닫지 못했습니다', result.error)
            })
          }
        }
      ]
    }
  }

  const terminal = terminalRef.current
  let groups: TerminalMenuGroup[] | null = null
  let top: ReturnType<typeof commonTerminalItems>['top'] | null = null
  if (menu && terminal) {
    const items = commonTerminalItems(terminal, tabName, then, pasteRef.current)
    const chatKey = shortcutLabel(useShortcutsStore.getState().getEffectiveKeys('toggle-agent-chat'))
    top = [
      ...items.top,
      { label: '명령어 기록', icon: RiHistoryLine, disabled: !!exit || !!chatAgent, onSelect: () => setShowHistory(true) },
      {
        label: chatAgent ? `채팅 모드 (${chatKey})` : '채팅 모드 (에이전트가 돌고 있지 않음)',
        icon: RiChat3Line,
        disabled: !chatAgent,
        onSelect: () => showChat(shellId)
      },
      {
        label: development ? '터미널 재시작 (실행 구성에서 재기동해 주세요)' : '터미널 재시작',
        icon: RiRestartLine,
        disabled: development || restarting,
        onSelect: () => void restart()
      }
    ]
    const split = getSplitMenu()
    groups = [...(split ? [split] : []), { label: '편의', icon: RiToolsLine, items: items.output }]
  }

  return (
    <div
      ref={paneRef}
      className="local-terminal-pane"
      data-pane={pane}
      data-local-shell-id={shellId}
      data-local-tab-id={tabId}
      data-agent-work={agentWork}
      data-chat-mode={isChat || undefined}
      data-chat-kind={isChat ? (chatKind ?? chatAgent) : undefined}
      // The chat theme goes on the pane, not just the cover: its focus border, the working trace,
      // the sleep cover and the return bar are drawn here and must follow the same palette
      style={chatTheme ? { ...chatTheme.style, ...style } : style}
    >
      {/* A row above the terminal, not an overlay: the terminal gives up its height while the bar shows,
          so Codex's review lines at the top stay readable. Mounted for every pane: Codex asks before its
          MCP connects, when the pane's agent is not known yet */}
      {!antigravity && !exit && <CodexHookReviewBar shellId={shellId} isChat={isChat} onShowTerminal={showTerminal} />}
      {!exit && inboxDraftBlocked && (
        <div className="local-terminal-inbox-draft" role="status">
          <span>입력칸에 글이 남아 메시지를 전하지 못했습니다</span>
          {isChat && <button type="button" onClick={showTerminal}>터미널 보기</button>}
        </div>
      )}
      <div className="local-terminal-stage" data-chat-question={inlineQuestion || undefined}>
        <div
          ref={hostRef}
          className="local-terminal-host"
          inert={isChat && !inlineQuestion}
          role={inlineQuestion ? 'region' : undefined}
          aria-label={inlineQuestion ? (terminalApproval === 'folder-trust' ? 'Claude 폴더 신뢰 확인' : antigravity ? 'Antigravity 터미널 입력' : 'Claude 질문 응답') : undefined}
          onContextMenu={onContextMenu}
        />
        {showHistory && !exit && !isChat && !chatAgent && (
          <CommandHistoryPanel
            sessionId={shellId}
            scopeLabel="로컬 셸"
            onInsert={(command) => {
              commandHistory.insert(command)
              setShowHistory(false)
            }}
            onClose={() => {
              setShowHistory(false)
              terminalRef.current?.focus()
            }}
          />
        )}
        {!exit && !isChat && !chatAgent && commandHistory.popup}
        {isChat && (
          <AgentChatCover
            shellId={shellId}
            appearance={chatTheme}
            usageActions={usageActions}
            tabId={tabId}
            getSplitMenu={getSplitMenu}
            onShowTerminal={showTerminal}
            onFocusQuestion={() => {
              terminalRef.current?.scrollToBottom()
              terminalRef.current?.focus()
            }}
          />
        )}
        {!isChat && <AgentScreenReturnBar shellId={shellId} />}
        {!antigravity && <AgentSleepCover shellId={shellId} onTerminal={showTerminal} />}
      </div>
      {!antigravity && <AgentPaneUsage shellId={shellId} actionsRef={hasSpeedControls ? setUsageActions : undefined} showIdentity={!isChat} style={chatTheme?.style} />}
      {!antigravity && <AgentPaneMessages shellId={shellId} tabId={tabId} />}
      {exit && (
        <div className="local-terminal-exit" role="status">
          셸이 종료되었습니다{exit.code !== null && exit.code !== 0 ? ` (종료 코드 ${exit.code})` : ''}.
          {pane === MAIN_PANE && !tab?.isSplit ? ' 탭을 닫아 주세요.' : ' 우클릭 메뉴의 `분할` > `이 칸 닫기` 로 닫아 주세요.'}
          {!development && (
            <button type="button" className="local-terminal-restart" disabled={restarting} onClick={() => void restart()}>새 셸로 재시작</button>
          )}
        </div>
      )}
      {menu && groups && top && (
        <TerminalContextMenu
          key={`${menu.x}:${menu.y}`}
          position={menu}
          top={top}
          groups={groups}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** A split pane of a local terminal tab: opens a shell of its own, then shows it */
function LocalSplitPane({ tabId, pane, style }: { tabId: string; pane: PaneId; style: CSSProperties }) {
  const currentShellId = useTerminalStore(() => getLocalPaneShellId(tabId, pane))
  const [shell, setShell] = useState<{ id: string } | { error: string } | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let isCurrent = true
    setShell(null)
    void ensureLocalPaneShell(tabId, pane).then((result) => {
      if (isCurrent) setShell(result.ok ? { id: result.id } : { error: result.error })
    })
    return () => { isCurrent = false }
  }, [tabId, pane, attempt])

  const shellId = currentShellId ?? (shell && 'id' in shell ? shell.id : null)
  if (shellId) return <LocalShellView key={shellId} tabId={tabId} pane={pane} shellId={shellId} takesFocus={false} style={style} />
  return (
    <div className="local-terminal-pane local-terminal-pane-status" data-pane={pane} style={style} role="status">
      {shell && 'error' in shell ? (
        <>
          <span>{shell.error}</span>
          <button type="button" className="split-terminal-retry-btn" onClick={() => setAttempt(count => count + 1)}>다시 시도</button>
        </>
      ) : <span>로컬 셸 여는 중...</span>}
    </div>
  )
}

/**
 * A terminal of this PC shown as a tab. Like an SSH tab it can be divided into panes
 * (lib/splitTree.ts); the first pane is the tab's own shell, every other pane has a shell of its own.
 */
export function LocalTerminalTab({ terminalId, isActive, onActivate }: LocalTerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const splitTree = useTerminalStore(state => state.terminals.get(terminalId)?.splitTree)
  const mainShellId = useTerminalStore(state => state.terminals.get(terminalId)?.local?.shellId ?? terminalId)
  const isSplit = !!splitTree
  const layout = useMemo(() => layoutOf(splitTree ?? singlePane()), [splitTree])
  const mainRect = layout.panes.find(entry => entry.pane === MAIN_PANE)?.rect
  // In a fixed order (by id), whatever their places: swapping panes changes boxes, not elements
  const splitPanes = isSplit
    ? layout.panes.filter(entry => entry.pane !== MAIN_PANE).sort((a, b) => a.pane.localeCompare(b.pane, undefined, { numeric: true }))
    : []

  // A pane that left the split (closed, or the split ended) takes its shell with it
  useEffect(() => {
    closeLocalPaneShells(terminalId, splitTree ? paneIds(splitTree) : [])
  }, [terminalId, splitTree])

  return (
    <div ref={containerRef} className={`local-terminal-tab${isSplit ? ' is-split' : ''}`} onMouseDown={() => {
      if (!isTabHostPreviewed(terminalId)) onActivate()
    }}>
      <LocalShellView
        key={mainShellId}
        tabId={terminalId}
        pane={MAIN_PANE}
        shellId={mainShellId}
        takesFocus={isActive}
        style={isSplit && mainRect ? paneBox(mainRect, PANE_DIVIDER_PX) : undefined}
      />
      {splitPanes.map(({ pane, rect }) => (
        <LocalSplitPane key={`w-${pane}`} tabId={terminalId} pane={pane} style={paneBox(rect, PANE_DIVIDER_PX)} />
      ))}
      <SplitChrome tabId={terminalId} tree={splitTree ?? singlePane()} containerRef={containerRef} />
      {!isSplit && <PaneArrival tabId={terminalId} />}
    </div>
  )
}

export default LocalTerminalTab
