import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  answerRunCommand, askRunCommand, clearRunPresets, draftKey, dropDraft, keepDraft, loadRunPresets, startRunPresets, stateKey,
  takeDraft, turnOffAgentControl, useRunPresets, worktreeRuns
} from './runPresetStore'
import { emptyDraft } from '../lib/runPresets'

const ROOT = 'C:\work\app'
const TREE = 'C:\work\app-feature'
const preset = { id: 'p1', name: '백엔드', relative: 'backend', kind: 'task' as const, taskId: 't', jdk: 'system', env: {}, notify: true, agentControl: true, inAll: true, waitReady: false }

describe('run preset store', () => {
  afterEach(() => { clearRunPresets(); vi.unstubAllGlobals() })

  it('keys a state by worktree and preset, and a draft by project and preset', () => {
    expect(stateKey('c:/work/app', 'p1')).not.toBe(stateKey('c:/work/app-feature', 'p1'))
    expect(draftKey('c:/work/app', null)).toBe(draftKey('c:/work/app', null))
    expect(draftKey('c:/work/app', 'p1')).not.toBe(draftKey('c:/work/app', null))
  })

  it('keeps the states of each worktree apart and tells an agent\u2019s first action once', async () => {
    let listener: ((event: unknown) => void) | undefined
    const api = {
      runPresetsList: vi.fn(async (folder: string) => ({ ok: true, projectKey: 'c:/work/app', worktreeKey: folder === ROOT ? 'c:/work/app' : 'c:/work/app-feature', presets: [preset], states: {} })),
      onRunPresetState: (callback: (event: unknown) => void) => { listener = callback; return () => {} }
    }
    vi.stubGlobal('window', Object.assign(new EventTarget(), { electronAPI: api }))
    const stop = startRunPresets()
    await loadRunPresets(ROOT)
    await loadRunPresets(TREE)
    const action = { by: 'codex-5', action: 'restart' as const, at: 5 }
    listener?.({ projectKey: 'c:/work/app', worktreeKey: 'c:/work/app-feature', id: 'p1', state: { status: 'running', errors: 0, lastAction: action }, firstAgentAction: true })
    const { worktrees, agentNotices } = useRunPresets.getState()
    expect(worktrees['c:/work/app-feature'].states.p1?.status).toBe('running')
    expect(worktrees['c:/work/app'].states.p1).toBeUndefined()
    expect(agentNotices).toHaveLength(1)
    expect(agentNotices[0]).toMatchObject({ worktreeKey: 'c:/work/app-feature', id: 'p1', action })
    listener?.({ projectKey: 'c:/work/app', worktreeKey: 'c:/work/app-feature', id: 'p1', state: { status: 'running', errors: 0, lastAction: { ...action, at: 9 } } })
    expect(useRunPresets.getState().agentNotices).toHaveLength(1)
    stop()
  })

  it('keeps an agent’s first action on a worktree no card has read, and tells it', async () => {
    let listener: ((event: unknown) => void) | undefined
    const api = {
      runPresetsList: vi.fn(async (folder: string) => ({ ok: true, projectKey: 'c:/work/app', worktreeKey: folder === ROOT ? 'c:/work/app' : 'c:/work/app-feature', presets: [preset], states: {} })),
      onRunPresetState: (callback: (event: unknown) => void) => { listener = callback; return () => {} }
    }
    vi.stubGlobal('window', Object.assign(new EventTarget(), { electronAPI: api }))
    const stop = startRunPresets()
    const event = (at: number) => ({ projectKey: 'c:/work/app', worktreeKey: 'c:/work/app-feature', id: 'p1',
      state: { status: 'running', errors: 0, lastAction: { by: 'codex-5', action: 'start', at } }, firstAgentAction: true })
    // No card of the project yet: kept, told when the worktree's list comes
    listener?.(event(1))
    expect(useRunPresets.getState().agentNotices).toHaveLength(0)
    await loadRunPresets(TREE)
    expect(useRunPresets.getState().agentNotices).toHaveLength(1)
    clearRunPresets()
    // Another worktree of the project is read: the shared presets name it at once, and only once
    await loadRunPresets(ROOT)
    listener?.(event(2))
    expect(useRunPresets.getState().agentNotices).toMatchObject([{ worktreeKey: 'c:/work/app-feature', action: { at: 2 } }])
    await loadRunPresets(TREE)
    expect(useRunPresets.getState().agentNotices).toHaveLength(1)
    stop()
  })

  it('does not lose an agent’s first action to a plain state change that comes before the list', async () => {
    let listener: ((event: unknown) => void) | undefined
    vi.stubGlobal('window', Object.assign(new EventTarget(), { electronAPI: {
      runPresetsList: async () => ({ ok: true, projectKey: 'c:/work/app', worktreeKey: 'c:/work/app-feature', presets: [preset], states: {} }),
      onRunPresetState: (callback: (event: unknown) => void) => { listener = callback; return () => {} }
    } }))
    const stop = startRunPresets()
    const lastAction = { by: 'codex-5', action: 'start', at: 7 }
    const base = { projectKey: 'c:/work/app', worktreeKey: 'c:/work/app-feature', id: 'p1' }
    listener?.({ ...base, state: { status: 'starting', errors: 0, lastAction }, firstAgentAction: true })
    listener?.({ ...base, state: { status: 'running', errors: 0, port: 5173, lastAction } })
    await loadRunPresets(TREE)
    expect(useRunPresets.getState().agentNotices).toMatchObject([{ worktreeKey: 'c:/work/app-feature', action: { at: 7 } }])
    await loadRunPresets(TREE)
    expect(useRunPresets.getState().agentNotices).toHaveLength(1)
    stop()
  })

  it('finds a card by its folder when main keys the worktree by another spelling of the path', async () => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { electronAPI: {
      runPresetsList: async () => ({ ok: true, projectKey: 'd:/real/app', worktreeKey: 'd:/real/app', presets: [preset], states: {} })
    } }))
    await loadRunPresets('C:\\link\\app', ['C:\\link\\app'])
    expect(worktreeRuns('C:\\link\\app')?.worktreeKey).toBe('d:/real/app')
    expect(useRunPresets.getState().projectRoots['d:/real/app']).toEqual(['C:\\link\\app'])
  })

  it('asks one command question at a time and answers it', async () => {
    const first = askRunCommand('custom', 'npm  run dev')
    expect(useRunPresets.getState().commandAsk).toMatchObject({ kind: 'custom', command: 'npm  run dev' })
    const second = askRunCommand('install', 'npm ci')
    await expect(first).resolves.toBe(false)
    answerRunCommand(true)
    await expect(second).resolves.toBe(true)
    expect(useRunPresets.getState().commandAsk).toBeNull()
  })

  it('turns agent control off on main\u2019s latest copy of the preset', async () => {
    const save = vi.fn(async () => ({ ok: true, preset }))
    vi.stubGlobal('window', Object.assign(new EventTarget(), { electronAPI: {
      runPresetsList: async () => ({ ok: true, projectKey: 'c:/work/app', worktreeKey: 'c:/work/app', presets: [{ ...preset, name: '바뀐 이름' }], states: {} }),
      runPresetsSave: save
    } }))
    expect(await turnOffAgentControl(ROOT, preset)).toBe(true)
    expect(save).toHaveBeenCalledWith(ROOT, { ...preset, name: '바뀐 이름', agentControl: false })
  })

  it('keeps a draft until it is dropped or the app locks', () => {
    const key = draftKey('c:/work/app', null)
    keepDraft(key, { ...emptyDraft(), name: '백엔드' })
    expect(takeDraft(key)?.name).toBe('백엔드')
    dropDraft(key)
    expect(takeDraft(key)).toBeNull()
    keepDraft(key, emptyDraft())
    clearRunPresets()
    expect(takeDraft(key)).toBeNull()
  })
})
