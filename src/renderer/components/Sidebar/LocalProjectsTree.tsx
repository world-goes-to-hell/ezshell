import { useState, type DragEvent, type ReactNode } from 'react'
import { RiArrowDownSLine, RiArrowRightSLine, RiFolder3Line, RiGitBranchLine } from 'react-icons/ri'
import type { LocalProjectState } from '../../hooks/useLocalProjects'
import { folderLabel, pathKey } from '../../lib/localWorkspaceTree'

export interface WorktreeNode {
  path: string
  branch: string | null
  /** The repository's main checkout */
  isMain: boolean
}

export interface ProjectNode {
  folder: string
  name: string
  worktrees: WorktreeNode[]
  /** Shown under the name when Git could not be read */
  note?: string
}

/**
 * Projects with their worktrees, one entry per repository: a second registered folder of a repository
 * already shown adds nothing. A folder that is not a Git checkout is its own single "worktree".
 */
export function buildProjectNodes(projects: readonly LocalProjectState[]): ProjectNode[] {
  const seenRoots = new Set<string>()
  const nodes: ProjectNode[] = []
  for (const { folder, info, error } of projects) {
    const repo = info?.repo
    if (repo) {
      const root = pathKey(repo.root)
      if (seenRoots.has(root)) continue
      seenRoots.add(root)
      nodes.push({
        folder,
        name: folderLabel(repo.root),
        worktrees: repo.worktrees.map(tree => ({ path: tree.path, branch: tree.branch, isMain: pathKey(tree.path) === root }))
      })
      continue
    }
    nodes.push({
      folder,
      name: folderLabel(folder),
      worktrees: [{ path: folder, branch: null, isMain: true }],
      note: error ?? (info ? undefined : '읽는 중…')
    })
  }
  return nodes
}

interface LocalProjectsTreeProps {
  nodes: ProjectNode[]
  folded: ReadonlySet<string>
  onToggleFold: (key: string) => void
  /** Tab ids per worktree path */
  tabsOf: (path: string) => string[]
  renderTab: (tabId: string) => ReactNode
  onOpenWorktree: (project: ProjectNode, worktree: WorktreeNode) => void
  /** The saved SSH sessions linked to the project ("서버"), drawn above its worktrees */
  renderServers?: (project: ProjectNode) => ReactNode
  /** A sidebar session or a tab dropped on the project (the drag's text/plain) */
  onDropOnProject?: (project: ProjectNode, text: string) => void
}

export const projectFoldKey = (folder: string) => `p:${pathKey(folder)}`
export const worktreeFoldKey = (path: string) => `w:${pathKey(path)}`

/** Registered folders → worktrees → the local terminals open in each (with their agents) */
// Past agent sessions are not listed here: the agent history of the right panel shows them (user's choice)
export function LocalProjectsTree({ nodes, folded, onToggleFold, tabsOf, renderTab, onOpenWorktree, renderServers, onDropOnProject }: LocalProjectsTreeProps) {
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  // Sessions and tabs are dragged as text/plain (`session:<id>` / the tab id)
  const dropProps = (project: ProjectNode, key: string) => onDropOnProject ? {
    onDragOver: (event: DragEvent<HTMLLIElement>) => {
      if (!event.dataTransfer.types.includes('text/plain')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      if (dropTarget !== key) setDropTarget(key)
    },
    onDragLeave: (event: DragEvent<HTMLLIElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
    },
    onDrop: (event: DragEvent<HTMLLIElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setDropTarget(null)
      onDropOnProject(project, event.dataTransfer.getData('text/plain'))
    }
  } : {}
  return (
    <ul className="local-projects">
      {nodes.map(project => {
        const projectKey = projectFoldKey(project.folder)
        const isProjectOpen = !folded.has(projectKey)
        const Chevron = isProjectOpen ? RiArrowDownSLine : RiArrowRightSLine
        return (
          <li key={projectKey} className={`local-project${dropTarget === projectKey ? ' is-drop-target' : ''}`} data-project-folder={project.folder} {...dropProps(project, projectKey)}>
            <button
              type="button"
              className="local-project-row"
              aria-expanded={isProjectOpen}
              onClick={() => onToggleFold(projectKey)}
              title={project.folder}
            >
              <Chevron size={14} className="local-project-chevron" />
              <RiFolder3Line size={14} className="local-project-icon" />
              <span className="local-project-name">{project.name}</span>
              {project.note && <span className="local-project-note">{project.note}</span>}
            </button>
            {isProjectOpen && renderServers?.(project)}
            {isProjectOpen && (
              <ul className="local-worktrees">
                {project.worktrees.map(worktree => {
                  const tabs = tabsOf(worktree.path)
                  const treeKey = worktreeFoldKey(worktree.path)
                  const isTreeOpen = !folded.has(treeKey)
                  const hasChildren = tabs.length > 0
                  return (
                    <li key={treeKey} className={`local-worktree${tabs.length > 0 ? ' has-tabs' : ''}`} data-worktree-path={worktree.path}>
                      <div className="local-worktree-row">
                        <button
                          type="button"
                          className="local-worktree-open"
                          onClick={() => onOpenWorktree(project, worktree)}
                          title={tabs.length > 0 ? `${worktree.path}\n열린 터미널로 이동` : `${worktree.path}\n이 폴더에서 로컬 터미널 열기`}
                        >
                          <span className={`local-worktree-dot${tabs.length > 0 ? ' is-on' : ''}`} aria-hidden="true" />
                          <span className="local-worktree-label">
                            <span className="local-worktree-name">{folderLabel(worktree.path)}</span>
                            {worktree.isMain && project.worktrees.length > 1 && <span className="local-worktree-tag">기본</span>}
                          </span>
                          {worktree.branch && (
                            <span className="local-worktree-branch" title={worktree.branch}>
                              <RiGitBranchLine size={11} aria-hidden="true" />
                              <span className="local-worktree-branch-name">{worktree.branch}</span>
                            </span>
                          )}
                        </button>
                        {hasChildren && (
                          <button
                            type="button"
                            className="local-worktree-fold"
                            aria-expanded={isTreeOpen}
                            onClick={() => onToggleFold(treeKey)}
                            title={isTreeOpen ? '터미널 목록 접기' : `터미널 ${tabs.length}개 펼치기`}
                          >
                            {isTreeOpen ? <RiArrowDownSLine size={14} /> : <span className="local-worktree-count">{tabs.length}</span>}
                          </button>
                        )}
                      </div>
                      {hasChildren && isTreeOpen && (
                        <div className="local-worktree-content">
                          <ul className="local-terms-list is-nested">{tabs.map(renderTab)}</ul>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}
