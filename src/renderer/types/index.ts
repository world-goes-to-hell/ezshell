import type { RootSwitchOutcome } from '../lib/rootSwitch'
import type { DesktopPointerConfig } from '../lib/pointerDesktop'
import type { ChatLinkPreviewResult } from './chatLinkPreview'
import type { DbColumnSource, DbCredentials, DbDatabase, DbEndpoint, DbQueryResult, DbRelations, DbResult, DbSchema, DbServerInfo, DbTable, DbTableColumn, DbWindowInfo, DiscoveredDb } from './db'

export interface SessionConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  folderId?: string
}

export interface FolderConfig {
  id: string
  name: string
}

export interface TerminalSession {
  id: string
  config: SessionConfig
  connected: boolean
}

export type PathBookmarkSide = 'local' | 'remote'

export interface PathBookmarkEntry {
  local: string[]
  remote: string[]
}

export interface CommandHistoryEntry {
  command: string
  lastUsedAt: number
}

export interface CommandHistoryResult {
  success: boolean
  entries?: CommandHistoryEntry[]
  error?: string
}

export interface SshSessionInfo {
  host: string
  port: number
  username: string
  savedSessionId: string | null
  sessionName?: string
  color?: string
}

export type SshConnectionTestResult =
  | { success: true; elapsedMs: number; viaJumpHost: boolean }
  | { success: false; stage: 'jump' | 'target'; error: string; hint?: string; detail?: string }

export type LocalFileOpResult = { success: true } | { success: false; error: string }

export interface LocalTrashResult {
  trashed: number
  failures: { path: string; error: string }[]
}

export type McpAlertLevel = 'all' | 'medium' | 'danger'
export type McpRiskLevel = 'low' | 'medium' | 'danger' | 'forbidden'
export type McpAuditOutcome = 'executed' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'blocked' | 'failed'

export interface McpConfig {
  enabled: boolean
  port: number
  alertLevel: McpAlertLevel
  token: string
  /** Folders on this PC the transfer tools (upload_file / download_file) may read and write */
  transferRoots: string[]
}

/** Answer to adding a transfer folder: the folder comes from a dialog of the main process, which may be cancelled */
export type McpTransferFolderResult = McpStatusResult | { success: false; cancelled: true }

export interface McpStatus {
  config: McpConfig
  running: boolean
  error: string | null
  registerCommand: string
}

export type McpStatusResult = { success: true; status: McpStatus } | { success: false; error: string }

/** One line of a file change shown for approval; `note` is a remark such as a missing final line break */
export interface McpDiffLine {
  type: 'add' | 'remove' | 'context' | 'note'
  text: string
}

export interface McpDiffHunk {
  header: string
  lines: McpDiffLine[]
}

// ==================== Server file window (edit / preview) ====================

/** 'tail' is a text preview that follows the end of the file ("실시간 보기") */
export type RemoteFileMode = 'edit' | 'preview' | 'tail'

/** Where following a log stands: the load it belongs to, and the last answer the window took in */
export interface RemoteFileFollow {
  generation: number
  cursor: number
}

/**
 * One look at the end of a followed log. Pass `cursor` back on the next look once its text is shown
 * (an answer not taken in is sent again). 'busy' and 'stale' (from before a refresh) carry none.
 */
export type RemoteFileTailResult =
  | { status: 'busy' | 'stale'; cursor?: undefined }
  | { status: 'same' | 'missing'; cursor: number }
  | { status: 'append'; text: string; cursor: number }
  | { status: 'skipped'; skippedBytes: number; text: string; cursor: number }
  | { status: 'rotated'; skippedBytes?: number; text: string; cursor: number }

/** Every answer of the file window's IPC: the fields on success, a message to show otherwise */
export type RemoteFileResult<T> = ({ success: true } & T) | { success: false; error: string }

export interface RemoteFileDraft {
  editor: string
  top: number
  left: number
  ending: 'lf' | 'crlf' | 'mixed' | 'none'
}

export interface RemoteFileOpenHint {
  sequence: number
  line?: number
  compareHead?: true
}

export interface RemoteFileTab {
  docId: string
  path: string
  local: boolean
  dirty: boolean
  hint?: RemoteFileOpenHint
}

export interface RemoteFileWindowState {
  revision: number
  tabbed: boolean
  activeId: string | null
  tabs: RemoteFileTab[]
}

interface RemoteFileLoadedBase {
  sessionName: string
  sessionColor?: string
  requestedPath: string
  /** The real path behind links */
  path: string
  mode: RemoteFileMode
  /** A file on this PC (the workspace panel), not on a server */
  local?: true
  /** A line to go to once (opened from a placeholder's definitions) */
  revealLine?: number
  /** Opened from the uncommitted changes: start comparing with Git HEAD */
  compareHead?: true
}

/** Where a placeholder's name (`${NAME}`) is set; opened by `key` only */
export interface ConfigDefinition {
  key: string
  path: string
  line: number
  text: string
}

export type RemoteFileLoaded = RemoteFileLoadedBase & (
  | { kind: 'text'; editable: true; content: string; canWrite: boolean; draft?: RemoteFileDraft }
  /** `pace: 'command'`: each look runs a command on the server (a container's log), so looks are further apart */
  | { kind: 'text'; editable: false; content: string; truncated: boolean; size: number; follow: RemoteFileFollow; pace?: 'command' }
  | { kind: 'image' | 'pdf'; mime: string; size: number; data: Uint8Array<ArrayBuffer> }
)

export type RemoteFileReview =
  | { unchanged: true }
  | { unchanged: false; token: string; change: { added: number; removed: number; isWholeFile: boolean; hunks: McpDiffHunk[]; truncated: boolean } }

export type RemoteFileSaveResult =
  | { ok: true; backupName: string | null }
  | { ok: false; conflict: true; message: string }

export interface RemoteFileBackup {
  name: string
  createdAt: number
  size: number
}

/** A backup beside the server file, or a revision of a local file. */
export type RemoteServerBackup =
  | { name: string; size: number; time: number; timeFrom: 'name' | 'modified' }
  | { name: string; size?: number; time: number; timeFrom: 'git'; subject?: string; deleted?: boolean }

/** Question from main about an SSH host key that is not saved yet ('unknown') or differs from the saved one ('changed') */
export interface HostKeyPrompt {
  id: string
  status: 'unknown' | 'changed'
  host: string
  port: number
  keyType: string
  fingerprint: string
  previous?: { keyType: string; fingerprint: string }
}

export interface McpApprovalRequest {
  id: string
  sessionName: string
  folder: string
  /** The colour the user gave this session in the sidebar, shown as a swatch (null when none) */
  sessionColor?: string | null
  cwd: string | null
  command: string
  /** Commands only: why Claude says it wants to run it (its own words, at most 500 characters) */
  purpose?: string
  level: McpRiskLevel
  reasons: string[]
  expiresAt: number
  /**
   * The PC window's copy only: the question also reached a signed-in phone (or its notifications), so it
   * can be answered there and waits longer (remote access, main.js showMcpApproval)
   */
  sentToPhone?: boolean
  /** Requests waiting behind this one in the desktop dialog. */
  waitingCount?: number
  /** Set when the command is started as a background job: it may run this long after being allowed */
  background?: { limitMinutes: number }
  /**
   * 'file' for write_file / edit_file: the dialog shows the change instead of a command.
   * 'transfer' for upload_file / download_file: it shows both ends of the transfer.
   */
  kind?: 'file' | 'transfer'
  /** Transfers only: which way the file goes */
  direction?: 'upload' | 'download'
  /** Transfers only: the real file on this PC, and what the tool asked for */
  localPath?: string
  requestedLocalPath?: string
  /** Transfers only: the real file on the server (links resolved), and what the tool asked for */
  remotePath?: string
  requestedRemotePath?: string
  /** Transfers only: bytes to be transferred */
  size?: number
  /** The real file that will be written (links resolved) */
  path?: string
  /** What the tool asked for, when it differs from `path` */
  requestedPath?: string
  isNew?: boolean
  /** The content sent is what the file already holds; asked only where confirming that is sensitive */
  noChange?: boolean
  /** The change is shown as the whole file replaced (an exact diff would have taken too long) */
  isWholeFile?: boolean
  added?: number
  removed?: number
  hunks?: McpDiffHunk[]
}

export type McpActivityState = 'waiting' | 'running' | 'done' | 'timeout' | 'denied' | 'expired' | 'cancelled' | 'blocked' | 'failed'

/** Answer to starting or stopping a session log (terminal output written to a text file) */
export interface SessionLogResult {
  success: boolean
  filePath?: string
  error?: string
}

/** A tab started or stopped being logged; `error` is set when the log ended because the file could not be written */
export interface SessionLogChange {
  sessionId: string
  isLogging: boolean
  filePath?: string
  error?: string
}

/** A piece of what a command printed, in arrival order */
export interface McpOutputPart {
  stream: 'stdout' | 'stderr'
  text: string
}

/** Live output of a running request, sent in batches */
export interface McpActivityOutput {
  id: string
  parts: McpOutputPart[]
}

/** upload_file / download_file: how far the copy got, for the progress bar */
export interface McpTransferProgress {
  direction: 'upload' | 'download'
  size: number
  done: number
  /** When the copy began (not the request: that may have waited for the user) */
  startedAt: number
}

export interface McpActivityItem {
  id: string
  time: string
  sessionId: string
  sessionName: string
  command: string
  level: McpRiskLevel
  reasons: string[]
  state: McpActivityState
  startedAt: number
  finishedAt: number | null
  /** Directory the request ran in; null while the gateway has not learned it yet */
  cwd?: string | null
  exitCode?: number | null
  timedOut?: boolean
  truncated?: boolean
  error?: string
  /** The result text Claude received */
  output?: string
  /** What the command printed, for the terminal view */
  outputParts?: McpOutputPart[]
  /** The start of `outputParts` was dropped because the request printed more than is kept */
  outputTrimmed?: boolean
  /** A background job (run_command with `background`): stays running until the job ends */
  background?: boolean
  /** Id of the background job, once it has started */
  jobId?: string
  /** File transfers only */
  transfer?: McpTransferProgress
}

export interface McpAuditEntry {
  time: string
  requestId: string
  sessionId: string
  sessionName: string
  command: string
  level: McpRiskLevel
  reasons: string[]
  outcome: McpAuditOutcome
  exitCode?: number | null
  timedOut?: boolean
  truncated?: boolean
  cancelled?: boolean
  phase?: 'end'
  error?: string
}

export type McpSetupScope = 'project' | 'global'
export type McpSetupClient = 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor'

