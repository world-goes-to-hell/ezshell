// A local shell's Claude Code / Codex as a chat, drawn over its pane (docs/plan/2026-11-19-agent-chat-view.md).
// The shell and the agent keep running under it and the terminal stays mounted: this is only a view of
// the agent's transcript (src/agentChat) with a box that types into the agent's own composer.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { RiCheckboxBlankCircleLine, RiCheckboxCircleLine, RiCloseLine, RiExternalLinkLine, RiFileCopyLine, RiFileTextLine, RiFolderOpenLine, RiLoader4Line, RiSendPlane2Line, RiStopCircleLine, RiTerminalBoxLine } from 'react-icons/ri'
import type { AgentChatApproval, AgentChatItem } from '../../types'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { useAgentMessagesStore } from '../Terminal/AgentMessages'
import { AGENT_PROVIDER_ICONS } from '../Sidebar/LocalSessionAgents'
import { useShortcutsStore } from '../../stores/shortcutsStore'
import { shortcutLabel } from '../../lib/shortcutModifiers'
import { matchesBinding } from '../../lib/shortcutMatch'
import { LOCAL_PATH_LINK, renderChatMarkdown } from '../../lib/markdownRender'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { TerminalContextMenu } from '../Terminal/TerminalContextMenu'
import { diffLineKind, shellAgentOf } from '../../lib/agentChatItems'
import { toast } from '../../stores/toastStore'
import './AgentChat.css'

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' } as const
const STATUS_LABELS: Record<string, string> = {
  working: '작업 중',
  starting: '시작 중',
  blocked: '확인 대기',
  idle: '입력 대기',
  unknown: '',
  error: '오류',
  ended: '종료됨'
}
/** Rows the text box grows to before it scrolls */
const MAX_COMPOSER_ROWS = 8

// Links are handled by the cover (a menu to open them), so the answer itself only draws them
function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderChatMarkdown(text), [text])
  // eslint-disable-next-line react/no-danger -- inert HTML from markdownRender (html: false, links checked, no images)
  return <div className="agent-chat-md" dangerouslySetInnerHTML={{ __html: html }} />
}

interface LinkMenu {
  x: number
  y: number
  href: string
  isFile: boolean
}

