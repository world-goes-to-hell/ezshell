// The slash commands the chat composer lists when a draft starts with "/" (components/AgentChat/
// SlashCommandMenu.tsx). The CLIs' own commands are listed here; the ones the user made (commands, skills,
// prompts) come from main (src/agentChat/slashCommands.js). A CLI version can add or drop commands: a
// command missing here can still be typed and sent as it is.

export interface SlashCommand {
  /** With the slash: "/compact" */
  name: string
  description: string
  /** Opens a screen of the CLI's own: the pane shows the terminal while it is open */
  screen?: boolean
  /** Takes a value after it ("/model sonnet") */
  args?: string
  source: 'builtin' | 'user' | 'project'
}

type Entry = [name: string, description: string, extra?: { screen?: boolean; args?: string }]

const CLAUDE: Entry[] = [
  ['/add-dir', '작업 폴더 추가', { args: '<폴더>' }],
  ['/agents', '하위 에이전트 관리', { screen: true }],
  ['/clear', '대화 지우고 새로 시작'],
  ['/compact', '지금까지의 대화를 요약해 줄이기', { args: '[요약 지시]' }],
  ['/config', '설정', { screen: true }],
  ['/context', '컨텍스트 사용량 보기'],
  ['/cost', '이 세션의 비용·시간'],
  ['/doctor', '설치 상태 점검', { screen: true }],
  ['/effort', '노력 수준 바꾸기', { args: '[low|medium|high|max]' }],
  ['/exit', 'Claude Code 끝내기'],
  ['/export', '대화를 파일·클립보드로 내보내기', { screen: true }],
  ['/help', '도움말', { screen: true }],
  ['/hooks', '훅 설정', { screen: true }],
  ['/init', '이 프로젝트의 CLAUDE.md 만들기'],
  ['/login', '로그인', { screen: true }],
  ['/logout', '로그아웃'],
  ['/mcp', 'MCP 서버 관리', { screen: true }],
  ['/memory', '메모리 파일 편집', { screen: true }],
  ['/model', '모델 바꾸기', { args: '[모델]' }],
  ['/permissions', '도구 권한 규칙', { screen: true }],
  ['/plugin', '플러그인 관리', { screen: true }],
  ['/pr-comments', 'PR 댓글 가져오기'],
  ['/release-notes', '릴리스 노트 보기'],
  ['/resume', '지난 대화 이어서 열기', { screen: true }],
  ['/review', '코드 리뷰'],
  ['/rewind', '대화·코드를 이전 시점으로 되돌리기', { screen: true }],
  ['/security-review', '보안 검토'],
  ['/status', '버전·모델·계정 상태', { screen: true }],
  ['/statusline', '상태 줄 설정'],
  ['/terminal-setup', 'Shift+Enter 줄바꿈 설정'],
  ['/todos', '할 일 목록 보기'],
  ['/usage', '요금제 사용량 보기', { screen: true }],
  ['/vim', 'Vim 입력 모드 켜고 끄기']
]

const CODEX: Entry[] = [
  ['/approvals', '승인 방식 바꾸기', { screen: true }],
  ['/compact', '지금까지의 대화를 요약해 줄이기'],
  ['/diff', 'Git 변경 내용 보기'],
  ['/exit', 'Codex 끝내기'],
  ['/init', '이 프로젝트의 AGENTS.md 만들기'],
  ['/logout', '로그아웃'],
  ['/mcp', 'MCP 도구 목록'],
  ['/mention', '파일 언급하기', { args: '<파일>' }],
  ['/model', '모델·노력 수준 바꾸기', { screen: true }],
  ['/new', '새 대화 시작'],
  ['/quit', 'Codex 끝내기'],
  ['/resume', '지난 대화 이어서 열기', { screen: true }],
  ['/review', '변경 내용 리뷰', { screen: true }],
  ['/status', '세션 설정·토큰 사용량'],
  ['/undo', '마지막 변경 되돌리기']
]

const BUILTIN: Record<'claude' | 'codex', SlashCommand[]> = {
  claude: CLAUDE.map(([name, description, extra]) => ({ name, description, ...extra, source: 'builtin' })),
  codex: CODEX.map(([name, description, extra]) => ({ name, description, ...extra, source: 'builtin' }))
}

/** The CLI's own commands and the user's, one per name (the CLI's own first) */
export function allSlashCommands(kind: 'claude' | 'codex', custom: readonly Omit<SlashCommand, 'screen' | 'args'>[] = []): SlashCommand[] {
  const builtin = BUILTIN[kind]
  const names = new Set(builtin.map(command => command.name))
  return [...builtin, ...custom.filter(command => !names.has(command.name))]
}

/**
 * What the list shows for a draft: the word being typed when the draft is "/" and one word so far (no
 * space or line yet), else null. Names starting with it first, then names containing it, then descriptions.
 */
export function matchSlashCommands(draft: string, commands: readonly SlashCommand[], max = 50): SlashCommand[] | null {
  const typed = /^\/([^\s/]*)$/.exec(draft)
  if (!typed) return null
  const word = typed[1].toLowerCase()
  if (!word) return commands.slice(0, max)
  const starts: SlashCommand[] = []
  const contains: SlashCommand[] = []
  const described: SlashCommand[] = []
  for (const command of commands) {
    const name = command.name.slice(1).toLowerCase()
    if (name.startsWith(word)) starts.push(command)
    else if (name.includes(word)) contains.push(command)
    else if (command.description.toLowerCase().includes(word)) described.push(command)
  }
  return [...starts, ...contains, ...described].slice(0, max)
}

/** The draft once a command was picked: its name and a space (ready for a value) */
export const draftFor = (command: SlashCommand): string => command.name + ' '

/** A slash command, as the chat sends it ("/model sonnet"): not a path like "/tmp/x" */
export const isSlashCommand = (text: string): boolean => /^\/[^\s/]+(?:\s|$)/.test(text.trim())
