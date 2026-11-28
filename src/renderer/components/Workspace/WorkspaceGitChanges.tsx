// Git details of the workspace panel: the changes not committed yet (staged, changed, new) with boxes to
// pick what to commit, and the files of a commit. A file row opens its diff in place; a file that exists
// opens in the file window too.
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { RiArrowDownSLine, RiArrowRightSLine, RiExternalLinkLine, RiFolderLine, RiFolderOpenLine, RiGitBranchLine } from 'react-icons/ri'
import type { WorkspaceFileOwner, WorkspaceGitFile, WorkspaceGitStatus } from '../../types'
import { agentChip, agentsWithFiles, overlaps, ownersByPath, ownersTitle } from '../../lib/fileOwners'
import { useFileOwners } from './useFileOwners'
import { RepoFreeze } from './RepoFreeze'
import { FILE_KIND_LABELS, FILE_KIND_MARKS, splitPath } from '../../lib/workspaceDetails'
import { buildChangeTree, formatCount, mergeChanges, totalLines, type ChangeNode, type ChangedFile } from '../../lib/gitChangeTree'
import { checkState, isSelectable, selectablePaths, toggleOne, togglePaths, type CheckState } from '../../lib/gitCommitSelection'
import { gitCommitFilesKey, gitStatusKey } from '../../lib/gitReadCache'
import { draftOf, useGitCommitStore } from '../../stores/gitCommitStore'
import { GitDiffBlock, openWorkspaceFile, useWorkspaceFileMenu } from './WorkspaceDetails'
import { GitCommitBox } from './GitCommitBox'
import { loadGitStatus } from '../../lib/workspaceGitReads'
import { useCachedGitRead } from './useCachedGitRead'

interface FileRowProps {
  root: string
  file: WorkspaceGitFile
  /** The commit the file changed in; none for a change not committed yet */
  hash?: string
  label: string
  /** In the folder tree: the depth (indent) and the lines added / removed; the folder is not repeated */
  tree?: { depth: number; changed: ChangedFile }
  /** The file's box in the change list */
  select?: { checked: boolean; disabled: boolean; onToggle: () => void }
  /** The agents that changed it (an uncommitted file; docs/plan/2026-11-28-agent-file-owners.md) */
  owner?: WorkspaceFileOwner
}

/** Who changed a file: the most recent agent's role, and the overlap when another agent changed it too */
function OwnerChips({ owner }: { owner: WorkspaceFileOwner }) {
  const [first] = owner.agents
  if (!first) return null
  return (
    <span className="workspace-git-owners" title={ownersTitle(owner)} data-overlap={overlaps(owner) || undefined} data-uncertain={owner.uncertain || undefined}>
      <span className="workspace-git-owner" data-kind={first.kind}>{agentChip(first)}{owner.uncertain && '?'}</span>
      {overlaps(owner) && <span className="workspace-git-overlap">겹침 {owner.agents.length}</span>}
    </span>
  )
}

/** "+12 −3" of a file; nothing for a binary file */
function LineCounts({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null && removed === null) return <span className="workspace-git-lines is-binary" title="바이너리 파일">bin</span>
  return (
    <span className="workspace-git-lines">
      {added !== null && added > 0 && <span className="is-add">+{formatCount(added)}</span>}
      {removed !== null && removed > 0 && <span className="is-remove">−{formatCount(removed)}</span>}
    </span>
  )
}

