// A Git login the server asks for and Git cannot give with its prompts off (src/ipc/nestedGit.js): main says so
// in one sentence (nestedRepositories.js GIT_LOGIN_NEEDED) and the screen offers to log in once from a terminal.
import { OPEN_LOCAL_TERMINAL_EVENT } from './localProjectList'

/** The opening sentence of main's message (src/ipc/nestedRepositories.js): keep the two the same */
const GIT_LOGIN_NEEDED = 'Git 로그인이 필요합니다.'

export const needsGitLogin = (message: string | null | undefined) => !!message?.startsWith(GIT_LOGIN_NEEDED)

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
// Host, port and a path of plain URL characters only: no quote, space or shell sign, so it is one word to
// PowerShell and sh alike and needs no quoting. No user info either (a password would end up in the history).
const PLAIN_HTTPS = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%+/-]*)?$/

/**
 * What to type for the login: `git ls-remote` reaches the server, which asks for the login, and Git Credential
 * Manager (prompts on in the user's terminal) shows its window and saves it. null for a target that is not
 * a remote name or a plain https address.
 */
export function gitLoginCommand(target?: string): string | null {
  if (target === undefined) return 'git ls-remote --heads'
  const word = target.trim()
  return REMOTE_NAME.test(word) || PLAIN_HTTPS.test(word) ? `git ls-remote --heads -- ${word}` : null
}

/** Opens a local terminal in the repository with the command typed in; the user presses Enter */
export function openGitLoginTerminal(directory: string, label: string, command: string) {
  window.dispatchEvent(new CustomEvent(OPEN_LOCAL_TERMINAL_EVENT, {
    detail: { cwd: directory, workspaceLabel: `${label} · Git 로그인`, input: command }
  }))
}

type ShellState = { backlog: string; exited: boolean } | null | undefined

/**
 * Types `text` once a new shell has drawn its prompt: its output has been there and unchanged for `quietMs`
 * (PowerShell's profile can take seconds). Gives up writing if the shell ends; after `limitMs` it types anyway.
 */
export async function typeWhenShellSettles(shellId: string, text: string, {
  read = (id: string): Promise<ShellState> => window.electronAPI.localShellAttach?.(id) ?? Promise.resolve(null),
  write = (id: string, data: string) => window.electronAPI.localShellWrite?.(id, data),
  wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(), quietMs = 400, limitMs = 10_000, pollMs = 150
} = {}): Promise<boolean> {
  const started = now()
  let length = -1
  let since = started
  while (now() - started < limitMs) {
    const state = await read(shellId).catch(() => null)
    if (!state || state.exited) return false
    if (state.backlog.length !== length) {
      length = state.backlog.length
      since = now()
    } else if (length > 0 && now() - since >= quietMs) {
      break
    }
    await wait(pollMs)
  }
  write(shellId, text)
  return true
}
