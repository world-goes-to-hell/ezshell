import type { AgentMessageSession } from '../types'
import { agentIdentityStatus } from './agentIdentity'
import { folderLabel, pathKey } from './localWorkspaceTree'
import { FOLDER_GROUP_PREFIX, projectOfFolder, type GroupProject } from './tabGroups'

type ProjectLabel = { key: string; name: string; folder?: string }

export interface HandoffProject extends ProjectLabel {
  sameProject: boolean
  agents: AgentMessageSession[]
  workingCount: number
}

function projectLabel(cwd: string | null, projects: readonly GroupProject[]): ProjectLabel {
  if (!cwd?.trim()) return { key: 'unknown', name: '기타' }
  const project = projectOfFolder(cwd, projects)
  if (project) return { key: project.key, name: project.name, folder: project.key }
  return { key: FOLDER_GROUP_PREFIX + pathKey(cwd), name: folderLabel(cwd), folder: cwd }
}

/** Group eligible recipients with the same project keys as the local work tree. */
export function handoffProjects(
  agents: readonly AgentMessageSession[],
  sourceId: string | null,
  sourceCwd: string | null,
  projects: readonly GroupProject[]
): HandoffProject[] {
  const sourceProject = sourceCwd?.trim() ? projectLabel(sourceCwd, projects).key : null
  const groups = new Map<string, HandoffProject>()
  for (const agent of agents) {
    if (!agent.active || agent.id === sourceId || (!agent.mcpConnected && agent.status !== 'sleeping')) continue
    const project = projectLabel(agent.cwd, projects)
    const group = groups.get(project.key) ?? { ...project, sameProject: project.key === sourceProject, agents: [], workingCount: 0 }
    group.agents.push(agent)
    if (agentIdentityStatus(agent).status === 'working') group.workingCount++
    groups.set(project.key, group)
  }
  const result = [...groups.values()]
  for (const group of result) group.agents.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  return result.sort((a, b) => Number(b.sameProject) - Number(a.sameProject)
    || a.name.localeCompare(b.name, 'ko', { numeric: true }) || a.key.localeCompare(b.key))
}

/** An explicit choice takes precedence. With a single project, show its agents immediately. */
export function selectedHandoffProject(groups: readonly HandoffProject[], key: string | null): HandoffProject | undefined {
  return groups.length === 1 ? groups[0] : groups.find(group => group.key === key)
}
