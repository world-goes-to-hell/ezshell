import { useEffect } from 'react'
import { create } from 'zustand'
import { pathKey } from '../lib/localWorkspaceTree'
import { readLocalProjects } from '../lib/localProjectList'
import type { NestedRepositoryBranch, NestedRepositoryGroup, NestedRepositoryPullResult, NestedRepositoryStatus } from '../types'
import { toast } from './toastStore'

interface Project {
  folder: string
  folders: string[]
  worktrees: { path: string }[]
}

interface Group extends NestedRepositoryGroup {
  project: string
  branch: string | null
}

interface Summary {
  count: number
  behind: number
  branch: string | null
  detached: boolean
  readable: boolean
}

interface State {
  groups: Record<string, Group | undefined>
  summaries: Record<string, Summary | undefined>
  progress: Record<string, Record<string, NestedRepositoryPullResult> | undefined>
  lastPulled: Record<string, number | undefined>
  trusted: Record<string, boolean | undefined>
  autoFetchEnabled: boolean
}

export const useNestedRepositories = create<State>(() => ({
  groups: {}, summaries: {}, progress: {}, lastPulled: {}, trusted: {}, autoFetchEnabled: true
}))
let sequence = 0
const revisions = new Map<string, number>()
const refreshing = new Map<string, Promise<void>>()

function summarize(groups: NestedRepositoryGroup[]): Summary {
  const repositories = Array.from(new Map(groups.flatMap(group =>
    group.repositories.map(repo => [pathKey(repo.path), repo] as const))).values())
  const readable = repositories.filter(repo => repo.error === undefined)
  const byBranch = new Map<string, number>()
  for (const { branch } of readable) {
    if (branch) byBranch.set(branch, (byBranch.get(branch) ?? 0) + 1)
  }
  const ranked = [...byBranch].sort((a, b) => b[1] - a[1])
  return {
    count: repositories.length,
    behind: readable.filter(repo => repo.behind > 0).length,
    branch: ranked[0] && ranked[0][1] !== ranked[1]?.[1] ? ranked[0][0] : null,
    detached: ranked.length === 0,
    readable: readable.length > 0
  }
}

async function refreshProject(project: Project, excluded: string[], fetch: boolean | 'manual') {
  const id = pathKey(project.folder)
  const revision = ++sequence
  revisions.set(id, revision)
  const request = { project: project.folder, roots: project.worktrees.map(tree => tree.path), excluded }
  const result = await (fetch === 'manual'
    ? window.electronAPI.localNestedRepositoriesFetch?.(request)
    : window.electronAPI.localNestedRepositoriesStatus?.({ ...request, fetch }))?.catch(() => undefined)
  if (!result?.success) {
    if (fetch === 'manual') toast.error('원격 확인에 실패했습니다', result?.error)
    return false
  }
  if (revisions.get(id) !== revision) return false
  const requested = new Set(project.worktrees.map(tree => pathKey(tree.path)))
  const groups = result.groups.filter(group => requested.has(pathKey(group.root)))
  const summary = summarize(groups)
  useNestedRepositories.setState(state => ({
    trusted: { ...state.trusted, [id]: result.trusted },
    autoFetchEnabled: result.autoFetchEnabled,
    summaries: { ...state.summaries, [id]: summary },
    groups: {
      ...state.groups,
      ...Object.fromEntries(groups.map(group => [pathKey(group.root), { ...group, project: project.folder, branch: summary.branch }]))
    },
    progress: {
      ...state.progress,
      ...Object.fromEntries(groups.map(group => {
        const root = pathKey(group.root)
        return [root, Object.fromEntries(Object.entries(state.progress[root] ?? {}).filter(([, result]) => pullPending(result)))]
      }))
    }
  }))
  return summary.count > 0
}

export function refreshNestedRepositoryProject(project: Project, excluded: string[], fetch: boolean | 'manual',
  readLocalFirst = false, current = () => true) {
  const id = pathKey(project.folder)
  const pending = refreshing.get(id)
  if (pending) return pending
  const read = async () => {
    if (fetch === true && readLocalFirst) {
      const found = await refreshProject(project, excluded, false)
      const state = useNestedRepositories.getState()
      if (!found || !current() || !state.autoFetchEnabled || !state.trusted[id]) return
    }
    await refreshProject(project, excluded, fetch)
  }
  const result = read().finally(() => refreshing.delete(id))
  refreshing.set(id, result)
  return result
}