export interface McpSetupOutcome {
  client: McpSetupClient
  scope: McpSetupScope
  filePath: string
  result: 'added' | 'replaced' | 'unchanged' | 'conflict'
  backupPath: string | null
  /** Projects in ~/.claude.json whose own registration of the same name wins over the global one */
  shadowedProjects: string[]
  /** Old names of the server whose entries were removed from the file in the same write */
  renamedFrom?: string[]
  /** The old name, and the projects in ~/.claude.json that still register the server under it */
  legacyName?: string
  legacyRegistrations?: Array<{ name: string; projects: string[] }>
  legacyProjects?: string[]
  existingUrl?: string
  tokenEnv: 'set' | 'unsupported' | 'failed' | null
  tokenEnvError: string | null
}

export type McpSetupResult =
  | { success: true; outcome: McpSetupOutcome }
  | { success: false; error?: string; cancelled?: boolean }

// Extend Window interface for electronAPI
export type LocalAgent = 'codex' | 'claude'
export type AgentChatProvider = LocalAgent | 'antigravity'
export type AgentMessageKind = AgentChatProvider | 'aside'
export interface ClaudeProfile { id: string; name: string }
type ClaudeProfilesResult = { success: true; profiles: ClaudeProfile[] } | { success: false; error: string }

/** A past Claude Code or Codex session of this PC (src/agentHistory). `key` is all the main process takes back. */
export interface AgentHistorySession {
  key: string
  agent: LocalAgent
  id: string
  cwd: string | null
  branch: string | null
  model: string | null
  version: string | null
  title: string
  preview: string
  role?: string
  hasPrompt: boolean
  created: number | null
  updated: number
  claudeProfileId?: string
  claudeProfileName?: string
}

export interface AgentHistoryTurn {
  role: 'user' | 'assistant'
  text: string
  time: number | null
}

export interface AgentHistoryDetail {
  firstPrompt: string | null
  turns: AgentHistoryTurn[]
  /** The end of a very large compressed transcript was not read */
  turnsUnavailable: boolean
}

/** One subscription window: percent used and when it resets (ms), from src/ipc/agentUsage.js */
export interface AgentUsageWindow {
  percent: number
  resetsAt: number | null
}

export interface AgentUsage {
  agent: LocalAgent
  model: string | null
  /** Reasoning effort of the session (low, medium, high, xhigh, max, ...), when the model has it */
  effort: string | null
  /** The CLI's session id: a restart opens the same conversation again (claude --resume, codex resume) */
  sessionId: string | null
  context: { percent: number; size: number | null } | null
  fiveHour: AgentUsageWindow | null
  sevenDay: AgentUsageWindow | null
}

/** usage null: the agent ended */
/** One thing in a chat view, made by main from the agent's transcript (src/agentChat/items.js) */
/** An agent answer pinned into a window of its own (src/agentChat/pins.js) */
export interface PinnedReply {
  text: string
  kind: AgentChatProvider | null
  title: string
  time: number | null
  pinnedAt: number
  folded: boolean
  maximized: boolean
}

/** An agent closed to save memory, resumed in its shell when woken (src/agentIdle.js) */
export interface CodexHookReview {
  count: number
  injectedCount: number
  declineSelected: boolean
  projectHooks?: boolean
}

export interface AgentSleep {
  kind: 'claude' | 'codex'
  since: number
  waking?: boolean
}

export interface AgentTurnLimitUsage {
  before: number
  after: number
  used: number
  reset?: true
}

/** Tokens one question used: input counts what came from the cache too; output counts thinking */
export interface AgentTurnUsage {
  input: number
  cached: number
  output: number
  durationMs?: number
  /** Account usage rates before and after the turn, with the increase in percentage points */
  limits?: { fiveHour?: AgentTurnLimitUsage; sevenDay?: AgentTurnLimitUsage }
}

type AgentChatSendResult = { ok: true } | { ok: false; reason?: string; error: string; recorded?: AgentChatItem; forceToken?: string }
export type AgentChatMcpSummary = { id: string; canLogin: boolean }

export interface AgentChatItem {
  id: string
  /** output: what a slash command printed (Claude's transcript, or read off Codex's screen) */
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'notice' | 'output'
  time: number | null
  /** When the user sent it from the chat, if the transcript recorded it later */
  sentAt?: number
  text?: string
  hasImage?: boolean
  inboxNotice?: boolean
  /** On a notice: the CLI reported an interrupted turn. */
  interrupted?: true
  /** On an output item: the command failed (Claude's stderr) */
  isError?: boolean
  /** On a slash command sent from the chat that no transcript records (Codex): what came of it */
  commandState?: 'done' | 'screen'
  /** On output read off Codex's screen: the command that produced it. */
  outputCommand?: string
  mcpSummary?: AgentChatMcpSummary
  /** On a user item: the tokens the turn it started used so far (src/agentChat/turnUsage.js) */
  usage?: AgentTurnUsage
  tool?: {
    name: string
    summary: string
    input: string
    result?: string
    isInbox?: boolean
    isError?: boolean
    diff?: string[]
    todos?: { text: string; status: 'completed' | 'in_progress' | 'pending' }[]
    /** Claude's AskUserQuestion: its questions (src/agentChat/askQuestions.js) */
    question?: { questions: AgentAskQuestion[] }
    /** Its answers once given, one per question (null: left unanswered) */
    answers?: (string | null)[]
  }
}

export interface AgentAskQuestion {
  question: string
  header: string
  multiSelect: boolean
  /** A choice's sketch (ASCII art, a snippet) shown while it is chosen */
  options: { label: string; description: string; preview?: string }[]
  /** Some choice has a preview (single choice only): no typed answer then */
  preview?: boolean
}

/** One answer from the chat's question card: choices by index, and a typed answer */
export interface AgentAskAnswer {
  picks: number[]
  other: string | null
}

/** The agent's prompt with numbered choices, as its terminal shows it (src/ipc/agentInboxWake.js) */
export interface AgentChatApproval {
  question: string | null
  detail: string[]
  options: { key: string; label: string }[]
  selected: string | null
  /** Input goes to the CLI's own question screen embedded in chat. */
  usesTerminalInput?: boolean
  /** A startup screen that only accepts input directly in the terminal. */
  terminalOnly?: 'folder-trust'
  /** Sent back with the answer: main answers only if the screen still shows this prompt */
  signature: string
}

/** waiting: the agent has written no transcript yet; ended: no agent runs in the shell any more */
export type AgentChatState = 'waiting' | 'live' | 'ended'

export type AgentChatImagesResult =
  | { ok: true; kind: 'images'; images: { id: string; preview: Uint8Array<ArrayBuffer> }[]; text?: string }
  | { ok: false; error: string }

export type CodexSpeedMode = 'fast' | 'ultrafast'

export interface CodexSpeedState {
  speed: 'standard' | CodexSpeedMode | 'flex' | null
  ultrafastAvailable: boolean
}

export interface AgentChatSubagent {
  id: string
  name: string
  task: string
  status: 'starting' | 'running' | 'completed' | 'error' | 'stopped' | 'unknown'
  startedAt: number | null
  finishedAt: number | null
  result: string
}

export interface AgentChatSubagentActivity {
  label: string
  detail: string
}

export interface AgentChatSubagentConversation {
  mode: 'direct' | 'relay' | 'select-parent' | 'read-only'
  scope: string
  messages: { id: string; role: 'user' | 'assistant'; text: string; time: number | null }[]
}

export interface AgentChatQuestion {
  id: string
  text: string
  time: number | null
  /** Received messages have a message ID of their own and point to the tool that read them. */
  itemId?: string
  sender?: string
  isReply?: boolean
}

export interface AgentChatQuestions {
  scope: string | null
  questions: AgentChatQuestion[]
  limited: boolean
}

export interface AgentChatQuestionContext {
  scope: string
  items: AgentChatItem[]
}

export interface AgentChatBackgroundShells {
  count: number
  jobs: { id: string; command: string; description: string }[]
}

export interface AgentChatFrame {
  shellId: string
  /** The view starts over with these items (a new conversation or the first read) */
  reset?: boolean
  scope?: string
  /** Opaque identity of the transcript, stable across reopening the same file. */
  transcriptId?: string
  /** Items from before what the view has */
  older?: boolean
  items?: AgentChatItem[]
  subagents?: AgentChatSubagent[]
  kind?: AgentChatProvider
  status?: LocalAgentStatus | null
  state?: AgentChatState
  title?: string | null
  hasOlder?: boolean
  /** The shell was closed: the view is dropped */
  gone?: boolean
  /** The prompt on screen now, or null when it went away */
  approval?: AgentChatApproval | null
  codexSpeed?: CodexSpeedState | null
  backgroundShells?: AgentChatBackgroundShells | null
}

export type AgentChatCapture = { shellId: string; id: string } & (
  | { time: number; text: string; previews: Uint8Array<ArrayBuffer>[]; imageIds: string[]; queued: boolean }
  | { discard: true }
)

export interface AgentUsageReport {
  agentId: string
  shellId: string | null
  usage: AgentUsage | null
}

/** `sleeping`: closed to save memory, resumed in its shell when woken (src/agentIdle.js) */
export type LocalAgentStatus = 'unknown' | 'starting' | 'idle' | 'working' | 'blocked' | 'error' | 'ended' | 'sleeping'

export interface AgentMessageSession {
  id: string
  shellId: string
  kind: AgentMessageKind
  claudeProfileId?: string
  cwd: string
  active: boolean
  status: LocalAgentStatus
  waitingForReply: boolean
  mcpConnected: boolean
  role?: string | null
  roleSource?: 'agent' | 'user' | null
  exitCode?: number | null
  /** Opaque key of the agent's conversation (main hashes it): where its card sits on the relationship map */
  layoutKey?: string | null
  /** Where `status` came from: the CLI's own hooks, or reading its screen. Absent when main cannot tell (T7) */
  statusSource?: 'hook' | 'screen'
}

/** A model or effort level the agent CLI's picker offers (src/ipc/agentPicker.js) */
export interface AgentPickerOption {
  label: string
  description: string
  current: boolean
}

export interface AgentMessage {
  id: string
  from: string
  to: string
  text: string
  replyTo?: string
  replyStatus?: 'completed' | 'deferred'
  /** Browser request as entered in the app, apart from the element context sent to the agent. */
  reviewRequest?: { text: string; url: string; selector: string; imageCount?: number }
  sentAt: number
  /** Handled: answered or acknowledged */
  read: boolean
  /** When the recipient agent took it from its inbox (the "읽음" its sender sees with check_sent) */
  seenAt?: number | null
}

export interface AgentMessagesSnapshot {
  revision: number
  agents: AgentMessageSession[]
  messages: AgentMessage[]
}

export interface BrowserReviewSelection {
  id: string
  url: string
  selector: string
  tag: string
  label: string
  text: string
  classes: string[]
  component?: string
  componentFile?: string
}

