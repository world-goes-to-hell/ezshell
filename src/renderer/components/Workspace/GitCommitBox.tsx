// The commit box of the workspace panel's "변경" tab: a message, a button that commits the ticked
// files (docs/plan/2026-11-24-workspace-git-commit.md), and Git's words when it refused.
import type { KeyboardEvent } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiArrowDownSLine, RiGitCommitLine, RiRobot2Line } from 'react-icons/ri'
import { agentName, type AgentFiles } from '../../lib/fileOwners'
import { forgetAfterCommit } from '../../lib/gitReadCache'
import { toast } from '../../stores/toastStore'
import { draftOf, useGitCommitStore } from '../../stores/gitCommitStore'

const MESSAGE_MAX = 5000

/** Commits `paths` of the repository `top` with its draft message; `onDone` after a commit */
async function commitDraft(top: string, paths: string[], onDone: () => void): Promise<void> {
  const store = useGitCommitStore.getState()
  const draft = draftOf(store.repos, top)
  if (draft.busy || paths.length === 0 || !draft.message.trim()) return
  const commit = window.electronAPI.workspaceGitCommit
  if (!commit) {
    store.setCommitting(top, false, '앱을 다시 시작한 뒤에 사용할 수 있습니다.')
    return
  }
  store.setCommitting(top, true)
  try {
    const result = await commit(top, paths, draft.message)
    if (!result.success) {
      useGitCommitStore.getState().setCommitting(top, false, result.error)
      return
    }
    useGitCommitStore.getState().committed(top)
    // The kept history and changes are from before the commit: no tab may show them again
    forgetAfterCommit()
    const summary = `${result.shortHash} · 파일 ${result.count.toLocaleString()}개`
    if (result.warning) toast.warning('커밋했습니다 (확인 필요)', `${summary} · ${result.warning}`)
    else toast.success('커밋했습니다', summary)
    onDone()
  } catch {
    useGitCommitStore.getState().setCommitting(top, false, '커밋하지 못했습니다.')
  }
}

/**
 * `waiting`: the changes shown are an earlier list being read again (after a commit, a refresh).
 * `agents`: the agents that changed files of the list; picking one ticks exactly its files (`onPickAgent`).
 */
export function GitCommitBox({ top, paths, waiting = false, onCommitted, agents = [], onPickAgent }: {
  top: string; paths: string[]; waiting?: boolean; onCommitted: () => void; agents?: readonly AgentFiles[]; onPickAgent?: (paths: string[]) => void
}) {
  const draft = useGitCommitStore(state => draftOf(state.repos, top))
  const setMessage = useGitCommitStore(state => state.setMessage)
  const count = paths.length
  const hasMessage = draft.message.trim().length > 0
  const canCommit = !draft.busy && !waiting && count > 0 && hasMessage
  const commit = () => { if (canCommit) void commitDraft(top, paths, onCommitted) }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return
    event.preventDefault()
    commit()
  }
  const label = draft.busy ? '커밋하는 중…'
    : count === 0 ? '커밋할 파일을 선택하세요'
    : `선택한 ${count.toLocaleString()}개 파일 커밋`
  return (
    <div className="workspace-commit-box" data-busy={draft.busy || undefined}>
      {agents.length > 0 && onPickAgent && (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="workspace-commit-agents" disabled={draft.busy || waiting}
              title="한 에이전트가 고친 파일만 고릅니다 (지금 선택을 바꿉니다)">
              <RiRobot2Line size={14} aria-hidden="true" />
              <span>에이전트로 고르기</span>
              <RiArrowDownSLine size={14} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="terminal-menu workspace-commit-agent-menu" align="start" sideOffset={4} collisionPadding={8}>
              {agents.map(({ agent, paths: files, shared }) => (
                <DropdownMenu.Item key={agent.id} className="terminal-menu-item workspace-commit-agent" data-kind={agent.kind} onSelect={() => onPickAgent(files)}
                  title={shared ? `다른 에이전트도 고친 파일 ${shared}개가 함께 골라집니다` : undefined}>
                  <span className="workspace-commit-agent-name">{agentName(agent)}</span>
                  <span className="workspace-commit-agent-count">{files.length}개{shared > 0 && <span className="workspace-git-overlap">겹침 {shared}</span>}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      <textarea
        className="workspace-commit-message"
        rows={2}
        maxLength={MESSAGE_MAX}
        spellCheck={false}
        value={draft.message}
        readOnly={draft.busy}
        aria-label="커밋 메시지"
        placeholder="커밋 메시지 (Ctrl+Enter 로 커밋)"
        onChange={event => setMessage(top, event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" className="workspace-commit-button" disabled={!canCommit} onClick={commit}
        title={waiting ? '변경 사항을 다시 읽는 중입니다' : count > 0 && !hasMessage ? '커밋 메시지를 입력하세요' : undefined}>
        <RiGitCommitLine size={15} aria-hidden="true" />
        <span>{label}</span>
      </button>
      {draft.error && <pre className="workspace-commit-error" role="alert">{draft.error}</pre>}
    </div>
  )
}
