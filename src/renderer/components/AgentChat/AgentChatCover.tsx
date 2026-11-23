// A local shell's Claude Code / Codex as a chat, drawn over its pane (docs/plan/2026-11-19-agent-chat-view.md).
// The shell and the agent keep running under it and the terminal stays mounted: this is only a view of
// the agent's transcript (src/agentChat) with a box that types into the agent's own composer.
import { memo, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type ToggleEvent } from 'react'
import { createPortal } from 'react-dom'
import { RiArrowDownLine, RiArrowUpLine, RiChat1Line, RiCheckboxBlankCircleLine, RiCheckboxCircleLine, RiCheckboxMultipleLine, RiClipboardLine, RiCloseLine, RiFileCopyLine, RiFileTextLine, RiFlashlightLine, RiFolderOpenLine, RiImageAddLine, RiListUnordered, RiLoader4Line, RiMailLine, RiNotification3Line, RiPushpinLine, RiSave3Line, RiSendPlane2Line, RiStopCircleLine, RiTerminalBoxLine, RiTimeLine, RiToolsLine } from 'react-icons/ri'
import type { AgentChatApproval, AgentChatBackgroundShells, AgentChatItem, AgentChatQuestion, AgentChatQuestionContext, CodexSpeedMode } from '../../types'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { chatLinesToTakeBack, draftWithTakenBack, takeBackQueued } from '../../lib/chatTakeBack'
import { chatImageReference, insertChatImages, resolveChatImages } from '../../lib/chatImageReferences'
import { openAgentMessages, useAgentMessagesStore, usePaneAgentMail } from '../Terminal/AgentMessages'
import { AGENT_PROVIDER_ICONS } from '../ui/agentProviderIcons'
import { useShortcutsStore } from '../../stores/shortcutsStore'
import { matchesBinding } from '../../lib/shortcutMatch'
import { LOCAL_PATH_LINK, renderChatMarkdown } from '../../lib/markdownRender'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { outputFileName } from '../../lib/terminalText'
import { TerminalContextMenu, type TerminalMenuGroup, type TerminalMenuItem } from '../Terminal/TerminalContextMenu'
import { webLinkItems } from '../Terminal/TerminalWebLinkMenu'
import { chatTextForClipboard, diffLineKind, sentImageKey, shellAgentOf, visibleSendTime, waitingItemIds, type SentChatImages } from '../../lib/agentChatItems'
import { turnUsageSpots, turnUsageText } from '../../lib/agentTurnUsage'
import { toast } from '../../stores/toastStore'
import { AgentChatSubagents } from './AgentChatSubagents'
import { AgentChatQuestions, receivedMessageLabel } from './AgentChatQuestions'
import { AgentChatThemePicker } from './AgentChatThemePicker'
import { SubagentConversation } from './SubagentConversation'
import { useChatWindow } from './useChatWindow'
import { isAwayFromBottom, isChatQuestion, previousQuestionIndex, questionLine } from '../../lib/chatScrollNav'
import { SlashCommandMenu } from './SlashCommandMenu'
import { AskQuestionCard, AskQuestionSummary } from './AskQuestionCard'
import { answerableAskItem, pendingAskItem } from '../../lib/askQuestion'
import { useAskQuestionStore } from '../../stores/askQuestionStore'
import { allSlashCommands, draftFor, isSlashCommand, matchSlashCommands, type SlashCommand } from '../../lib/slashCommands'
import { useAgentScreenReturnStore } from '../../stores/agentScreenReturnStore'
import type { ChatAppearance } from '../../themes/chatThemes'
import './AgentChat.css'
import './AgentChatThemes.css'

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' } as const
const CODEX_SPEEDS = [
  { id: 'fast', name: 'Fast' },
  { id: 'ultrafast', name: 'Ultrafast' }
] as const
const STATUS_LABELS: Record<string, string> = {
  working: '작업 중',
  starting: '시작 중',
  blocked: '응답 필요',
  sleeping: '잠듦',
  unknown: '',
  error: '오류',
  ended: '종료됨'
}
const REPLY_START_GRACE_MS = 6000
const EMPTY_ITEMS: AgentChatItem[] = []
const sendClock = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', hour12: true })

type TimelineRow = { key: string; estimate: number } & (
  | { kind: 'older' }
  | { kind: 'item'; item: AgentChatItem; sendTime: number | null; sentImages?: SentChatImages }
)

type DraftImage = { id: string; number: number; url: string; preview: Blob }

function estimateItem(item: AgentChatItem): number {
  if (item.kind === 'output') return Math.min(380, 24 + (item.text?.split('\n').length ?? 1) * 17)
  if (item.kind !== 'assistant') return item.kind === 'user' ? 44 : 32
  return Math.min(1000, 48 + Math.ceil((item.text?.length ?? 0) / 90) * 20)
}

// Links are handled by the cover (a menu to open them), so the answer itself only draws them
function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderChatMarkdown(text), [text])
  // eslint-disable-next-line react/no-danger -- inert HTML from markdownRender (html: false, links checked, no images)
  return <div className="agent-chat-md" dangerouslySetInnerHTML={{ __html: html }} />
}

interface LinkMenu {
  href: string
  isFile: boolean
}

interface ChatMenu {
  x: number
  y: number
  link?: LinkMenu
  context?: { selection: string; inComposer: boolean }
}

function answerLink(target: EventTarget): HTMLAnchorElement | null {
  const link = target instanceof Element ? target.closest('a') : null
  return link?.closest('.agent-chat-md') ? link : null
}

