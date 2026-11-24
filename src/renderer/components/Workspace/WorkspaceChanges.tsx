// The workspace panel's "변경" tab (docs/plan/2026-11-24-workspace-git-commit.md): the changes since
// the last commit, ticked to commit. The history ("Git 기록") is its own tab.
import { folderName } from '../../lib/agentHistory'
import { BrowserHeader, WorkspaceNote, gitMissingNote } from './WorkspaceBrowser'
import { ChangeList } from './WorkspaceGitChanges'
import { useGitTarget } from './useGitTarget'

export function WorkspaceChanges({ folder }: { folder: string }) {
  const target = useGitTarget(folder, { offerAllBranches: false })
  const data = target.result?.data
  return (
    <>
      <BrowserHeader folder={target.displayPath} branch={target.displayBranch} picker={target.picker} onRefresh={target.refresh} />
      {!target.result ? <WorkspaceNote>변경 사항을 읽는 중…</WorkspaceNote>
        : !data?.success ? <WorkspaceNote error>{data?.error ?? 'Git 저장소를 읽지 못했습니다.'}</WorkspaceNote>
        : data.repo ? <ChangeList key={data.repo.root} folder={data.repo.root} revision={target.revision}
            label={folderName(data.repo.root)} onCommitted={target.refresh} />
        : <WorkspaceNote>{gitMissingNote(data.reason)}</WorkspaceNote>}
    </>
  )
}