export async function setNestedRepositoryAutoFetch(enabled?: boolean) {
  const result = await window.electronAPI.localNestedRepositoriesPreferences?.(enabled).catch(() => undefined)
  if (result?.success) useNestedRepositories.setState({ autoFetchEnabled: result.autoFetchEnabled })
  else if (typeof enabled === 'boolean') toast.error('자동 원격 확인 설정을 저장하지 못했습니다', result?.error)
}

export async function setNestedRepositoryTrust(project: string, enabled: boolean) {
  const result = await window.electronAPI.localNestedRepositoriesTrust?.({ project, enabled }).catch(() => undefined)
  if (!result?.success) {
    toast.error('신뢰 설정을 저장하지 못했습니다', result?.error)
    return
  }
  const id = pathKey(project)
  revisions.set(id, ++sequence)
  useNestedRepositories.setState(state => ({
    trusted: { ...state.trusted, [id]: result.trusted }, autoFetchEnabled: result.autoFetchEnabled
  }))
}

export async function checkNestedRepositoryRemote(project: string) {
  const id = pathKey(project)
  await refreshing.get(id)
  const worktrees = Object.values(useNestedRepositories.getState().groups).flatMap(group =>
    group && pathKey(group.project) === id ? [{ path: group.root }] : [])
  if (worktrees.length) await refreshNestedRepositoryProject({ folder: project, folders: [project], worktrees }, readLocalProjects(), 'manual')
}

export function scheduleNestedRepositoryFocus(refresh: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => clearTimeout(timer)
  const schedule = () => {
    cancel()
    timer = setTimeout(refresh, 3000)
  }
  return { schedule, cancel }
}

export function useNestedRepositoryProjects(projects: Project[]) {
  const value = JSON.stringify(projects.map(({ folder, folders, worktrees }) => ({ folder, folders, worktrees: worktrees.map(({ path }) => ({ path })) })))
  useEffect(() => {
    if (!window.electronAPI.localNestedRepositoriesStatus) return
    const list: Project[] = JSON.parse(value)
    const active = new Set(list.map(project => pathKey(project.folder)))
    const roots = new Set(list.flatMap(project => project.worktrees.map(tree => pathKey(tree.path))))
    useNestedRepositories.setState(state => ({
      summaries: Object.fromEntries(Object.entries(state.summaries).filter(([id]) => active.has(id))),
      groups: Object.fromEntries(Object.entries(state.groups).filter(([id]) => roots.has(id))),
      progress: Object.fromEntries(Object.entries(state.progress).filter(([id]) => roots.has(id))),
      trusted: Object.fromEntries(Object.entries(state.trusted).filter(([id]) => active.has(id)))
    }))
    for (const id of revisions.keys()) if (!active.has(id)) revisions.delete(id)
    const excluded = list.flatMap(project => project.folders)
    let disposed = false
    const refresh = (focused: boolean, listChanged = false) => {
      for (const project of list) {
        if (!project.worktrees.length) continue
        const id = pathKey(project.folder)
        const run = () => {
          const state = useNestedRepositories.getState()
          const unknown = state.trusted[id] === undefined
          const fetch = focused && state.autoFetchEnabled && (unknown || !!state.trusted[id])
          if (!disposed) void refreshNestedRepositoryProject(project, excluded, fetch,
            listChanged || unknown, () => !disposed)
        }
        const pending = refreshing.get(id)
        if (!pending) run()
        else if (listChanged) void pending.then(run)
      }
    }
    const focus = scheduleNestedRepositoryFocus(() => refresh(document.hasFocus()))
    refresh(document.hasFocus(), true)
    window.addEventListener('focus', focus.schedule)
    window.addEventListener('blur', focus.cancel)
    return () => {
      disposed = true
      focus.cancel()
      window.removeEventListener('focus', focus.schedule)
      window.removeEventListener('blur', focus.cancel)
    }
  }, [value])
}

export const changedRepository = (repo: NestedRepositoryStatus, branch: string | null) =>
  repo.error !== undefined || repo.branch !== branch || !repo.branch
  || !!(repo.ahead || repo.behind || repo.changed || repo.upstreamGone || repo.fetchError)

export function repositoryForPreset(group: Group | undefined, folder: string) {
  const relative = group && pathKey(`${group.root}/${folder}`)
  return group?.repositories.reduce<NestedRepositoryStatus | undefined>((best, repo) => {
    const prefix = pathKey(`${group.root}/${repo.folder}`)
    if (relative !== prefix && !relative?.startsWith(`${prefix}/`)) return best
    return !best || repo.folder.length > best.folder.length ? repo : best
  }, undefined)
}

export function pullPending(result?: NestedRepositoryPullResult) {
  return result?.kind === 'queued' || result?.kind === 'running'
}

