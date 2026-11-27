import { useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { RiAddLine, RiArrowDownSLine, RiArrowRightSLine, RiCloseLine, RiFolder3Line, RiFolderOpenLine, RiGitBranchLine, RiPlayLine, RiTerminalBoxLine } from 'react-icons/ri'
import { SiNodedotjs, SiSpringboot, SiVuedotjs } from 'react-icons/si'
import type { IconType } from 'react-icons'
import type { LocalProjectState } from '../../hooks/useLocalProjects'
import type { LocalDevelopmentTask } from '../../types'
import { folderLabel, pathKey } from '../../lib/localWorkspaceTree'
import { developmentTaskLabel, developmentTaskMenu } from '../../lib/developmentTaskMenu'
import { presetOfTask, presetSeedOfTask } from '../../lib/runPresets'
import { useDevelopmentRuns } from '../../lib/developmentRun'
import { runPresetAction, worktreeRuns } from '../../stores/runPresetStore'
import { confirmDialog } from '../../stores/confirmStore'
import { toast } from '../../stores/toastStore'
import { TerminalContextMenu, type TerminalMenuGroup, type TerminalMenuItem } from '../Terminal/TerminalContextMenu'
import { LocalSessionAgents } from './LocalSessionAgents'
import { RunPresetAddButton, RunPresetsSection, requestAddRunPreset } from './RunPresetsSection'
import { NestedRepositoryList, NestedRepositorySummary } from './NestedRepositories'
import { useNestedRepositories, useNestedRepositoryProjects } from '../../stores/nestedRepositoryStore'

const TASK_ICONS: Record<string, IconType> = { 'Spring Boot': SiSpringboot, Vue: SiVuedotjs, Node: SiNodedotjs }
const taskIcon = (task: LocalDevelopmentTask) => TASK_ICONS[task.name] ?? RiPlayLine

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
  isFolder?: boolean
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
      isFolder: !!info,
      note: error ?? (info ? undefined : '읽는 중…')
    })
  }
  return nodes
}

interface LocalProjectsTreeProps {
  nodes: ProjectNode[]
  folded: ReadonlySet<string>
  onToggleFold: (key: string) => void
  /** The tabs of a worktree: its local terminals, and the browser / SSH / DB tabs of its work (strip order) */
  tabsOf: (path: string) => WorktreeTab[]
  currentTabId: string | null
  renderTab: (tabId: string, label?: string) => ReactNode
  renderTabActions: (tabId: string, name: string) => ReactNode
  onOpenWorktree: (project: ProjectNode, worktree: WorktreeNode) => void
  /** A new local terminal in the worktree, even when one is open there (the row's click goes to that one) */
  onOpenTerminal?: (project: ProjectNode, worktree: WorktreeNode) => void
  onStartDevelopmentTask?: (folder: string, task: LocalDevelopmentTask) => void
  /** The saved SSH sessions linked to the project ("서버"), drawn above its worktrees */
  renderServers?: (project: ProjectNode) => ReactNode
  /** A sidebar session or a tab dropped on the project (the drag's text/plain) */
  onDropOnProject?: (project: ProjectNode, text: string) => void
  /** Takes the project off the list (its folders, terminals and linked servers stay) */
  onRemoveProject?: (project: ProjectNode) => void
}

export interface WorktreeTab {
  id: string
  name: string
  kind: 'local' | 'browser' | 'ssh' | 'db'
  connected: boolean
  working: boolean
}

export const projectFoldKey = (folder: string) => `p:${pathKey(folder)}`
export const worktreeFoldKey = (path: string) => `w:${pathKey(path)}`

type TaskMenu = {
  position: { x: number; y: number }
  worktree: WorktreeNode
  result?: Awaited<ReturnType<Window['electronAPI']['localProjectDevelopmentTasks']>>
}

