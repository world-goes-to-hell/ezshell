import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LocalProjectInfo } from '../types'
import { LOCAL_PROJECTS_EVENT, readLocalProjects } from '../lib/localProjectList'

export interface LocalProjectState {
  folder: string
  /** Git's view of the folder; absent until read */
  info?: LocalProjectInfo
  error?: string
}

/** Coming back to the window reads Git again, at most this often */
const FOCUS_REFRESH_MS = 30_000

/**
 * The registered work folders with their worktrees. Git is asked when the list changes, when
 * `refresh` is called and when the window gets the focus back (not on a timer).
 */
export function useLocalProjects(enabled = true): { projects: LocalProjectState[]; refresh: () => void } {
  const [folders, setFolders] = useState(readLocalProjects)
  const [found, setFound] = useState<ReadonlyMap<string, Omit<LocalProjectState, 'folder'>>>(new Map())
  const lastRead = useRef(0)
  const generation = useRef(0)

  const inspect = useCallback((list: readonly string[]) => {
    const run = ++generation.current
    lastRead.current = Date.now()
    for (const folder of list) {
      void window.electronAPI.localProjectInspect(folder).then(
        result => result.success ? { info: { repo: result.repo, gitMissing: result.gitMissing } } : { error: result.error },
        () => ({ error: '폴더의 Git 정보를 읽지 못했습니다.' })
      ).then(entry => {
        if (generation.current !== run) return
        setFound(previous => new Map(previous).set(folder, entry))
      })
    }
  }, [])

  useEffect(() => {
    const onChange = () => setFolders(readLocalProjects())
    window.addEventListener(LOCAL_PROJECTS_EVENT, onChange)
    return () => window.removeEventListener(LOCAL_PROJECTS_EVENT, onChange)
  }, [])

  useEffect(() => { if (enabled) inspect(folders) }, [enabled, folders, inspect])

  useEffect(() => {
    if (!enabled) return
    const onFocus = () => {
      if (Date.now() - lastRead.current >= FOCUS_REFRESH_MS) inspect(folders)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled, folders, inspect])

  const refresh = useCallback(() => { window.dispatchEvent(new Event(LOCAL_PROJECTS_EVENT)) }, [])
  const projects = useMemo(() => folders.map(folder => ({ folder, ...found.get(folder) })), [folders, found])
  return { projects, refresh }
}