function GitFileRow({ root, file, hash, label, tree, select, owner }: FileRowProps) {
  const [isOpen, setIsOpen] = useState(false)
  const split = splitPath(file.path)
  const name = split.name
  const folder = tree ? '' : split.folder
  const Chevron = isOpen ? RiArrowDownSLine : RiArrowRightSLine
  // A new file has no earlier version to compare with; a deleted one no file to open
  const canDiff = file.kind !== 'untracked'
  const canOpen = !hash && file.kind !== 'deleted'
  // A file the last commit has: the window opens comparing with it (new files have nothing to compare)
  const hasHead = file.kind !== 'untracked' && file.kind !== 'added'
  const openCurrentFile = () => void openWorkspaceFile(root, file.path, label, { compareHead: hasHead })
  const { openMenu, menu } = useWorkspaceFileMenu(root, file.path, openCurrentFile)
  return (
    <li className="workspace-git-file" data-kind={file.kind} data-path={file.path}>
      <div className="workspace-git-file-row" style={tree ? { '--workspace-tree-depth': tree.depth } as CSSProperties : undefined}
        onContextMenu={canOpen ? openMenu : undefined}>
        {select && (
          <CheckBox state={select.checked ? 'all' : 'none'} disabled={select.disabled} onToggle={select.onToggle}
            label={`${file.path} 선택`} title={file.kind === 'conflict' ? '충돌을 해결한 뒤 커밋할 수 있습니다'
              : file.path.endsWith('/') ? '이 저장소 안의 다른 저장소는 여기서 커밋할 수 없습니다' : undefined} />
        )}
        <button
          type="button"
          className="workspace-git-file-toggle"
          aria-expanded={canDiff ? isOpen : undefined}
          title={`${file.from ? `${file.from} → ` : ''}${file.path} (${FILE_KIND_LABELS[file.kind]})`}
          onClick={() => (canDiff ? setIsOpen(open => !open) : void openWorkspaceFile(root, file.path, label))}
        >
          {canDiff ? <Chevron size={14} className="workspace-tree-chevron" aria-hidden="true" /> : <span className="workspace-tree-chevron" aria-hidden="true" />}
          {!tree && <span className="workspace-git-mark" data-kind={file.kind} aria-label={FILE_KIND_LABELS[file.kind]}>{FILE_KIND_MARKS[file.kind]}</span>}
          <span className="workspace-git-file-name" dir="auto">{name}</span>
          {folder && <span className="workspace-git-file-folder" dir="auto">{folder}</span>}
          {owner && <OwnerChips owner={owner} />}
          {tree && <LineCounts added={tree.changed.added} removed={tree.changed.removed} />}
          {tree && (
            <span className="workspace-git-mark" data-kind={file.kind} data-staged={tree.changed.staged || undefined}
              aria-label={`${FILE_KIND_LABELS[file.kind]}${tree.changed.staged ? ' (스테이징됨)' : ''}`}
              title={`${FILE_KIND_LABELS[file.kind]}${tree.changed.staged ? ' · 스테이징됨' : ''}`}>
              {FILE_KIND_MARKS[file.kind]}
            </span>
          )}
        </button>
        {canOpen && (
          <button type="button" className="workspace-git-file-open" title={hasHead ? '파일 창에서 열기 (마지막 커밋과 비교)' : '파일 창에서 열기'} aria-label={`${name} 열기`} onClick={openCurrentFile}>
            <RiExternalLinkLine size={14} />
          </button>
        )}
      </div>
      {menu}
      {isOpen && <GitDiffBlock root={root} file={file.path} hash={hash} />}
    </li>
  )
}

/** A file's or a folder's box; a folder with some files ticked shows the mixed state */
function CheckBox({ state, disabled = false, label, title, onToggle }: {
  state: CheckState; disabled?: boolean; label: string; title?: string; onToggle: () => void
}) {
  return (
    <input type="checkbox" className="workspace-git-check" checked={state === 'all'} disabled={disabled}
      ref={element => { if (element) element.indeterminate = state === 'some' }}
      aria-label={label} title={title} onChange={onToggle} />
  )
}

interface TreeSelection {
  /** The agents of each file, by path (empty until main offers them) */
  owners: ReadonlyMap<string, WorkspaceFileOwner>
  selected: ReadonlySet<string>
  disabled: boolean
  onFile: (path: string) => void
  onPaths: (paths: readonly string[]) => void
}

