import type { LocalDevelopmentTask } from '../types'

/** Up to this many start commands are listed directly; more are grouped by kind (2026-11-26, an MSA repo cut the menu off) */
export const FLAT_TASK_LIMIT = 8

const KIND_ORDER = ['Spring Boot', 'Vue', 'Node']

export interface DevelopmentTaskGroup {
  kind: string
  tasks: LocalDevelopmentTask[]
}

export interface DevelopmentTaskMenu {
  /** Shown directly: every task when there are few, otherwise the ones the worktree's branch or folder names */
  direct: LocalDevelopmentTask[]
  /** One submenu per kind, only when there are many */
  groups: DevelopmentTaskGroup[]
}

const kindRank = (kind: string) => {
  const index = KIND_ORDER.indexOf(kind)
  return index < 0 ? KIND_ORDER.length : index
}

const byName = (a: LocalDevelopmentTask, b: LocalDevelopmentTask) =>
  a.relative.localeCompare(b.relative, 'ko', { numeric: true, sensitivity: 'base' })

/**
 * Orders the start commands of a worktree for its menu. `preferred` is the module the worktree is for
 * (its branch's last part or its folder name): that task comes first, outside any group.
 */
export function developmentTaskMenu(tasks: LocalDevelopmentTask[], preferred: string): DevelopmentTaskMenu {
  const wanted = preferred.toLowerCase()
  const matches = (task: LocalDevelopmentTask) => task.relative.toLowerCase() === wanted
  const ordered = [...tasks].sort((a, b) => Number(matches(b)) - Number(matches(a)) ||
    kindRank(a.name) - kindRank(b.name) || a.name.localeCompare(b.name) || byName(a, b))
  if (tasks.length <= FLAT_TASK_LIMIT) return { direct: ordered, groups: [] }
  const direct = ordered.filter(matches)
  const groups = new Map<string, LocalDevelopmentTask[]>()
  for (const task of ordered) {
    if (matches(task)) continue
    const list = groups.get(task.name) ?? []
    list.push(task)
    groups.set(task.name, list)
  }
  return {
    direct,
    groups: [...groups].map(([kind, list]) => ({ kind, tasks: list.sort(byName) }))
  }
}

/** The menu label of a task listed directly ("Spring Boot 기동 · backend"); inside a kind's submenu only the folder is shown */
export function developmentTaskLabel(task: LocalDevelopmentTask, grouped = false): string {
  const where = task.relative === '.' ? '' : task.relative
  if (grouped) return where || '저장소 루트'
  return `${task.name} 기동${where ? ` · ${where}` : ''}`
}
