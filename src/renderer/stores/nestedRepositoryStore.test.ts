import { afterEach, expect, test, vi } from 'vitest'
import type { NestedRepositoryGroup, NestedRepositoryPullResult, NestedRepositoryStatus } from '../types'
import { changedRepository, refreshNestedRepositoryProject, scheduleNestedRepositoryFocus, useNestedRepositories } from './nestedRepositoryStore'

const root = '/project/main'
const other = '/project/secondary'
const project = { folder: root, folders: [root], worktrees: [{ path: root }, { path: other }] }
const repo = { folder: 'service', path: `${root}/service`, branch: 'main', hasUpstream: true, upstreamGone: false, ahead: 0, behind: 0, changed: 0 }

afterEach(() => {
  useNestedRepositories.setState({ groups: {}, summaries: {}, progress: {}, lastPulled: {}, trusted: {}, autoFetchEnabled: true })
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('coalesces focus events and cancels the delayed refresh on blur', () => {
  vi.useFakeTimers()
  const refresh = vi.fn()
  const focus = scheduleNestedRepositoryFocus(refresh)
  focus.schedule()
  vi.advanceTimersByTime(2900)
  focus.schedule()
  vi.advanceTimersByTime(2900)
  expect(refresh).not.toHaveBeenCalled()
  vi.advanceTimersByTime(100)
  expect(refresh).toHaveBeenCalledTimes(1)
  focus.schedule()
  focus.cancel()
  vi.advanceTimersByTime(3000)
  expect(refresh).toHaveBeenCalledTimes(1)
})

test('skips a duplicate project refresh, matches groups by path, and removes completed progress', async () => {
  type Result = { success: true; groups: NestedRepositoryGroup[]; trusted: boolean; autoFetchEnabled: boolean }
  let finish: (value: Result) => void = () => {}
  const status = vi.fn(() => new Promise<Result>(resolve => { finish = resolve }))
  vi.stubGlobal('window', { electronAPI: { localNestedRepositoriesStatus: status } })
  const running: NestedRepositoryPullResult = { folder: 'running', kind: 'running' }
  useNestedRepositories.setState({ progress: { [other]: {
    done: { folder: 'done', kind: 'skipped', reason: 'current', message: '받을 커밋이 없습니다.' },
    running
  } } })
  const first = refreshNestedRepositoryProject(project, [], false)
  expect(refreshNestedRepositoryProject(project, [], false)).toBe(first)
  expect(status).toHaveBeenCalledTimes(1)
  finish({ success: true, trusted: false, autoFetchEnabled: true, groups: [
    { root: other, repositories: [{ ...repo, path: `${other}/service` }] },
    { root: '/unexpected', repositories: [repo] }
  ] })
  await first
  const state = useNestedRepositories.getState()
  expect(state.groups[root]).toBeUndefined()
  expect(state.groups[other]?.repositories[0].path).toBe(`${other}/service`)
  expect(state.groups['/unexpected']).toBeUndefined()
  expect(state.summaries[root]?.count).toBe(1)
  expect(state.progress[other]).toEqual({ running })
})

test('keeps failed or deleted-upstream repositories visible in the differences filter', () => {
  const error: NestedRepositoryStatus = { folder: 'service', path: `${root}/service`, error: 'Git 상태를 읽지 못했습니다.' }
  expect(changedRepository(error, 'main')).toBe(true)
  expect(changedRepository({ ...repo, hasUpstream: false, upstreamGone: true }, 'main')).toBe(true)
  expect(changedRepository(repo, 'main')).toBe(false)
})
