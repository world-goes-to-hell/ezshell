// Git details of the workspace panel: the changes not committed yet (staged, changed, new) and the files
// of a commit. A file row opens its diff in place; a file that exists opens in the file window too.
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { RiArrowDownSLine, RiArrowRightSLine, RiExternalLinkLine, RiFolderLine, RiFolderOpenLine, RiGitBranchLine } from 'react-icons/ri'
import type { WorkspaceGitFile, WorkspaceGitStatus } from '../../types'
import { FILE_KIND_LABELS, FILE_KIND_MARKS, splitPath } from '../../lib/workspaceDetails'
import { buildChangeTree, formatCount, mergeChanges, totalLines, type ChangeNode, type ChangedFile } from '../../lib/gitChangeTree'
import { GitDiffBlock, openWorkspaceFile, useWorkspaceFileMenu } from './WorkspaceDetails'

interface FileRowProps {
  root: string
  file: WorkspaceGitFile
  /** The commit the file changed in; none for a change not committed yet */
  hash?: string
  label: string
  /** In the folder tree: the depth (indent) and the lines added / removed; the folder is not repeated */
  tree?: { depth: number; changed: ChangedFile }
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

function GitFileRow({ root, file, hash, label, tree }: FileRowProps) {
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

/** The changes as folders → files: folders open by default, a folder row folds what is under it */
function ChangeTree({ nodes, root, label, depth, folded, onFold }: {
  nodes: ChangeNode[]; root: string; label: string; depth: number; folded: ReadonlySet<string>; onFold: (path: string) => void
}) {
  return (
    <ul className="workspace-git-files is-tree">
      {nodes.map(node => {
        if (node.kind === 'file') return <GitFileRow key={node.path} root={root} file={node.file} label={label} tree={{ depth, changed: node.file }} />
        const isOpen = !folded.has(node.path)
        const Chevron = isOpen ? RiArrowDownSLine : RiArrowRightSLine
        const Icon = isOpen ? RiFolderOpenLine : RiFolderLine
        return (
          <li key={node.path} className="workspace-git-folder" data-path={node.path}>
            <button type="button" className="workspace-git-folder-row" aria-expanded={isOpen} onClick={() => onFold(node.path)}
              style={{ '--workspace-tree-depth': depth } as CSSProperties} title={node.path}>
              <Chevron size={14} className="workspace-tree-chevron" aria-hidden="true" />
              <Icon size={14} className="workspace-git-folder-icon" aria-hidden="true" />
              <span className="workspace-git-folder-name" dir="auto">{node.name}</span>
              <span className="workspace-git-folder-count" title={`바뀐 파일 ${node.count}개`}>{node.count}</span>
            </button>
            {isOpen && <ChangeTree nodes={node.children} root={root} label={label} depth={depth + 1} folded={folded} onFold={onFold} />}
          </li>
        )
      })}
    </ul>
  )
}

type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T }

/** The changes since the last commit, read again when `revision` changes (the panel's refresh) */
export function UncommittedChanges({ folder, revision, label }: { folder: string; revision: number; label: string }) {
  const [state, setState] = useState<Load<WorkspaceGitStatus | null>>({ status: 'loading' })
  const [isOpen, setIsOpen] = useState(true)
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
  useEffect(() => {
    let active = true
    const read = window.electronAPI.workspaceGitStatus
    if (!read) return
    void read(folder).then(
      result => { if (active) setState(result.success ? { status: 'ready', value: result.repo } : { status: 'error', message: result.error }) },
      () => { if (active) setState({ status: 'error', message: '커밋하지 않은 변경을 읽지 못했습니다.' }) }
    )
    return () => { active = false }
  }, [folder, revision])
  if (state.status === 'loading') return <p className="workspace-diff-note">변경 사항을 읽는 중…</p>
  if (state.status === 'error') return <p className="workspace-diff-note is-error">{state.message}</p>
  const repo = state.value
  if (!repo) return null
  const count = files.length
  const Chevron = isOpen ? RiArrowDownSLine : RiArrowRightSLine
  return (
    <section className="workspace-uncommitted" data-empty={count === 0 || undefined} data-open={isOpen || undefined} aria-label="커밋하지 않은 변경">
      <button type="button" className="workspace-uncommitted-head" aria-expanded={isOpen} onClick={() => setIsOpen(open => !open)}>
        <Chevron size={15} aria-hidden="true" />
        <span className="workspace-uncommitted-label">커밋하지 않은 변경</span>
        {count > 0 && (
          <span className="workspace-uncommitted-lines" title="HEAD 와 비교한 줄 수 (새 파일 포함)">
            <span className="is-add">+{formatCount(lines.added)}</span>
            <span className="is-remove">−{formatCount(lines.removed)}</span>
          </span>
        )}
        <span className="workspace-uncommitted-count">{count === 0 ? '없음' : `${count}개`}</span>
      </button>
      {isOpen && count > 0 && repo.branch && (
        <div className="workspace-uncommitted-branch" title={repo.upstream ? `${repo.branch} → ${repo.upstream}` : repo.branch}>
          <RiGitBranchLine size={12} aria-hidden="true" />
          <span className="workspace-uncommitted-branch-name">{repo.branch}</span>
          {repo.upstream && <span className="workspace-uncommitted-upstream">→ {repo.upstream}</span>}
        </div>
      )}
      {isOpen && count > 0 && (
        <div className="workspace-uncommitted-body">
          <ChangeTree nodes={tree} root={repo.top} label={label} depth={0} folded={folded} onFold={fold} />
          {repo.truncated && <p className="workspace-diff-note">변경이 많아 일부만 표시했습니다.</p>}
        </div>
      )}
    </section>
  )
}

/** The files a commit changed (against its first parent) */
export function CommitFiles({ root, hash, label }: { root: string; hash: string; label: string }) {
  const [state, setState] = useState<Load<WorkspaceGitFile[]>>({ status: 'loading' })
  useEffect(() => {
    let active = true
    const read = window.electronAPI.workspaceGitCommitFiles
    if (!read) return
    void read(root, hash).then(
      result => { if (active) setState(result.success ? { status: 'ready', value: result.files } : { status: 'error', message: result.error }) },
      () => { if (active) setState({ status: 'error', message: '커밋의 파일을 읽지 못했습니다.' }) }
    )
    return () => { active = false }
  }, [root, hash])
  if (state.status === 'loading') return <p className="workspace-diff-note">바뀐 파일을 읽는 중…</p>
  if (state.status === 'error') return <p className="workspace-diff-note is-error">{state.message}</p>
  if (state.value.length === 0) return <p className="workspace-diff-note">바뀐 파일이 없습니다.</p>
  return (
    <ul className="workspace-git-files is-commit">
      {state.value.map(file => <GitFileRow key={`${file.path}:${file.kind}`} root={root} file={file} hash={hash} label={label} />)}
    </ul>
  )
}
