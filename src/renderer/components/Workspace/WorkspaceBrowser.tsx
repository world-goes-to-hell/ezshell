import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RiArrowDownSLine, RiArrowRightSLine, RiCloseLine, RiFolderLine, RiGitBranchLine, RiGitCommitLine, RiRefreshLine, RiSearchLine } from 'react-icons/ri'
import type { WorkspaceDirectorySearchResult, WorkspaceGitRepository, WorkspaceGitSearchResult } from '../../types'
import { workspaceGitGraph, type GitGraphRow } from '../../lib/workspaceGitGraph'
import { folderName } from '../../lib/agentHistory'
import { TreeLevel, WorkspaceFileResults } from './WorkspaceDetails'
import { CommitFiles, UncommittedChanges } from './WorkspaceGitChanges'
import { isInsidePath, pathKey, worktreeOf } from '../../lib/localWorkspaceTree'
import { SelectMenu } from '../ui/SelectMenu'

const readGit = (folder: string) => window.electronAPI.workspaceGitLog(folder)
const readAllGit = (folder: string) => window.electronAPI.workspaceGitLog(folder, true)
const searchFiles = (folder: string, query: string) => window.electronAPI.workspaceDirectorySearch?.(folder, query)
const prepareFiles = (folder: string, refresh = false) => window.electronAPI.workspaceDirectoryPrepare?.(folder, refresh).catch(() => undefined)
const searchGit = (folder: string, query: string) => window.electronAPI.workspaceGitSearch?.(folder, query)
const searchCheckoutGit = (folder: string, query: string) => window.electronAPI.workspaceGitSearch?.(folder, query, true)
const date = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' })
const ALL_BRANCHES = 'all-branches'

function useFolderData<T>(folder: string | null, load: (folder: string) => Promise<T>, revision: number) {
  const [sample, setSample] = useState<{ folder: string; revision: number; load: typeof load; data: T | null } | null>(null)
  useEffect(() => {
    if (folder === null) return
    let active = true
    void Promise.resolve().then(() => load(folder)).then(
      data => { if (active) setSample({ folder, revision, load, data }) },
      () => { if (active) setSample({ folder, revision, load, data: null }) }
    )
    return () => { active = false }
  }, [folder, load, revision])
  const latest = sample?.folder === folder && sample.load === load ? sample : null
  return {
    result: latest?.revision === revision ? latest : null,
    latest: latest?.data
  }
}

type SearchAnswer<T> = ({ success: true } & T) | { success: false; error: string }

function useWorkspaceSearch<T>(folder: string, query: string, revision: number, read: (folder: string, query: string) => Promise<SearchAnswer<T>> | undefined, delay = 220) {
  const [sample, setSample] = useState<{ folder: string; query: string; revision: number; read: typeof read; result: SearchAnswer<T> } | null>(null)
  useEffect(() => {
    if (!folder || !query) return
    let active = true
    const load = async () => {
      try {
        const result = await read(folder, query) ?? { success: false as const, error: '앱을 다시 시작한 뒤에 검색할 수 있습니다.' }
        if (active) setSample({ folder, query, revision, read, result })
      } catch {
        if (active) setSample({ folder, query, revision, read, result: { success: false, error: '검색을 완료하지 못했습니다.' } })
      }
    }
    const timer = window.setTimeout(() => void load(), delay)
    return () => { active = false; window.clearTimeout(timer) }
  }, [folder, query, revision, read, delay])

  return sample?.folder === folder && sample.query === query && sample.revision === revision && sample.read === read ? sample.result : null
}

function WorkspaceSearchBox({ label, placeholder, query, onChange }: { label: string; placeholder: string; query: string; onChange: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="workspace-search" role="search" aria-label={label}>
      <RiSearchLine size={15} aria-hidden="true" />
      <input ref={input} type="search" maxLength={200} value={query} aria-label={label} placeholder={placeholder}
        spellCheck={false} onChange={event => onChange(event.target.value)} onKeyDown={event => {
          if (event.key !== 'Escape' || !query || event.nativeEvent.isComposing) return
          event.preventDefault()
          event.stopPropagation()
          onChange('')
        }} />
      {query && <button type="button" onClick={() => { onChange(''); input.current?.focus() }} aria-label="검색 지우기" title="검색 지우기">
        <RiCloseLine size={15} aria-hidden="true" />
      </button>}
    </div>
  )
}

