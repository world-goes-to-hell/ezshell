// A local shell's Claude Code / Codex as a chat, drawn over its pane (docs/plan/2026-11-19-agent-chat-view.md).
// The shell and the agent keep running under it and the terminal stays mounted: this is only a view of
// the agent's transcript (src/agentChat) with a box that types into the agent's own composer.
import { memo, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type ToggleEvent } from 'react'
import { createPortal } from 'react-dom'
import { RiArrowDownLine, RiArrowUpLine, RiChat1Line, RiCheckboxBlankCircleLine, RiCheckboxCircleLine, RiCheckboxMultipleLine, RiClipboardLine, RiCloseLine, RiFileCopyLine, RiFileTextLine, RiFlashlightLine, RiFolder3Line, RiFolderOpenLine, RiGlobalLine, RiImageAddLine, RiListUnordered, RiLoader4Line, RiMailLine, RiPushpinLine, RiSave3Line, RiSendPlane2Line, RiStopCircleLine, RiTerminalBoxLine, RiTimeLine, RiToolsLine } from 'react-icons/ri'
import type { AgentChatApproval, AgentChatBackgroundShells, AgentChatItem, AgentChatQuestion, AgentChatQuestionContext, AgentMessageSession, CodexSpeedMode } from '../../types'
import { isUnconfirmedSend, useAgentChatStore } from '../../stores/agentChatStore'
import { chatLinesToTakeBack, draftWithTakenBack, takeBackQueued } from '../../lib/chatTakeBack'
import { chatImageReference, insertChatImages, resolveChatImages } from '../../lib/chatImageReferences'
import { CHAT_QUOTE_LIMIT, composeQuotedReply, prepareChatQuote } from '../../lib/chatQuote'
import { openAgentMessages, useAgentMessagesStore, useAgentPaneLocation, usePaneAgentMail } from '../Terminal/AgentMessages'
import { AgentRoleButton } from '../ui/AgentIdentity'
import { AGENT_PROVIDER_ICONS, AGENT_PROVIDER_NAMES } from '../ui/agentProviderIcons'
import { useShortcutsStore } from '../../stores/shortcutsStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { matchesBinding } from '../../lib/shortcutMatch'
import { LOCAL_PATH_LINK, renderChatMarkdown } from '../../lib/markdownRender'
import { isWorkspaceWebDocument } from '../../lib/workspaceDetails'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { outputFileName } from '../../lib/terminalText'
import { TerminalContextMenu, type TerminalMenuGroup, type TerminalMenuItem } from '../Terminal/TerminalContextMenu'
import { webLinkItems } from '../Terminal/TerminalWebLinkMenu'
import { chatTextForClipboard, diffLineKind, echoOutputId, isAgentChatProvider, sentImageKey, shellAgentOf, visibleSendTime, waitingItemIds, type SentChatImages } from '../../lib/agentChatItems'
import { turnUsageSpots, turnUsageText } from '../../lib/agentTurnUsage'
import { toast } from '../../stores/toastStore'
import { AgentChatSubagents } from './AgentChatSubagents'
import { AgentChatQuestions, receivedMessageLabel } from './AgentChatQuestions'
import { AgentChatThemePicker } from './AgentChatThemePicker'
import { AgentChatImagePreview, useChatImageUrl } from './AgentChatImagePreview'
import { AgentChatLinkPreview } from './AgentChatLinkPreview'
import { ChatQuoteCards, ChatQuoteReply, ChatQuoteSelection, QuotedChatMessage, type ChatQuote } from './ChatQuote'
import { SubagentConversation } from './SubagentConversation'
import { ChatHandoff, ChatHandoffButton } from './ChatHandoff'
import { useChatWindow } from './useChatWindow'
import { isApprovalClick, isApprovalShortcut, useApprovalArming } from './useApprovalArming'
import { isAwayFromBottom, isChatQuestion, previousQuestionIndex, questionLine } from '../../lib/chatScrollNav'
import { SlashCommandMenu } from './SlashCommandMenu'
import { AskQuestionCard, AskQuestionSummary } from './AskQuestionCard'
import { CommandOutput } from './CodexMcpOutput'
import { answerableAskItem, pendingAskItem } from '../../lib/askQuestion'
import { useAskQuestionStore } from '../../stores/askQuestionStore'
import { allSlashCommands, draftFor, isSlashCommand, matchSlashCommands, type SlashCommand } from '../../lib/slashCommands'
import { useAgentScreenReturnStore } from '../../stores/agentScreenReturnStore'
import { useAgentScreenWatch } from './useAgentScreenWatch'
import { ClaudeProfileMenu } from './ClaudeProfileMenu'
import type { ChatAppearance } from '../../themes/chatThemes'
import { AgentMailBell } from './AgentMailBell'
import './AgentChat.css'
import './AgentChatThemes.css'

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
const EMPTY_QUOTES: ChatQuote[] = []
const sendClock = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', hour12: true })
const fullChatDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full', timeStyle: 'medium' })

type TimelineRow = { key: string; estimate: number } & (
  | { kind: 'older' }
  | { kind: 'item'; item: AgentChatItem; sendTime: number | null; sentImages?: SentChatImages }
)

type DraftImage = { id: string; number: number; url: string; preview: Blob }