/** What a link names, for the menu's title: a file's or folder's name, or the address */
function linkName(href: string, isFile: boolean): string {
  if (!isFile) return href
  const plain = href.replace(/^file:\/\/\//i, '').replace(/[\\/]+$/, '')
  return plain.split(/[\\/]/).pop() || plain
}

function Diff({ lines }: { lines: string[] }) {
  return (
    <pre className="agent-chat-diff">
      {lines.map((line, index) => <span key={index} className={`agent-chat-diff-${diffLineKind(line)}`}>{line}{'\n'}</span>)}
    </pre>
  )
}

function Todos({ todos }: { todos: NonNullable<NonNullable<AgentChatItem['tool']>['todos']> }) {
  return (
    <ul className="agent-chat-todos">
      {todos.map((todo, index) => (
        <li key={index} data-status={todo.status}>
          {todo.status === 'completed' ? <RiCheckboxCircleLine aria-hidden /> : todo.status === 'in_progress' ? <RiLoader4Line aria-hidden /> : <RiCheckboxBlankCircleLine aria-hidden />}
          <span>{todo.text}</span>
        </li>
      ))}
    </ul>
  )
}

function ToolCard({ tool, running }: { tool: NonNullable<AgentChatItem['tool']>; running: boolean }) {
  const added = tool.diff?.filter(line => diffLineKind(line) === 'add').length ?? 0
  const removed = tool.diff?.filter(line => diffLineKind(line) === 'remove').length ?? 0
  if (tool.todos) {
    return (
      <div className="agent-chat-tool agent-chat-tool-todos">
        <div className="agent-chat-tool-head"><span className="agent-chat-tool-name">할 일</span></div>
        <Todos todos={tool.todos} />
      </div>
    )
  }
  return (
    <details className="agent-chat-tool" data-error={tool.isError ? 'true' : undefined}>
      <summary className="agent-chat-tool-head">
        <span className="agent-chat-tool-name">{tool.name}</span>
        {tool.summary && <span className="agent-chat-tool-summary">{tool.summary}</span>}
        {tool.diff && <span className="agent-chat-tool-counts"><span className="agent-chat-diff-add">+{added}</span> <span className="agent-chat-diff-remove">−{removed}</span></span>}
        {running && <span className="agent-chat-tool-state"><RiLoader4Line className="agent-chat-spin" aria-hidden /> 실행 중</span>}
        {tool.isError && <span className="agent-chat-tool-state agent-chat-tool-failed">실패</span>}
      </summary>
      <div className="agent-chat-tool-body">
        {tool.input && <pre className="agent-chat-tool-input">{tool.input}</pre>}
        {tool.diff && <Diff lines={tool.diff} />}
        {tool.result && <pre className="agent-chat-tool-result">{tool.result}</pre>}
      </div>
    </details>
  )
}

/**
 * The agent's question with its choices, answered here instead of in the terminal. Main checks the
 * screen still shows this very prompt before it presses the number key.
 */
function ApprovalCard({ shellId, approval }: { shellId: string; approval: AgentChatApproval }) {
  const [answering, setAnswering] = useState<string | null>(null)
  const firstRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setAnswering(null)
    firstRef.current?.focus()
  }, [approval.signature])

  const answer = async (key: string) => {
    if (answering) return
    setAnswering(key)
    const result = await window.electronAPI.agentChatAnswer?.(shellId, key, approval.signature)
    if (!result?.ok) {
      setAnswering(null)
      toast.error('답하지 못했습니다', result && !result.ok ? result.error : '이 앱 버전에서는 쓸 수 없습니다.')
    }
  }

  // Number keys answer too, as in the terminal
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.altKey || event.metaKey || !/^[1-9]$/.test(event.key)) return
    if (!approval.options.some(option => option.key === event.key)) return
    event.preventDefault()
    void answer(event.key)
  }

  return (
    <div className="agent-chat-approval" role="group" aria-label="에이전트의 확인 요청" onKeyDown={onKeyDown}>
      <div className="agent-chat-approval-question">{approval.question ?? '에이전트가 확인을 기다리고 있습니다'}</div>
      {approval.detail.length > 0 && <pre className="agent-chat-approval-detail">{approval.detail.join('\n')}</pre>}
      <div className="agent-chat-approval-options">
        {approval.options.map((option, index) => (
          <button
            key={option.key}
            ref={index === 0 ? firstRef : undefined}
            type="button"
            className="agent-chat-approval-option"
            disabled={answering !== null}
            onClick={() => void answer(option.key)}
          >
            <span className="agent-chat-approval-key">{option.key}</span>
            <span>{option.label}</span>
            {answering === option.key && <RiLoader4Line className="agent-chat-spin" aria-hidden />}
          </button>
        ))}
      </div>
    </div>
  )
}

const ChatItem = memo(function ChatItem({ item, live }: { item: AgentChatItem; live: boolean }) {
  const time = item.time ? new Date(item.time).toLocaleTimeString() : undefined
  switch (item.kind) {
    case 'user':
      return <div className="agent-chat-user" title={time}><div className="agent-chat-bubble">{item.text}</div></div>
    case 'assistant':
      return <div className="agent-chat-assistant" title={time}><Markdown text={item.text ?? ''} /></div>
    case 'thinking':
      return (
        <details className="agent-chat-thinking">
          <summary>생각</summary>
          <div className="agent-chat-thinking-text">{item.text}</div>
        </details>
      )
    case 'tool':
      return item.tool ? <ToolCard tool={item.tool} running={live && item.tool.result === undefined && !item.tool.isError && !item.tool.diff} /> : null
    case 'notice':
      return <div className="agent-chat-notice" role="separator"><span>{item.text}</span></div>
    default:
      return null
  }
})

interface AgentChatCoverProps {
  shellId: string
  /** Back to the terminal (the pane focuses its xterm) */
  onShowTerminal: () => void
}