function BrowserHeader({ folder, branch, onRefresh, picker }: { folder: string; branch?: string; onRefresh: () => void; picker?: ReactNode }) {
  return (
    <div className="workspace-browser-header">
      {picker ?? <>
        <RiFolderLine size={15} aria-hidden="true" />
        <span className="workspace-browser-path" title={folder} dir="auto">{folder}</span>
      </>}
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
  const [query, setQuery] = useState('')
  const term = query.trim()
  const found = useWorkspaceSearch<WorkspaceDirectorySearchResult>(folder, term, revision, searchFiles, 90)
  useEffect(() => { void prepareFiles(folder) }, [folder])
  const refresh = async () => {
    await prepareFiles(folder, true)
    setRevision(value => value + 1)
  }
  const label = folderName(folder)
  return (
    <>
      <BrowserHeader folder={folder} onRefresh={() => void refresh()} />
      <WorkspaceSearchBox label="파일·폴더 검색" placeholder="파일 이름 또는 경로" query={query} onChange={setQuery} />
      <div className="workspace-file-browse" hidden={Boolean(term)}>
        <TreeLevel key={`${folder}:${revision}`} root={folder} relative="" depth={0} label={label} />
      </div>
      {term && (!found ? <WorkspaceNote>작업 폴더를 검색하는 중…</WorkspaceNote>
        : !found.success ? <WorkspaceNote error>{found.error}</WorkspaceNote>
        : <>
          <WorkspaceNote>{found.entries.length || found.truncated ? `검색 결과 ${found.entries.length}개` : '일치하는 파일·폴더가 없습니다.'}{found.truncated && ' · 일부 범위만 검색됨'}</WorkspaceNote>
          {found.entries.length > 0 && <WorkspaceFileResults root={folder} label={label} entries={found.entries} />}
        </>)}
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

function GitLog({ repo, searching, found }: { repo: WorkspaceGitRepository; searching: boolean; found: SearchAnswer<WorkspaceGitSearchResult> | null }) {
  const graph = useMemo(() => searching ? null : workspaceGitGraph(repo.commits), [repo.commits, searching])
  // The commits opened to show the files they changed
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const toggle = (hash: string) => setOpened(previous => {
    const next = new Set(previous)
    if (next.has(hash)) next.delete(hash)
    else next.add(hash)
    return next
  })
  const label = folderName(repo.root)
  if (searching && !found) return <WorkspaceNote>Git 기록을 검색하는 중…</WorkspaceNote>
  if (searching && found && !found.success) return <WorkspaceNote error>{found.error}</WorkspaceNote>
  const commits = searching && found?.success ? found.commits : repo.commits
  if (!commits.length) return <WorkspaceNote>{searching ? '일치하는 커밋이 없습니다.' : '아직 커밋이 없습니다.'}</WorkspaceNote>
  return (
    <>
      {searching && <WorkspaceNote>{found?.success && found.hasMore ? `최근 검색 결과 ${commits.length}개 표시` : `검색 결과 ${commits.length}개`}</WorkspaceNote>}
      <ol className="workspace-git-list" aria-label={searching ? 'Git 커밋 검색 결과' : 'Git 커밋 기록'}>
        {commits.map((commit, index) => {
          const isHead = commit.hash === repo.head
          const isOpen = opened.has(commit.hash)
          const Chevron = isOpen ? RiArrowDownSLine : RiArrowRightSLine
          return (
            <li key={commit.hash} className="workspace-git-commit" data-merge={commit.parents.length > 1 || undefined} data-open={isOpen || undefined}>
              <div className="workspace-git-commit-row">
                {graph ? <GraphRow row={graph.rows[index]} lanes={graph.laneCount} isHead={isHead} />
                  : <RiGitCommitLine size={16} className="workspace-git-search-marker" aria-hidden="true" />}
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
      {!searching && repo.hasMore && <WorkspaceNote>최근 {repo.commits.length}개 커밋 표시</WorkspaceNote>}
    </>
  )
}

export function WorkspaceGit({ folder }: { folder: string }) {
  // Keep the repository list when moving among its checkouts and nested repositories. A manual
  // choice belongs to the checkout where it was made and clears when the terminal changes checkout.
  const [anchor, setAnchor] = useState(folder)
  const [revision, setRevision] = useState(0)
  const [selection, setSelection] = useState<{ origin: string; value: string } | null>(null)
  const terminal = useFolderData(anchor, readGit, revision)
  const current = terminal.latest?.success ? terminal.latest.repo : null
  const worktrees = current?.worktrees ?? []
  const base = worktrees[0]?.path ?? anchor
  const named = (path: string) => pathKey(path) !== pathKey(base) && isInsidePath(path, base)
    ? path.slice(base.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') : folderName(path)
  const choices = [
    ...worktrees.map(tree => ({ ...tree, label: named(tree.path), kind: '워크트리' })),
    ...(current?.nestedRepositories ?? []).map(path => ({ path, branch: undefined, label: named(path), kind: '하위 저장소' }))
  ]
  const closest = worktreeOf(folder, choices.map(tree => tree.path))
  const defaultPath = closest ?? current?.root ?? anchor
  useEffect(() => {
    if (!closest && pathKey(folder) !== pathKey(anchor)) setAnchor(folder)
    setSelection(previous => previous?.origin === defaultPath ? previous : null)
  }, [folder, anchor, closest, defaultPath])

  const choice = selection?.origin === defaultPath ? selection.value : null
  const offerAllBranches = worktrees.length > 1 && worktrees.some(tree => tree.path === defaultPath)
  const allBranches = offerAllBranches && choice === ALL_BRANCHES
  const chosen = choices.find(tree => tree.path === choice)
  const displayPath = chosen?.path ?? defaultPath
  const otherFolder = allBranches || pathKey(displayPath) !== pathKey(current?.root ?? anchor) ? displayPath : null
  const alternate = useFolderData(otherFolder, allBranches ? readAllGit : readGit, revision)
  const result = otherFolder ? alternate.result : terminal.result
  const data = result?.data
  const repo = data?.success ? data.repo : null
  const repoRoot = repo?.root
  const scope = repo ? `${repo.allBranches ? 'all' : 'checkout'}:${repo.root}` : ''
  const [search, setSearch] = useState<{ scope: string; query: string } | null>(null)
  const query = search && search.scope === scope ? search.query : ''
  const term = query.trim()
  const found = useWorkspaceSearch<WorkspaceGitSearchResult>(repoRoot ?? '', term, revision, repo?.allBranches === false ? searchCheckoutGit : searchGit)
  const targetBranch = choices.find(tree => tree.path === displayPath)?.branch
  const displayBranch = repo ? repo.branch ?? (repo.head ? '분리된 HEAD' : undefined)
    : targetBranch === null ? '분리된 HEAD' : targetBranch
  const picker = choices.length > 1 ? (
    <div className="workspace-git-picker" title={displayPath}>
      <SelectMenu size="compact" ariaLabel="Git 기록 대상" icon={<RiFolderLine size={15} aria-hidden="true" />}
        value={allBranches ? ALL_BRANCHES : displayPath} onChange={value => setSelection({ origin: defaultPath, value })}
        options={[...choices.map(tree => {
          const duplicate = choices.some(other => tree !== other && tree.label === other.label)
          return { value: tree.path, label: duplicate ? `${tree.label} · ${tree.kind}` : tree.label }
        }), ...(offerAllBranches ? [{ value: ALL_BRANCHES, label: '전체 브랜치' }] : [])]} />
    </div>
  ) : undefined
  return (
    <>
      <BrowserHeader folder={displayPath} branch={displayBranch} picker={picker} onRefresh={() => setRevision(value => value + 1)} />
      {!result ? <WorkspaceNote>Git 기록을 읽는 중…</WorkspaceNote>
        : !data?.success ? <WorkspaceNote error>{data?.error ?? 'Git 기록을 읽지 못했습니다.'}</WorkspaceNote>
        : data.repo ? (
          <>
            <WorkspaceSearchBox label="Git 이력 검색" placeholder="커밋 메시지, 작성자, 해시" query={query}
              onChange={value => setSearch({ scope, query: value })} />
            <UncommittedChanges key={data.repo.root} folder={data.repo.root} revision={revision} label={folderName(data.repo.root)} />
            <GitLog key={scope} repo={data.repo} searching={Boolean(term)} found={found} />
          </>
        )
        : <WorkspaceNote>{data.reason === 'git-missing' ? 'Git을 설치하면 커밋 기록을 볼 수 있습니다.' : '현재 폴더는 Git 저장소에 속해 있지 않습니다.'}</WorkspaceNote>}
    </>
  )
}