function updatedRepositories(state: State, id: string, updates: NestedRepositoryStatus[]) {
  const active = state.groups[id]
  if (!active) return {}
  const project = pathKey(active.project)
  const byPath = new Map(updates.map(repo => [pathKey(repo.path), repo]))
  const groups = { ...state.groups }
  const updated: Array<[string, Group]> = []
  for (const [key, group] of Object.entries(groups)) {
    if (!group || pathKey(group.project) !== project) continue
    const repositories = group.repositories.map(repo => {
      const next = byPath.get(pathKey(repo.path))
      return next ? { ...next, folder: repo.folder } : repo
    })
    updated.push([key, { ...group, repositories }])
  }
  const summary = summarize(updated.map(([, group]) => group))
  for (const [key, group] of updated) groups[key] = { ...group, branch: summary.branch }
  return { groups, summaries: { ...state.summaries, [project]: summary } }
}

export async function switchNestedRepositoryBranch(root: string, folder: string, branch: NestedRepositoryBranch) {
  const id = pathKey(root)
  const group = useNestedRepositories.getState().groups[id]
  if (!group) throw new Error('등록된 로컬 작업을 찾을 수 없습니다.')
  const project = pathKey(group.project)
  revisions.set(project, ++sequence)
  const result = await window.electronAPI.localNestedRepositorySwitchBranch?.({
    project: group.project, root, folder, branch: { name: branch.name, remote: branch.remote }
  })
  if (!result?.success) throw new Error(result?.error ?? '브랜치를 바꾸지 못했습니다.')
  revisions.set(project, ++sequence)
  useNestedRepositories.setState(state => {
    const progress = state.progress[id] ?? {}
    return {
      ...updatedRepositories(state, id, [result.status]),
      progress: { ...state.progress, [id]: Object.fromEntries(Object.entries(progress).filter(([key, item]) =>
        key !== folder || pullPending(item))) }
    }
  })
}

export async function pullNestedRepositories(root: string, repositories: NestedRepositoryStatus[]) {
  const id = pathKey(root)
  const state = useNestedRepositories.getState()
  const group = state.groups[id]
  const folders = repositories.filter(repo => !pullPending(state.progress[id]?.[repo.folder])).map(repo => repo.folder)
  if (!group || !folders.length) return
  const select = new Set(folders)
  const project = pathKey(group.project)
  revisions.set(project, ++sequence)
  const requestId = String(++sequence)
  const setProgress = (result: NestedRepositoryPullResult) => useNestedRepositories.setState(current => ({
    progress: { ...current.progress, [id]: { ...current.progress[id], [result.folder]: result } }
  }))
  for (const folder of folders) setProgress({ folder, kind: 'queued' })
  const remove = window.electronAPI.onLocalNestedRepositoriesProgress?.(event => {
    if (event.requestId === requestId) setProgress(event.result)
  })
  try {
    const response = await window.electronAPI.localNestedRepositoriesPull?.({
      project: group.project, root, folders, requestId
    })
    if (!response?.success) throw new Error(response?.error ?? '최신 커밋을 받지 못했습니다.')
    for (const item of response.results) setProgress(item)
    revisions.set(project, ++sequence)
    useNestedRepositories.setState(current => {
      const updates = response.results.flatMap(result => 'status' in result && result.status ? [result.status] : [])
      const lastPulled = { ...current.lastPulled }
      for (const item of response.results) {
        if (item.kind === 'received' && item.count > 0) lastPulled[pathKey(item.status.path)] = Date.now()
      }
      return { ...updatedRepositories(current, id, updates), lastPulled }
    })
    const received = response.results.filter(item => item.kind === 'received').length
    const skipped = response.results.filter(item => item.kind === 'skipped').length
    const failed = response.results.filter(item => item.kind === 'failed').length
    const outcomes = response.results.flatMap(item => item.kind === 'failed' || (item.kind === 'skipped' && item.reason !== 'current')
      ? [`${item.folder} · ${item.message}`] : [])
    const details = [
      ...outcomes.slice(0, 5),
      ...(outcomes.length > 5 ? [`외 ${outcomes.length - 5}개 · 저장소 목록에서 확인`] : [])
    ].join('\n')
    const title = `저장소 받기 · 받음 ${received} · 건너뜀 ${skipped} · 실패 ${failed}`
    if (failed) toast.error(title, details)
    else toast.info(title, details || undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : '최신 커밋을 받지 못했습니다.'
    for (const folder of select) setProgress({ folder, kind: 'failed', message })
    toast.error('최신 커밋을 받지 못했습니다', message)
  } finally {
    remove?.()
  }
}