/** Registered folders → worktrees → the local terminals open in each (with their agents) */
// Past agent sessions are not listed here: the agent history of the right panel shows them (user's choice)
export function LocalProjectsTree({
  nodes, folded, onToggleFold, tabsOf, currentTabId, renderTab, renderTabActions, onOpenWorktree, onOpenTerminal, onStartDevelopmentTask, renderServers, onDropOnProject, onRemoveProject
}: LocalProjectsTreeProps) {
  useNestedRepositoryProjects(nodes.filter(node => !node.note))
  const nestedSummaries = useNestedRepositories(state => state.summaries)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [taskMenu, setTaskMenu] = useState<TaskMenu | null>(null)
  // The project row's menu: its folder in the file manager
  const [folderMenu, setFolderMenu] = useState<{ position: { x: number; y: number }; folder: string; name: string } | null>(null)
  const canOpenFolder = typeof window.electronAPI.localProjectOpenFolder === 'function'
  const openInExplorer = async (folder: string) => {
    const result = await window.electronAPI.localProjectOpenFolder?.(folder).catch(() => null)
    if (!result?.success) toast.error('파일 탐색기로 열지 못했습니다', result && !result.success ? result.error : undefined)
  }
  const openFolderMenu = (event: MouseEvent<HTMLElement>, folder: string, name: string) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.clientX === 0 && event.clientY === 0 ? event.currentTarget.getBoundingClientRect() : null
    setFolderMenu({ position: { x: rect?.left ?? event.clientX, y: rect?.bottom ?? event.clientY }, folder, name })
  }
  const folderItem = (folder: string): TerminalMenuItem[] => canOpenFolder
    ? [{ label: '파일 탐색기로 열기', icon: RiFolderOpenLine, onSelect: () => void openInExplorer(folder) }] : []
  const projectItems = (folder: string): TerminalMenuItem[] => {
    const project = nodes.find(node => node.folder === folder)
    if (!project?.isFolder || !nestedSummaries[pathKey(folder)]?.count) return folderItem(folder)
    return [
      { label: '터미널 실행', icon: RiTerminalBoxLine, onSelect: () => (onOpenTerminal ?? onOpenWorktree)(project, project.worktrees[0]) },
      { label: '실행 구성 추가…', icon: RiAddLine, onSelect: () => requestAddRunPreset(folder) },
      ...folderItem(folder)
    ]
  }
  const openTasks = async (event: MouseEvent<HTMLElement>, worktree: WorktreeNode) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.clientX === 0 && event.clientY === 0 ? event.currentTarget.getBoundingClientRect() : null
    const opened = { position: { x: rect?.left ?? event.clientX, y: rect?.bottom ?? event.clientY }, worktree }
    setTaskMenu(opened)
    try {
      const result = await window.electronAPI.localProjectDevelopmentTasks(worktree.path)
      setTaskMenu(current => current === opened ? { ...opened, result } : current)
    } catch {
      setTaskMenu(current => current === opened ? { ...opened, result: { success: false, error: '기동 명령을 읽지 못했습니다.' } } : current)
    }
  }
  /** Whether a shell of this worktree runs (or ran) this found command, started from the menu before presets */
  const startedDirectly = async (worktree: WorktreeNode, task: LocalDevelopmentTask) => {
    if (!Object.values(useDevelopmentRuns.getState().runs).some(run => run.taskId === task.id)) return false
    const shells = await window.electronAPI.localShellList?.().catch(() => undefined) ?? []
    const folder = pathKey(task.relative === '.' ? worktree.path : `${worktree.path}/${task.relative}`)
    return shells.some(shell => shell.development?.taskId === task.id && !!shell.cwd && pathKey(shell.cwd) === folder)
  }
  const runTask = async (worktree: WorktreeNode, task: LocalDevelopmentTask) => {
    // A found command is set up before it runs (2026-11-26 user request): the run preset dialog opens with its
    // folder and way chosen, and starts it once added; one already saved for it just starts. A folder left out of
    // the sparse checkout has no files for a preset yet, so it keeps the direct start that brings them in.
    // A server this command already started the old way keeps going through it, which goes back to its tab.
    if (!task.includeSource && typeof window.electronAPI.runPresetsList === 'function' && !await startedDirectly(worktree, task)) {
      const saved = presetOfTask(worktreeRuns(worktree.path)?.presets ?? [], task)
      if (saved) void runPresetAction(worktree.path, 'start', saved.id)
      else requestAddRunPreset(worktree.path, presetSeedOfTask(task))
      return
    }
    if (task.includeSource || task.installCommand) {
      const actions = [task.includeSource ? `이 워크트리의 sparse checkout에 ${task.relative}/ 폴더를 포함합니다.` : '',
        task.installCommand ? `의존성 설치 명령 ${task.installCommand}` : '', `기동 명령 ${task.command}`].filter(Boolean)
      const confirmed = await confirmDialog({ title: `${task.name} 기동`, message: [worktree.path, ...actions].join('\n'), confirmLabel: '기동' })
      if (!confirmed) return
    }
    onStartDevelopmentTask?.(worktree.path, task)
  }
  const taskMenuOf = (menu: TaskMenu) => {
    const { result, worktree } = menu
    const preferred = worktree.branch?.split('/').pop() || folderLabel(worktree.path)
    return developmentTaskMenu(result?.success ? result.tasks : [], preferred)
  }
  // Many start commands (an MSA repository) go into one submenu per kind, so the menu stays on screen
  const taskGroups = (menu: TaskMenu): TerminalMenuGroup[] => taskMenuOf(menu).groups.map(group => ({
    label: `${group.kind} 기동 · ${group.tasks.length}개`,
    icon: TASK_ICONS[group.kind] ?? RiPlayLine,
    items: group.tasks.map(task => ({
      label: developmentTaskLabel(task, true), icon: taskIcon(task), onSelect: () => void runTask(menu.worktree, task)
    }))
  }))
  const taskItems = (menu: TaskMenu): TerminalMenuItem[] => {
    const { result, worktree } = menu
    const tasks = result?.success ? result.tasks : []
    // The card keeps no place for a project without presets: adding one is also offered here
    const add: TerminalMenuItem[] = typeof window.electronAPI.runPresetsList === 'function'
      ? [{ label: '실행 구성 추가…', icon: RiAddLine, onSelect: () => requestAddRunPreset(worktree.path) }] : []
    // The items that are there from the start come first: the start commands arrive a moment later, and
    // above them they pushed the other items down under the pointer (2026-11-26 user report)
    // 터미널 실행 (user request, 2026-11-26): a new shell in this worktree's folder
    const project = nodes.find(node => node.worktrees.some(tree => tree.path === worktree.path))
    const terminal: TerminalMenuItem[] = onOpenTerminal && project
      ? [{ label: '터미널 실행', icon: RiTerminalBoxLine, onSelect: () => onOpenTerminal(project, worktree) }] : []
    const fixed = [...terminal, ...add, ...folderItem(worktree.path)]
    if (!tasks.length) return [...fixed, { icon: RiPlayLine, disabled: true, onSelect: () => {},
      label: !result ? '기동 명령 찾는 중…' : result.success ? '찾은 기동 명령이 없습니다' : result.error }]
    return [...fixed, ...taskMenuOf(menu).direct.map(task => ({
      label: developmentTaskLabel(task), icon: taskIcon(task), onSelect: () => void runTask(worktree, task)
    }))]
  }
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
  return (<>
    <ul className="local-projects">
      {nodes.map(project => {
        const projectKey = projectFoldKey(project.folder)
        const isProjectOpen = !folded.has(projectKey)
        const plainNested = project.isFolder && !!nestedSummaries[pathKey(project.folder)]?.count
        const projectWorking = !isProjectOpen && project.worktrees.some(tree => tabsOf(tree.path).some(tab => tab.working))
        const Chevron = isProjectOpen ? RiArrowDownSLine : RiArrowRightSLine
        return (
          <li key={projectKey} className={`local-project${dropTarget === projectKey ? ' is-drop-target' : ''}`} data-project-folder={project.folder} {...dropProps(project, projectKey)}>
            <div className="local-project-head" onContextMenu={canOpenFolder ? event => openFolderMenu(event, project.folder, project.name) : undefined}>
              <button
                type="button"
                className="local-project-row"
                data-agent-work={projectWorking ? 'working' : undefined}
                aria-expanded={isProjectOpen}
                aria-description={projectWorking ? '작업 중인 에이전트 있음' : undefined}
                onClick={() => onToggleFold(projectKey)}
                title={project.folder}
              >
                <Chevron size={14} className="local-project-chevron" />
                <RiFolder3Line size={14} className="local-project-icon" />
                <span className="local-project-name">{project.name}</span>
                <NestedRepositorySummary project={project.folder} />
                {project.note && <span className="local-project-note">{project.note}</span>}
              </button>
              {plainNested && isProjectOpen && <RunPresetAddButton folder={project.folder} />}
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
                  // A lone local terminal is the worktree's own row even beside the work's SSH, browser or DB
                  // tabs, which are listed under it: opening a server of the work used to move the terminal
                  // down and rename it "터미널 1" (2026-11-22 user report). Two or more terminals all go under it.
                  const localTabs = tabs.filter(tab => tab.kind === 'local')
                  const singleTab = localTabs.length === 1 ? localTabs[0] : undefined
                  const childTabs = singleTab ? tabs.filter(tab => tab.kind !== 'local') : tabs
                  const hasChildren = childTabs.length > 0
                  const worktreeWorking = hasChildren && !isTreeOpen && childTabs.some(tab => tab.working)
                  const isCurrent = singleTab?.id === currentTabId
                  const name = folderLabel(worktree.path)
                  const shownNames = [name, project.name, worktree.branch && `${project.name} · ${worktree.branch}`]
                  const presets = <RunPresetsSection folder={worktree.path} projectName={project.name} roots={project.worktrees.map(tree => tree.path)} />
                  const nested = <NestedRepositoryList root={worktree.path}
                    onAddPreset={relative => requestAddRunPreset(worktree.path, { relative })} />
                  if (plainNested) return (
                    <li key={treeKey} className="local-worktree is-folder" data-worktree-path={worktree.path}>
                      {tabs.length > 0 && <ul className="local-terms-list is-nested">{tabs.map(tab => renderTab(tab.id))}</ul>}
                      {presets}
                      {nested}
                    </li>
                  )
                  return (
                    <li key={treeKey} className={`local-worktree${tabs.length > 0 ? ' has-tabs' : ''}${isCurrent ? ' is-current' : ''}`}
                      data-worktree-path={worktree.path} data-local-session-id={singleTab?.id}
                      data-agent-work={worktreeWorking ? 'working' : undefined}>
                      <div className="local-worktree-row" onContextMenu={onStartDevelopmentTask ? event => void openTasks(event, worktree) : undefined}>
                        <button
                          type="button"
                          className="local-worktree-open"
                          aria-current={isCurrent || undefined}
                          onClick={() => onOpenWorktree(project, worktree)}
                          title={`${worktree.path}\n${singleTab ? `${singleTab.name} 탭으로 이동` : hasChildren ? '열린 터미널로 이동' : '이 폴더에서 로컬 터미널 열기'}`}
                        >
                          <span className={`local-worktree-dot${tabs.some(tab => tab.kind === 'local' && tab.connected) ? ' is-on' : ''}`} aria-hidden="true" />
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
                        <RunPresetAddButton folder={worktree.path} />
                        {singleTab && renderTabActions(singleTab.id, singleTab.name)}
                        {hasChildren && (
                          <button
                            type="button"
                            className="local-worktree-fold"
                            aria-expanded={isTreeOpen}
                            aria-description={worktreeWorking ? '작업 중인 에이전트 있음' : undefined}
                            onClick={() => onToggleFold(treeKey)}
                            title={isTreeOpen ? '탭 목록 접기' : `탭 ${childTabs.length}개 펼치기`}
                          >
                            {isTreeOpen ? <RiArrowDownSLine size={14} /> : <span className="local-worktree-count">{childTabs.length}</span>}
                          </button>
                        )}
                      </div>
                      {singleTab && <LocalSessionAgents tabId={singleTab.id} />}
                      {hasChildren && isTreeOpen && (
                        <div className="local-worktree-content">
                          <ul className="local-terms-list is-nested">
                            {childTabs.filter(tab => tab.kind === 'local').map((tab, index) => {
                              const repeated = shownNames.includes(tab.name) || shownNames.includes(tab.name.replace(/ \(\d+\)$/, ''))
                              return renderTab(tab.id, repeated ? `터미널 ${index + 1}` : tab.name)
                            })}
                            {childTabs.filter(tab => tab.kind !== 'local').map(tab => renderTab(tab.id))}
                          </ul>
                        </div>
                      )}
                      {/* The project's run presets as this worktree runs them (docs/plan/2026-11-25-local-project-run.md):
                          the presets are shared, each worktree has its own servers and states */}
                      {presets}
                      {nested}
                    </li>
                  )
                })}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
      {taskMenu && <TerminalContextMenu key={`${taskMenu.worktree.path}:${taskMenu.position.x}:${taskMenu.position.y}`}
        position={taskMenu.position} top={[]} groups={taskGroups(taskMenu)} onClose={() => setTaskMenu(null)}
        target={{ name: folderLabel(taskMenu.worktree.path), hint: '개발 서버', items: taskItems(taskMenu) }} />}
      {folderMenu && <TerminalContextMenu key={`${folderMenu.folder}:${folderMenu.position.x}:${folderMenu.position.y}`}
        position={folderMenu.position} top={[]} groups={[]} onClose={() => setFolderMenu(null)}
        target={{ name: folderMenu.name, hint: '프로젝트', items: projectItems(folderMenu.folder) }} />}
  </>)
}