/** The changes as folders → files: folders open by default, a folder row folds what is under it */
function ChangeTree({ nodes, root, label, depth, folded, onFold, selection }: {
  nodes: ChangeNode[]; root: string; label: string; depth: number; folded: ReadonlySet<string>; onFold: (path: string) => void; selection: TreeSelection
}) {
  return (
    <ul className="workspace-git-files is-tree">
      {nodes.map(node => {
        if (node.kind === 'file') {
          const canSelect = isSelectable(node.file)
          return (
            <GitFileRow key={node.path} root={root} file={node.file} label={label} tree={{ depth, changed: node.file }} owner={selection.owners.get(node.path)} select={{
              checked: canSelect && selection.selected.has(node.path),
              disabled: selection.disabled || !canSelect,
              onToggle: () => selection.onFile(node.path)
            }} />
          )
        }
        const isOpen = !folded.has(node.path)
        const Chevron = isOpen ? RiArrowDownSLine : RiArrowRightSLine
        const Icon = isOpen ? RiFolderOpenLine : RiFolderLine
        const paths = selectablePaths(node)
        return (
          <li key={node.path} className="workspace-git-folder" data-path={node.path}>
            <div className="workspace-git-folder-line" style={{ '--workspace-tree-depth': depth } as CSSProperties}>
              <CheckBox state={checkState(paths, selection.selected)} disabled={selection.disabled || paths.length === 0}
                label={`${node.path} 폴더의 파일 모두 선택`} onToggle={() => selection.onPaths(paths)} />
              <button type="button" className="workspace-git-folder-row" aria-expanded={isOpen} onClick={() => onFold(node.path)} title={node.path}>
                <Chevron size={14} className="workspace-tree-chevron" aria-hidden="true" />
                <Icon size={14} className="workspace-git-folder-icon" aria-hidden="true" />
                <span className="workspace-git-folder-name" dir="auto">{node.name}</span>
                <span className="workspace-git-folder-count" title={`바뀐 파일 ${node.count}개`}>{node.count}</span>
              </button>
            </div>
            {isOpen && <ChangeTree nodes={node.children} root={root} label={label} depth={depth + 1} folded={folded} onFold={onFold} selection={selection} />}
          </li>
        )
      })}
    </ul>
  )
}

type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T }
type Answer<T> = ({ success: true } & T) | { success: false; error: string }

/** An IPC answer as what to show; undefined (nothing known yet) is loading */
function loadOf<T, V>(answer: Answer<T> | undefined, value: (answer: { success: true } & T) => V): Load<V> {
  if (answer === undefined) return { status: 'loading' }
  return answer.success ? { status: 'ready', value: value(answer) } : { status: 'error', message: answer.error }
}

const NOTHING: ReadonlySet<string> = new Set()

/**
 * The "변경" tab's list: the changes since the last commit as a folder tree with boxes, and the commit
 * box for the ticked files. Read again when `revision` changes (refresh, and after a commit); the last
 * list shows meanwhile, dimmed and not to be ticked or committed until the new one comes.
 */