/** Where a browser tab was opened from: its project's agents come first in the element request */
export type BrowserReviewOpener = { folder: string } | { shellId: string }

export interface BrowserReviewProjects {
  projects: { folder: string; name: string; agentIds: string[] }[]
  /** The listed project the tab was opened from */
  preferred: string | null
}

export interface BrowserReviewState {
  url: string
  localFile?: string
  loginOrigin: string | null
  /** The page's title (empty until it arrives); the tab name follows it */
  title: string
  /** The page's developer tools window is open */
  devToolsOpen: boolean
  loading: boolean
  error: string
  picking: boolean
  selection: BrowserReviewSelection | null
  canGoBack: boolean
  canGoForward: boolean
  agents: Pick<AgentMessageSession, 'id' | 'kind' | 'cwd' | 'status'>[]
}

export type BrowserReviewAction =
  | { type: 'navigate'; address: string }
  | { type: 'back' | 'forward' | 'reload' | 'pick' | 'cancel' | 'devtools' }
  | { type: 'send'; agentId: string; text: string; selectionId: string; imageIds?: string[] }
  | { type: 'send-new'; kind: 'claude' | 'codex'; projectFolder?: string; text: string; selectionId: string; imageIds?: string[] }
export type BrowserReviewResult = { success: true } | { success: false; error: string; cancelled?: true }

export interface BrowserLoginAccount {
  id: string
  origin: string
  username: string
}

export interface BrowserLoginSource {
  id: 'chrome' | 'edge' | 'firefox'
  name: string
  profiles: { id: string; name: string }[]
}

export interface BrowserSavedPage {
  url: string
  title: string
}

export type BrowserBookmarkPage = BrowserSavedPage & { kind?: 'page'; local?: true }

export interface BrowserBookmarkFolder {
  kind: 'folder'
  id: string
  title: string
  children: BrowserBookmarkEntry[]
}

export type BrowserBookmarkEntry = BrowserBookmarkPage | BrowserBookmarkFolder

export interface BrowserVisit extends BrowserSavedPage {
  visitedAt: number
}

export type BrowserDataImportAction =
  | { type: 'sources' }
  | { type: 'read'; id: string; bookmarks: boolean; history: boolean }

export type BrowserImportCategory<T> = { entries: T[]; limited?: boolean } | { error: string }

export type BrowserDataImportResult = {
  success: true
  sources?: BrowserLoginSource[]
  bookmarks?: BrowserImportCategory<BrowserBookmarkEntry>
  history?: BrowserImportCategory<BrowserVisit>
} | { success: false; error: string }

export type BrowserLoginAction =
  | { type: 'list' | 'sources' | 'import' | 'clear-session' }
  | { type: 'open-source' | 'start-import'; id: string }
  | { type: 'finish-import' | 'copy-import-path' | 'cancel-import'; importId: string }
  | { type: 'save'; origin: string; username: string; password: string }
  | { type: 'fill'; id: string; origin: string }
  | { type: 'remove'; id: string }
  | { type: 'remember'; enabled: boolean }

export type BrowserLoginResult = {
  success: true
  accounts?: BrowserLoginAccount[]
  sources?: BrowserLoginSource[]
  autoImport?: boolean
  importId?: string
  rememberSession?: boolean
  sessionPersistent?: boolean
  imported?: number
  skipped?: number
} | { success: false; error: string }

export interface AgentMessageDelivery {
  id: string
  from: string
  to: string
  toShell?: string
}

export interface LocalWorktree {
  path: string
  branch: string | null
}

export interface LocalProjectInfo {
  repo: { root: string; branch: string | null; worktrees: LocalWorktree[] } | null
  gitMissing: boolean
}

export type NestedRepositoryStatus = {
  folder: string
  path: string
} & ({ error: string } | {
  error?: undefined
  branch: string | null
  hasUpstream: boolean
  upstreamGone: boolean
  ahead: number
  behind: number
  changed: number
  fetchError?: string
})

export type NestedRepositoryPullResult = { folder: string } & (
  { kind: 'queued' | 'running' }
  | { kind: 'received'; count: number; status: NestedRepositoryStatus }
  | { kind: 'skipped'; reason: string; message: string; status?: NestedRepositoryStatus }
  | { kind: 'failed'; message: string }
)

export interface NestedRepositoryGroup {
  root: string
  manualOnly?: boolean
  repositories: NestedRepositoryStatus[]
}

export interface NestedRepositoryBranch {
  name: string
  remote?: string
  current: boolean
}

interface NestedRepositoryRequest {
  project: string
  root: string
  folder: string
}

export interface NestedRepositoryPreferences {
  autoFetchEnabled: boolean
}

export interface NestedRepositoryTrust extends NestedRepositoryPreferences {
  trusted: boolean
}

interface NestedRepositoryProjectRequest {
  project: string
  roots: string[]
  excluded: string[]
}

type NestedRepositoryProjectResult =
  | ({ success: true; groups: NestedRepositoryGroup[] } & NestedRepositoryTrust)
  | { success: false; error: string }

export interface LocalDevelopmentTask {
  id: string
  name: string
  relative: string
  command: string
  installCommand?: string
  includeSource: boolean
}

export interface LocalDevelopmentRun {
  taskId: string
  name: string
  label: string
  status: 'starting' | 'running' | 'stopping' | 'exited'
  exitCode: number | null
  url: string | null
}

export interface WorkspaceDirectoryEntry {
  name: string
  kind: 'directory' | 'file' | 'link'
}

export interface WorkspaceDirectorySearchResult {
  entries: (WorkspaceDirectoryEntry & { path: string })[]
  truncated: boolean
  /** Installed/generated folders (node_modules, build…) the default search lists but does not read */
  skipped?: { count: number; names: string[] }
  /** The search read those folders too */
  includedAll?: boolean
}

/** 프로젝트 검색's content search (src/localFiles/contentSearch.js): lines per file, paths relative with / */
export interface WorkspaceContentSearchResult {
  engine: 'git' | 'scan'
  files: { path: string; matches: { line: number; text: string }[] }[]
  /** A limit was reached (lines, files, lines per file, time): there is more */
  truncated: boolean
}

export interface WorkspaceGitCommit {
  hash: string
  shortHash: string
  parents: string[]
  author: string
  time: string
  subject: string
  refs: string[]
}

export interface WorkspaceGitRepository {
  root: string
  head: string | null
  branch: string | null
  worktrees: LocalWorktree[]
  nestedRepositories: string[]
  allBranches: boolean
  commits: WorkspaceGitCommit[]
  hasMore: boolean
}

export type WorkspaceGitSearchResult = Pick<WorkspaceGitRepository, 'commits' | 'hasMore'>

export type WorkspaceGitFileKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'conflict' | 'untracked'

/** A changed file, its path relative to the repository top (forward slashes) */
export interface WorkspaceGitFile {
  path: string
  kind: WorkspaceGitFileKind
  from?: string
}

export interface WorkspaceGitStatus {
  top: string
  staged: WorkspaceGitFile[]
  changed: WorkspaceGitFile[]
  untracked: WorkspaceGitFile[]
  truncated: boolean
  /** Lines [added, removed] per path against HEAD (null: binary or not counted) */
  stats?: Record<string, [number | null, number | null]>
  branch?: string | null
  upstream?: string | null
}

export interface WorkspaceGitDiff {
  text: string
  truncated: boolean
  binary?: boolean
}

export type JdkVendor = 'temurin' | 'zulu' | 'jbr'

/** A run preset of a local project (docs/plan/2026-11-25-local-project-run.md): main keeps them in userData */
export interface RunPreset {
  id: string
  name: string
  relative: string
  kind: 'task' | 'custom' | 'tomcat'
  taskId?: string
  /** Shown only: main runs the saved command */
  command?: string
  jdk: string | 'system'
  env: Record<string, string>
  notify: boolean
  agentControl: boolean
  inAll: boolean
  waitReady: boolean
  /** Applying saved Java changes to the running server (stage 3): Spring Boot tasks and Tomcat. Missing in old files: off */
  hotReload?: HotReload
  mavenMirrors?: { repositoryId: string; url: string }[]
  mavenUserSettings?: false
  mavenRunner?: string
  /** Missing uses the Java version of the project to choose whether to split. */
  mavenSplit?: boolean
  mavenPin?: boolean
  mavenSource?: 'online' | 'pinned'
  // kind 'tomcat' (stage 2): main runs `catalina run` with a CATALINA_BASE of its own for the preset
  /** The store's (or a found) Tomcat id */
  tomcat?: string
  /** The unpacked web folder with WEB-INF, from the project root */
  webapp?: string
  /** '/' or '/name' */
  contextPath?: string
  /** HTTP port for Tomcat (default 8080) or Spring Boot (optional override). */
  port?: number
  /** JVM arguments on one line for Tomcat or Spring Boot, confirmed before use. */
  vmArgs?: string
  /** The build before the server (run in `relative`) */
  prepare?: RunPrepare
  /** Tomcat: an existing context.xml (JNDI) main reads at each run; its passwords are never saved here */
  contextXml?: string
  /** Tomcat: jars added to /WEB-INF/lib (approved from a missing-class diagnosis) */
  extraLibs?: string[]
  /** How the server's output is read (every kind); missing: auto */
  logEncoding?: LogEncoding
}

/** `eclipse`: compile with the Eclipse project's settings (.classpath), for a project whose build.xml is missing or broken */
export type LogEncoding = 'auto' | 'utf-8' | 'ms949'

/** A server of an Eclipse workspace (Servers/<name>-config, its .launch VM arguments), to fill a Tomcat preset */
export interface WorkspaceServer {
  name: string
  port?: number
  vmArgs?: string
  contextPath?: string
  /** The server's context.xml, as the preset keeps it */
  contextXml?: string
}

/** A jar that holds a missing class (a candidate of the tomcatJar suggestion) */
export interface JarCandidate {
  /** Opaque: sent back to approve it */
  id: string
  /** For the user to read: from the project, or shortened like ~/.m2/… */
  path: string
  coordinate?: string | null
  source?: 'project' | 'maven' | 'gradle'
}

export type RunPrepare = { tool: 'ant'; target: string } | { tool: 'maven'; goals: string } | { tool: 'eclipse' }

/**
 * What main read from an Eclipse project: fills the dialog, saved only by the user. Paths are from the
 * Eclipse project's folder (the preset's `relative`), not the worktree.
 */
export interface EclipseImportDraft {
  webapp: string
  contextPath: string
  /** Compile version, e.g. 8 (main reads it again at each run) */
  release?: number | string
  /** Source encoding; missing when the project does not say */
  encoding?: string
  sources: string[]
  libs: string[]
}

export type HotReload = 'off' | 'standard' | 'enhanced'

