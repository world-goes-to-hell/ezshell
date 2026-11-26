import type { BrowserReviewProjects } from '../types'

type Project = BrowserReviewProjects['projects'][number]

/**
 * The project the element request shows: the one already chosen while it still has agents, else the project
 * the tab was opened from, else the only project; none when the user has to choose.
 */
export function chooseProject({ projects, preferred }: BrowserReviewProjects, current: string): string {
  const listed = (folder: string | null) => Boolean(folder) && projects.some(project => project.folder === folder)
  if (listed(current)) return current
  if (preferred && listed(preferred)) return preferred
  return projects.length === 1 ? projects[0].folder : ''
}

/** The agent kept when the project changes: the chosen one while it is in the project, else its only agent */
export function chooseRecipient(project: Project | undefined, current: string): string {
  if (!project) return ''
  if (project.agentIds.includes(current)) return current
  return project.agentIds.length === 1 ? project.agentIds[0] : ''
}
