import { useState, type DragEvent, type ReactNode } from 'react'
import { RiArrowDownSLine, RiArrowRightSLine, RiCloseLine, RiFolder3Line, RiGitBranchLine } from 'react-icons/ri'
import type { LocalProjectState } from '../../hooks/useLocalProjects'
import { folderLabel, pathKey } from '../../lib/localWorkspaceTree'
import { LocalSessionAgents } from './LocalSessionAgents'

export interface WorktreeNode {
  path: string
  branch: string | null
  /** The repository's main checkout */
  isMain: boolean
}

export interface ProjectNode {
  folder: string
  /** Every registered folder this node stands for (other folders of the same repository add none of their own) */
  folders: string[]
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
  const byRoot = new Map<string, ProjectNode>()
  const nodes: ProjectNode[] = []
  for (const { folder, info, error } of projects) {
    const repo = info?.repo
    if (repo) {
      // The main checkout (git lists it first): a registered linked worktree's own top level is not the
      // repository's, so keying by `repo.root` showed one repository twice, with that worktree as "기본"
      const mainPath = repo.worktrees[0]?.path ?? repo.root
      const root = pathKey(mainPath)
      const shown = byRoot.get(root)
      if (shown) {
        shown.folders.push(folder)
        continue
      }
      const node: ProjectNode = {
        folder,
        folders: [folder],
        name: folderLabel(mainPath),
        worktrees: repo.worktrees.map(tree => ({ path: tree.path, branch: tree.branch, isMain: pathKey(tree.path) === root }))
      }
      byRoot.set(root, node)
      nodes.push(node)
      continue
    }
    nodes.push({
      folder,
      folders: [folder],
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
  tabsOf: (path: string) => { id: string; name: string; connected: boolean }[]
  currentTabId: string | null
  renderTab: (tabId: string, label?: string) => ReactNode
  renderTabActions: (tabId: string, name: string) => ReactNode
  onOpenWorktree: (project: ProjectNode, worktree: WorktreeNode) => void
  /** The saved SSH sessions linked to the project ("서버"), drawn above its worktrees */
  renderServers?: (project: ProjectNode) => ReactNode
  /** A sidebar session or a tab dropped on the project (the drag's text/plain) */
  onDropOnProject?: (project: ProjectNode, text: string) => void
  /** Takes the project off the list (its folders, terminals and linked servers stay) */
  onRemoveProject?: (project: ProjectNode) => void
}

export const projectFoldKey = (folder: string) => `p:${pathKey(folder)}`
export const worktreeFoldKey = (path: string) => `w:${pathKey(path)}`

/** Registered folders → worktrees → the local terminals open in each (with their agents) */
// Past agent sessions are not listed here: the agent history of the right panel shows them (user's choice)
export function LocalProjectsTree({
  nodes, folded, onToggleFold, tabsOf, currentTabId, renderTab, renderTabActions, onOpenWorktree, renderServers, onDropOnProject, onRemoveProject
}: LocalProjectsTreeProps) {
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
            <div className="local-project-head">
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
              {onRemoveProject && (
                <button type="button" className="local-project-remove" onClick={() => onRemoveProject(project)}
                  title="목록에서 빼기 (폴더와 열린 터미널은 그대로)" aria-label={`${project.name} 을 목록에서 빼기`}>
                  <RiCloseLine size={14} />
                </button>
              )}
            </div>
            {isProjectOpen && renderServers?.(project)}
            {isProjectOpen && (
              <ul className="local-worktrees">
                {project.worktrees.map(worktree => {
                  const tabs = tabsOf(worktree.path)
                  const treeKey = worktreeFoldKey(worktree.path)
                  const isTreeOpen = !folded.has(treeKey)
                  const singleTab = tabs.length === 1 ? tabs[0] : undefined
                  const hasChildren = tabs.length > 1
                  const isCurrent = singleTab?.id === currentTabId
                  const name = folderLabel(worktree.path)
                  const shownNames = [name, project.name, worktree.branch && `${project.name} · ${worktree.branch}`]
                  return (
                    <li key={treeKey} className={`local-worktree${tabs.length > 0 ? ' has-tabs' : ''}${isCurrent ? ' is-current' : ''}`}
                      data-worktree-path={worktree.path} data-local-session-id={singleTab?.id}>
                      <div className="local-worktree-row">
                        <button
                          type="button"
                          className="local-worktree-open"
                          aria-current={isCurrent || undefined}
                          onClick={() => onOpenWorktree(project, worktree)}
                          title={`${worktree.path}\n${singleTab ? `${singleTab.name} 탭으로 이동` : hasChildren ? '열린 터미널로 이동' : '이 폴더에서 로컬 터미널 열기'}`}
                        >
                          <span className={`local-worktree-dot${tabs.some(tab => tab.connected) ? ' is-on' : ''}`} aria-hidden="true" />
                          <span className="local-worktree-label">
                            <span className="local-worktree-name">{name}</span>
                            {worktree.isMain && project.worktrees.length > 1 && <span className="local-worktree-tag">기본</span>}
                          </span>
                          {worktree.branch && (
                            <span className="local-worktree-branch" title={worktree.branch}>
                              <RiGitBranchLine size={11} aria-hidden="true" />
                              <span className="local-worktree-branch-name">{worktree.branch}</span>
                            </span>
                          )}
                        </button>
                        {singleTab && renderTabActions(singleTab.id, singleTab.name)}
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
                      {singleTab && <LocalSessionAgents tabId={singleTab.id} />}
                      {hasChildren && isTreeOpen && (
                        <div className="local-worktree-content">
                          <ul className="local-terms-list is-nested">
                            {tabs.map((tab, index) => {
                              const repeated = shownNames.includes(tab.name) || shownNames.includes(tab.name.replace(/ \(\d+\)$/, ''))
                              return renderTab(tab.id, repeated ? `터미널 ${index + 1}` : tab.name)
                            })}
                          </ul>
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
