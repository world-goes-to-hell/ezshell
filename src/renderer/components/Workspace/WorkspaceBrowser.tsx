import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RiArrowDownSLine, RiArrowRightSLine, RiCloseLine, RiFolderLine, RiGitBranchLine, RiGitCommitLine, RiGitMergeLine, RiRefreshLine, RiSearchLine } from 'react-icons/ri'
import type { WorkspaceDirectorySearchResult, WorkspaceGitCommit, WorkspaceGitRepository, WorkspaceGitSearchResult, WorkspaceGitUpstreamComparison } from '../../types'
import { workspaceGitGraph, type GitGraphRow } from '../../lib/workspaceGitGraph'
import { folderName } from '../../lib/agentHistory'
import { TreeLevel, TreeRevealContext, WorkspaceFileResults, type TreeReveal } from './WorkspaceDetails'
import { CommitFiles } from './WorkspaceGitChanges'
import { useGitTarget } from './useGitTarget'

const searchFiles = (folder: string, query: string) => window.electronAPI.workspaceDirectorySearch?.(folder, query)
// node_modules, build output and the like too (the default search lists those folders but does not read them)
const searchAllFiles = (folder: string, query: string) => window.electronAPI.workspaceDirectorySearch?.(folder, query, true)
const prepareFiles = (folder: string, refresh = false, includeAll = false) => window.electronAPI.workspaceDirectoryPrepare?.(folder, refresh, includeAll).catch(() => undefined)
const searchGit = (folder: string, query: string) => window.electronAPI.workspaceGitSearch?.(folder, query)
const searchCheckoutGit = (folder: string, query: string) => window.electronAPI.workspaceGitSearch?.(folder, query, true)
const date = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' })
const REVEAL_GIVE_UP_MS = 6000

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

/** `refreshing`: what shows is the last answer and a new read runs (the refresh button turns after a moment) */
export function BrowserHeader({ folder, branch, onRefresh, picker, refreshing = false }: { folder: string; branch?: string; onRefresh: () => void; picker?: ReactNode; refreshing?: boolean }) {
  return (
    <div className="workspace-browser-header">
      {picker ?? <>
        <RiFolderLine size={15} aria-hidden="true" />
        <span className="workspace-browser-path" title={folder} dir="auto">{folder}</span>
      </>}
      {branch && <span className="workspace-branch" title={branch}><RiGitBranchLine size={13} />{branch}</span>}
      <button type="button" className="workspace-close" data-refreshing={refreshing || undefined} onClick={onRefresh}
        aria-label={refreshing ? '새로 고침 (다시 읽는 중)' : '새로 고침'} title={refreshing ? '다시 읽는 중…' : '새로 고침'}>
        <RiRefreshLine size={16} />
      </button>
    </div>
  )
}