function estimateItem(item: AgentChatItem): number {
  const timeHeight = item.time === null ? 0 : 17
  if (item.kind === 'output') return Math.min(380, 24 + (item.text?.split('\n').length ?? 1) * 17) + timeHeight
  if (item.kind !== 'assistant') return item.kind === 'user' ? 44 : 32
  return Math.min(1000, 48 + Math.ceil((item.text?.length ?? 0) / 90) * 20) + timeHeight
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

/** A folder of this PC, written with the slash at its end (`docs/plan/`) */
const isFolderLink = (menu: LinkMenu) => menu.isFile && /[\\/]$/.test(menu.href)

function isBrowserFileLink(href: string): boolean {
  try {
    const value = /^file:\/\//i.test(href) ? new URL(href).pathname : href
    const name = decodeURIComponent(value).replace(/(?::\d{1,7}(?::\d{1,7})?|#L\d{1,7}(?:-L?\d{1,7})?)$/, '')
    return isWorkspaceWebDocument(name)
  } catch {
    return false
  }
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
  const [submitted, setSubmitted] = useState(false)
  const pending = useRef(false)
  const { armed, canActivate } = useApprovalArming()

  useEffect(() => {
    if (!submitted) return
    const timer = window.setTimeout(() => {
      pending.current = false
      setAnswering(null)
      setSubmitted(false)
    }, 3000)
    return () => window.clearTimeout(timer)
  }, [submitted])

  const answer = async (key: string) => {
    if (pending.current || !canActivate()) return
    pending.current = true
    setAnswering(key)
    const result = await window.electronAPI.agentChatAnswer?.(shellId, key, approval.signature).catch(() => null)
    if (result?.ok) {
      setSubmitted(true)
      return
    }
    pending.current = false
    setAnswering(null)
    toast.error('답하지 못했습니다', result?.error ?? '셸에 답을 보내지 못했습니다.')
  }

  // Number keys answer too, as in the terminal
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isApprovalShortcut(event) || !canActivate() || !/^[1-9]$/.test(event.key)) return
    if (!approval.options.some(option => option.key === event.key)) return
    event.preventDefault()
    void answer(event.key)
  }

  return (
    <div className="agent-chat-approval" role="group" aria-label="에이전트의 확인 요청" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="agent-chat-approval-question">{approval.question ?? '에이전트가 확인을 기다리고 있습니다'}</div>
      {approval.detail.length > 0 && <pre className="agent-chat-approval-detail">{approval.detail.join('\n')}</pre>}
      <div className="agent-chat-approval-options">
        {approval.options.map(option => (
          <button
            key={option.key}
            type="button"
            className="agent-chat-approval-option"
            disabled={!armed || answering !== null}
            onClick={event => { if (isApprovalClick(event)) void answer(option.key) }}
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

type SentImageTarget = { thumbnail: Blob; index: number; imageId?: string; opener: HTMLButtonElement }

function SentImageThumbnail({ preview, index, imageId, onOpen }: {
  preview: Blob; index: number; imageId?: string; onOpen: (image: SentImageTarget) => void
}) {
  const url = useChatImageUrl(preview)
  const label = chatImageReference(index + 1)
  return (
    <button type="button" className="agent-chat-sent-image" aria-label={`${label} 크게 보기`} aria-haspopup="dialog" title="크게 보기"
      onClick={event => onOpen({ thumbnail: preview, index, imageId, opener: event.currentTarget })}>
      <img src={url} alt={label} draggable={false} />
      <span className="agent-chat-image-number" aria-hidden="true">{index + 1}</span>
    </button>
  )
}

function ChatTimestamp({ value, alwaysVisible = false }: { value: number | null; alwaysVisible?: boolean }) {
  if (value === null) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return <time className="agent-chat-timestamp" dateTime={date.toISOString()} title={fullChatDate.format(date)}
    data-always-visible={alwaysVisible || undefined}>{sendClock.format(date)}</time>
}

const ChatItem = memo(function ChatItem({ item, sentImages, sendTime, live, waiting, onRetry, retryDisabled, onPin, onQuote, onHandoff, onCommand, onOpenImage, expanded, rememberDisclosure }: {
  item: AgentChatItem; live: boolean; waiting?: 'queued' | 'input'; onPin?: (item: AgentChatItem) => void
  onQuote?: (text: string) => void
  onHandoff?: (text: string) => void
  onRetry?: (id: string) => void; retryDisabled?: boolean
  onCommand?: (command: string, loginServer?: string) => void
  onOpenImage: (image: SentImageTarget) => void
  sentImages?: SentChatImages; sendTime: number | null; expanded: boolean; rememberDisclosure: (id: string, open: boolean) => void
}) {
  const itemTime = item.sentAt ?? item.time
  const answer = item.text ?? ''
  const onToggle = (event: ToggleEvent<HTMLDetailsElement>) => rememberDisclosure(item.id, event.currentTarget.open)
  switch (item.kind) {
    case 'user':
      return (
        <div className="agent-chat-user">
          {sentImages && (
            <div className="agent-chat-sent-images" role="group" aria-label="보낸 이미지">
              {sentImages.previews.map((preview, index) => <SentImageThumbnail key={index} preview={preview} index={index}
                imageId={sentImages.imageIds[index]} onOpen={onOpenImage} />)}
            </div>
          )}
          <div className="agent-chat-user-message">
            <ChatTimestamp value={itemTime} alwaysVisible={sendTime !== null} />
            <div className="agent-chat-bubble" data-waiting={waiting}>
              <QuotedChatMessage text={sentImages ? sentImages.text || '스크린샷 첨부' : item.text ?? (item.hasImage ? '스크린샷 첨부' : '')} />
            </div>
          </div>
          {/* Sent while the agent worked: it reads the message when it can, and the mark goes then */}
          {waiting && !onRetry && !item.commandState && (
            <div className="agent-chat-command-state agent-chat-waiting" role="status" data-input-needed={waiting === 'input' || undefined}
              title={waiting === 'input' ? '에이전트의 질문이나 승인 요청에 응답하면 메시지를 처리할 수 있습니다.' : '에이전트가 작업을 마치면 메시지를 읽습니다.'}>
              {waiting === 'input' ? <><RiChat1Line aria-hidden /> 응답 후 처리</> : <><RiTimeLine aria-hidden /> 대기 중…</>}
            </div>
          )}
          {onRetry && (
            <div className="agent-chat-command-state agent-chat-delivery">
              <span role="status">전송 확인 안 됨</span>
              <button type="button" disabled={retryDisabled} onClick={() => onRetry(item.id)}>다시 보내기</button>
            </div>
          )}
          {/* A Codex slash command: no transcript records it, so what came of it shows here */}
          {item.commandState && (
            <div className="agent-chat-command-state">{item.commandState === 'screen' ? '터미널에 화면을 열었습니다' : '실행함'}</div>
          )}
        </div>
      )
    case 'output':
      return (
        <div className="agent-chat-incoming">
          <CommandOutput text={answer} command={item.outputCommand} isError={item.isError} canLogin={item.mcpSummary?.canLogin}
            onCommand={onCommand} expanded={expanded} onToggle={onToggle} />
          <ChatTimestamp value={itemTime} />
        </div>
      )
    case 'assistant':
      return (
        <div className="agent-chat-incoming">
          <div className="agent-chat-assistant">
            <Markdown text={answer} />
            {(onPin || onQuote || onHandoff) && (
              <div className="agent-chat-answer-actions">
                {onQuote && answer.trim() && <ChatQuoteReply onClick={() => onQuote(answer)} />}
                {onHandoff && answer.trim() && <ChatHandoffButton onClick={() => onHandoff(answer)} />}
                {onPin && <button type="button" className="agent-chat-pin" aria-label="이 답변 띄워 두기" onClick={() => onPin(item)}>
                  <RiPushpinLine aria-hidden /> 띄워 두기
                </button>}
              </div>
            )}
          </div>
          <ChatTimestamp value={itemTime} />
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

export function AgentChatCover({ shellId, appearance, usageActions, tabId, getSplitMenu, onShowTerminal, onFocusQuestion }: AgentChatCoverProps) {
  const chat = useAgentChatStore(state => state.chats.get(shellId))
  const loadOlder = useAgentChatStore(state => state.loadOlder)
  const agent = useAgentMessagesStore(state => shellAgentOf(state.snapshot.agents, shellId))
  const { agent: mailAgent, count: unreadMail } = usePaneAgentMail(shellId)
  const location = useAgentPaneLocation(mailAgent)
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
  const [linkPreview, setLinkPreview] = useState<{ href: string; opener: HTMLAnchorElement; scope: string | null } | null>(null)
  const [imagePreview, setImagePreview] = useState<(SentImageTarget & { scope: string | null }) | null>(null)
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
  const openImagePreview = useCallback((image: SentImageTarget) => {
    setMenu(null)
    setImagePreview({ ...image, scope })
  }, [scope])
  const quoteKey = `${shellId}:${scope ?? ''}`
  const [forceSendOffer, setForceSendOffer] = useState<{ key: string; token: string } | null>(null)
  const forceToken = forceSendOffer?.key === quoteKey ? forceSendOffer.token : undefined
  const [quoteDraft, setQuoteDraft] = useState<{ key: string; quotes: ChatQuote[] } | null>(null)
  const nextQuoteId = useRef(0)
  const quotes = quoteDraft?.key === quoteKey ? quoteDraft.quotes : EMPTY_QUOTES
  const quotedDraft = useMemo(() => quotes.length ? composeQuotedReply(quotes.map(quote => quote.text), draftImages.text) : null,
    [quotes, draftImages.text])
  const quoteProblem = quotedDraft && 'reason' in quotedDraft ? quotedDraft.reason : null
  const addQuote = useCallback((text: string) => {
    const prepared = prepareChatQuote(text)
    if (!prepared || sendPending.current) return
    const quote = { id: ++nextQuoteId.current, text: prepared }
    setQuoteDraft(current => {
      const items = current?.key === quoteKey ? current.quotes : EMPTY_QUOTES
      return items.length < CHAT_QUOTE_LIMIT ? { key: quoteKey, quotes: [...items, quote] } : current
    })
    boxRef.current?.focus({ preventScroll: true })
  }, [quoteKey])
  const removeQuote = (id: number) => setQuoteDraft(current => current?.key === quoteKey
    ? { ...current, quotes: current.quotes.filter(quote => quote.id !== id) } : current)
  const liveItems = chat?.items ?? EMPTY_ITEMS
  const history = questionContext?.scope === scope ? questionContext : null
  const items = history?.items ?? liveItems
  const sentImages = chat?.sentImages
  const chosenQuestion = selectedQuestion?.scope === scope ? selectedQuestion.question : null
  const highlighted = chosenQuestion && (chosenQuestion.itemId ?? chosenQuestion.id)
  const kind = chat?.kind ?? (isAgentChatProvider(agent?.kind) ? agent.kind : null)
  const antigravity = kind === 'antigravity'
  const folderTrust = chat?.approval?.terminalOnly === 'folder-trust'
  const interactiveKind = kind === 'claude' || kind === 'codex' ? kind : null
  const subagent = !interactiveKind || folderTrust || chat?.approval?.usesTerminalInput ? undefined : chat?.subagents.find(child => child.id === subagentId)
  const preview = !subagent && linkPreview?.scope === scope ? linkPreview : null
  const activeImagePreview = !subagent && imagePreview?.scope === scope ? imagePreview : null
  const ProviderIcon = kind ? AGENT_PROVIDER_ICONS[kind] : null
  const agentName = kind === 'claude' ? 'Claude' : kind ? AGENT_PROVIDER_NAMES[kind] : '에이전트'
  const status = chat?.state === 'ended' ? 'ended'
    : chat?.approval ? 'blocked'
      : (antigravity ? chat?.status : agent?.status) ?? 'unknown'
  // Claude's AskUserQuestion: answered on the chat's own card while its dialog shows (and while the card's
  // answer is on its way: the dialog is out of reach meanwhile), unless it went to the terminal
  const askSending = useAskQuestionStore(state => state.sending.get(shellId))
  const askInTerminal = useAskQuestionStore(state => state.inTerminal.get(shellId))
  const setAskSending = useAskQuestionStore(state => state.setSending)
  const pendingAsk = useMemo(() => kind === 'claude' ? pendingAskItem(liveItems) : null, [kind, liveItems])
  const answerableAsk = useMemo(() => (
    kind === 'claude' && chat?.state !== 'ended' ? answerableAskItem(liveItems, chat?.approval ?? null) : null
  ), [kind, liveItems, chat?.approval, chat?.state])
  const askCard = !folderTrust && (answerableAsk && askInTerminal !== answerableAsk.id ? answerableAsk
    : askSending && pendingAsk?.id === askSending.itemId ? pendingAsk : null)
  const composerBlocked = status === 'blocked' || Boolean(askCard)
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
  const slashTyping = Boolean(interactiveKind) && !composerBlocked && draft.startsWith('/') && !draftImages.images.length && !quotes.length
  useEffect(() => {
    if (!slashTyping || customCommands || !window.electronAPI.agentChatSlashCommands) return
    let live = true
    window.electronAPI.agentChatSlashCommands(shellId)
      .then(list => { if (live) setCustomCommands(list) })
      .catch(() => { if (live) setCustomCommands([]) })
    return () => { live = false }
  }, [customCommands, shellId, slashTyping])
  const slashMatches = useMemo(() => {
    if (!interactiveKind || !slashTyping || slashClosedFor === draft) return null
    const matches = matchSlashCommands(draft, allSlashCommands(interactiveKind, customCommands ?? []))
    return matches?.length ? matches : null
  }, [customCommands, draft, interactiveKind, slashClosedFor, slashTyping])
  useEffect(() => { setSlashIndex(0) }, [draft])
  const isOver = chat?.state === 'ended' || (!agent && !antigravity)
  // A screen of the CLI's own (not a question) took the composer's place: the terminal shows it. Not while
  // Claude's question waits or its answer is being keyed in (its dialog has its own card and terminal way
  // out), nor during a send or the folder trust screen (handled on their own)
  useAgentScreenWatch(shellId, Boolean(chat) && interactiveKind !== null && !isOver && !pendingAsk && !askSending
    && !folderTrust && !sending, onShowTerminal)
  const replyId = chat?.reply?.sendId
  const idle = status === 'idle'
  const canReply = !isOver && !composerBlocked && status !== 'error' && (!antigravity || idle)
  const canAddQuote = canReply && !subagent && !sending && !pasting && !stopping && !changingSpeed && quotes.length < CHAT_QUOTE_LIMIT
  const canStop = !antigravity && canReply && (status === 'working' || Boolean(replyId))
  const canToggleSpeed = canReply && !stopping && !replyId && status !== 'working' && status !== 'starting'
  const speed = chat?.codexSpeed?.speed ?? null
  // Sent while the agent was busy and not read yet: the CLI holds it (Claude reads it at its next step,
  // Codex when its turn ends), so the bubble says it waits and the progress line is about the work before it
  const waiting = useMemo(() => waitingItemIds(liveItems, chat?.echoes ?? [], chat?.held ?? [], status),
    [liveItems, chat?.echoes, chat?.held, status])
  const unconfirmed = useMemo(() => new Set(chat?.echoes.filter(echo => isUnconfirmedSend(chat, echo)).map(echo => echo.id)), [chat])
  useEffect(() => {
    if (antigravity) return
    let timer: number | undefined
    const isIdle = (agents: readonly AgentMessageSession[]) => shellAgentOf(agents, shellId)?.status === 'idle'
    const check = () => {
      window.clearTimeout(timer)
      const store = useAgentChatStore.getState()
      const confirmedIdle = !store.chats.get(shellId)?.approval && isIdle(useAgentMessagesStore.getState().snapshot.agents)
      const next = store.checkSendConfirmations(shellId, confirmedIdle)
      if (next !== undefined) timer = window.setTimeout(check, Math.max(0, next - Date.now()))
    }
    const unsubscribe = useAgentMessagesStore.subscribe((state, before) => {
      if (isIdle(state.snapshot.agents) !== isIdle(before.snapshot.agents)) check()
    })
    check()
    return () => { unsubscribe(); window.clearTimeout(timer) }
  }, [antigravity, shellId, chat?.state, chat?.transcriptId, chat?.echoes, chat?.approval])
  useEffect(() => () => { useAgentChatStore.getState().checkSendConfirmations(shellId, false) }, [shellId])
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
  const showSendTime = appearance?.id === 'chat-kakao'
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

  // The main process verifies the clicked file link against the conversation. Web links keep their menu.
  const onLogClick = (event: MouseEvent<HTMLDivElement>) => {
    const link = answerLink(event.target)
    if (!link) return
    event.preventDefault()
    const target = linkMenuTarget(link)
    // Folders written as code paths locate their tree entry. Markdown links can open the preview.
    if (target && isFolderLink(target) && link.classList.contains('md-code-link')) {
      void openInApp(target.href)
      return
    }
    if (target?.isFile && window.electronAPI.agentChatLinkPreview) {
      setMenu(null)
      setLinkPreview({ href: target.href, opener: link, scope })
      return
    }
    if (target) {
      menuFocusOrigin.current = null
      setMenu({ x: event.clientX, y: event.clientY, link: target })
    }
  }

  const restorePreviewFocus = (opener?: HTMLElement) => {
    if (opener?.isConnected && opener.checkVisibility({ visibilityProperty: true })) {
      opener.focus({ preventScroll: true })
      if (document.activeElement === opener) return
    }
    const fallback = boxRef.current ?? coverRef.current
    if (fallback?.checkVisibility({ visibilityProperty: true })) fallback.focus({ preventScroll: true })
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
      const text = chatTextForClipboard(result.items, chat.items, chat.echoes, agentName)
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
      else if (how === 'browser-tab') setLinkPreview(null)
    } catch {
      toast.error('열지 못했습니다', '링크를 열 수 없습니다.')
    }
  }

  // A folder opens in the workspace panel's file tree, which opens up to it (2026-11-24 user request:
  // the file manager was a step away from the work). A file, or a folder outside the panel's folder,
  // opens as before (main: the file window or the file manager).
  const openInApp = async (href: string) => {
    try {
      const found = await window.electronAPI.agentChatOpenLink?.(shellId, href, 'workspace')
      if (found?.ok && found.folder) {
        useWorkspacePanelStore.getState().revealFolder({
          shellId,
          folder: found.folder,
          fallback: () => {
            toast.info('파일 탐색기에서 엽니다', '작업 공간의 폴더 밖에 있는 폴더입니다.')
            void openLink(href, 'app')
          }
        })
        return
      }
    } catch {
      // Opened as before
    }
    await openLink(href, 'app')
  }

  const linkMenuItems = (menu: LinkMenu) => isFolderLink(menu)
    ? [
        { label: '작업 공간에서 보기', icon: RiFolder3Line, onSelect: () => void openInApp(menu.href) },
        { label: '파일 탐색기에서 열기', icon: RiFolderOpenLine, onSelect: () => void openLink(menu.href, 'app') },
        { label: '경로 복사', icon: RiFileCopyLine, onSelect: () => void copyToClipboard(menu.href) }
      ]
    : menu.isFile
    ? [
        ...(isBrowserFileLink(menu.href) ? [{ label: '브라우저로 열기', icon: RiGlobalLine, onSelect: () => void openLink(menu.href, 'browser-tab') }] : []),
        { label: 'ezShell 에서 열기', icon: RiFileTextLine, onSelect: () => void openInApp(menu.href) },
        { label: '파일 탐색기에서 열기', icon: RiFolderOpenLine, onSelect: () => void openLink(menu.href, 'explorer') },
        { label: '경로 복사', icon: RiFileCopyLine, onSelect: () => void copyToClipboard(menu.href) }
      ]
    : webLinkItems(menu.href, destination => void openLink(menu.href, destination === 'internal' ? 'browser-tab' : 'browser'))

  // `인계`: the answer shown in the hand-off card (ChatHandoff), or null while it is closed
  const [handoffText, setHandoffText] = useState<string | null>(null)
  const closeHandoff = useCallback(() => setHandoffText(null), [])
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
    // Following the end during a layout change can leave a short conversation near the top too.
    const distanceToEnd = log.scrollHeight - log.clientHeight - log.scrollTop
    if (log.scrollTop < 80 && distanceToEnd > 1 && showOlder) loadOlder(shellId)
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
    if (antigravity && source === 'files') return
    const read = source === 'clipboard'
      ? window.electronAPI.agentChatReadClipboard
      : window.electronAPI.agentChatPickImages
    if (!read || box.readOnly || pastePending.current || sendPending.current) return
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
      if (!result.ok && source === 'clipboard' && boxRef.current === box && !box.readOnly && attachments.length && reclaimUnused()) {
        result = await read(shellId)
      }
      if (boxRef.current !== box || box.readOnly) {
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
    if (antigravity || composerBlocked || !window.electronAPI.agentChatReadClipboard
      || !Array.from(event.clipboardData.items).some(item => item.type.startsWith('image/'))) return
    event.preventDefault()
    void readIntoDraft(event.currentTarget, 'clipboard')
  }

  /** After a slash command went: Codex's line gets what came of it; a screen hands the pane to the terminal */
  const watchCommand = async (sendId: string) => {
    const result = await window.electronAPI.agentChatCommandWatch?.(shellId).catch(() => null)
    if (!result?.ok) return
    if (kind === 'codex' && (result.state === 'done' || result.state === 'screen')) {
      useAgentChatStore.getState().settleCommand(shellId, sendId, { state: result.state, output: result.output, mcpSummary: result.mcpSummary })
    }
    if (result.state === 'screen' && useAgentChatStore.getState().chats.has(shellId)) {
      useAgentScreenReturnStore.getState().begin(shellId, result.screen === 'claude-login')
      onShowTerminal()
    }
  }

  const canRunOutputCommand = !history && interactiveKind === 'codex' && idle && canReply
    && !replyId && !sending && !stopping && !changingSpeed && !pasting
  const latestMcpOutputId = chat?.latestMcpSendId ? echoOutputId(chat.latestMcpSendId) : null
  const send = async ({ override, retryId, mcpAction, force }: {
    override?: string; retryId?: string; mcpAction?: { summaryId: string; server?: string }; force?: string
  } = {}) => {
    if (!chat || sendPending.current || stopPending.current || speedPending.current || pastePending.current || isOver || composerBlocked) return
    if (antigravity && (!canReply || retryId)) return
    const keepDraft = Boolean(mcpAction)
    if (keepDraft && !canRunOutputCommand) return
    const current = useAgentChatStore.getState().chats.get(shellId)
    const retry = retryId && current ? current.echoes.find(echo => echo.id === retryId && isUnconfirmedSend(current, echo)) : null
    const delivery = retry?.delivery
    const retryContext = current && delivery?.transcriptId && delivery.acceptedAt !== undefined ? {
      acceptedAt: delivery.acceptedAt,
      transcriptId: delivery.transcriptId,
      ignoreIds: current.items.filter(item => item.kind === 'user' && !item.id.startsWith('outgoing:')).slice(-256).map(item => item.id)
    } : undefined
    if (retryId && (!retryContext || !idle || !canReply)) return
    const consumesDraft = !retry && !keepDraft
    const outgoing = keepDraft ? { text: override ?? '', images: [] }
      : override === undefined ? draftImages : resolveChatImages(override, attachments)
    const withQuotes = consumesDraft && quotes.length ? (override === undefined ? quotedDraft :
      composeQuotedReply(quotes.map(quote => quote.text), outgoing.text)) : null
    if (withQuotes && 'reason' in withQuotes) return
    const text = retry?.text ?? withQuotes?.text ?? outgoing.text
    const imageIds = retry ? Array.from(retry.delivery?.imageIds ?? []) : outgoing.images.map(image => image.id)
    if (!text && !imageIds.length) return
    if (antigravity && (imageIds.length || isSlashCommand(text))) {
      toast.info('Antigravity 채팅은 일반 텍스트를 보냅니다', '슬래시 명령과 첨부는 터미널에서 사용해 주세요.')
      return
    }
    sendPending.current = true
    if (consumesDraft) setForceSendOffer(null)
    resetQuestionPosition()
    followAfterSend()
    setSending(true)
    if (consumesDraft) setDraft('')
    const { echoSend, acceptSend, confirmSend, discardSend } = useAgentChatStore.getState()
    const queued = status === 'working'
    const sendId = retry?.id ?? echoSend(shellId, text, outgoing.images.map(image => image.preview), queued, imageIds)
    const restoreDraft = () => {
      if (retry) return
      discardSend(shellId, sendId)
      if (consumesDraft) setDraft(draft)
    }
    try {
      const api = window.electronAPI
      const result = mcpAction
        ? mcpAction.server === undefined
          ? await api.agentChatMcpVerbose?.(shellId, mcpAction.summaryId)
          : await api.agentChatMcpLogin?.(shellId, mcpAction.summaryId, mcpAction.server)
        : await api.agentChatSend?.(shellId, text, imageIds, retryContext, force)
      if (result?.ok) {
        acceptSend(shellId, sendId, retry ? queued : undefined)
        if (!retry && interactiveKind && !imageIds.length && isSlashCommand(text)) void watchCommand(sendId)
        if (consumesDraft) {
          setQuoteDraft(current => current?.key === quoteKey ? null : current)
          for (const { id } of attachments) releaseAttachment(id)
          setAttachments([])
          nextAttachmentNumber.current = 0
        }
      } else if (retry && result?.reason === 'already-recorded' && result.recorded) {
        confirmSend(shellId, sendId, result.recorded)
      } else {
        restoreDraft()
        if (consumesDraft && result?.forceToken) {
          setForceSendOffer({ key: quoteKey, token: result.forceToken })
        } else if (result?.reason !== 'interrupted') {
          toast.error('보내지 못했습니다', result && !result.ok ? result.error : '이 앱 버전에서는 쓸 수 없습니다.')
        }
      }
    } catch {
      restoreDraft()
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
    else void send({ override: command.name })
    boxRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Korean input: Enter that ends a composition is not a send
    if (composerBlocked || event.nativeEvent.isComposing) return
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
      { label: '터미널 모드', icon: RiTerminalBoxLine, onSelect: onShowTerminal }
    )
    if (!antigravity) contextItems.push(
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
        ...(!antigravity ? [{
          label: '이미지 첨부…', icon: RiImageAddLine, disabled: !canEditDraft || !window.electronAPI.agentChatPickImages,
          onSelect: () => readDraftFromMenu('files')
        }] : [])
      ]
    })
  }

  return (
    <div className="agent-chat-cover" ref={coverRef} tabIndex={-1} role="region" aria-label="에이전트 채팅"
      data-chat-theme={appearance?.id} data-chat-bubbles={appearance?.bubbles || undefined}
      style={appearance?.style}
      onKeyDown={onCoverKeyDown} onContextMenu={onContextMenu}>
      <div className="agent-chat-parent" inert={Boolean(subagent)}>
      <header className="agent-chat-head">
        {kind && ProviderIcon && (
          <span className="agent-chat-kind" data-kind={kind}>
            <ProviderIcon size={12} aria-hidden="true" />
            {agentName}
          </span>
        )}
        {/* Click to name the agent (its role), as in the agent message window */}
        {mailAgent?.active && <AgentRoleButton agent={mailAgent} location={location} />}
        <button type="button" className="agent-chat-title agent-chat-title-copy" title={`${title} · 클릭하여 제목 복사`}
          aria-label={`제목 복사 · ${title}`} onClick={() => void copyToClipboard(title)}>
          {title}
        </button>
        {(STATUS_LABELS[status] || (antigravity && idle)) && (
          <span className="agent-chat-status" data-status={status}>
            {status === 'working' && <RiLoader4Line className="agent-chat-spin" aria-hidden />}
            {antigravity && idle ? '입력 대기' : STATUS_LABELS[status]}
          </span>
        )}
        {/* Opens the messages not handled yet; picking one asks the agent to handle it now (AgentMailBell) */}
        {!antigravity && mailAgent && <AgentMailBell shellId={shellId} agent={mailAgent} unread={unreadMail} tabId={tabId} />}
        {kind === 'claude' && <ClaudeProfileMenu shellId={shellId} profileId={agent?.claudeProfileId} />}
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
      {interactiveKind && questionsOpen && <AgentChatQuestions key={scope ?? 'waiting'} shellId={shellId} scope={scope}
        items={liveItems} onPick={question => void jumpToQuestion(question)} onDismiss={dismissQuestions} />}
      {highlighted && <div className="agent-chat-question-location">
        {history && <span>{chosenQuestion?.sender ? '받은 메시지 주변 대화' : '선택한 질문 주변 대화'}</span>}
        <button type="button" className="agent-chat-head-btn" onClick={() => {
          resetQuestionPosition()
          setJump({ id: null, scope })
        }}><RiArrowDownLine aria-hidden /> 최신 대화</button>
      </div>}
      {interactiveKind && chat && chat.subagents.length > 0 && <AgentChatSubagents key={shellId} shellId={shellId} kind={interactiveKind} agents={chat.subagents}
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
              const summaryId = item?.id === latestMcpOutputId ? item?.mcpSummary?.id : undefined
              const usage = item ? usageSpots.get(item.id) : undefined
              const line = !antigravity && usage ? turnUsageText(usage) : null
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
                    onRetry={!history && unconfirmed.has(entry.item.id) ? id => void send({ retryId: id }) : undefined}
                    retryDisabled={!idle || !canReply || sending || stopping || Boolean(changingSpeed) || pasting}
                    onCommand={summaryId && canRunOutputCommand
                      ? (command, server) => void send({ override: command, mcpAction: { summaryId, server } }) : undefined}
                    expanded={disclosures.current.has(entry.item.id)} rememberDisclosure={rememberDisclosure}
                    onOpenImage={openImagePreview}
                    onQuote={canAddQuote ? addQuote : undefined}
                    onHandoff={window.electronAPI.agentChatHandoff ? setHandoffText : undefined}
                    onPin={window.electronAPI.agentChatPin ? pinReply : undefined} />}
                  {line && <p className="agent-chat-usage" title={line.title}>{line.text}</p>}
                </div>
              )
            })}
          </div>
        )}
        {chat?.state === 'opening' && !items.length && <p className="agent-chat-empty">대화를 불러오는 중…</p>}
        {chat?.state === 'waiting' && !items.length && !folderTrust && <p className="agent-chat-empty">대화가 시작되면 여기에 보입니다.</p>}
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
      {askCard && !isOver && <AskQuestionCard key={askCard.id} shellId={shellId} item={askCard} onTerminal={() => requestAnimationFrame(onFocusQuestion)} />}
      {!antigravity && chat?.approval && !askCard && !isOver && ((folderTrust || chat.approval.usesTerminalInput) ? (
        <div className="agent-chat-approval agent-chat-inline-question">
          <div role="status">
            <div className="agent-chat-approval-state">{folderTrust ? '이 폴더를 신뢰할지 터미널에서 답해 주세요.' : '답변 대기 중'}</div>
            {chat.approval.question && <div className="agent-chat-approval-question">{chat.approval.question}</div>}
          </div>
          <button type="button" className="agent-chat-head-btn" onClick={onFocusQuestion}>{folderTrust ? '터미널에서 답하기' : '질문에 답하기'}</button>
        </div>
      ) : <ApprovalCard key={chat.approval.signature} shellId={shellId} approval={chat.approval} />)}
      {askUnread && unreadAskId === askUnread && status !== 'blocked' && !isOver && (
        <div className="agent-chat-banner" role="status">
          Claude 가 질문의 답을 기다리고 있습니다. 이 질문 화면은 채팅에서 읽지 못해 터미널에서 답해 주세요.
          <button type="button" onClick={onShowTerminal}>터미널에서 답하기</button>
        </div>
      )}
      {antigravity && !isOver && (status === 'blocked' || status === 'starting' || status === 'error' || status === 'unknown') && (
        <div className="agent-chat-banner" role="status">
          {status === 'blocked' ? 'Antigravity가 터미널에서 확인을 기다리고 있습니다.' : '터미널에서 시작 또는 로그인 상태를 확인할 수 있습니다.'}
          <button type="button" onClick={onShowTerminal}>터미널 보기</button>
        </div>
      )}
      {!antigravity && status === 'blocked' && !isOver && !chat?.approval && !askCard && (
        // A prompt the view cannot read as choices: answered in the terminal
        <div className="agent-chat-banner" role="status">
          에이전트가 확인을 기다리고 있습니다. 터미널에서 답해 주세요.
          <button type="button" onClick={onShowTerminal}>터미널 보기</button>
        </div>
      )}
      {isOver && (
        <div className="agent-chat-banner" role="status">
          {agentName} 가 종료되었습니다.
          <button type="button" onClick={onShowTerminal}>터미널 보기</button>
        </div>
      )}
      {!isOver && (
        <div className="agent-chat-composer">
          {progressLabel && <p className="agent-chat-reply-progress" role="status">
            <RiLoader4Line className="agent-chat-spin" aria-hidden />{progressLabel}
          </p>}
          {kind === 'claude' && forceToken && (draftImages.text || draftImages.images.length > 0) && (
            <div className="agent-chat-force-send">
              <span role="status">Claude 입력칸에 글이 표시되어 있습니다. 강제로 보내면 기존 입력을 지웁니다.</span>
              <button type="button" onClick={() => void send({ force: forceToken })}
                disabled={composerBlocked || Boolean(quoteProblem) || sending || stopping || Boolean(changingSpeed) || pasting}>
                강제로 보내기
              </button>
            </div>
          )}
          <ChatQuoteCards quotes={quotes} disabled={sending || composerBlocked} onRemove={removeQuote}
            notice={quoteProblem === 'command' ? '슬래시 명령을 보내려면 인용을 제거하세요.'
              : quoteProblem === 'too-long' ? '본문을 줄이거나 인용을 제거하세요.'
                : quoteProblem === 'empty' && draftImages.images.length ? '인용과 함께 보낼 내용을 입력해 주세요.'
                  : quotes.length === CHAT_QUOTE_LIMIT ? `인용은 최대 ${CHAT_QUOTE_LIMIT}개까지 추가할 수 있습니다.` : undefined} />
          {!antigravity && !!draftImages.images.length && (
            <div className="agent-chat-attachments" role="group" aria-label="첨부 이미지">
              {draftImages.images.map(image => (
                <div key={image.id} className="agent-chat-attachment">
                  <img src={image.url} alt={chatImageReference(image.number)} />
                  <span className="agent-chat-image-number" aria-hidden="true">{image.number}</span>
                  <button type="button" aria-label={`이미지 ${image.number} 첨부 제거`} title="이미지 첨부 제거" disabled={sending || pasting || composerBlocked}
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
            {!antigravity && window.electronAPI.agentChatPickImages && (
              <button type="button" className="agent-chat-add-image" aria-label="이미지 첨부" title="이미지 첨부" disabled={sending || pasting || composerBlocked}
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
              readOnly={sending || composerBlocked}
              aria-disabled={composerBlocked || undefined}
              placeholder={`${agentName}에게 보내기 (Enter 보내기, Shift+Enter 줄바꿈)`}
              onChange={event => setDraft(event.target.value)}
              onPaste={onPaste}
              onKeyDown={onKeyDown}
              aria-label="에이전트에게 보낼 글"
              aria-autocomplete={interactiveKind ? 'list' : undefined}
              aria-controls={slashMatches ? `agent-chat-slash-${shellId}` : undefined}
              aria-activedescendant={slashMatches ? `agent-chat-slash-${shellId}-${Math.min(slashIndex, slashMatches.length - 1)}` : undefined}
            />
            {!antigravity && (canStop || stopping) && (
              <button type="button" className="agent-chat-stop" onClick={() => void stop()} disabled={stopping} title="지금 작업 중지 (Esc)">
                <RiStopCircleLine aria-hidden /> 중지
              </button>
            )}
            <button type="button" className="agent-chat-send" onClick={() => void send()} disabled={composerBlocked || (antigravity && !canReply) || Boolean(quoteProblem) || (!draftImages.text && !draftImages.images.length) || sending || stopping || Boolean(changingSpeed) || pasting} title="보내기 (Enter)">
              {sending || pasting ? <RiLoader4Line className="agent-chat-spin" aria-hidden /> : <RiSendPlane2Line aria-hidden />}
            </button>
          </div>
        </div>
      )}
      <ChatQuoteSelection coverRef={coverRef} logRef={logRef} enabled={canAddQuote} onQuote={addQuote} />
      {handoffText !== null && <ChatHandoff shellId={shellId} answer={handoffText} source={mailAgent ?? null} onClose={closeHandoff} />}
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
      {preview && <AgentChatLinkPreview shellId={shellId} href={preview.href} themeStyle={appearance?.style}
        onClose={() => setLinkPreview(null)} onRestoreFocus={() => restorePreviewFocus(preview.opener)} onOpen={openLink} />}
      {activeImagePreview && <AgentChatImagePreview shellId={shellId} imageId={activeImagePreview.imageId} thumbnail={activeImagePreview.thumbnail}
        label={chatImageReference(activeImagePreview.index + 1)} themeStyle={appearance?.style} onClose={() => setImagePreview(null)}
        onRestoreFocus={() => restorePreviewFocus(activeImagePreview.opener)} />}
      {subagent && interactiveKind && <SubagentConversation key={subagent.id} shellId={shellId} agent={subagent} kind={interactiveKind} menuStyle={appearance?.style}
        onBack={() => setSubagentId(null)} onShowTerminal={onShowTerminal} />}
    </div>
  )
}