export function ChangeList({ folder, revision, label, onCommitted }: { folder: string; revision: number; label: string; onCommitted: () => void }) {
  const readStatus = window.electronAPI.workspaceGitStatus
  const status = useCachedGitRead<Answer<{ repo: WorkspaceGitStatus | null }>>(readStatus ? gitStatusKey(folder) : null,
    () => loadGitStatus(folder), revision)
  const state = loadOf(status.value, answer => answer.repo)
  const stale = status.value !== undefined && !status.fresh
  // Folded folders of the tree (open by default); kept across refreshes
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const fold = (path: string) => setFolded(previous => {
    const next = new Set(previous)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  const repoValue = state.status === 'ready' ? state.value : null
  const files = useMemo(() => (repoValue ? mergeChanges(repoValue.staged, repoValue.changed, repoValue.untracked, repoValue.stats) : []), [repoValue])
  const tree = useMemo(() => buildChangeTree(files), [files])
  const lines = useMemo(() => totalLines(files), [files])
  const selectable = useMemo(() => selectablePaths(tree), [tree])
  const top = repoValue?.top ?? null
  const draft = useGitCommitStore(store => (top ? draftOf(store.repos, top) : null))
  const applyStatus = useGitCommitStore(store => store.applyStatus)
  const setSelected = useGitCommitStore(store => store.setSelected)
  const selected = draft?.selected ?? NOTHING
  const chosen = useMemo(() => selectable.filter(path => selected.has(path)), [selectable, selected])
  useEffect(() => { if (top) applyStatus(top, files) }, [top, files, applyStatus])
  const { owners, freeze, reload: reloadOwners } = useFileOwners(top, revision)
  const ownerMap = useMemo(() => ownersByPath(owners), [owners])
  const agents = useMemo(() => agentsWithFiles(owners, selectable), [owners, selectable])
  if (state.status === 'loading') return <p className="workspace-diff-note">변경 사항을 읽는 중…</p>
  if (state.status === 'error') return <p className="workspace-diff-note is-error">{state.message}</p>
  const repo = state.value
  if (!repo || !top) return null
  const count = files.length
  // Ticking an earlier list (one from before a commit) could commit what is already committed
  const busy = draft?.busy === true || stale
  const selection: TreeSelection = {
    owners: ownerMap,
    selected,
    disabled: busy,
    onFile: path => setSelected(top, toggleOne(selected, path)),
    onPaths: paths => setSelected(top, togglePaths(selected, paths))
  }
  return (
    <div className="workspace-changes" data-refreshing={stale || undefined} aria-busy={stale || undefined}>
      <RepoFreeze key={top} top={top} freeze={freeze} onChanged={reloadOwners} />
      {count > 0 && <GitCommitBox top={top} paths={chosen} waiting={stale} onCommitted={onCommitted}
        agents={agents} onPickAgent={paths => setSelected(top, new Set(paths))} />}
      <section className="workspace-uncommitted" data-empty={count === 0 || undefined} aria-label="커밋하지 않은 변경">
        <div className="workspace-uncommitted-head">
          {count > 0 && <CheckBox state={checkState(selectable, selected)} disabled={busy || selectable.length === 0}
            label="모든 파일 선택" title="모든 파일 선택 · 해제" onToggle={() => setSelected(top, togglePaths(selected, selectable))} />}
          <span className="workspace-uncommitted-label">커밋하지 않은 변경</span>
          {count > 0 && (
            <span className="workspace-uncommitted-lines" title="HEAD 와 비교한 줄 수 (새 파일 포함)">
              <span className="is-add">+{formatCount(lines.added)}</span>
              <span className="is-remove">−{formatCount(lines.removed)}</span>
            </span>
          )}
          <span className="workspace-uncommitted-count" title={count > 0 ? `바뀐 파일 ${count}개 중 ${chosen.length}개 선택` : undefined}>
            {count === 0 ? '없음' : chosen.length > 0 ? `${chosen.length} / ${count}개` : `${count}개`}
          </span>
        </div>
        {/* The header names the branch already; this line is for where it goes */}
        {count > 0 && repo.branch && repo.upstream && (
          <div className="workspace-uncommitted-branch" title={`${repo.branch} → ${repo.upstream}`}>
            <RiGitBranchLine size={12} aria-hidden="true" />
            <span className="workspace-uncommitted-branch-name">{repo.branch}</span>
            <span className="workspace-uncommitted-upstream">→ {repo.upstream}</span>
          </div>
        )}
        {count > 0 ? (
          <div className="workspace-uncommitted-body">
            <ChangeTree nodes={tree} root={repo.top} label={label} depth={0} folded={folded} onFold={fold} selection={selection} />
            {repo.truncated && <p className="workspace-diff-note">변경이 많아 일부만 표시했습니다 (표시된 파일만 커밋할 수 있습니다).</p>}
          </div>
        ) : <p className="workspace-diff-note">마지막 커밋 뒤로 바뀐 파일이 없습니다.</p>}
      </section>
    </div>
  )
}

/** The files a commit changed (against its first parent) */
export function CommitFiles({ root, hash, label }: { root: string; hash: string; label: string }) {
  // A commit's files never change: opened again, the kept list is final
  const readFiles = window.electronAPI.workspaceGitCommitFiles
  const answer = useCachedGitRead<Answer<{ files: WorkspaceGitFile[] }>>(readFiles ? gitCommitFilesKey(root, hash) : null,
    () => (readFiles as NonNullable<typeof readFiles>)(root, hash).catch(() => ({ success: false as const, error: '커밋의 파일을 읽지 못했습니다.' })),
    0, { immutable: true })
  const state = loadOf(answer.value, value => value.files)
  if (state.status === 'loading') return <p className="workspace-diff-note">바뀐 파일을 읽는 중…</p>
  if (state.status === 'error') return <p className="workspace-diff-note is-error">{state.message}</p>
  if (state.value.length === 0) return <p className="workspace-diff-note">바뀐 파일이 없습니다.</p>
  return (
    <ul className="workspace-git-files is-commit">
      {state.value.map(file => <GitFileRow key={`${file.path}:${file.kind}`} root={root} file={file} hash={hash} label={label} />)}
    </ul>
  )
}