export function AgentChatCover({ shellId, onShowTerminal }: AgentChatCoverProps) {
  const chat = useAgentChatStore(state => state.chats.get(shellId))
  const loadOlder = useAgentChatStore(state => state.loadOlder)
  const agent = useAgentMessagesStore(state => shellAgentOf(state.snapshot.agents, shellId))
  const toggleKeys = useShortcutsStore(state => state.getEffectiveKeys('toggle-agent-chat'))
  const [draft, setDraft] = useState('')
  const [attachment, setAttachment] = useState<{ id: string; url: string } | null>(null)
  const [pasting, setPasting] = useState(false)
  const [sending, setSending] = useState(false)
  const pastePending = useRef(false)
  const [linkMenu, setLinkMenu] = useState<LinkMenu | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const stickRef = useRef(true)
  const firstIdRef = useRef<string | null>(null)
  const heightRef = useRef(0)

  const items = chat?.items ?? []
  const kind = chat?.kind ?? (agent?.kind === 'claude' || agent?.kind === 'codex' ? agent.kind : null)
  const ProviderIcon = kind ? AGENT_PROVIDER_ICONS[kind] : null
  const status = chat?.state === 'ended' ? 'ended' : agent?.status ?? 'unknown'
  const isOver = chat?.state === 'ended' || !agent
  const title = chat?.title ?? items.find(item => item.kind === 'user')?.text?.split('\n')[0] ?? '대화'
  const lastToolId = useMemo(() => [...items].reverse().find(item => item.kind === 'tool')?.id, [items])

  useEffect(() => {
    const timer = window.setTimeout(() => boxRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (attachment) return () => URL.revokeObjectURL(attachment.url)
  }, [attachment])
  useEffect(() => {
    if (!isOver || !attachment) return
    window.electronAPI.agentChatRemoveImage?.(shellId, attachment.id)
    setAttachment(null)
  }, [isOver, attachment, shellId])

  // New items keep the view at the bottom when it was there; older items keep the reader's place
  useLayoutEffect(() => {
    const log = logRef.current
    if (!log) return
    const firstId = items[0]?.id ?? null
    if (firstIdRef.current && firstId !== firstIdRef.current && log.scrollHeight > heightRef.current && !stickRef.current) {
      log.scrollTop += log.scrollHeight - heightRef.current
    } else if (stickRef.current) {
      log.scrollTop = log.scrollHeight
    }
    firstIdRef.current = firstId
    heightRef.current = log.scrollHeight
  }, [items])

  // A link in an answer opens a menu (it never navigates the app window): a file or folder of this PC
  // in ezShell or the file manager, a web page in the browser. Main opens only links of this conversation.
  const onLogClick = (event: MouseEvent<HTMLDivElement>) => {
    const link = (event.target as HTMLElement).closest('a')
    if (!link || !link.closest('.agent-chat-md')) return
    event.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (!href || href.startsWith('#') || /^mailto:/i.test(href)) return
    setLinkMenu({ x: event.clientX, y: event.clientY, href, isFile: LOCAL_PATH_LINK.test(href) })
  }

  const openLink = async (href: string, how: 'app' | 'explorer' | 'browser') => {
    const result = await window.electronAPI.agentChatOpenLink?.(shellId, href, how)
    if (!result?.ok) toast.error('열지 못했습니다', result && !result.ok ? result.error : '이 앱 버전에서는 쓸 수 없습니다.')
  }

  const linkMenuItems = (menu: LinkMenu) => menu.isFile
    ? [
        { label: 'ezShell 에서 열기', icon: RiFileTextLine, onSelect: () => void openLink(menu.href, 'app') },
        { label: '파일 탐색기에서 열기', icon: RiFolderOpenLine, onSelect: () => void openLink(menu.href, 'explorer') },
        { label: '경로 복사', icon: RiFileCopyLine, onSelect: () => void copyToClipboard(menu.href) }
      ]
    : [
        { label: '브라우저에서 열기', icon: RiExternalLinkLine, onSelect: () => void openLink(menu.href, 'browser') },
        { label: '주소 복사', icon: RiFileCopyLine, onSelect: () => void copyToClipboard(menu.href) }
      ]

  const onScroll = () => {
    const log = logRef.current
    if (!log) return
    stickRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 40
    heightRef.current = log.scrollHeight
    if (log.scrollTop < 80 && chat?.hasOlder) loadOlder(shellId)
  }

  const paste = async (box: HTMLTextAreaElement) => {
    const readClipboard = window.electronAPI.agentChatReadClipboard
    if (!readClipboard || pastePending.current || sending) return
    pastePending.current = true
    setPasting(true)
    try {
      const result = await readClipboard(shellId)
      if (boxRef.current !== box) {
        if (result.ok && result.kind === 'image') window.electronAPI.agentChatRemoveImage?.(shellId, result.id)
        return
      }
      if (!result.ok) {
        toast.error('붙여넣기 실패', result.error)
      } else if (result.kind === 'image') {
        setAttachment({
          id: result.id,
          url: URL.createObjectURL(new Blob([result.preview], { type: 'image/png' }))
        })
      } else if (result.text) {
        const text = result.text.replace(/\r\n?/g, '\n')
        const start = box.selectionStart
        const next = box.value.slice(0, start) + text + box.value.slice(box.selectionEnd)
        box.value = next
        box.setSelectionRange(start + text.length, start + text.length)
        setDraft(next)
      }
    } catch {
      if (boxRef.current === box) toast.error('붙여넣기 실패', '클립보드에 접근할 수 없습니다.')
    } finally {
      pastePending.current = false
      setPasting(false)
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!window.electronAPI.agentChatReadClipboard || event.clipboardData.getData('text/plain')
      || !Array.from(event.clipboardData.items).some(item => item.type.startsWith('image/'))) return
    event.preventDefault()
    void paste(event.currentTarget)
  }

  const send = async () => {
    const text = draft.trim()
    if ((!text && !attachment) || sending || pastePending.current || isOver) return
    setSending(true)
    try {
      const result = await window.electronAPI.agentChatSend?.(shellId, text, attachment?.id)
      if (result?.ok) {
        setDraft('')
        setAttachment(null)
        stickRef.current = true
      } else {
        toast.error('보내지 못했습니다', result && !result.ok ? result.error : '이 앱 버전에서는 쓸 수 없습니다.')
      }
    } catch {
      toast.error('보내지 못했습니다', '에이전트에 연결할 수 없습니다.')
    } finally {
      setSending(false)
      boxRef.current?.focus()
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Korean input: Enter that ends a composition is not a send
    if (event.nativeEvent.isComposing) return
    if (window.electronAPI.agentChatReadClipboard && matchesBinding(event, ['Ctrl', 'V'])) {
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) void paste(event.currentTarget)
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      void send()
    } else if (event.key === 'Escape' && status === 'working') {
      event.preventDefault()
      void window.electronAPI.agentChatInterrupt?.(shellId)
    }
  }

  // The toggle key works anywhere in the cover (the app-wide handler skips text boxes)
  const onCoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (matchesBinding(event, toggleKeys)) {
      event.preventDefault()
      event.stopPropagation()
      onShowTerminal()
    }
  }

  const rows = Math.min(MAX_COMPOSER_ROWS, Math.max(1, draft.split('\n').length))
  const toggleLabel = shortcutLabel(toggleKeys)

  return (
    <div className="agent-chat-cover" role="region" aria-label="에이전트 채팅" onKeyDown={onCoverKeyDown}>
      <header className="agent-chat-head">
        {kind && ProviderIcon && (
          <span className="agent-chat-kind" data-kind={kind}>
            <ProviderIcon size={12} aria-hidden="true" />
            {AGENT_NAMES[kind]}
          </span>
        )}
        <span className="agent-chat-title" title={title}>{title}</span>
        {STATUS_LABELS[status] && (
          <span className="agent-chat-status" data-status={status}>
            {status === 'working' && <RiLoader4Line className="agent-chat-spin" aria-hidden />}
            {STATUS_LABELS[status]}
          </span>
        )}
        <button type="button" className="agent-chat-head-btn" onClick={onShowTerminal} title={`터미널 보기 (${toggleLabel})`}>
          <RiTerminalBoxLine aria-hidden /> 터미널
        </button>
      </header>
      <div className="agent-chat-log" ref={logRef} onScroll={onScroll} onClick={onLogClick}>
        {chat?.hasOlder && (
          <button type="button" className="agent-chat-older" onClick={() => loadOlder(shellId)} disabled={chat.loadingOlder}>
            {chat.loadingOlder ? '이전 대화 불러오는 중…' : '이전 대화 더 보기'}
          </button>
        )}
        {items.map(item => <ChatItem key={item.id} item={item} live={!isOver && item.id === lastToolId} />)}
        {chat?.state === 'opening' && <p className="agent-chat-empty">대화를 불러오는 중…</p>}
        {chat?.state === 'waiting' && !items.length && <p className="agent-chat-empty">대화가 시작되면 여기에 보입니다.</p>}
        {chat?.state === 'live' && !items.length && <p className="agent-chat-empty">아직 주고받은 말이 없습니다.</p>}
      </div>
      {chat?.approval && !isOver && <ApprovalCard shellId={shellId} approval={chat.approval} />}
      {status === 'blocked' && !isOver && !chat?.approval && (
        // A prompt the view cannot read as choices: answered in the terminal
        <div className="agent-chat-banner" role="status">
          에이전트가 확인을 기다리고 있습니다. 터미널에서 답해 주세요.
          <button type="button" onClick={onShowTerminal}>터미널 보기</button>
        </div>
      )}
      {isOver && (
        <div className="agent-chat-banner" role="status">
          {kind ? AGENT_NAMES[kind] : '에이전트'} 가 종료되었습니다.
          <button type="button" onClick={onShowTerminal}>터미널 보기</button>
        </div>
      )}
      {/* While a prompt waits the composer is hidden: the agent takes no line then (the draft is kept) */}
      {!isOver && !chat?.approval && (
        <div className="agent-chat-composer">
          {attachment && (
            <div className="agent-chat-attachments">
              <div className="agent-chat-attachment">
                <img src={attachment.url} alt="첨부한 스크린샷" />
                <button type="button" aria-label="이미지 첨부 제거" title="이미지 첨부 제거" disabled={sending || pasting}
                  onClick={() => {
                    window.electronAPI.agentChatRemoveImage?.(shellId, attachment.id)
                    setAttachment(null)
                    boxRef.current?.focus()
                  }}>
                  <RiCloseLine aria-hidden />
                </button>
              </div>
            </div>
          )}
          <textarea
            ref={boxRef}
            id={`agent-chat-input-${shellId}`}
            className="agent-chat-input"
            value={draft}
            rows={rows}
            placeholder={`${kind ? AGENT_NAMES[kind] : '에이전트'}에게 보내기 (Enter 보내기, Shift+Enter 줄바꿈)`}
            onChange={event => setDraft(event.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            aria-label="에이전트에게 보낼 글"
          />
          {status === 'working' && (
            <button type="button" className="agent-chat-stop" onClick={() => void window.electronAPI.agentChatInterrupt?.(shellId)} title="지금 작업 중지 (Esc)">
              <RiStopCircleLine aria-hidden /> 중지
            </button>
          )}
          <button type="button" className="agent-chat-send" onClick={() => void send()} disabled={(!draft.trim() && !attachment) || sending || pasting} title="보내기 (Enter)">
            {sending || pasting ? <RiLoader4Line className="agent-chat-spin" aria-hidden /> : <RiSendPlane2Line aria-hidden />}
          </button>
        </div>
      )}
      {linkMenu && (
        <TerminalContextMenu
          key={`${linkMenu.x}:${linkMenu.y}`}
          position={linkMenu}
          target={{ name: linkName(linkMenu.href, linkMenu.isFile), hint: linkMenu.isFile ? '이 PC' : '웹 주소', items: linkMenuItems(linkMenu) }}
          top={[]}
          groups={[]}
          onClose={() => setLinkMenu(null)}
        />
      )}
    </div>
  )
}