/** The last thing the hot reload of a running preset did (stage 3 contract) */
export interface RunReload {
  status: 'watching' | 'compiling' | 'applied' | 'restartNeeded' | 'compileError' | 'failed'
  /** applied: the classes changed (including ones not loaded yet) */
  classes?: number
  /** restartNeeded, compileError, failed: one line, without ports or paths */
  reason?: string
  /** Spring Boot DevTools restarts the app instead */
  devtools?: true
  at: number
}

/** `preparing`: the build before the server (a Tomcat preset's prepare) */
/** A saved choice of a project's presets to start and stop together; the order is the project's start order */
export interface RunBundle {
  id: string
  /** 1 to 20 characters */
  name: string
  presetIds: string[]
}

export type RunStatus = 'idle' | 'preparing' | 'starting' | 'running' | 'stopped' | 'crashed'

export interface RunAction {
  /** 'user' or the agent id that did it */
  by: string
  action: 'start' | 'restart' | 'stop'
  at: number
}

export interface RunProposal {
  id: string
  by: string
  at: number
  note: string
  suggestion: {
    id: string
    apply: 'mavenMirror' | 'mavenUserSettings' | 'tomcatJar'
    replacementUrl?: string
    jarId?: string
    repositoryId?: string
    className?: string
  }
}

export interface RunState {
  status: RunStatus
  exitCode?: number | null
  address?: string
  startedAt?: number
  readyAt?: number
  errors: number
  /** The shell the server runs in: the screen finds its tab and pane by it */
  shellId?: string
  lastAction?: RunAction
  reload?: RunReload
  /** Pending proposals for this run, newest first */
  proposals?: RunProposal[]
  /** crashed: the build before the server failed (the server was not started) */
  failedAt?: 'prepare'
}

export interface RunCandidate {
  taskId: string
  name: string
  command: string
}

export interface RunErrorGroup {
  at: number
  lines: string[]
}

export interface RunSuggestion {
  id: string
  kind: 'missingClass' | 'jdkVersion' | 'jndi' | 'sourceEncoding' | 'portInUse' | 'mavenHttpBlocked'
    | 'mavenRepositoryUnavailable' | 'mavenUnauthorized' | 'mavenTls' | 'mavenArtifactMissing' | 'mavenPluginJdk' | 'mavenUserMirror'
    | 'mavenPinnedAvailable' | 'mavenObsoleteJvmOption'
  message: string
  apply?: 'mavenMirror' | 'mavenUserSettings' | 'tomcatJar' | 'mavenPinned' | 'mavenRunner'
  /** tomcatJar: the jars found with the missing class */
  jars?: JarCandidate[]
  /** tomcatJar: some places could not be searched to the end (limits) */
  jarSearchIncomplete?: boolean
  repositoryId?: string
  mirrorId?: string
  reason?: 'notFound' | 'unknownHost'
  artifact?: string
  className?: string
  requiredFeature?: number | null
  classMajor?: number
  preview?: true
  name?: string
  encoding?: string
  port?: number | null
  settingsFlag?: '-s'
  requiresApproval?: true
}

/** Every run preset answer: `{ ok: false, error }` on failure, or a question to ask the user first */
export interface RunPresetResult {
  ok: boolean
  error?: string
  needsConfirm?: { command: string }
  needsInstall?: { command: string }
  needsDependencies?: string[]
}

export type RunPresetOptions = { confirmCustom?: true; confirmInstall?: true; dependencies?: 'include' | 'only' }

export type RunStageGate = { kind: 'none' | 'ready' } | { kind: 'log' | 'url'; value: string }
export interface RunStartOrder {
  stages: { ids: string[]; gate: RunStageGate }[]
  timeoutSeconds: number
  onTimeout: 'pause' | 'continue'
  reverseStop: boolean
  askDependencies: boolean
}

export type RunStartProgress = { index: number; total: number; stages: string[][] } & (
  | { status: 'starting' }
  | { status: 'waiting'; gate: RunStageGate; since: number; ids: string[] }
  | { status: 'paused'; reason: 'timeout' | 'exited' | 'startFailed'; ids: string[]; error?: string }
  | { status: 'cancelled'; reason: 'cancelled' }
)

export interface JdkRuntime {
  id: string
  vendor: string
  version: string
  feature: number
  arch: string
  managed: boolean
  sizeBytes?: number
  folder?: string
}

export type JdkBuild = Pick<JdkRuntime, 'id' | 'version' | 'feature' | 'arch' | 'sizeBytes'> & { vendor: JdkVendor; licenseUrl: string }
export interface HotswapAgentStatus {
  installed: boolean
  version?: string
}
export type DevelopmentTool = 'tomcat' | 'maven' | 'ant' | 'gradle' | 'node'
export interface ToolRuntime {
  id: string
  tool: DevelopmentTool
  version: string | null
  series: string | null
  managed: boolean
  folder?: string
  sizeBytes?: number
}
export type ApacheToolRuntime = ToolRuntime
export type ToolBuild = { id: string; tool: DevelopmentTool; version: string; series: string; licenseUrl: string }
type ToolResult = { ok: true; tool: ToolRuntime } | { ok: false; error?: string; cancelled?: true }
export interface JdkProgress {
  vendor: JdkVendor | 'hotswap-agent' | DevelopmentTool
  feature: number | null
  phase: 'lookup' | 'download' | 'unpack'
  received: number
  total: number | null
}

export interface OracleClientProgress {
  step: 'download' | 'unpack'
  received: number
  total: number
}

/** Oracle's client libraries (Instant Client), needed for Oracle servers older than 12.1 */
export interface OracleClientStatus {
  success: true
  /** Windows x64 only */
  isSupported: boolean
  isInstalled: boolean
  version: string
  /** Size of the download */
  bytes: number
  licenseUrl: string
  progress: OracleClientProgress | null
  /** Installed, but this run already made an Oracle connection without them: applies after a restart */
  needsRestart: boolean
  /** Loaded by this run (the files cannot be removed until the app restarts) */
  isInUse: boolean
}

/** A QR code as its cells, drawn by the page (no image URL: the page's CSP allows none) */
export interface QrMatrix {
  size: number
  /** size * size cells, row by row; 1 = dark */
  cells: number[]
}

export interface RemoteAccessDevice {
  id: string
  name: string
  /** The device asked to be notified of MCP questions */
  hasPush?: boolean
  createdAt?: number
  lastSeenAt?: number | null
}

export interface RemoteAccessStatus {
  success: true
  enabled: boolean
  /** MCP questions also go to signed-in devices and wait up to five minutes for an answer */
  answerMcp: boolean
  /** A signed-in device may follow the PC's SSH tabs. Off by default. */
  tabs?: boolean
  browserReview?: boolean
  /** A signed-in device may use the PC's agents (list, chat, send, answer); off by default */
  agents?: boolean
  isRunning: boolean
  hasTailscale: boolean
  /** The address a phone opens, when it is listening */
  url: string | null
  /** Phone notifications: possible only over HTTPS (a Tailscale certificate); `note` says what is missing */
  push?: { available: boolean; note: string | null }
  devices: RemoteAccessDevice[]
  connected: RemoteAccessDevice[]
  error: string | null
}

