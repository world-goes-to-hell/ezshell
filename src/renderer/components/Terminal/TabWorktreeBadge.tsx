import { RiFolder3Line, RiGitBranchLine } from 'react-icons/ri'
import { folderLabel, pathKey } from '../../lib/localWorkspaceTree'
import type { WorktreeNode } from '../Sidebar/LocalProjectsTree'

export function TabWorktreeBadge({ cwd, worktree }: { cwd: string; worktree?: WorktreeNode }) {
  const nested = worktree && pathKey(cwd) !== pathKey(worktree.path)
  const label = worktree?.branch ?? folderLabel(worktree?.path ?? cwd)
  const title = [
    `작업 폴더 ${cwd}`,
    nested && `워크트리 ${worktree.path}`,
    worktree?.branch && `브랜치 ${worktree.branch}`
  ].filter(Boolean).join('\n')
  const Icon = worktree?.branch ? RiGitBranchLine : RiFolder3Line
  return (
    <span className="tab-worktree-badge" title={title}>
      <Icon size={10} aria-hidden="true" />
      <span>{nested ? `${label} / ${folderLabel(cwd)}` : label}</span>
    </span>
  )
}