function linkMenuTarget(link: HTMLAnchorElement | null): LinkMenu | undefined {
  const href = link?.getAttribute('href')
  if (!href || href.startsWith('#') || /^mailto:/i.test(href)) return undefined
  return { href, isFile: LOCAL_PATH_LINK.test(href) }
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

function ToolCard({ tool, running, expanded, onToggle }: {
  tool: NonNullable<AgentChatItem['tool']>; running: boolean; expanded: boolean; onToggle: (event: ToggleEvent<HTMLDetailsElement>) => void
}) {
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
    <details className="agent-chat-tool" data-error={tool.isError ? 'true' : undefined} open={expanded} onToggle={onToggle}>
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

function BackgroundShells({ count, jobs }: AgentChatBackgroundShells) {
  const unknown = count - jobs.length
  return (
    <details className="agent-chat-background-shells">
      <summary>
        <RiTerminalBoxLine aria-hidden />
        <span role="status">Shell {count}개 실행 중</span>
        <RiArrowDownLine className="agent-chat-shell-chevron" aria-hidden />
      </summary>
      <div className="agent-chat-shell-jobs">
        {!!jobs.length && (
          <ul>
            {jobs.map(({ id, description, command }) => (
              <li key={id}>
                {description && <span>{description}</span>}
                {command && <code>{command}</code>}
              </li>
            ))}
          </ul>
        )}
        {unknown > 0 && <p>명령을 확인할 수 없는 Shell {unknown}개</p>}
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

function SentImageThumbnail({ preview, index }: { preview: Blob; index: number }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    const next = URL.createObjectURL(preview)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [preview])
  return (
    <span className="agent-chat-sent-image">
      <img src={url} alt={chatImageReference(index + 1)} />
      <span className="agent-chat-image-number" aria-hidden="true">{index + 1}</span>
    </span>
  )
}

const ChatItem = memo(function ChatItem({ item, sentImages, sendTime, live, waiting, onPin, expanded, rememberDisclosure }: {
  item: AgentChatItem; live: boolean; waiting?: 'queued' | 'input'; onPin?: (item: AgentChatItem) => void
  sentImages?: SentChatImages; sendTime: number | null; expanded: boolean; rememberDisclosure: (id: string, open: boolean) => void
}) {
  const itemTime = item.sentAt ?? item.time
  const time = itemTime === null ? undefined : new Date(itemTime).toLocaleTimeString()
  const onToggle = (event: ToggleEvent<HTMLDetailsElement>) => rememberDisclosure(item.id, event.currentTarget.open)
  switch (item.kind) {
    case 'user':
      return (
        <div className="agent-chat-user" title={time}>
          {sentImages && (
            <div className="agent-chat-sent-images" role="group" aria-label="보낸 이미지">
              {sentImages.previews.map((preview, index) => <SentImageThumbnail key={index} preview={preview} index={index} />)}
            </div>
          )}
          <div className="agent-chat-user-message">
            {sendTime !== null && <time className="agent-chat-sent-time" dateTime={new Date(sendTime).toISOString()}>{sendClock.format(sendTime)}</time>}
            <div className="agent-chat-bubble" data-waiting={waiting}>
              {sentImages ? sentImages.text || '스크린샷 첨부' : item.text ?? (item.hasImage ? '스크린샷 첨부' : '')}
            </div>
          </div>
          {/* Sent while the agent worked: it reads the message when it can, and the mark goes then */}
          {waiting && !item.commandState && (
            <div className="agent-chat-command-state agent-chat-waiting" role="status" data-input-needed={waiting === 'input' || undefined}
              title={waiting === 'input' ? '에이전트의 질문이나 승인 요청에 응답하면 메시지를 처리할 수 있습니다.' : '에이전트가 작업을 마치면 메시지를 읽습니다.'}>
              {waiting === 'input' ? <><RiChat1Line aria-hidden /> 응답 후 처리</> : <><RiTimeLine aria-hidden /> 대기 중…</>}
            </div>
          )}
          {/* A Codex slash command: no transcript records it, so what came of it shows here */}
          {item.commandState && (
            <div className="agent-chat-command-state">{item.commandState === 'screen' ? '터미널에 화면을 열었습니다' : '실행함'}</div>
          )}
        </div>
      )
    case 'output':
      return <pre className={`agent-chat-output${item.isError ? ' is-error' : ''}`} title={time} aria-label="명령 출력">{item.text}</pre>
    case 'assistant':
      return (
        <div className="agent-chat-assistant" title={time}>
          <Markdown text={item.text ?? ''} />
          {/* Pinned out into a small window, read while working in another tab */}
          {onPin && (
            <button type="button" className="agent-chat-pin" aria-label="이 답변 띄워 두기" onClick={() => onPin(item)}>
              <RiPushpinLine aria-hidden /> 띄워 두기
            </button>
          )}
        </div>
      )
    case 'thinking':
      return (
        <details className="agent-chat-thinking" open={expanded} onToggle={onToggle}>
          <summary>생각</summary>
          <div className="agent-chat-thinking-text">{item.text}</div>
        </details>
      )
    case 'tool':
      if (item.tool?.question) return <AskQuestionSummary tool={item.tool} />
      return item.tool ? <ToolCard tool={item.tool} running={live && item.tool.result === undefined && !item.tool.isError && !item.tool.diff}
        expanded={expanded} onToggle={onToggle} /> : null
    case 'notice':
      return <div className="agent-chat-notice" role="separator"><span>{item.text}</span></div>
    default:
      return null
  }
})

interface AgentChatCoverProps {
  shellId: string
  themeId: string | undefined
  appearance: ChatAppearance | undefined
  /** The speed controls share the usage row below the terminal stage. */
  usageActions: HTMLSpanElement | null
  /** The tab of the pane (the inbox opens from it) */
  tabId: string
  /** The same pane actions as in terminal mode, sized to the pane when the menu opens. */
  getSplitMenu: () => TerminalMenuGroup | null
  /** Back to the terminal (the pane focuses its xterm) */
  onShowTerminal: () => void
  onFocusQuestion: () => void
}

export function AgentChatCover({ shellId, themeId, appearance, usageActions, tabId, getSplitMenu, onShowTerminal, onFocusQuestion }: AgentChatCoverProps) {
  const chat = useAgentChatStore(state => state.chats.get(shellId))
  const loadOlder = useAgentChatStore(state => state.loadOlder)
  const agent = useAgentMessagesStore(state => shellAgentOf(state.snapshot.agents, shellId))
  const { agent: mailAgent, count: unreadMail } = usePaneAgentMail(shellId)
  const notificationLabel = unreadMail ? `읽지 않은 메시지 ${unreadMail}개` : '메시지 알림'
  const toggleKeys = useShortcutsStore(state => state.getEffectiveKeys('toggle-agent-chat'))
  const [draft, setDraft] = useState('')
  const [subagentId, setSubagentId] = useState<string | null>(null)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [questionContext, setQuestionContext] = useState<AgentChatQuestionContext | null>(null)
  const [selectedQuestion, setSelectedQuestion] = useState<{ question: AgentChatQuestion; scope: string | null } | null>(null)
  const [jump, setJump] = useState<{ id: string | null; scope: string | null } | null>(null)
  const questionRequest = useRef(0)
  const [attachments, setAttachments] = useState<DraftImage[]>([])
  const nextAttachmentNumber = useRef(0)
  const draftImages = useMemo(() => resolveChatImages(draft, attachments), [draft, attachments])
  const previewUrls = useRef(new Map<string, string>())
  const [pasting, setPasting] = useState(false)
  const [sending, setSending] = useState(false)
  const sendPending = useRef(false)
  const [stopping, setStopping] = useState(false)
  const stopPending = useRef(false)
  const restoredTurn = useRef<{ sentAt: number; text: string } | null>(null)
  const [changingSpeed, setChangingSpeed] = useState<CodexSpeedMode | null>(null)
  const speedPending = useRef(false)
  const pastePending = useRef(false)
  const workingReply = useRef<string | null>(null)
  const [menu, setMenu] = useState<ChatMenu | null>(null)
  const menuFocusOrigin = useRef<HTMLElement | null>(null)
  const [conversationAction, setConversationAction] = useState<'copy' | 'save' | null>(null)
  const coverRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const logContentRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const disclosures = useRef(new Set<string>())
  const rememberDisclosure = useCallback((id: string, open: boolean) => {
    if (open) disclosures.current.add(id)
    else disclosures.current.delete(id)
  }, [])

  const scope = chat?.scope ?? null
  const liveItems = chat?.items ?? EMPTY_ITEMS
  const history = questionContext?.scope === scope ? questionContext : null
  const items = history?.items ?? liveItems
  const sentImages = chat?.sentImages
  const chosenQuestion = selectedQuestion?.scope === scope ? selectedQuestion.question : null
  const highlighted = chosenQuestion && (chosenQuestion.itemId ?? chosenQuestion.id)
  const kind = chat?.kind ?? (agent?.kind === 'claude' || agent?.kind === 'codex' ? agent.kind : null)
  const subagent = chat?.approval?.usesTerminalInput ? undefined : chat?.subagents.find(child => child.id === subagentId)
  const ProviderIcon = kind ? AGENT_PROVIDER_ICONS[kind] : null
  const status = chat?.state === 'ended' ? 'ended' : chat?.approval ? 'blocked' : agent?.status ?? 'unknown'
  // Claude's AskUserQuestion: answered on the chat's own card while its dialog shows (and while the card's
  // answer is on its way: the dialog is out of reach meanwhile), unless it went to the terminal
  const askSending = useAskQuestionStore(state => state.sending.get(shellId))
  const askInTerminal = useAskQuestionStore(state => state.inTerminal.get(shellId))
  const setAskSending = useAskQuestionStore(state => state.setSending)
  const pendingAsk = useMemo(() => pendingAskItem(liveItems), [liveItems])
  const answerableAsk = useMemo(() => (chat?.state === 'ended' ? null : answerableAskItem(liveItems, chat?.approval ?? null)), [liveItems, chat?.approval, chat?.state])
  const askCard = answerableAsk && askInTerminal !== answerableAsk.id ? answerableAsk
    : askSending && pendingAsk?.id === askSending.itemId ? pendingAsk : null
  // Claude's question still waits but its dialog was not read off the screen (a layout not known): said
  // after a moment (the dialog closes a little before the answer is recorded), with the way to answer it
  const askUnread = pendingAsk && !askCard && !chat?.approval && chat?.state !== 'ended' ? pendingAsk.id : null
  const [unreadAskId, setUnreadAskId] = useState<string | null>(null)
  useEffect(() => {
    if (!askUnread) return
    const timer = setTimeout(() => setUnreadAskId(askUnread), 2000)
    return () => clearTimeout(timer)
  }, [askUnread])
  useEffect(() => {
    // Answered (the result came), or gone: the card's sending state ends with it
    if (askSending && pendingAsk?.id !== askSending.itemId) setAskSending(shellId, null)
  }, [askSending, pendingAsk, setAskSending, shellId])
  // The slash command list over the composer: the CLI's own commands, and the user's (read once, when first needed)
  const [customCommands, setCustomCommands] = useState<SlashCommand[] | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashClosedFor, setSlashClosedFor] = useState<string | null>(null)
  const slashTyping = draft.startsWith('/') && !draftImages.images.length
  useEffect(() => {
    if (!slashTyping || customCommands || !window.electronAPI.agentChatSlashCommands) return
    let live = true
    window.electronAPI.agentChatSlashCommands(shellId)
      .then(list => { if (live) setCustomCommands(list) })
      .catch(() => { if (live) setCustomCommands([]) })
    return () => { live = false }
  }, [customCommands, shellId, slashTyping])
  const slashMatches = useMemo(() => {
    if (!kind || !slashTyping || slashClosedFor === draft) return null
    const matches = matchSlashCommands(draft, allSlashCommands(kind, customCommands ?? []))
    return matches?.length ? matches : null
  }, [customCommands, draft, kind, slashClosedFor, slashTyping])
  useEffect(() => { setSlashIndex(0) }, [draft])
  const isOver = chat?.state === 'ended' || !agent
  const replyId = chat?.reply?.sendId
  const canReply = !isOver && status !== 'blocked' && status !== 'error'
  const canStop = canReply && (status === 'working' || Boolean(replyId))
  const canToggleSpeed = canReply && !stopping && !replyId && status !== 'working' && status !== 'starting'
  const speed = chat?.codexSpeed?.speed ?? null
  // Sent while the agent was busy and not read yet: the CLI holds it (Claude reads it at its next step,
  // Codex when its turn ends), so the bubble says it waits and the progress line is about the work before it
  const waiting = useMemo(() => waitingItemIds(liveItems, chat?.echoes ?? [], chat?.held ?? [], status),
    [liveItems, chat?.echoes, chat?.held, status])
  // The reply waits on the echo first, then on the transcript item that replaced it
  const replyWaiting = Boolean(replyId && (waiting.has(replyId) || (chat?.reply && waiting.has(chat.reply.itemId))))
  let progressLabel: string | null = null
  if (canReply) {
    if (stopping) progressLabel = '중지하는 중…'
    else if (sending) progressLabel = '보내는 중…'
    else if (replyId) progressLabel = replyWaiting ? '앞 작업 진행 중…' : '답변 생성 중…'
    else if (status === 'working') progressLabel = '작업 중…'
  }
  const title = chat?.title ?? liveItems.find(item => item.kind === 'user')?.text?.split('\n')[0] ?? '대화'
  const lastToolId = useMemo(() => [...items].reverse().find(item => item.kind === 'tool')?.id, [items])
  // The tokens each question used, at the end of its turn
  const usageSpots = useMemo(() => turnUsageSpots(items), [items])
  const showOlder = !history && Boolean(chat?.hasOlder)
  const showSendTime = Boolean(appearance && themeId === 'chat-kakao')
  const timeline = useMemo(() => {
    const rows: TimelineRow[] = []
    if (showOlder) rows.push({ kind: 'older', key: 'older', estimate: 26 })
    items.forEach((item, index) => {
      const sendTime = showSendTime ? visibleSendTime(item, items[index + 1]) : null
      const images = item.kind === 'user' ? sentImages?.get(sentImageKey(item)) : undefined
      const estimate = estimateItem(item) + (images ? 84 : 0) + (usageSpots.has(item.id) ? 28 : 0)
      rows.push({ kind: 'item', key: `item:${item.id}`, estimate, item, sendTime, sentImages: images })
    })
    return rows
  }, [items, sentImages, showOlder, showSendTime, usageSpots])
  const { virtualizer, followAfterSend, rememberFocus, selectAll: selectChatLog } = useChatWindow(timeline, logRef, items.length > 0)
  // The bar over the top goes to the question before what is on screen; the button over the bottom goes back down
  const questionRows = useMemo(() => timeline.flatMap((row, index) => row.kind === 'item' && isChatQuestion(row.item) ? [index] : []), [timeline])
  const [scrollNav, setScrollNav] = useState<{ previous: number | null; away: boolean; fresh: boolean }>({ previous: null, away: false, fresh: false })
  const seenItems = useRef(0)
  const updateScrollNav = useCallback(() => {
    const log = logRef.current
    if (!log) return
    const rows = virtualizer.measurementsCache
    const previous = previousQuestionIndex(questionRows.map(index => ({ index, start: rows[index]?.start ?? Infinity })), log.scrollTop)
    const away = isAwayFromBottom(log.scrollTop, log.clientHeight, log.scrollHeight)
    if (!away) seenItems.current = items.length
    const fresh = away && items.length > seenItems.current
    setScrollNav(current => current.previous === previous && current.away === away && current.fresh === fresh ? current : { previous, away, fresh })
  }, [items.length, questionRows, virtualizer])
  useEffect(() => { updateScrollNav() }, [timeline, updateScrollNav])
  const updateNavAfterLayout = useEffectEvent(updateScrollNav)
  const hasRows = timeline.length > 0
  useLayoutEffect(() => {
    const log = logRef.current
    if (!log) return
    // A new viewport or a measured row can change the distance to the end without a scroll event.
    const observer = new ResizeObserver(() => updateNavAfterLayout())
    observer.observe(log)
    if (logContentRef.current) observer.observe(logContentRef.current)
    return () => observer.disconnect()
  }, [hasRows])
  const previousQuestion = scrollNav.previous === null ? null : timeline[scrollNav.previous]

  useLayoutEffect(() => {
    if (!jump || jump.scope !== scope) return
    if (jump.id === null) virtualizer.scrollToEnd()
    else {
      const index = timeline.findIndex(row => row.key === `item:${jump.id}`)
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'start' })
    }
    setJump(null)
  }, [jump, scope, timeline, virtualizer])

  const dismissQuestions = () => {
    questionRequest.current++
    setQuestionsOpen(false)
    const target = boxRef.current ?? coverRef.current
    target?.focus({ preventScroll: true })
  }

  const resetQuestionPosition = () => {
    questionRequest.current++
    setQuestionsOpen(false)
    setQuestionContext(null)
    setSelectedQuestion(null)
    setJump(null)
  }

  const jumpToQuestion = async (question: AgentChatQuestion) => {
    const { id, itemId } = question
    const target = itemId ?? id
    const request = ++questionRequest.current
    if (liveItems.some(item => item.id === target && (!itemId || item.tool?.result !== undefined))) {
      setQuestionContext(null)
    } else if (!history?.items.some(item => item.id === target)) {
      const read = window.electronAPI.agentChatQuestionContext
      if (!scope || !read) return
      const result = await read({ shellId, scope, id }).catch(() => null)
      if (!coverRef.current || request !== questionRequest.current || useAgentChatStore.getState().chats.get(shellId)?.scope !== scope) return
      if (!result?.ok) {
        toast.error('질문으로 이동하지 못했습니다', result?.error ?? '대화 기록을 읽을 수 없습니다.')
        return
      }
      setQuestionContext(result)
    }
    dismissQuestions()
    setSelectedQuestion({ question, scope })
    setJump({ id: target, scope })
  }

  useEffect(() => {
    if (history || !disclosures.current.size) return
    const ids = new Set(items.map(item => item.id))
    for (const id of disclosures.current) if (!ids.has(id)) disclosures.current.delete(id)
  }, [history, items])

  useEffect(() => {
    const timer = window.setTimeout(() => boxRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [])
  const releaseAttachment = useCallback((id: string) => {
    const url = previewUrls.current.get(id)
    if (url) URL.revokeObjectURL(url)
    previewUrls.current.delete(id)
    window.electronAPI.agentChatRemoveImage?.(shellId, id)
  }, [shellId])
  useEffect(() => {
    const urls = previewUrls.current
    return () => {
      for (const id of urls.keys()) releaseAttachment(id)
    }
  }, [releaseAttachment])
  useEffect(() => {
    if (!isOver || !attachments.length) return
    for (const { id } of attachments) releaseAttachment(id)
    setAttachments([])
  }, [isOver, attachments, releaseAttachment])

  useEffect(() => {
    if (!replyId) return
    const done = () => useAgentChatStore.getState().stopWaiting(shellId, replyId)
    if (!canReply) return done()
    if (status === 'working') {
      workingReply.current = replyId
      return
    }
    if (sending || status === 'starting') return
    if (status === 'idle' && workingReply.current === replyId) return done()
    // Allow the CLI's status to catch up after the PTY acknowledges the input.
    const timer = window.setTimeout(done, REPLY_START_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [canReply, replyId, sending, shellId, status])

  // A link in an answer opens a menu (it never navigates the app window): a file or folder of this PC
  // in ezShell or the file manager, a web page in the browser. Main opens only links of this conversation.
  const onLogClick = (event: MouseEvent<HTMLDivElement>) => {
    const link = answerLink(event.target)
    if (!link) return
    event.preventDefault()
    const target = linkMenuTarget(link)
    if (target) {
      menuFocusOrigin.current = null
      setMenu({ x: event.clientX, y: event.clientY, link: target })
    }
  }

  const showContextMenu = (target: EventTarget, x: number, y: number, keyboardFocus?: HTMLElement) => {
    const box = boxRef.current
    const inComposer = box !== null && target === box
    const range = window.getSelection()
    const insideChat = coverRef.current?.contains(range?.anchorNode ?? null) && coverRef.current.contains(range?.focusNode ?? null)
    const selection = inComposer ? box.value.slice(box.selectionStart, box.selectionEnd) : insideChat ? range?.toString() ?? '' : ''
    menuFocusOrigin.current = keyboardFocus ?? (inComposer ? box : null)
    setMenu({
      x, y,
      link: linkMenuTarget(answerLink(target)),
      context: { selection, inComposer }
    })
  }

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    showContextMenu(event.target, event.clientX, event.clientY)
  }

  const exportConversation = async (action: 'copy' | 'save') => {
    const read = window.electronAPI.agentChatCopy
    const save = window.electronAPI.saveExportFile
    if (!read || !chat || conversationAction || (action === 'save' && !save)) return
    const failure = action === 'copy' ? '복사 실패' : '저장 실패'
    setConversationAction(action)
    try {
      const result = await read(shellId)
      if (!coverRef.current) return
      if (!result.ok) {
        toast.error(failure, result.error)
        return
      }
      const text = chatTextForClipboard(result.items, chat.items, chat.echoes, kind ? AGENT_NAMES[kind] : '에이전트')
      if (!text) {
        toast.info(action === 'copy' ? '복사할 대화가 없습니다' : '저장할 대화가 없습니다')
      } else if (action === 'copy') {
        if (!(await copyToClipboard(text))) toast.error(failure, '클립보드에 접근할 수 없습니다.')
      } else if (save) {
        const saved = await save(outputFileName(title, new Date()), 'txt', text, 'agent-chat')
        if (saved.success) toast.success('채팅을 저장했습니다', saved.filePath)
        else if (!saved.cancelled) toast.error(failure, saved.error)
      }
    } catch {
      if (coverRef.current) toast.error(failure, '대화 기록을 처리할 수 없습니다.')
    } finally {
      setConversationAction(null)
    }
  }

  const openLink = async (href: string, how: 'app' | 'explorer' | 'browser' | 'browser-tab') => {
    try {
      const result = await window.electronAPI.agentChatOpenLink?.(shellId, href, how)
      if (!result?.ok) toast.error('열지 못했습니다', result && !result.ok ? result.error : '이 앱 버전에서는 쓸 수 없습니다.')
    } catch {
      toast.error('열지 못했습니다', '링크를 열 수 없습니다.')
    }
  }

  const linkMenuItems = (menu: LinkMenu) => menu.isFile
    ? [
        { label: 'ezShell 에서 열기', icon: RiFileTextLine, onSelect: () => void openLink(menu.href, 'app') },
        { label: '파일 탐색기에서 열기', icon: RiFolderOpenLine, onSelect: () => void openLink(menu.href, 'explorer') },
        { label: '경로 복사', icon: RiFileCopyLine, onSelect: () => void copyToClipboard(menu.href) }
      ]
    : webLinkItems(menu.href, destination => void openLink(menu.href, destination === 'internal' ? 'browser-tab' : 'browser'))

  const pinReply = useCallback(async (item: AgentChatItem) => {
    const pin = window.electronAPI.agentChatPin
    if (!pin) return
    try {
      const result = await pin({ shellId, itemId: item.id, text: item.text ?? '', kind, title, time: item.time })
      if (!result.ok) toast.error('띄우지 못했습니다', result.error)
    } catch {
      toast.error('띄우지 못했습니다', '답변 창을 열 수 없습니다.')
    }
  }, [kind, shellId, title])

  const onScroll = () => {
    const log = logRef.current
    if (!log) return
    if (log.scrollTop < 80 && showOlder) loadOlder(shellId)
    updateScrollNav()
  }

  const goToBottom = () => {
    if (history) {
      resetQuestionPosition()
      setJump({ id: null, scope })
    } else virtualizer.scrollToEnd()
  }

  const placeDraft = (box: HTMLTextAreaElement, text: string, caret: number) => {
    box.value = text
    box.setSelectionRange(caret, caret)
    setDraft(text)
  }

  const removeDraftImage = (image: DraftImage) => {
    const reference = chatImageReference(image.number)
    releaseAttachment(image.id)
    setAttachments(current => current.filter(attachment => attachment.id !== image.id))
    const box = boxRef.current
    if (!box) return
    const withoutReference = (value: string) => value.split(reference + ' ').join('').split(reference).join('')
    const text = withoutReference(box.value)
    const caret = withoutReference(box.value.slice(0, box.selectionStart)).length
    placeDraft(box, text.trim() ? text : '', caret)
    box.focus()
  }

  const readIntoDraft = async (box: HTMLTextAreaElement, source: 'clipboard' | 'files') => {
    const read = source === 'clipboard'
      ? window.electronAPI.agentChatReadClipboard
      : window.electronAPI.agentChatPickImages
    if (!read || pastePending.current || sendPending.current) return
    const errorTitle = source === 'clipboard' ? '붙여넣기 실패' : '이미지 첨부 실패'
    const { value: original, selectionStart, selectionEnd } = box
    // Keep cut references available for text paste. Reclaim unused files when adding more images.
    const reclaimUnused = () => {
      const used = new Set(resolveChatImages(box.value, attachments).images)
      if (used.size === attachments.length) return false
      for (const image of attachments) if (!used.has(image)) releaseAttachment(image.id)
      setAttachments(current => current.filter(image => used.has(image)))
      return true
    }
    if (source === 'files') reclaimUnused()
    if (!attachments.length) nextAttachmentNumber.current = 0
    pastePending.current = true
    setPasting(true)
    try {
      let result = await read(shellId)
      if (!result.ok && source === 'clipboard' && boxRef.current === box && attachments.length && reclaimUnused()) {
        result = await read(shellId)
      }
      if (boxRef.current !== box) {
        if (result.ok && result.kind === 'images') {
          for (const { id } of result.images) releaseAttachment(id)
        }
        return
      }
      if (!result.ok) {
        toast.error(errorTitle, result.error)
        return
      }
      const added = result.kind === 'images' ? result.images.map(({ id, preview }) => {
        const image = new Blob([preview], { type: 'image/png' })
        const url = URL.createObjectURL(image)
        previewUrls.current.set(id, url)
        return { id, number: ++nextAttachmentNumber.current, url, preview: image }
      }) : []
      const text = result.text?.replace(/\r\n?/g, '\n') ?? ''
      const value = box.value
      if (added.length) {
        const before = original.slice(0, selectionStart)
        const after = original.slice(selectionEnd)
        // If text was entered while reading the clipboard, the image still precedes those keystrokes.
        const typedAtCaret = value.startsWith(before) && value.endsWith(after) && value.length >= before.length + after.length
        const start = value === original || typedAtCaret ? selectionStart : box.selectionStart
        const end = value === original ? selectionEnd : typedAtCaret ? start : box.selectionEnd
        const inserted = insertChatImages(value, start, end, added, text)
        const caret = typedAtCaret && value !== original && box.selectionStart >= start
          ? box.selectionStart + inserted.caret - start : inserted.caret
        setAttachments(current => [...current, ...added])
        placeDraft(box, inserted.text, caret)
      } else if (text) {
        const start = box.selectionStart
        placeDraft(box, value.slice(0, start) + text + value.slice(box.selectionEnd), start + text.length)
      }
    } catch {
      if (boxRef.current === box) toast.error(errorTitle, '첨부할 내용을 읽을 수 없습니다.')
    } finally {
      pastePending.current = false
      setPasting(false)
      if (source === 'files' && boxRef.current === box) box.focus()
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!window.electronAPI.agentChatReadClipboard
      || !Array.from(event.clipboardData.items).some(item => item.type.startsWith('image/'))) return
    event.preventDefault()
    void readIntoDraft(event.currentTarget, 'clipboard')
  }

  /** After a slash command went: Codex's line gets what came of it; a screen hands the pane to the terminal */
  const watchCommand = async (sendId: string) => {
    const result = await window.electronAPI.agentChatCommandWatch?.(shellId).catch(() => null)
    if (!result?.ok) return
    if (kind === 'codex' && (result.state === 'done' || result.state === 'screen')) {
      useAgentChatStore.getState().settleCommand(shellId, sendId, { state: result.state, output: result.output })
    }
    if (result.state === 'screen' && useAgentChatStore.getState().chats.has(shellId)) {
      useAgentScreenReturnStore.getState().begin(shellId)
      onShowTerminal()
    }
  }

  const send = async (override?: string) => {
    const { text, images } = override === undefined ? draftImages : resolveChatImages(override, attachments)
    if (!chat || (!text && !images.length) || sendPending.current || stopPending.current || speedPending.current || pastePending.current || isOver) return
    sendPending.current = true
    resetQuestionPosition()
    followAfterSend()
    setSending(true)
    setDraft('')
    const { echoSend, discardSend } = useAgentChatStore.getState()
    const sendId = echoSend(shellId, text, images.map(image => image.preview), status === 'working')
    try {
      const result = await window.electronAPI.agentChatSend?.(shellId, text, images.map(image => image.id))
      if (result?.ok) {
        if (!images.length && isSlashCommand(text)) void watchCommand(sendId)
        for (const { id } of attachments) releaseAttachment(id)
        setAttachments([])
        nextAttachmentNumber.current = 0
      } else {
        discardSend(shellId, sendId)
        setDraft(draft)
        if (result?.reason !== 'interrupted') {
          toast.error('보내지 못했습니다', result && !result.ok ? result.error : '이 앱 버전에서는 쓸 수 없습니다.')
        }
      }
    } catch {
      discardSend(shellId, sendId)
      setDraft(draft)
      toast.error('보내지 못했습니다', '에이전트에 연결할 수 없습니다.')
    } finally {
      sendPending.current = false
      setSending(false)
      boxRef.current?.focus()
    }
  }

  const stop = async () => {
    const snapshot = useAgentChatStore.getState().chats.get(shellId)
    if (!snapshot || !canStop || stopPending.current) return
    const { queued, lines } = chatLinesToTakeBack(snapshot.items, snapshot.echoes, snapshot.held)
    const lastRestored = restoredTurn.current
    const candidates = queued ? lines : lines.filter(line =>
      line.sentAt !== lastRestored?.sentAt || line.text !== lastRestored.text)
    const currentChat = () => {
      const current = useAgentChatStore.getState().chats.get(shellId)
      return coverRef.current && current && (snapshot.scope === null || current.scope === snapshot.scope) ? current : null
    }
    stopPending.current = true
    setStopping(true)
    try {
      if (!await window.electronAPI.agentChatInterrupt?.(shellId)) return
      if (snapshot.reply) useAgentChatStore.getState().stopWaiting(shellId, snapshot.reply.sendId)
      if (!candidates.length) return
      const takeBack = window.electronAPI.agentChatTakeBack
      const cleared = takeBack ? await takeBackQueued(
        list => currentChat() ? takeBack(shellId, list) : Promise.resolve({ ok: false, reason: 'not-agent' }),
        candidates.map(line => line.text)
      ) : false
      if (queued && !cleared) return

      const current = currentChat()
      if (!current) return
      // An unsubmitted send handles its own draft when cancelled. A recorded question stays in history.
      const restored = candidates.filter(line => current.items.some(item =>
        item.id === line.id || (item.sentAt === line.sentAt && item.text === line.text)))
      if (!restored.length) return
      if (cleared) {
        const { discardSend } = useAgentChatStore.getState()
        for (const line of restored) if (line.optimistic) discardSend(shellId, line.id)
      }
      if (!queued) restoredTurn.current = restored[0]
      setDraft(draft => draftWithTakenBack(restored.map(line => line.text), draft))
      boxRef.current?.focus()
    } catch {
      toast.error('중지하지 못했습니다', '에이전트에 연결할 수 없습니다.')
    } finally {
      stopPending.current = false
      setStopping(false)
    }
  }

  const toggleSpeed = async (target: CodexSpeedMode) => {
    const toggle = window.electronAPI.agentChatToggleSpeed
    if (!toggle || !canToggleSpeed || speedPending.current || sendPending.current || pastePending.current) return
    speedPending.current = true
    setChangingSpeed(target)
    try {
      const result = await toggle(shellId, target)
      if (!result.ok) toast.error('속도 모드 전환 실패', result.error)
    } catch {
      toast.error('속도 모드 전환 실패', 'Codex에 연결할 수 없습니다.')
    } finally {
      speedPending.current = false
      setChangingSpeed(null)
    }
  }

  /** A command picked from the list: one that takes a value waits for it, the others go at once */
  const pickCommand = (command: SlashCommand) => {
    if (command.args) setDraft(draftFor(command))
    else void send(command.name)
    boxRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Korean input: Enter that ends a composition is not a send
    if (event.nativeEvent.isComposing) return
    if (slashMatches && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const plain = !event.shiftKey
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setSlashIndex(index => (index + step + slashMatches.length) % slashMatches.length)
        return
      }
      const picked = slashMatches[Math.min(slashIndex, slashMatches.length - 1)]
      if (event.key === 'Tab' && plain) {
        event.preventDefault()
        setDraft(draftFor(picked))
        return
      }
      if (event.key === 'Enter' && plain) {
        event.preventDefault()
        pickCommand(picked)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setSlashClosedFor(draft)
        return
      }
    }
    if (window.electronAPI.agentChatReadClipboard && matchesBinding(event, ['Ctrl', 'V'])) {
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) void readIntoDraft(event.currentTarget, 'clipboard')
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      void send()
    }
  }

  // The toggle key works anywhere in the cover (the app-wide handler skips text boxes)
  const onCoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target
    if (!event.defaultPrevented && !event.nativeEvent.isComposing && !subagent && !menu
      && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
      && !event.ctrlKey && !event.altKey && !event.metaKey && target instanceof HTMLElement
      && !target.closest('.agent-chat-questions')) {
      event.preventDefault()
      event.stopPropagation()
      const rect = target.getBoundingClientRect()
      showContextMenu(target, rect.left + Math.min(rect.width / 2, 16), rect.bottom, target)
    } else if (matchesBinding(event, toggleKeys)) {
      event.preventDefault()
      event.stopPropagation()
      onShowTerminal()
    } else if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.key === 'Escape'
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !subagent && !menu && canStop) {
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) void stop()
    }
  }

  const contextItems: TerminalMenuItem[] = []
  const contextGroups: TerminalMenuGroup[] = []
  if (menu?.context) {
    const { selection, inComposer } = menu.context
    const canEditDraft = canReply && !sending && !pasting && !changingSpeed && Boolean(boxRef.current)
    const canExport = Boolean(chat && window.electronAPI.agentChatCopy && !conversationAction)
    const readDraftFromMenu = (source: 'clipboard' | 'files') => {
      const box = boxRef.current
      if (!canEditDraft || !box) return
      void readIntoDraft(box, source)
      window.setTimeout(() => boxRef.current?.focus({ preventScroll: true }), 0)
    }
    const selectAll = () => {
      if (inComposer) {
        boxRef.current?.select()
        return
      }
      selectChatLog()
    }
    contextItems.push(
      { label: '복사', icon: RiFileCopyLine, disabled: !selection, onSelect: () => void copyToClipboard(selection) },
      {
        label: '붙여넣기', icon: RiClipboardLine, disabled: !canEditDraft || !window.electronAPI.agentChatReadClipboard,
        onSelect: () => readDraftFromMenu('clipboard')
      },
      { label: '모두 선택', icon: RiCheckboxMultipleLine, disabled: inComposer ? !draft : !items.length, onSelect: selectAll },
      {
        label: conversationAction === 'copy' ? '채팅 복사 중…' : '채팅 전체 복사',
        icon: RiFileCopyLine, disabled: !canExport,
        onSelect: () => void exportConversation('copy')
      },
      { label: '채팅 닫고 터미널로 전환', icon: RiTerminalBoxLine, onSelect: onShowTerminal },
      {
        label: unreadMail > 0 ? `메시지 (${unreadMail})` : '메시지',
        icon: RiMailLine, disabled: !mailAgent,
        onSelect: () => {
          if (!mailAgent) return
          menuFocusOrigin.current = null
          openAgentMessages(mailAgent.id, tabId)
        }
      },
      {
        label: questionsOpen ? '질문 목록 닫기' : '질문 목록', icon: RiListUnordered,
        onSelect: () => {
          menuFocusOrigin.current = null
          if (questionsOpen) dismissQuestions()
          else setQuestionsOpen(true)
        }
      }
    )
    const split = getSplitMenu()
    if (split) contextGroups.push(split)
    contextGroups.push({
      label: '편의',
      icon: RiToolsLine,
      items: [
        {
          label: conversationAction === 'save' ? '채팅 저장 중…' : '채팅을 파일로 저장…',
          icon: RiSave3Line, disabled: !canExport || !window.electronAPI.saveExportFile,
          onSelect: () => void exportConversation('save')
        },
        {
          label: '이미지 첨부…', icon: RiImageAddLine, disabled: !canEditDraft || !window.electronAPI.agentChatPickImages,
          onSelect: () => readDraftFromMenu('files')
        }
      ]
    })
  }

  return (
    <div className="agent-chat-cover" ref={coverRef} tabIndex={-1} role="region" aria-label="에이전트 채팅"
      data-chat-theme={appearance ? themeId : undefined} data-chat-bubbles={appearance?.bubbles || undefined} style={appearance?.style}
      onKeyDown={onCoverKeyDown} onContextMenu={onContextMenu}>
      <div className="agent-chat-parent" inert={Boolean(subagent)}>
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
        {mailAgent && (
          <span className="agent-chat-notification" role="img" title={notificationLabel} aria-label={notificationLabel} data-unread={unreadMail > 0}>
            <RiNotification3Line size={15} aria-hidden="true" />
            {unreadMail > 0 && <span className="agent-mail-count" aria-hidden="true">{unreadMail > 99 ? '99+' : unreadMail}</span>}
          </span>
        )}
        <AgentChatThemePicker toolbar menuStyle={appearance?.style} />
      </header>
      {usageActions && !subagent && kind === 'codex' && createPortal(
        CODEX_SPEEDS.filter(({ id }) => id === 'fast' || chat?.codexSpeed?.ultrafastAvailable).map(({ id, name }) => {
          const active = speed === null ? undefined : speed === id
          return (
            <button key={id} type="button" className="agent-usage-speed" data-speed={id}
              aria-label={`Codex ${name} 모드`} aria-pressed={active}
              title={`Codex ${name} 모드 · ${active === undefined ? '상태 미확인' : active ? '켜짐' : '꺼짐'}`}
              disabled={!canToggleSpeed || Boolean(changingSpeed) || sending || pasting} onClick={() => void toggleSpeed(id)}>
              {changingSpeed === id ? <RiLoader4Line size={11} className="agent-chat-spin" aria-hidden /> : <RiFlashlightLine size={11} aria-hidden />}
              {name.toUpperCase()}
            </button>
          )
        }), usageActions
      )}
      {questionsOpen && <AgentChatQuestions key={scope ?? 'waiting'} shellId={shellId} scope={scope}
        items={liveItems} onPick={question => void jumpToQuestion(question)} onDismiss={dismissQuestions} />}
      {highlighted && <div className="agent-chat-question-location">
        {history && <span>{chosenQuestion?.sender ? '받은 메시지 주변 대화' : '선택한 질문 주변 대화'}</span>}
        <button type="button" className="agent-chat-head-btn" onClick={() => {
          resetQuestionPosition()
          setJump({ id: null, scope })
        }}><RiArrowDownLine aria-hidden /> 최신 대화</button>
      </div>}
      {chat && chat.subagents.length > 0 && <AgentChatSubagents key={shellId} shellId={shellId} kind={kind} agents={chat.subagents}
        live={chat.state === 'live'} onOpen={setSubagentId} themeStyle={appearance?.style} />}
      <div className="agent-chat-log" ref={logRef} onScroll={onScroll} onClick={onLogClick}
        onFocus={event => rememberFocus(event.target)} onBlur={event => rememberFocus(event.relatedTarget)}
        onTouchStart={() => virtualizer.cancelScroll()}>
        {previousQuestion?.kind === 'item' && (
          <div className="agent-chat-scroll-control is-top">
            <button type="button" className="agent-chat-jump-question" title="이 질문으로 이동"
              onClick={() => virtualizer.scrollToIndex(scrollNav.previous ?? 0, { align: 'start' })}>
              <RiArrowUpLine aria-hidden />
              <span className="agent-chat-jump-question-label">이전 질문</span>
              <span className="agent-chat-jump-question-text">{questionLine(previousQuestion.item)}</span>
            </button>
          </div>
        )}
        {hasRows && (
          <div ref={logContentRef} className="agent-chat-window" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map(row => {
              const entry = timeline[row.index]
              const item = entry.kind === 'item' ? entry.item : null
              const usage = item ? usageSpots.get(item.id) : undefined
              const line = usage ? turnUsageText(usage) : null
              return (
                <div className="agent-chat-row" key={entry.key} data-chat-row={entry.key} data-index={row.index}
                  data-question-target={highlighted !== null && item?.id === highlighted ? '' : undefined}
                  ref={virtualizer.measureElement} style={{ top: row.start }}>
                  {entry.kind === 'older' && (
                    <button type="button" className="agent-chat-older" onClick={() => loadOlder(shellId)} disabled={chat?.loadingOlder}>
                      {chat?.loadingOlder ? '이전 대화 불러오는 중…' : '이전 대화 더 보기'}
                    </button>
                  )}
                  {item && item.id === highlighted && chosenQuestion?.sender && (
                    <div className="agent-chat-bubble agent-chat-received-message">
                      <span className="agent-chat-question-sender">{receivedMessageLabel(chosenQuestion.sender, chosenQuestion.isReply)}</span>
                      <div>{chosenQuestion.text}</div>
                    </div>
                  )}
                  {entry.kind === 'item' && <ChatItem item={entry.item} sentImages={entry.sentImages} sendTime={entry.sendTime} live={!history && !isOver && entry.item.id === lastToolId}
                    waiting={!history && waiting.has(entry.item.id) ? (status === 'blocked' ? 'input' : 'queued') : undefined}
                    expanded={disclosures.current.has(entry.item.id)} rememberDisclosure={rememberDisclosure}
                    onPin={window.electronAPI.agentChatPin ? pinReply : undefined} />}
                  {line && <p className="agent-chat-usage" title={line.title}>{line.text}</p>}
                </div>
              )
            })}
          </div>
        )}
        {chat?.state === 'opening' && !items.length && <p className="agent-chat-empty">대화를 불러오는 중…</p>}
        {chat?.state === 'waiting' && !items.length && <p className="agent-chat-empty">대화가 시작되면 여기에 보입니다.</p>}
        {chat?.state === 'live' && !items.length && <p className="agent-chat-empty">아직 주고받은 말이 없습니다.</p>}
        {scrollNav.away && (
          <div className="agent-chat-scroll-control is-bottom">
            <button type="button" className="agent-chat-jump-bottom" data-fresh={scrollNav.fresh || undefined}
              title={history ? '최신 대화로 이동' : '대화 맨 아래로 이동'} onClick={goToBottom}>
              {scrollNav.fresh && <span className="agent-chat-jump-dot" aria-hidden />}
              <RiArrowDownLine aria-hidden /> {scrollNav.fresh ? '새 내용 · 맨 아래로' : '맨 아래로'}
            </button>
          </div>
        )}
      </div>
      {!isOver && chat?.backgroundShells && <BackgroundShells {...chat.backgroundShells} />}
      {askCard && !isOver && <AskQuestionCard shellId={shellId} item={askCard} onTerminal={() => requestAnimationFrame(onFocusQuestion)} />}
      {chat?.approval && !askCard && !isOver && (chat.approval.usesTerminalInput ? (
        <div className="agent-chat-approval agent-chat-inline-question">
          <div role="status">
            <div className="agent-chat-approval-state">답변 대기 중</div>
            {chat.approval.question && <div className="agent-chat-approval-question">{chat.approval.question}</div>}
          </div>
          <button type="button" className="agent-chat-head-btn" onClick={onFocusQuestion}>질문에 답하기</button>
        </div>
      ) : <ApprovalCard shellId={shellId} approval={chat.approval} />)}
      {askUnread && unreadAskId === askUnread && status !== 'blocked' && !isOver && (
        <div className="agent-chat-banner" role="status">
          Claude 가 질문의 답을 기다리고 있습니다. 이 질문 화면은 채팅에서 읽지 못해 터미널에서 답해 주세요.
          <button type="button" onClick={onShowTerminal}>터미널에서 답하기</button>
        </div>
      )}
      {status === 'blocked' && !isOver && !chat?.approval && !askCard && (
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
      {!isOver && !chat?.approval && !askCard && (
        <div className="agent-chat-composer">
          {progressLabel && <p className="agent-chat-reply-progress" role="status">
            <RiLoader4Line className="agent-chat-spin" aria-hidden />{progressLabel}
          </p>}
          {!!draftImages.images.length && (
            <div className="agent-chat-attachments" role="group" aria-label="첨부 이미지">
              {draftImages.images.map(image => (
                <div key={image.id} className="agent-chat-attachment">
                  <img src={image.url} alt={chatImageReference(image.number)} />
                  <span className="agent-chat-image-number" aria-hidden="true">{image.number}</span>
                  <button type="button" aria-label={`이미지 ${image.number} 첨부 제거`} title="이미지 첨부 제거" disabled={sending || pasting}
                    onClick={() => removeDraftImage(image)}>
                    <RiCloseLine aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          )}
          {slashMatches && (
            <SlashCommandMenu id={`agent-chat-slash-${shellId}`} commands={slashMatches} active={Math.min(slashIndex, slashMatches.length - 1)}
              onPick={pickCommand} onHover={setSlashIndex} />
          )}
          <div className="agent-chat-composer-row">
            {window.electronAPI.agentChatPickImages && (
              <button type="button" className="agent-chat-add-image" aria-label="이미지 첨부" title="이미지 첨부" disabled={sending || pasting}
                onClick={() => { if (boxRef.current) void readIntoDraft(boxRef.current, 'files') }}>
                <RiImageAddLine aria-hidden />
              </button>
            )}
            <textarea
              ref={boxRef}
              id={`agent-chat-input-${shellId}`}
              className="agent-chat-input"
              value={draft}
              rows={1}
              readOnly={sending}
              placeholder={`${kind ? AGENT_NAMES[kind] : '에이전트'}에게 보내기 (Enter 보내기, Shift+Enter 줄바꿈)`}
              onChange={event => setDraft(event.target.value)}
              onPaste={onPaste}
              onKeyDown={onKeyDown}
              aria-label="에이전트에게 보낼 글"
              aria-autocomplete="list"
              aria-controls={slashMatches ? `agent-chat-slash-${shellId}` : undefined}
              aria-activedescendant={slashMatches ? `agent-chat-slash-${shellId}-${Math.min(slashIndex, slashMatches.length - 1)}` : undefined}
            />
            {(canStop || stopping) && (
              <button type="button" className="agent-chat-stop" onClick={() => void stop()} disabled={stopping} title="지금 작업 중지 (Esc)">
                <RiStopCircleLine aria-hidden /> 중지
              </button>
            )}
            <button type="button" className="agent-chat-send" onClick={() => void send()} disabled={(!draftImages.text && !draftImages.images.length) || sending || stopping || Boolean(changingSpeed) || pasting} title="보내기 (Enter)">
              {sending || pasting ? <RiLoader4Line className="agent-chat-spin" aria-hidden /> : <RiSendPlane2Line aria-hidden />}
            </button>
          </div>
        </div>
      )}
      {menu && (
        <TerminalContextMenu
          key={`${menu.x}:${menu.y}`}
          position={menu}
          target={menu.link && { name: linkName(menu.link.href, menu.link.isFile), hint: menu.link.isFile ? '이 PC' : '웹 주소', items: linkMenuItems(menu.link) }}
          top={contextItems}
          groups={contextGroups}
          onClose={() => {
            setMenu(null)
            const origin = menuFocusOrigin.current
            menuFocusOrigin.current = null
            if (origin) window.setTimeout(() => origin.focus({ preventScroll: true }), 0)
          }}
        />
      )}
      </div>
      {subagent && kind && <SubagentConversation key={subagent.id} shellId={shellId} agent={subagent} kind={kind} menuStyle={appearance?.style}
        onBack={() => setSubagentId(null)} onShowTerminal={onShowTerminal} />}
    </div>
  )
}
