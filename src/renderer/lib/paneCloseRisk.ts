// What an Alt+drag that closes a pane would end (design review D9: closing a shell asks only when a
// program runs in it). Read from what the window already knows: the agent bound to a local shell, the
// terminal's full-screen mode and whether the cursor sits on a shell prompt. No command is sent.
import { isCommandLine } from './terminalLogRows'

const AGENT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }

export interface PaneScreen {
  /** The kind of agent running in the pane's local shell, if any */
  agent?: string
  /** A full-screen program (vim, less, top) has the alternate screen */
  alternate: boolean
  /**
   * The cursor's line up to the cursor, rows it wraps from joined in front. Read up to the cursor, not
   * with the trailing blanks trimmed: ConPTY often moves the cursor past a prompt's space without
   * writing it, and the space is what tells a prompt.
   */
  cursorLine: string
}

/**
 * A shell prompt the cursor waits right after: `-bash-4.2$ `, `sh-4.2$ `, `$ `, busybox `/ # `,
 * zsh `% `, starship / oh-my-posh `❯ `, PowerShell `PS C:\x> `, cmd `C:\>`. Its own rule, wider than the
 * log highlight's isCommandLine (that one stays narrow so log lines with "> " keep their highlight).
 * - A prompt sign needs a blank after it (a progress line ending in "45%" is not a prompt), except cmd's.
 * - `>` counts only in PowerShell's and cmd's shape: interactive programs prompt with it (Python `>>> `,
 *   node `> `, `mysql> `, PowerShell's continuation `>> `), and closing one loses its state (variables,
 *   an open transaction) without the question. psql's `db=# ` is left out the same way.
 */
const PROMPT_AT_CURSOR = /(?:(?<!=)[$#%❯]\s+|^PS .{0,200}>\s+|^[A-Za-z]:\\[^>]{0,200}>)$/

/** Why closing this pane needs a confirmation, or null when its shell waits at a prompt */
export function paneCloseRisk({ agent, alternate, cursorLine }: PaneScreen): string | null {
  if (agent) return `${AGENT_NAMES[agent] ?? '에이전트'} 세션이 실행 중입니다`
  if (alternate) return '전체 화면 프로그램이 실행 중입니다'
  // A shell waits at its prompt (what the user has typed after it does not run yet); anything else is
  // output of a running command (tail -f, a build). A prompt not recognised asks once too many: the safe side.
  const line = cursorLine.trimStart()
  if (!isCommandLine(line) && !PROMPT_AT_CURSOR.test(line)) return '명령이 실행 중인 것 같습니다'
  return null
}

/** The question shown before the pane closes */
export const paneCloseMessage = (risk: string) =>
  `이 칸에서 ${risk}. 칸을 닫으면 셸과 그 안의 프로그램이 함께 종료됩니다. 닫을까요?`