declare global {
  interface Window {
    electronAPI: {
      startupReady?: () => void
      // Window controls
      minimizeWindow: () => void
      /** See-through window, 0.5 to 1 (main clamps). Missing in an app built before it existed */
      setWindowOpacity?: (opacity: number) => void
      /** Glass: what settings chose, kept by main for the next start */
      setAppearance?: (value: { surface: 'flat' | 'glass'; scheme: 'light' | 'dark' }) => void
      setQuickCaptureTheme?: (theme: import('./theme').QuickCaptureTheme) => void
      /** Glass: whether acrylic is behind this window now, and whether this system can draw it */
      getBackdrop?: () => Promise<{ active: boolean; supported: boolean }>
      /** Popped-out SFTP window: reports the folders it shows now */
      sftpWindowPaths?: (sessionId: string, localPath: string, remotePath: string) => void
      /** Main window: a popped-out SFTP window closed (with the folders it last showed, when known) */
      onSftpWindowClosed?: (callback: (info: { sessionId: string; localPath?: string; remotePath?: string }) => void) => () => void
      /** A double press in a glass window, in physical pixels of the window (see lib/captionDoubleClick.ts) */
      onCaptionDoubleClick?: (callback: (point: { x: number; y: number }) => void) => () => void
      maximizeWindow: () => void
      closeWindow: () => void
      toggleFullscreen: () => Promise<void>
      showWorkOverview: (requestId?: number) => Promise<{ backdrop: Uint8Array<ArrayBuffer> | null } | null>
      hideWorkOverview: () => void
      setWorkOverviewKey?: (keys: string[]) => void
      setQuickCaptureKeys?: (keys: [string[], string[]]) => void
      startQuickCapture?: () => void
      /** The app's pointer set in other programs (Windows only; main checks each PNG). false: refused */
      pointerSystemApply?: (request: { size: number; cursors: { state: string; png: string; hotspot: [number, number] }[] }) => Promise<boolean>
      pointerSystemRestore?: () => Promise<void>
      pointerEffectsConfigure?: (request: DesktopPointerConfig) => Promise<boolean>
      onWorkOverviewRequest?: (callback: (requestId: number) => void) => () => void
      setShortcutRecording?: (recording: boolean) => void

      // SSH
      sshConnect: (config: any) => Promise<any>
      sshTestConnection: (config: any) => Promise<SshConnectionTestResult>
      sshSend: (sessionId: string, data: string) => void
      sshDisconnect: (sessionId: string) => void
      sshResize: (sessionId: string, cols: number, rows: number) => void
      onSshData: (callback: (data: any) => void) => () => void
      onSshClosed: (callback: (data: any) => void) => () => void

      // SSH reconnection
      onSshStateChanged: (callback: (data: any) => void) => void
      onSshReconnecting: (callback: (data: { sessionId: string; attempt: number; maxAttempts: number }) => void) => (() => void) | void
      onSshReconnected: (callback: (data: { sessionId: string }) => void) => (() => void) | void
      onSshReconnectFailed: (callback: (data: { sessionId: string; message?: string }) => void) => (() => void) | void
      sshCancelReconnect: (sessionId: string) => Promise<any>
      /** Connect a dropped tab again the way it first connected, under the same session id */
      sshReconnectNow?: (sessionId: string) => Promise<{ success: boolean; error?: string; rootSwitch?: RootSwitchOutcome }>

      // Split terminal (independent shell channels)
      sshCreateShell: (sessionId: string) => Promise<{ success: boolean; streamId?: string; error?: string }>
      sshSplitSend: (streamId: string, data: string) => void
      sshSplitResize: (streamId: string, cols: number, rows: number) => void
      sshSplitClose: (streamId: string) => void
      /** Opens a log window for a container that was in the tab's last list */
      containerLogOpen?: (sessionId: string, sessionName: string, name: string) => Promise<{ success: true } | { success: false; error: string }>
      /** Docker containers of the tab's server (asked only while the container panel is open) */
      containerList?: (sessionId: string, all: boolean) => Promise<import('../lib/containers').ContainerListResult>
      /** A split shell becomes a tab of its own; answers with the new tab's session id */
      sshAdoptSplit: (streamId: string) => Promise<{ success: boolean; sessionId?: string; error?: string }>
      sshPromotePane?: (sessionId: string, streamId: string, closePrevious?: boolean) => Promise<{ success: boolean; sessionId?: string; error?: string }>
      sshResumePromotedPane?: (sessionId: string, streamId: string) => void
      sshMergeTab?: (sourceId: string, targetId: string) => Promise<{ success: boolean; streamId?: string; error?: string }>
      onSshSplitData: (callback: (data: any) => void) => () => void
      onSshSplitClosed: (callback: (data: any) => void) => () => void

      // Command execution
      sshExecCommand: (sessionId: string, command: string) => Promise<any>

      // Private Key
      selectPrivateKey: () => Promise<{ success: boolean; path?: string }>

      // SFTP
      /** `alreadyOpen`: the tab's SFTP channel was open already (nothing was connected now) */
      sftpOpen: (sessionId: string) => Promise<{ success: boolean; alreadyOpen?: boolean }>
      sftpClose: (sessionId: string) => Promise<any>
      sftpList: (sessionId: string, remotePath: string) => Promise<any>
      sftpDownload: (sessionId: string, remotePath: string, localPath: string) => Promise<any>
      sftpUpload: (sessionId: string, localPath: string, remotePath: string) => Promise<any>
      sftpDelete: (sessionId: string, remotePath: string, isDirectory: boolean) => Promise<any>
      /** Entries read so far while a big folder is being listed */
      onSftpListProgress?: (callback: (data: { sessionId: string; remotePath: string; count: number }) => void) => () => void
      sftpStat?: (sessionId: string, remotePath: string) => Promise<{ isFile: boolean; isDirectory: boolean; size: number } | null>
      sftpRealpath?: (sessionId: string, remotePath: string) => Promise<string>
      sftpRename: (sessionId: string, oldPath: string, newPath: string) => Promise<any>
      sftpMkdir: (sessionId: string, remotePath: string) => Promise<any>
      selectDownloadPath: (defaultName: string) => Promise<any>
      selectUploadFiles: () => Promise<any>
      onSftpProgress: (callback: (data: any) => void) => void

      // Transfer Queue
      sftpQueueDownload: (sessionId: string, remotePath: string, localPath: string) => Promise<any>
      sftpQueueUpload: (sessionId: string, localPath: string, remotePath: string) => Promise<any>
      sftpUploadDirectory?: (sessionId: string, localDir: string, remoteDir: string) => Promise<{ success: boolean; uploadedFiles: string[] }>
      /** Downloads a remote folder with everything in it; `skipped` lists what was left out (links, names this PC cannot take) */
      sftpDownloadDirectory?: (sessionId: string, remoteDir: string, localDir: string) => Promise<{ success: boolean; files: number; folders: number; skipped: string[] }>
      sftpTransferPause: (sessionId: string, transferId: string) => Promise<any>
      sftpTransferResume: (sessionId: string, transferId: string) => Promise<any>
      sftpTransferRetry: (sessionId: string, transferId: string, overwrite?: boolean) => Promise<{ success: boolean; needsOverwrite?: boolean; error?: string }>
      sftpTransferCancel: (sessionId: string, transferId: string, failedOnly?: boolean) => Promise<any>
      sftpQueueClearCompleted: (sessionId: string) => Promise<any>
      sftpGetQueue: (sessionId: string) => Promise<any>
      // Unsubscribe function; absent on preloads built before it was added
      onSftpQueueUpdate: (callback: (data: any) => void) => (() => void) | void
      onSftpTransferProgress: (callback: (data: any) => void) => (() => void) | void

      // Local file system
      localList: (dirPath: string) => Promise<any>
      /** `resume`: a key from the agent history list; main then picks the folder, agent and session */
      localShellOpen?: (options: { cols: number; rows: number; cwd?: string; agent?: AgentChatProvider; resume?: string; replacementFor?: string; restoring?: true; claudeProfileId?: string; reuseClaudeProfile?: true }) => Promise<{ success: true; id: string; name: string; cwd?: string; reused?: true } | { success: false; error: string }>
      claudeProfilesList: () => Promise<ClaudeProfilesResult>
      claudeProfileSave: (request: { id?: string; name: string }) => Promise<ClaudeProfilesResult>
      onLocalAgentRequestOpened: (callback: (opened: { id: string; name: string; cwd: string; workspaceLabel: string }) => void) => () => void
      localProjectInspect: (folder: string) => Promise<({ success: true } & LocalProjectInfo) | { success: false; error: string }>
      localProjectDevelopmentTasks: (folder: string) => Promise<{ success: true; tasks: LocalDevelopmentTask[] } | { success: false; error: string }>
      localProjectOpenFolder?: (folder: string) => Promise<{ success: true } | { success: false; error: string }>
      localNestedRepositoriesStatus?: (request: NestedRepositoryProjectRequest & { fetch: boolean }) => Promise<NestedRepositoryProjectResult>
      localNestedRepositoriesFetch?: (request: NestedRepositoryProjectRequest) => Promise<NestedRepositoryProjectResult>
      localNestedRepositoriesPreferences?: (enabled?: boolean) =>
        Promise<({ success: true } & NestedRepositoryPreferences) | { success: false; error: string }>
      localNestedRepositoriesTrust?: (request: { project: string; enabled: boolean }) =>
        Promise<({ success: true } & NestedRepositoryTrust) | { success: false; error: string }>
      localNestedRepositoriesPull?: (request: { project: string; root: string; folders: string[]; requestId: string }) =>
        Promise<{ success: true; results: NestedRepositoryPullResult[] } | { success: false; error: string }>
      localNestedRepositoryBranches?: (request: NestedRepositoryRequest) =>
        Promise<{ success: true; branches: NestedRepositoryBranch[] } | { success: false; error: string }>
      localNestedRepositorySwitchBranch?: (request: NestedRepositoryRequest & { branch: Pick<NestedRepositoryBranch, 'name' | 'remote'> }) =>
        Promise<{ success: true; status: NestedRepositoryStatus } | { success: false; error: string }>
      onLocalNestedRepositoriesProgress?: (callback: (progress: { requestId: string; result: NestedRepositoryPullResult }) => void) => () => void
      localProjectDevelopmentStart: (options: { folder: string; id: string; cols: number; rows: number; includeSource: boolean; install: boolean }) =>
        Promise<{ success: true; id: string; name: string; cwd: string; label: string; development: LocalDevelopmentRun } | { success: false; error: string }>
      localProjectDevelopmentChange: (options: { shellId: string; taskId: string; action: 'restart' | 'stop' }) =>
        Promise<{ success: true } | { success: false; error: string }>
      onLocalShellDevelopmentState?: (callback: (event: { id: string; development: LocalDevelopmentRun | null }) => void) => () => void
      workspaceDirectoryList: (folder: string, relative?: string) => Promise<{ success: true; entries: WorkspaceDirectoryEntry[]; total: number } | { success: false; error: string }>
      workspaceDirectoryPrepare?: (root: string, refresh?: boolean, includeAll?: boolean) => Promise<{ success: true } | { success: false; error: string }>
      workspaceDirectorySearch?: (root: string, query: string, includeAll?: boolean) => Promise<({ success: true } & WorkspaceDirectorySearchResult) | { success: false; error: string }>
      workspaceContentSearch?: (root: string, query: string, caseSensitive?: boolean) => Promise<({ success: true } & WorkspaceContentSearchResult) | { success: false; error: string }>
      workspaceGitStatus?: (root: string) => Promise<{ success: true; repo: WorkspaceGitStatus | null } | { success: false; error: string }>
      workspaceGitCommitFiles?: (root: string, hash: string) => Promise<{ success: true; files: WorkspaceGitFile[] } | { success: false; error: string }>
      workspaceGitDiff?: (root: string, file: string, hash?: string) => Promise<({ success: true } & WorkspaceGitDiff) | { success: false; error: string }>
      /** Commits the ticked files of the change list (paths relative to the repository top) */
      workspaceGitCommit?: (root: string, files: string[], message: string) => Promise<{ success: true; hash: string; shortHash: string; count: number; warning?: string } | { success: false; error: string }>
      /** A file on this PC in the file window; `relative` is relative to `root` */
      localFileOpen?: (root: string, relative: string, mode: 'edit' | 'preview', label?: string, options?: { compareHead?: boolean; line?: number }) => Promise<{ success: true } | { success: false; error: string }>
      localFileReveal?: (root: string, relative: string) => Promise<{ success: true } | { success: false; error: string }>
      workspaceGitLog: (folder: string, allBranches?: boolean) => Promise<{ success: true; repo: WorkspaceGitRepository } | { success: true; repo: null; reason: 'git-missing' | 'not-repo' } | { success: false; error: string }>
      workspaceGitSearch?: (root: string, query: string, worktreeOnly?: boolean) => Promise<({ success: true } & WorkspaceGitSearchResult) | { success: false; error: string }>
      agentHistorySearch?: (shellId: string, query: string) => Promise<{ success: true; matches: { key: string; snippet: string }[] } | { success: false; cancelled?: boolean; error: string }>
      agentHistoryList?: (shellId: string) => Promise<{ success: true; project: string; sessions: AgentHistorySession[] } | { success: false; error: string }>
      agentHistoryDetail?: (shellId: string, key: string) => Promise<({ success: true } & AgentHistoryDetail) | { success: false; error: string }>
      agentHistoryOpenFolder?: (shellId: string, key: string) => Promise<{ success: true } | { success: false; error: string }>
      onAgentHistoryRolesChanged?: (callback: () => void) => () => void
      localWorktreeCreate: (options: { folder: string; branch: string; base: string }) => Promise<({ success: true } & LocalWorktree) | { success: false; error: string }>
      localShellAttach?: (id: string) => Promise<{ backlog: string; exited: boolean; exitCode: number | null; inboxDraftBlocked?: boolean; development?: LocalDevelopmentRun } | null>
      onLocalShellInboxDraft?: (callback: (notice: { id: string; blocked: boolean }) => void) => () => void
      /** Shells main still runs, for a reloaded window to take back as tabs */
      localShellList?: () => Promise<Array<{ id: string; name: string; exited: boolean; cwd: string | null; agent: AgentChatProvider | null; development?: LocalDevelopmentRun }>>
      /** Before restarting for an update: the tab layout of the local shells, kept for the next window */
      localShellKeepLayout?: (layout: unknown[]) => Promise<void>
      /** After that restart: the layout, once (null when no shell was kept) */
      localShellKeptLayout?: () => Promise<unknown[] | null>
      localShellCurrentDirectory: (id: string) => Promise<string | null>
      localShellClipboard?: (id: string) => Promise<{ success: true; text: string } | { success: false; error: string }>
      localShellHasWorkingAgent?: (ids: string[]) => Promise<boolean>
      agentMessagesSnapshot: () => Promise<AgentMessagesSnapshot | null>
      agentMessageSetRole: (id: string, role: string) => Promise<{ success: true } | { success: false; error: string }>
      browserReviewOpen: () => Promise<{ success: true; id: string } | { success: false; error: string }>
      browserReviewOpenWorkspace: (root: string, relative: string) => Promise<BrowserReviewResult>
      browserReviewOpenLink: (address: string, destination: 'internal' | 'external', opener?: BrowserReviewOpener) => Promise<BrowserReviewResult>
      browserReviewProjects: (id: string) => Promise<BrowserReviewProjects | null>
      onBrowserReviewLinkOpened: (callback: (id: string) => void) => () => void
      browserReviewState: (id: string) => Promise<BrowserReviewState | null>
      browserReviewAction: (id: string, request: BrowserReviewAction) => Promise<BrowserReviewResult>
      browserReviewAddImages: (id: string, source: 'clipboard' | 'files') => Promise<AgentChatImagesResult | { ok: true; kind: 'text'; text: string }>
      browserReviewRemoveImage: (id: string, imageId: string) => void
      browserReviewLogins: (id: string, request: BrowserLoginAction) => Promise<BrowserLoginResult>
      browserReviewImportData: (id: string, request: BrowserDataImportAction) => Promise<BrowserDataImportResult>
      browserReviewBounds: (id: string, bounds: { x: number; y: number; width: number; height: number } | null) => void
      browserReviewClose: (id: string) => void
      onBrowserReviewState: (callback: (id: string, state: BrowserReviewState) => void) => () => void
      onBrowserReviewFocus: (callback: (id: string) => void) => () => void
      agentMessageMcpSetup: (kind: LocalAgent) => Promise<
        { success: true; result: 'added' | 'unchanged' | 'conflict' } | { success: false; error: string }
      >
      agentMessageMcpExternal: (action: 'read' | 'copy-command' | 'copy-env') => Promise<
        { success: true; environment: string } | { success: false; error: string }
      >
      onAgentMessagesState: (callback: (snapshot: AgentMessagesSnapshot) => void) => () => void
      agentUsageState?: () => Promise<AgentUsageReport[]>
      onAgentUsage?: (callback: (report: AgentUsageReport) => void) => () => void
      onAgentMessageDelivered: (callback: (delivery: AgentMessageDelivery) => void) => () => void
      onAgentEscalation?: (callback: (notice: { id: string; shellId: string; title: string; label: string }) => void) => () => void
      localShellWrite?: (id: string, data: string) => void
      localShellComposing?: (id: string, value: boolean) => void
      localShellResize?: (id: string, cols: number, rows: number) => void
      localShellClose?: (id: string) => void
      localShellCodexHookReview?: (id: string) => Promise<CodexHookReview | null>
      localShellDeclineCodexHooks?: (id: string) => Promise<boolean>
      onCodexHooksDeclined?: (callback: () => void) => () => void
      onLocalShellCodexHookReview?: (callback: (data: { id: string; review: CodexHookReview | null }) => void) => () => void
      onLocalShellData?: (callback: (data: { id: string; data: string }) => void) => () => void
      onLocalShellExit?: (callback: (data: { id: string; exitCode: number | null }) => void) => () => void
      agentIdleConfigure?: (config: { trimMinutes: number; sleepMinutes: number }) => Promise<{ trimMinutes: number; sleepMinutes: number } | null>
      agentHooksConfigure?: (config: { enabled: boolean; resetCodexDecline?: true }) => Promise<{ success: boolean; codexMode?: 'pending' | 'approved' | 'disabled' }>
      localShellSleeping?: () => Promise<{ id: string; sleeping: AgentSleep }[]>
      localShellWake?: (id: string) => Promise<{ ok: boolean; reason?: string }>
      localShellStayAwake?: (id: string) => Promise<boolean>
      onLocalShellSleep?: (callback: (data: { id: string; sleeping: AgentSleep | null; failed?: boolean }) => void) => () => void
      agentChatOpen?: (shellId: string) => Promise<{ ok: true } | { ok: false; error: string }>
      agentChatCopy?: (shellId: string) => Promise<{ ok: true; items: AgentChatItem[] } | { ok: false; error: string }>
      agentChatSubagentPreview?: (shellId: string, agentId: string) => Promise<AgentChatSubagentActivity[]>
      agentChatSubagentConversation?: (shellId: string, agentId: string) => Promise<AgentChatSubagentConversation | null>
      agentChatSubagentSend?: (request: { shellId: string; agentId: string; scope: string; text: string; mode: 'direct' | 'relay' }) => Promise<{ ok: true } | { ok: false; error: string }>
      agentChatOlder?: (shellId: string) => Promise<void>
      agentChatQuestions?: (shellId: string) => Promise<({ ok: true } & AgentChatQuestions) | { ok: false; error: string }>
      agentChatQuestionContext?: (request: { shellId: string; scope: string; id: string }) => Promise<({ ok: true } & AgentChatQuestionContext) | { ok: false; error: string }>
      agentChatClose?: (shellId: string) => void
      agentChatReadClipboard?: (shellId: string) => Promise<
        { ok: true; kind: 'text'; text: string } | AgentChatImagesResult
      >
      agentChatPickImages?: (shellId: string) => Promise<AgentChatImagesResult>
      agentChatPreviewImage?: (shellId: string, imageId: string) => Promise<{ ok: true; data: Uint8Array<ArrayBuffer> } | { ok: false; error: string }>
      agentChatRemoveImage?: (shellId: string, imageId: string) => void
      agentChatSend?: (shellId: string, text: string, imageIds?: string[], retry?: { acceptedAt: number; transcriptId: string; ignoreIds: string[] }, forceToken?: string) => Promise<AgentChatSendResult>
      agentChatMcpLogin?: (shellId: string, summaryId: string, server: string) => Promise<AgentChatSendResult>
      agentChatMcpVerbose?: (shellId: string, summaryId: string) => Promise<AgentChatSendResult>
      agentChatToggleSpeed?: (shellId: string, speed: CodexSpeedMode) => Promise<{ ok: true } | { ok: false; reason?: string; error: string }>
      agentChatInterrupt?: (shellId: string) => Promise<boolean>
      /** After Esc: clears the CLI composer if it holds exactly these chat lines */
      agentChatTakeBack?: (shellId: string, texts: string[]) => Promise<{ ok: boolean; reason?: string }>
      agentChatAnswer?: (shellId: string, key: string, signature: string) => Promise<{ ok: true } | { ok: false; reason?: string; error: string }>
      agentChatAnswerQuestions?: (shellId: string, itemId: string, answers: AgentAskAnswer[]) => Promise<{ ok: true } | { ok: false; reason?: string; error: string }>
      /** After a slash command was sent: it ran (output: what Codex printed), asks a question, or opened a screen */
      agentChatCommandWatch?: (shellId: string) => Promise<{ ok: true; state: 'done' | 'approval' | 'screen' | 'gone'; screen?: 'claude-login'; output?: string; mcpSummary?: AgentChatMcpSummary } | { ok: false; error: string }>
      agentChatScreenState?: (shellId: string) => Promise<{ composer: 'empty' | 'draft' | null; approval: boolean; loginStage?: 'active' | 'continue' } | null>
      /** The slash commands the user made for the agent (its folders' commands, skills, prompts) */
      agentChatSlashCommands?: (shellId: string) => Promise<{ name: string; description: string; source: 'user' | 'project' }[]>
      agentPickerList?: (shellId: string, what: 'model' | 'effort') => Promise<
        | { ok: true; options: AgentPickerOption[] }
        | { ok: false; reason?: string; error: string }
      >
      agentPickerApply?: (shellId: string, what: 'model' | 'effort', label: string) => Promise<
        | { ok: true; options?: AgentPickerOption[] }
        | { ok: false; reason?: string; error: string; options?: AgentPickerOption[] }
      >
      agentChatOpenLink?: (shellId: string, href: string, how: 'app' | 'explorer' | 'browser' | 'browser-tab' | 'workspace') => Promise<{ ok: true; folder?: string } | { ok: false; error: string }>
      agentChatLinkPreview?: (shellId: string, link: string) => Promise<ChatLinkPreviewResult>
      onAgentChatFrame?: (callback: (frame: AgentChatFrame) => void) => () => void
      onAgentChatCapture?: (callback: (capture: AgentChatCapture) => void) => () => void
      agentChatPin?: (request: { shellId: string; itemId: string; text: string; kind: AgentChatProvider | null; title: string; time: number | null }) => Promise<{ ok: true; id: string; existing?: boolean } | { ok: false; error: string }>
      /** An answer and a comment handed to another agent's inbox, as a message from the user */
      agentChatHandoff?: (request: { shellId: string; to: string; comment: string; answer: string }) => Promise<{ ok: true; to: string; toLabel: string } | { ok: false; error: string }>
      pinnedReplyGet?: () => Promise<{ ok: true; pin: PinnedReply } | { ok: false; error: string }>
      pinnedReplyOpenLink?: (href: string, how: 'app' | 'explorer' | 'browser' | 'browser-tab') => Promise<{ ok: true } | { ok: false; error: string }>
      pinnedReplyFold?: (folded: boolean) => void
      onPinnedReplyMaximized?: (callback: (maximized: boolean) => void) => () => void
      pinnedReplyGo?: () => void
      onPinnedReplyGo?: (callback: (shellId: string) => void) => () => void
      runtimesList: () => Promise<{ jdks: JdkRuntime[]; hotswapAgent: HotswapAgentStatus; tools: ToolRuntime[] }>
      runtimesAvailable: (vendor: JdkVendor, feature: number) => Promise<{ jdk: JdkBuild | null; error?: string }>
      runtimesInstall: (vendor: JdkVendor, feature: number) => Promise<{ ok: true; jdk: JdkRuntime } | { ok: false; error?: string; cancelled?: true }>
      runtimesCancel: () => Promise<boolean>
      runtimesRemove: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>
      runtimesHotswapInstall: () => Promise<{ ok: true } | { ok: false; error?: string; cancelled?: true }>
      runtimesHotswapRemove: () => Promise<{ ok: true } | { ok: false; error: string }>
      runtimesToolAvailable: (tool: DevelopmentTool, series: string) => Promise<{ tool: ToolBuild | null; error?: string }>
      runtimesToolInstall: (tool: DevelopmentTool, series: string) => Promise<ToolResult>
      runtimesToolRemove: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>
      runtimesTomcatRegister: () => Promise<ToolResult>
      runtimesRequired: (projectFolder: string) => Promise<{ feature: number | null }>
      runtimesOpenLicense: (vendor: JdkVendor | 'hotswap-agent' | DevelopmentTool) => Promise<boolean>
      // Run presets of the local projects (src/ipc/runPresets.js; main window, unlocked). The first
      // argument is the worktree folder of the card: the presets are the project's, the states that worktree's
      runPresetsList?: (worktreeFolder: string) => Promise<RunPresetResult & { projectKey: string; worktreeKey: string; presets: RunPreset[]; states: Record<string, RunState>; bundles?: RunBundle[]; startOrder?: RunStartOrder; batch?: RunStartProgress | null }>
      runPresetsCandidates?: (projectFolder: string, relative: string) => Promise<RunPresetResult & { candidates: RunCandidate[] }>
      runPresetsSave?: (projectFolder: string, preset: Partial<RunPreset>) => Promise<RunPresetResult & { preset?: RunPreset }>
      runPresetsDelete?: (projectFolder: string, id: string) => Promise<RunPresetResult>
      runPresetsReorder?: (projectFolder: string, ids: string[]) => Promise<RunPresetResult>
      runStartOrderSave?: (folder: string, order: RunStartOrder, knownIds?: string[]) => Promise<RunPresetResult>
      runStartOrderResume?: (folder: string, action: 'skip' | 'retry' | 'cancel', options?: RunPresetOptions) => Promise<RunPresetResult>
      runPresetStart?: (projectFolder: string, id: string, options?: RunPresetOptions) => Promise<RunPresetResult>
      runPresetRestart?: (projectFolder: string, id: string, options?: RunPresetOptions) => Promise<RunPresetResult>
      runPresetStop?: (projectFolder: string, id: string) => Promise<RunPresetResult>
      /** bundleId: start only that bundle's presets, in the project's start order */
      runPresetStartAll?: (projectFolder: string, options?: RunPresetOptions & { bundleId?: string }) => Promise<RunPresetResult>
      runPresetStopAll?: (projectFolder: string, options?: { bundleId?: string }) => Promise<RunPresetResult>
      /** Saves a bundle (a new one without id) of the project; the project's bundles after it */
      runPresetBundleSave?: (projectFolder: string, bundle: { id?: string; name: string; presetIds: string[] }) => Promise<RunPresetResult & { bundles?: RunBundle[] }>
      runPresetBundleDelete?: (projectFolder: string, id: string) => Promise<RunPresetResult & { bundles?: RunBundle[] }>
      runPresetErrors?: (projectFolder: string, id: string) => Promise<RunPresetResult & { groups: RunErrorGroup[] }>
      runPresetDiagnosis?: (worktreeFolder: string, id: string) => Promise<RunPresetResult & { suggestions?: RunSuggestion[] }>
      runPresetMavenPinStatus?: (worktreeFolder: string, id: string) => Promise<RunPresetResult & { pinned?: boolean }>
      runPresetExportMavenPin?: (worktreeFolder: string, id: string, options?: RunPresetOptions) => Promise<RunPresetResult>
      runPresetDeleteMavenPin?: (worktreeFolder: string, id: string, options?: RunPresetOptions) => Promise<RunPresetResult>
      runPresetApplySuggestion?: (worktreeFolder: string, id: string, suggestion: { id: string; replacementUrl?: string; jarId?: string }) => Promise<RunPresetResult & { preset?: RunPreset }>
      runPresetDismissProposal?: (worktreeFolder: string, id: string, proposalId: string) => Promise<RunPresetResult>
      runPresetSendPreview?: (worktreeFolder: string, id: string, note?: string) => Promise<RunPresetResult & { text?: string; token?: string }>
      /** The `<target name>`s of the build.xml in a folder of the project (a Tomcat preset's Ant build) */
      runPresetAntTargets?: (worktreeFolder: string, relative: string) => Promise<RunPresetResult & { targets?: string[] }>
      /** Folders of the project with WEB-INF (a Tomcat preset's web folder), from the project root */
      runPresetWebapps?: (worktreeFolder: string) => Promise<RunPresetResult & { folders?: string[] }>
      /** Reads the Eclipse settings of a folder of the project (.classpath, .settings) for a Tomcat preset */
      runPresetEclipseImport?: (worktreeFolder: string, relative: string) => Promise<RunPresetResult & { draft?: EclipseImportDraft; notes?: string[] }>
      /** Picks an Eclipse workspace folder (main's chooser) and reads its servers */
      runPresetWorkspaceServers?: (worktreeFolder: string) => Promise<RunPresetResult & { cancelled?: true; workspace?: string; servers?: WorkspaceServer[] }>
      /** Picks an existing context.xml (JNDI) for a Tomcat preset */
      runPresetChooseContextXml?: (worktreeFolder: string) => Promise<RunPresetResult & { cancelled?: true; contextXml?: string; label?: string }>
      runPresetChooseFolder?: (worktreeFolder: string, relative: string) => Promise<RunPresetResult & { cancelled?: true; relative?: string }>
      runPresetSend?: (worktreeFolder: string, id: string, agentId: string, token: string) => Promise<RunPresetResult>
      onRunPresetState?: (callback: (event: { projectKey: string; worktreeKey: string } & (
        { id: string; state: RunState; firstAgentAction?: true } | { batch: RunStartProgress | null }
      )) => void) => () => void
      onRuntimesProgress: (callback: (progress: JdkProgress | null) => void) => () => void
      oracleClientStatus?: () => Promise<OracleClientStatus | { success: false; error: string }>
      oracleClientInstall?: () => Promise<OracleClientStatus | { success: false; error: string }>
      oracleClientRemove?: () => Promise<OracleClientStatus | { success: false; error: string }>
      oracleClientLicense?: () => Promise<{ success: boolean }>
      onOracleClientProgress?: (callback: (progress: OracleClientProgress) => void) => () => void
      remoteAccessStatus?: () => Promise<RemoteAccessStatus | { success: false; error: string }>
      remoteAccessSetProjects?: (projects: readonly { key: string; name: string; worktrees: readonly string[] }[],
        tabGroups?: readonly { id: string; key: string; label: string }[],
        projectServers?: readonly { key: string; sessionIds: readonly string[] }[]) => void
      remoteAccessSetEnabled?: (isEnabled: boolean) => Promise<RemoteAccessStatus | { success: false; error: string }>
      remoteAccessSetAnswerMcp?: (isOn: boolean) => Promise<RemoteAccessStatus | { success: false; error: string }>
      remoteAccessSetTabs?: (isOn: boolean) => Promise<RemoteAccessStatus | { success: false; error: string }>
      remoteAccessSetBrowserReview?: (isOn: boolean) => Promise<RemoteAccessStatus | { success: false; error: string }>
      remoteAccessSetAgents?: (isOn: boolean) => Promise<RemoteAccessStatus | { success: false; error: string }>
      remoteAccessPairing?: () => Promise<{ success: true; url: string; expiresAt: number; qr: QrMatrix } | { success: false; error: string }>
      remoteAccessAuthenticator?: () => Promise<{ success: true; secret: string; qr: QrMatrix } | { success: false; error: string }>
      remoteAccessRevoke?: (deviceId: string) => Promise<RemoteAccessStatus | { success: false; error: string }>
      onRemoteAccessChanged?: (callback: () => void) => () => void
      /** Saves an exported query result where the user picks (text, or the bytes of a spreadsheet file) */
      /** Where a File dropped from the OS is on this PC (webUtils.getPathForFile); '' when it cannot be told */
      getPathForFile?: (file: File) => string
      saveExportFile?: (defaultName: string, extension: string, data: string | Uint8Array, kind?: 'result' | 'ui-settings' | 'agent-chat') => Promise<{ success: boolean; cancelled?: boolean; filePath?: string; error?: string }>
      saveTerminalOutput?: (defaultName: string, text: string) => Promise<{ success: boolean; cancelled?: boolean; filePath?: string; error?: string }>
      localRename: (oldPath: string, newPath: string) => Promise<LocalFileOpResult>
      localMkdir: (dirPath: string) => Promise<LocalFileOpResult>
      /** Move an entry into another folder (same name); absent until the app restarts after an update */
      localMove?: (sourcePath: string, targetDir: string) => Promise<LocalFileOpResult>
      localTrash: (paths: string[]) => Promise<LocalTrashResult>
      selectLocalFolder: () => Promise<{ success: true; path: string } | { success: false }>

      // SFTP Window
      openSftpWindow?: (sessionId: string, localPath: string, remotePath: string, title?: string) => Promise<any>

      // Server file window (edit / preview); absent until the app restarts after an update
      openRemoteFile?: (sessionId: string, sessionName: string, remotePath: string, mode: RemoteFileMode) => Promise<RemoteFileResult<{ existing: boolean }>>
      remoteFileLoad?: (docId: string) => Promise<RemoteFileResult<RemoteFileLoaded>>
      remoteFileFindDefinitions?: (docId: string, name: string) => Promise<RemoteFileResult<{ results: ConfigDefinition[]; scanned: number; truncated: boolean }>>
      remoteFileOpenDefinition?: (docId: string, key: string) => Promise<RemoteFileResult<object>>
      remoteFileWindowState?: () => Promise<RemoteFileResult<RemoteFileWindowState>>
      onRemoteFileWindowChanged?: (callback: (state: RemoteFileWindowState) => void) => () => void
      remoteFileActivate?: (docId: string) => Promise<RemoteFileResult<object>>
      remoteFileDetach?: (docId: string, draft: RemoteFileDraft) => Promise<RemoteFileResult<object>>
      remoteFileDraftRestored?: (docId: string) => void
      remoteFileTail?: (docId: string, generation: number, cursor: number) => Promise<RemoteFileResult<RemoteFileTailResult>>
      remoteFileAttention?: (docId: string) => void
      remoteFileReview?: (docId: string, content: string) => Promise<RemoteFileResult<RemoteFileReview>>
      remoteFileSave?: (docId: string, content: string, token: string) => Promise<RemoteFileResult<RemoteFileSaveResult>>
      remoteFileBackups?: (docId: string) => Promise<RemoteFileResult<{ folder: string; backups: RemoteFileBackup[] }>>
      remoteFileReadBackup?: (docId: string, name: string) => Promise<RemoteFileResult<{ content: string }>>
      remoteFileServerBackups?: (docId: string) => Promise<RemoteFileResult<{ backups: RemoteServerBackup[]; historyError?: string }>>
      remoteFileReadServerBackup?: (docId: string, name: string) => Promise<RemoteFileResult<{ content: string }>>
      remoteFileOpenBackupFolder?: (docId: string) => Promise<RemoteFileResult<object>>
      remoteFileSetDirty?: (docId: string, isDirty: boolean) => void
      remoteFileClose?: (docId: string, discard?: boolean) => Promise<RemoteFileResult<{ needsConfirmation: boolean }>>
      remoteFileCloseWindow?: (discardIds: string[]) => Promise<RemoteFileResult<object>>
      onRemoteFileCloseRequested?: (callback: (docIds: string[]) => void) => () => void

      // DB client
      dbDiscover?: (sessionId: string) => Promise<DbResult<{ databases: DiscoveredDb[] }>>
      /** Opens as a tab of the main window (default, answers dbId) or as its own window */
      dbOpen?: (sessionId: string, sessionName: string, endpoint: DbEndpoint, credentials: DbCredentials, target?: 'tab' | 'window') => Promise<DbResult<{ info: DbServerInfo; dbId?: string }>>
      dbClose?: (dbId: string) => Promise<DbResult<object>>
      dbDetach?: (dbId: string) => Promise<DbResult<object>>
      dbTest?: (sessionId: string, endpoint: DbEndpoint, credentials: DbCredentials) => Promise<DbResult<{ info: DbServerInfo; database: string }>>
      dbInfo?: (dbId: string) => Promise<DbResult<DbWindowInfo>>
      dbDatabases?: (dbId: string) => Promise<DbResult<{ databases: DbDatabase[]; current: string }>>
      dbSwitchDatabase?: (dbId: string, database: string) => Promise<DbResult<DbWindowInfo>>
      dbSetSchema?: (dbId: string, schema: string) => Promise<DbResult<DbWindowInfo>>
      dbQuery?: (dbId: string, sql: string) => Promise<DbResult<DbQueryResult>>
      dbCancel?: (dbId: string) => Promise<DbResult<{ cancelled: boolean }>>
      dbSchemas?: (dbId: string, database: string) => Promise<DbResult<{ schemas: DbSchema[]; defaultSchema: string | null }>>
      dbTables?: (dbId: string, database: string, schema: string) => Promise<DbResult<{ tables: DbTable[] }>>
      /** CREATE statements of a table, or of every table of a schema when `table` is left out */
      dbDdl?: (dbId: string, database: string, schema: string, table?: string) => Promise<DbResult<{ ddl: string; tableCount: number; isCut: boolean }>>
      /** Foreign keys of result columns, one entry per source sent */
      dbRelations?: (dbId: string, sources: DbColumnSource[]) => Promise<DbResult<{ relations: DbRelations[] }>>
      dbColumns?: (dbId: string, database: string, schema: string, table: string) => Promise<DbResult<{ columns: DbTableColumn[] }>>

      // Terminal Window
      openTerminalWindow: (sessionId: string, title: string, snapshot?: string) => Promise<any>
      /** Opens (or brings forward) the MCP activity window; refused while the app is locked */
      openMcpActivityWindow?: () => Promise<{ success: boolean; error?: string }>
      /** Screen contents handed over by the main window; absent until the app restarts after an update */
      takeTerminalSnapshot?: (sessionId: string) => Promise<string | null>
      mergeTerminalToMain: (sessionId: string, title: string, host: string, username: string, snapshot?: string) => Promise<any>
      onTerminalMerge: (callback: (data: any) => void) => () => void

      // Sessions
      loadSessions: () => Promise<any>
      saveSessions: (sessions: any) => Promise<any>
      loadFolders: () => Promise<any>
      saveFolders: (folders: any) => Promise<any>
      exportSessions: (data: any) => Promise<any>
      importSessions: (mode: 'merge' | 'replace') => Promise<any>

      // SFTP path bookmarks (stored per saved session)
      sshGetSessionInfo: (sessionId: string) => Promise<SshSessionInfo | null>
      pathBookmarksGet: (key: string) => Promise<PathBookmarkEntry>
      pathBookmarksSet: (key: string, side: PathBookmarkSide, paths: string[]) => Promise<{ success: boolean; entry?: PathBookmarkEntry; error?: string }>
      onPathBookmarksChanged: (callback: (data: { key: string; entry: PathBookmarkEntry }) => void) => () => void

      // Terminal command history (per connection, encrypted in the main process)
      commandHistoryGet: (key: string) => Promise<CommandHistoryResult>
      commandHistoryAdd: (key: string, command: string) => Promise<CommandHistoryResult>
      commandHistoryRemove: (key: string, command: string) => Promise<CommandHistoryResult>
      commandHistoryClear: (key: string) => Promise<CommandHistoryResult>
      onCommandHistoryChanged: (callback: (data: { key: string; entries: CommandHistoryEntry[] }) => void) => () => void

      // App settings
      loadSettings: () => Promise<any>
      saveSettings: (settings: any) => Promise<any>

      // Master Password
      hasMasterPassword: () => Promise<boolean>
      setupMasterPassword: (password: string) => Promise<{ success: boolean; error?: string }>
      unlockApp: (password: string) => Promise<{ success: boolean; error?: string }>
      lockApp: (restoreRecord?: unknown) => Promise<{ success: boolean }>
      isAppLocked: () => Promise<{ locked: boolean }>
      resetMasterPassword: () => Promise<{ success: boolean }>

      // Auto-unlock (OS keychain via safeStorage)
      saveAutoUnlock: (password: string) => Promise<any>
      loadAutoUnlock: () => Promise<any>
      clearAutoUnlock: () => Promise<any>
      hasAutoUnlock: () => Promise<any>

      // Auto update
      checkForUpdates: () => Promise<import('../lib/updateCheck').UpdateCheckResult>
      downloadUpdate: () => Promise<any>
      installUpdate: () => Promise<any>
      /** Tabs open when an update is installed (lib/restoreTabs.ts), kept encrypted until the next start */
      restoreTabsSave?: (record: unknown) => Promise<{ success: boolean; error?: string }>
      /** Those tabs, once (the file is removed); null when there are none */
      restoreTabsTake?: () => Promise<{ savedAt: number; record: unknown; source?: 'close' } | null>
      restoreTabsCheckpoint?: (record: unknown) => void
      onRestoreTabsBeforeClose?: (readRecord: () => unknown) => () => void
      /** What an update would cut off */
      updateBusyWork?: () => Promise<{ transfers: number; unsavedEdits: number }>
      openUpdatePage?: () => Promise<{ success: boolean }>
      getAppVersion: () => Promise<string>
      /** Last version whose release notes were seen (src/lastVersion.js) */
      whatsNewState: () => Promise<{ previous: string | null; current: string; existingUser: boolean }>
      whatsNewSeen: () => Promise<void>
      /** The usual folders and the drives of this PC, for the SFTP local path bar (src/localPlaces.js) */
      /** Other programs' sessions (src/sessionImport): structure only, no passwords */
      sessionImportSources?: () => Promise<{ ok: true; sources: Array<{ id: string; label: string; detail: string }> } | { ok: false; error: string }>
      sessionImportRead?: (id: string) => Promise<{ ok: true; result: import('../lib/externalImport').ImportResult } | { ok: false; error: string }>
      sessionImportFile?: () => Promise<{ ok: true; canceled: true } | { ok: true; canceled?: undefined; result: import('../lib/externalImport').ImportResult } | { ok: false; error: string }>
      localPlaces?: () => Promise<{
        places: Array<{ kind: 'desktop' | 'home' | 'documents' | 'downloads' | 'pictures' | 'music' | 'videos'; label: string; path: string }>
        drives: Array<{ path: string; label: string; kind: 'local' | 'removable' | 'network' | 'cd' }>
      }>
      onUpdateStatus: (callback: (data: any) => void) => () => void

      // Port forwarding
      portForwardLocal: (sessionId: string, localPort: number, remoteHost: string, remotePort: number, localHost?: string) => Promise<any>
      portForwardRemote: (sessionId: string, remotePort: number, localHost: string, localPort: number, remoteHost?: string) => Promise<any>
      portForwardDynamic: (sessionId: string, localPort: number, localHost?: string) => Promise<any>
      portForwardStop: (forwardId: string) => Promise<any>
      portForwardList: (sessionId: string) => Promise<any>
      onPortForwardUpdate: (callback: (data: any) => void) => () => void

      // Terminal zoom
      onTerminalZoom?: (callback: (direction: string) => void) => (() => void)

      // App zoom (Ctrl+mouse wheel)
      appZoomIn?: () => void
      appZoomOut?: () => void
      appZoomReset?: () => void
      mcpGetStatus?: () => Promise<McpStatusResult>
      mcpUpdateConfig?: (patch: Partial<Pick<McpConfig, 'enabled' | 'port' | 'alertLevel'>>) => Promise<McpStatusResult>
      mcpRegenerateToken?: () => Promise<McpStatusResult>
      mcpRespondApproval?: (id: string, approved: boolean) => Promise<{ success: boolean }>
      mcpReadAudit?: (limit: number) => Promise<{ success: boolean; entries: McpAuditEntry[]; error?: string }>
      mcpListActivity?: () => Promise<{ success: boolean; items: McpActivityItem[] }>
      mcpCancelActivity?: (id: string) => Promise<{ success: boolean }>
      mcpSetupClient?: (request: { client?: McpSetupClient; scope: McpSetupScope; overwrite?: boolean; reuseDir?: boolean; setTokenEnv?: boolean }) => Promise<McpSetupResult>
      mcpAddTransferFolder?: () => Promise<McpTransferFolderResult>
      mcpRemoveTransferFolder?: (path: string) => Promise<McpStatusResult>
      sessionLogStart?: (sessionId: string, name: string) => Promise<SessionLogResult>
      sessionLogStop?: (sessionId: string) => Promise<SessionLogResult>
      sessionLogList?: () => Promise<{ success: boolean; items: Array<{ sessionId: string; filePath: string }> }>
      sessionLogOpenFolder?: () => Promise<{ success: boolean; error?: string }>
      onSessionLogChanged?: (callback: (change: SessionLogChange) => void) => () => void
      onMcpActivity?: (callback: (item: McpActivityItem) => void) => () => void
      onMcpActivityOutput?: (callback: (payload: McpActivityOutput) => void) => () => void
      onMcpApprovalRequest?: (callback: (request: McpApprovalRequest) => void) => () => void
      onMcpApprovalDismiss?: (callback: (payload: { id: string }) => void) => () => void
      onMcpApprovalQueue?: (callback: (payload: { id: string; waitingCount: number }) => void) => () => void
      onHostKeyPrompt?: (callback: (request: HostKeyPrompt) => void) => () => void
      onHostKeyDismiss?: (callback: (payload: { id: string }) => void) => () => void
      respondHostKey?: (id: string, decision: 'trust' | 'reject') => void
      getAppZoomFactor?: () => number
      setAppZoomFactor?: (factor: number) => void
    }
  }
}