export function WorkspaceNote({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <p className={`workspace-note${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</p>
}

/** The folder as a tree: folders expand in place, files open in the file window */
export function WorkspaceFiles({ folder, reveal, onRevealed }: { folder: string; reveal?: { relative: string; seq: number } | null; onRevealed?: (seq: number) => void }) {
  // Refresh reads the tree again from the top (open folders close again)
  const [revision, setRevision] = useState(0)
  const [query, setQuery] = useState('')
  const term = query.trim()
  // A chat's folder link: the search gives way to the tree, which opens up to that folder. A folder the
  // tree never reaches (a long folder shows only part of its entries) lets the request go after a while
  const revealSeq = reveal?.seq
  const revealTarget = reveal?.relative
  const doneRef = useRef(onRevealed)
  doneRef.current = onRevealed
  useEffect(() => {
    if (revealSeq === undefined || revealTarget === undefined) return
    setQuery('')
    if (!revealTarget) {
      doneRef.current?.(revealSeq)
      return
    }
    const timer = window.setTimeout(() => doneRef.current?.(revealSeq), REVEAL_GIVE_UP_MS)
    return () => window.clearTimeout(timer)
  }, [revealSeq, revealTarget])
  const treeReveal = useMemo<TreeReveal | null>(() => revealSeq === undefined || !revealTarget ? null : {
    target: revealTarget,
    seq: revealSeq,
    ignoreCase: /^[a-zA-Z]:|^\\\\/.test(folder),
    done: () => doneRef.current?.(revealSeq)
  }, [revealSeq, revealTarget, folder])
  // Situational: kept while this folder's panel is open; the default search leaves those folders out
  const [includeAll, setIncludeAll] = useState(false)
  const found = useWorkspaceSearch<WorkspaceDirectorySearchResult>(folder, term, revision, includeAll ? searchAllFiles : searchFiles, 90)
  useEffect(() => { void prepareFiles(folder, false, includeAll) }, [folder, includeAll])
  const refresh = async () => {
    await prepareFiles(folder, true, includeAll)
    setRevision(value => value + 1)
  }
  const label = folderName(folder)
  return (
    <>
      <BrowserHeader folder={folder} onRefresh={() => void refresh()} />
      <WorkspaceSearchBox label="파일·폴더 검색" placeholder="파일 이름 또는 경로" query={query} onChange={setQuery} />
      <div className="workspace-file-browse" hidden={Boolean(term)}>
        <TreeRevealContext.Provider value={treeReveal}>
          <TreeLevel key={`${folder}:${revision}`} root={folder} relative="" depth={0} label={label} />
        </TreeRevealContext.Provider>
      </div>
      {term && (!found ? <WorkspaceNote>작업 폴더를 검색하는 중…</WorkspaceNote>
        : !found.success ? <WorkspaceNote error>{found.error}</WorkspaceNote>
        : <>
          <WorkspaceNote>{found.entries.length || found.truncated ? `검색 결과 ${found.entries.length}개` : '일치하는 파일·폴더가 없습니다.'}{found.truncated && ' · 일부 범위만 검색됨'}</WorkspaceNote>
          <SkippedFolders result={found} onChange={setIncludeAll} />
          {found.entries.length > 0 && <WorkspaceFileResults root={folder} label={label} entries={found.entries} />}
        </>)}
    </>
  )
}

/** Which installed/generated folders the search left out, with the switch to include them */
function SkippedFolders({ result, onChange }: { result: WorkspaceDirectorySearchResult; onChange: (includeAll: boolean) => void }) {
  if (result.includedAll) {
    return (
      <p className="workspace-search-scope">
        <span>node_modules·빌드 결과 폴더 안까지 검색했습니다.</span>
        <button type="button" onClick={() => onChange(false)}>제외하기</button>
      </p>
    )
  }
  const skipped = result.skipped
  if (!skipped?.count) return null
  const names = skipped.names.join(', ')
  return (
    <p className="workspace-search-scope">
      <span title={names}>{names} 안은 검색하지 않았습니다 (폴더 {skipped.count}개).</span>
      <button type="button" onClick={() => onChange(true)}>포함해서 검색</button>
    </p>
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

function GitCommitList({ root, head, commits, label, showGraph = false }: {
  root: string; head: string | null; commits: WorkspaceGitCommit[]; label: string; showGraph?: boolean
}) {
  const graph = useMemo(() => showGraph ? workspaceGitGraph(commits) : null, [commits, showGraph])
  // The commits opened to show the files they changed
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const toggle = (hash: string) => setOpened(previous => {
    const next = new Set(previous)
    if (next.has(hash)) next.delete(hash)
    else next.add(hash)
    return next
  })
  if (!commits.length) return null
  return (
    <ol className="workspace-git-list" aria-label={label}>
      {commits.map((commit, index) => {
        const isHead = commit.hash === head
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
            {isOpen && <div className="workspace-git-commit-files"><CommitFiles root={root} hash={commit.hash} label={folderName(root)} /></div>}
          </li>
        )
      })}
    </ol>
  )
}

function GitLog({ repo, searching, found }: { repo: WorkspaceGitRepository; searching: boolean; found: SearchAnswer<WorkspaceGitSearchResult> | null }) {
  if (searching && !found) return <WorkspaceNote>Git 기록을 검색하는 중…</WorkspaceNote>
  if (searching && found && !found.success) return <WorkspaceNote error>{found.error}</WorkspaceNote>
  const commits = searching && found?.success ? found.commits : repo.commits
  if (!commits.length) return <WorkspaceNote>{searching ? '일치하는 커밋이 없습니다.' : '아직 커밋이 없습니다.'}</WorkspaceNote>
  return (
    <>
      {searching && <WorkspaceNote>{found?.success && found.hasMore ? `최근 검색 결과 ${commits.length}개 표시` : `검색 결과 ${commits.length}개`}</WorkspaceNote>}
      <GitCommitList root={repo.root} head={repo.head} commits={commits} showGraph={!searching}
        label={searching ? 'Git 커밋 검색 결과' : 'Git 커밋 기록'} />
      {!searching && repo.hasMore && <WorkspaceNote>최근 {repo.commits.length}개 커밋 표시</WorkspaceNote>}
    </>
  )
}

function GitUpstreamComparison({ root }: { root: string }) {
  const [answer, setAnswer] = useState<SearchAnswer<{ comparison: WorkspaceGitUpstreamComparison | null }> | null>(null)
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const result = await window.electronAPI.workspaceGitUpstream(root)
        if (active) setAnswer(result)
      } catch {
        if (active) setAnswer({ success: false, error: '원격 추적 브랜치와 비교하지 못했습니다.' })
      }
    }
    void load()
    return () => { active = false }
  }, [root])

  if (!answer) return <WorkspaceNote>원격 추적 브랜치와 비교하는 중…</WorkspaceNote>
  if (!answer.success) return <WorkspaceNote error>{answer.error}</WorkspaceNote>
  const { comparison } = answer
  if (!comparison) return <WorkspaceNote>비교할 원격 추적 브랜치가 없습니다.</WorkspaceNote>
  if (comparison.status === 'missing') return <WorkspaceNote>{comparison.upstream}의 원격 추적 정보가 없습니다.</WorkspaceNote>

  const { branch, head, upstream } = comparison
  const groups = [
    { label: '보낼 커밋', count: comparison.ahead, commits: comparison.outgoing },
    { label: '받을 커밋', count: comparison.behind, commits: comparison.incoming }
  ]
  return (
    <div className="workspace-upstream-results">
      <div className="workspace-upstream-target">
        <span title={`${branch} ↔ ${upstream}`}>{branch} ↔ {upstream}</span>
        <small>마지막으로 가져온 원격 정보 기준</small>
      </div>
      {groups.map(({ label, count, commits }) => (
        <section key={label} aria-label={label}>
          <h3>{label} {count}개</h3>
          {count > 0 && <GitCommitList root={root} head={head} commits={commits} label={label} />}
          {count > commits.length && <WorkspaceNote>최근 {commits.length}개 커밋 표시</WorkspaceNote>}
        </section>
      ))}
    </div>
  )
}

export function WorkspaceGit({ folder }: { folder: string }) {
  const target = useGitTarget(folder, { offerAllBranches: true })
  const { result, repo, revision } = target
  const data = result?.data
  const repoRoot = repo?.root
  const scope = repo ? `${repo.allBranches ? 'all' : 'checkout'}:${repo.root}` : ''
  const [search, setSearch] = useState<{ scope: string; query: string } | null>(null)
  const [comparisonScope, setComparisonScope] = useState<string | null>(null)
  const comparing = comparisonScope === scope
  const query = search && search.scope === scope ? search.query : ''
  const term = comparing ? '' : query.trim()
  const found = useWorkspaceSearch<WorkspaceGitSearchResult>(repoRoot ?? '', term, revision, repo?.allBranches === false ? searchCheckoutGit : searchGit)
  return (
    <>
      <BrowserHeader folder={target.displayPath} branch={target.displayBranch} picker={target.picker} onRefresh={target.refresh} refreshing={target.refreshing} />
      {!result ? <WorkspaceNote>Git 기록을 읽는 중…</WorkspaceNote>
        : !data?.success ? <WorkspaceNote error>{data?.error ?? 'Git 기록을 읽지 못했습니다.'}</WorkspaceNote>
        : data.repo ? (
          <>
             <button type="button" className="workspace-upstream-toggle" aria-pressed={comparing}
               onClick={() => setComparisonScope(comparing ? null : scope)}>
               <RiGitMergeLine size={15} aria-hidden="true" /> 원격과 비교
             </button>
             {comparing ? <GitUpstreamComparison key={`${scope}:${data.repo.branch}:${data.repo.head}:${revision}`} root={data.repo.root} /> : <>
               <WorkspaceSearchBox label="Git 이력 검색" placeholder="커밋 메시지, 작성자, 해시" query={query}
                 onChange={value => setSearch({ scope, query: value })} />
               <GitLog key={scope} repo={data.repo} searching={Boolean(term)} found={found} />
             </>}
          </>
        )
        : <WorkspaceNote>{gitMissingNote(data.reason)}</WorkspaceNote>}
    </>
  )
}

/** Why a folder has no Git tabs to show */
export const gitMissingNote = (reason: 'git-missing' | 'not-repo') =>
  reason === 'git-missing' ? 'Git을 설치하면 커밋 기록과 변경 사항을 볼 수 있습니다.' : '현재 폴더는 Git 저장소에 속해 있지 않습니다.'
