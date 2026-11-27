import { gitLoginCommand, openGitLoginTerminal } from '../../lib/gitLogin'

/**
 * Beside a failure that needs a Git login (lib/gitLogin.ts): opens a local terminal in the repository with
 * `git ls-remote` typed in. Pressing Enter there lets Git Credential Manager ask for the login and keep it.
 * Nothing shown for a target that cannot be typed as one plain word.
 */
export function GitLoginButton({ directory, label, target, onOpen }: {
  directory: string
  label: string
  /** A remote name or an https address; none: the branch's own remote */
  target?: string
  onOpen?: () => void
}) {
  const command = gitLoginCommand(target)
  if (!command) return null
  return <button type="button" className="nested-repository-result-action" data-action="git-login"
    title={`터미널을 열고 ${command} 를 입력해 둡니다. Enter 를 누르면 로그인 창이 뜹니다.`}
    onClick={() => { openGitLoginTerminal(directory, label, command); onOpen?.() }}>터미널에서 로그인</button>
}
