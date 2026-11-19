import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { RiArrowDownSLine, RiArrowRightSLine, RiFolderLine, RiGitBranchLine, RiRefreshLine } from 'react-icons/ri'
import type { WorkspaceGitRepository } from '../../types'
import { workspaceGitGraph, type GitGraphRow } from '../../lib/workspaceGitGraph'
import { folderName } from '../../lib/agentHistory'
import { TreeLevel } from './WorkspaceDetails'
import { CommitFiles, UncommittedChanges } from './WorkspaceGitChanges'
import { isInsidePath } from '../../lib/localWorkspaceTree'

const readGit = (folder: string) => window.electronAPI.workspaceGitLog(folder)
const date = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' })

function useFolderData<T>(folder: string, load: (folder: string) => Promise<T>) {
  const [revision, setRevision] = useState(0)
  const [sample, setSample] = useState<{ folder: string; revision: number; data: T | null } | null>(null)
  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => load(folder)).then(
      data => { if (active) setSample({ folder, revision, data }) },
      () => { if (active) setSample({ folder, revision, data: null }) }
    )
    return () => { active = false }
  }, [folder, load, revision])
  return {
    result: sample?.folder === folder && sample.revision === revision ? sample : null,
    refresh: () => setRevision(value => value + 1),
    revision
  }
}

function BrowserHeader({ folder, branch, onRefresh }: { folder: string; branch?: string; onRefresh: () => void }) {
  return (
    <div className="workspace-browser-header">
      <RiFolderLine size={15} aria-hidden="true" />
      <span className="workspace-browser-path" title={folder} dir="auto">{folder}</span>
      {branch && <span className="workspace-branch" title={branch}><RiGitBranchLine size={13} />{branch}</span>}
      <button type="button" className="workspace-close" onClick={onRefresh} aria-label="새로 고침" title="새로 고침">
        <RiRefreshLine size={16} />
      </button>
    </div>
  )
}

export function WorkspaceNote({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <p className={`workspace-note${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</p>
}

/** The folder as a tree: folders expand in place, files open in the file window */
export function WorkspaceFiles({ folder }: { folder: string }) {
  // Refresh reads the tree again from the top (open folders close again)
  const [revision, setRevision] = useState(0)
  return (
    <>
      <BrowserHeader folder={folder} onRefresh={() => setRevision(value => value + 1)} />
      <TreeLevel key={`${folder}:${revision}`} root={folder} relative="" depth={0} label={folderName(folder)} />
    </>
  )
}

function GraphRow({ row, lanes, isHead }: { row: GitGraphRow; lanes: number; isHead: boolean }) {
  const width = Math.min(120, lanes * 14 + 6)
  const x = (lane: number) => (lane + 0.5) * width / lanes
  return (
    <svg className="workspace-git-graph" style={{ width }} viewBox={`0 0 ${width} 44`} preserveAspectRatio="none" aria-hidden="true">
      {row.edges.map(({ from, to, color, segment }, index) => {
        const a = x(from)
        const b = x(to)
        const d = segment === 'incoming' ? `M ${a} 0 V 22`
          : segment === 'parent' ? `M ${a} 22 C ${a} 34 ${b} 30 ${b} 44`
          : `M ${a} 0 C ${a} 28 ${b} 16 ${b} 44`
        return <path key={index} d={d} data-graph-color={color % 5} data-segment={segment} />
      })}
      <circle cx={x(row.lane)} cy={22} r={isHead ? 4 : 3} data-graph-color={row.color % 5} />
    </svg>
  )
}

function GitLog({ repo }: { repo: WorkspaceGitRepository }) {
  const graph = useMemo(() => workspaceGitGraph(repo.commits), [repo.commits])
  // The commits opened to show the files they changed
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const toggle = (hash: string) => setOpened(previous => {
    const next = new Set(previous)
    if (next.has(hash)) next.delete(hash)
    else next.add(hash)
    return next
  })
  const label = folderName(repo.root)
  if (!graph.rows.length) return <WorkspaceNote>아직 커밋이 없습니다.</WorkspaceNote>
  return (
    <>
      <ol className="workspace-git-list" aria-label="Git 커밋 기록">
        {graph.rows.map(row => {
          const { commit } = row
          const isHead = commit.hash === repo.head
          const isOpen = opened.has(commit.hash)
          const Chevron = isOpen ? RiArrowDownSLine : RiArrowRightSLine
          return (
            <li key={commit.hash} className="workspace-git-commit" data-merge={commit.parents.length > 1 || undefined} data-open={isOpen || undefined}>
              <div className="workspace-git-commit-row">
                <GraphRow row={row} lanes={graph.laneCount} isHead={isHead} />
                <button
                  type="button"
                  className="workspace-git-detail"
                  aria-expanded={isOpen}
                  onClick={() => toggle(commit.hash)}
                  title={`${commit.subject}\n${commit.hash}\n${commit.author} · ${new Date(commit.time).toLocaleString('ko-KR')}\n눌러서 바뀐 파일 보기`}
                >
                  <Chevron size={14} className="workspace-commit-chevron" aria-hidden="true" />
                  <span className="workspace-commit-subject" dir="auto">{commit.subject || '(제목 없음)'}</span>
                  <span className="workspace-commit-meta">
                    <code>{commit.shortHash}</code>
                    <span className="workspace-commit-author">{commit.author}</span>
                    {commit.refs.length > 0 && <span className="workspace-commit-refs" title={commit.refs.join(', ')}>{commit.refs.join(' · ')}</span>}
                    <time dateTime={commit.time}>{date.format(new Date(commit.time))}</time>
                  </span>
                </button>
              </div>
              {isOpen && <div className="workspace-git-commit-files"><CommitFiles root={repo.root} hash={commit.hash} label={label} /></div>}
            </li>
          )
        })}
      </ol>
      {repo.hasMore && <WorkspaceNote>최근 {repo.commits.length}개 커밋 표시</WorkspaceNote>}
    </>
  )
}

export function WorkspaceGit({ folder }: { folder: string }) {
  // The folder the log was read for. Another shell or a `cd` inside the same repository keeps it, so
  // the log is not read again; leaving the repository reads the new folder.
  const [anchor, setAnchor] = useState(folder)
  const { result, refresh, revision } = useFolderData(anchor, readGit)
  const data = result?.data
  const repo = data?.success ? data.repo : null
  const repoRoot = repo?.root
  useEffect(() => {
    if (folder === anchor) return
    if (repoRoot && isInsidePath(folder, repoRoot)) return
    setAnchor(folder)
  }, [folder, anchor, repoRoot])
  return (
    <>
      <BrowserHeader folder={repo?.root ?? anchor} branch={repo?.branch ?? (repo?.head ? '분리된 HEAD' : undefined)} onRefresh={refresh} />
      {!result ? <WorkspaceNote>Git 기록을 읽는 중…</WorkspaceNote>
        : !data?.success ? <WorkspaceNote error>{data?.error ?? 'Git 기록을 읽지 못했습니다.'}</WorkspaceNote>
        : data.repo ? (
          <>
            <UncommittedChanges folder={data.repo.root} revision={revision} label={folderName(data.repo.root)} />
            <GitLog repo={data.repo} />
          </>
        )
        : <WorkspaceNote>{data.reason === 'git-missing' ? 'Git을 설치하면 커밋 기록을 볼 수 있습니다.' : '현재 폴더는 Git 저장소에 속해 있지 않습니다.'}</WorkspaceNote>}
    </>
  )
}
