import { create } from 'zustand'
import { pathKey } from '../lib/localWorkspaceTree'
import { crashKey, runError, type PresetDraft } from '../lib/runPresets'
import type { RunAction, RunErrorGroup, RunPreset, RunPresetResult, RunState } from '../types'
import { toast } from './toastStore'

// Run presets of the local projects (docs/plan/2026-11-25-local-project-run.md, stage 1): main keeps the
// presets (one list per project) and runs them per worktree, so this store mirrors one entry per
// worktree folder: the project's presets with that worktree's states. It follows `run-preset-state` and
// keeps the notices to show (a crash, an agent's first action) and the unsaved drafts of the form.

type Result = RunPresetResult

/** The run preset IPC (optional members: a build without it shows no presets) */
export const runPresetApi = () => window.electronAPI

export interface WorktreeRuns {
  /** The worktree folder: the first argument of every run preset call */
  folder: string
  projectKey: string
  worktreeKey: string
  presets: RunPreset[]
  states: Record<string, RunState>
}

export interface CrashNotice {
  key: string
  folder: string
  projectKey: string
  worktreeKey: string
  id: string
}

/** An agent ran, restarted or stopped a preset for the first time: the user is told agents may (and can turn it off) */
export interface AgentActionNotice {
  key: string
  folder: string
  projectKey: string
  worktreeKey: string
  id: string
  action: RunAction
}

/** A question main asked before running (a typed command the first time, an install): RunCommandConfirm shows it */
export interface RunCommandAsk { key: number; kind: 'custom' | 'install'; command: string }

interface RunPresetState {
  /** By worktree key, as main sends it (the worktree's real path) */
  worktrees: Record<string, WorktreeRuns>
  /**
   * pathKey(card folder) → worktree key: main keys a worktree by its real path, which may differ from the
   * folder the card was given (a junction, an 8.3 name, /private/var on macOS)
   */
  aliases: Record<string, string>
  /** By project key: the folders of all its worktrees, as the sidebar tree lists them (the send dialog's agents) */
  projectRoots: Record<string, string[]>
  notices: CrashNotice[]
  agentNotices: AgentActionNotice[]
  commandAsk: RunCommandAsk | null
  /**
   * By pathKey(card folder): its list did not come (main refused it: locked, the folder gone or not a
   * project). The card then shows nothing, not the place held for a list that will not come.
   */
  failed: Record<string, true>
}

export const useRunPresets = create<RunPresetState>(() => ({ worktrees: {}, aliases: {}, projectRoots: {}, notices: [], agentNotices: [], commandAsk: null, failed: {} }))

/** Crashes already told (by the run: preset, worktree and start time) */
const told = new Set<string>()
/** Presets the user started from a card: their tab comes to the front once main gives the shell */
const revealing = new Set<string>()
/**
 * An agent's first action on a worktree whose card has not read its list yet (a folded project): told when
 * it does, so main's one-time notice is not lost. Bounded: the latest per preset.
 */
type StateEvent = { projectKey: string; worktreeKey: string; id: string; state: RunState; firstAgentAction?: true }
const unseen = new Map<string, StateEvent>()
const MAX_UNSEEN = 100
/** The form's unsaved input while the user went to fetch a JDK (memory only, cleared on lock) */
const drafts = new Map<string, PresetDraft>()

export const REVEAL_RUN_SHELL_EVENT = 'ezshell:reveal-run-shell'
export interface RevealRunShell {
  shellId: string
  label: string
  /** The first error line to scroll to (the `오류 N` badge) */
  errorLine?: string
}

export function revealRunShell(detail: RevealRunShell) {
  window.dispatchEvent(new CustomEvent<RevealRunShell>(REVEAL_RUN_SHELL_EVENT, { detail }))
}

/** The worktree entry of a card folder (through its alias when main's key differs) */
export function selectWorktree(state: Pick<RunPresetState, 'worktrees' | 'aliases'>, folder: string): WorktreeRuns | undefined {
  const key = pathKey(folder)
  return state.worktrees[state.aliases[key] ?? key]
}
export const worktreeRuns = (folder: string) => selectWorktree(useRunPresets.getState(), folder)

/**
 * How many presets each card showed last time (pathKey of its folder → count), so a card can hold their
 * place while its list loads: the area appearing later pushed the rows below down (a click landed on
 * another worktree). Only folder keys and counts, nothing secret, in this browser's storage; a missing or
 * broken store means 0.
 */
const PRESET_COUNTS_KEY = 'ezshell.runPresetCounts'
const MAX_COUNTS = 200

function readPresetCounts(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(PRESET_COUNTS_KEY) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export function knownPresetCount(folder: string): number {
  const count = readPresetCounts()[pathKey(folder)]
  return Number.isInteger(count) && count > 0 ? Math.min(count, 50) : 0
}

function rememberPresetCount(folder: string, count: number) {
  try {
    const counts = readPresetCounts()
    const key = pathKey(folder)
    if (counts[key] === count) return
    delete counts[key]
    counts[key] = count
    const keys = Object.keys(counts)
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_COUNTS))) delete counts[old]
    localStorage.setItem(PRESET_COUNTS_KEY, JSON.stringify(counts))
  } catch { /* the place is held as for none */ }
}

/** The state of one preset in one worktree */
export const stateKey = (worktreeKey: string, id: string) => `${worktreeKey}\n${id}`

export async function loadRunPresets(folder: string, roots?: string[]): Promise<void> {
  const list = runPresetApi().runPresetsList
  if (!list) return
  const failed = (yes: boolean) => useRunPresets.setState(state => {
    const key = pathKey(folder)
    if (!!state.failed[key] === yes) return {}
    const next = { ...state.failed }
    if (yes) next[key] = true
    else delete next[key]
    return { failed: next }
  })
  try {
    const result = await list(folder)
    if (runError(result) && !Array.isArray(result?.presets)) { failed(true); return }
    const worktreeKey = result.worktreeKey || pathKey(folder)
    useRunPresets.setState(({ worktrees, aliases, projectRoots }) => ({
      worktrees: { ...worktrees, [worktreeKey]: { folder, projectKey: result.projectKey, worktreeKey, presets: result.presets ?? [], states: result.states ?? {} } },
      aliases: { ...aliases, [pathKey(folder)]: worktreeKey },
      projectRoots: roots ? { ...projectRoots, [result.projectKey]: roots } : projectRoots
    }))
    rememberPresetCount(folder, result.presets?.length ?? 0)
    failed(false)
    // What came for this worktree before its list: the list holds the states, the agent notice is told now
    for (const [key, event] of unseen) {
      if (event.worktreeKey !== worktreeKey) continue
      unseen.delete(key)
      if (event.firstAgentAction) tellAgentAction(event, folder)
    }
  } catch {
    failed(true)
  }
}

/** The presets are the project's: after a change every worktree of the project reads them again */
export async function reloadProjectPresets(folder: string): Promise<void> {
  const changed = worktreeRuns(folder)
  const folders = Object.values(useRunPresets.getState().worktrees)
    .filter(entry => changed ? entry.projectKey === changed.projectKey : entry.folder === folder)
    .map(entry => entry.folder)
  await Promise.all([...new Set([folder, ...folders])].map(item => loadRunPresets(item)))
}

/** The first time an agent acted on a preset (main tells it once): who did what, and `끄기` */
function tellAgentAction({ projectKey, worktreeKey, id, state }: StateEvent, folder: string) {
  const action = state.lastAction
  if (!action || action.by === 'user') return
  const key = `${stateKey(worktreeKey, id)}:${action.at}`
  useRunPresets.setState(({ agentNotices }) => agentNotices.some(notice => notice.key === key) ? {} : {
    agentNotices: [...agentNotices.filter(n => !(n.worktreeKey === worktreeKey && n.id === id)), { key, folder, projectKey, worktreeKey, id, action }]
  })
}

function applyState(projectKey: string, worktreeKey: string, id: string, state: RunState, firstAgentAction: boolean) {
  const entry = useRunPresets.getState().worktrees[worktreeKey]
  if (!entry || entry.projectKey !== projectKey) {
    // A worktree no card has read yet: its states come with its list when one does, so only an agent's first
    // action is kept (a later plain change must not replace it). The presets are the project's, so a card
    // of another worktree of the project can already name the preset in the notice.
    if (!firstAgentAction) return
    const sibling = Object.values(useRunPresets.getState().worktrees).find(item => item.projectKey === projectKey)
    if (sibling) {
      tellAgentAction({ projectKey, worktreeKey, id, state }, sibling.folder)
      return
    }
    const key = stateKey(worktreeKey, id)
    unseen.delete(key)
    unseen.set(key, { projectKey, worktreeKey, id, state, firstAgentAction: true })
    if (unseen.size > MAX_UNSEEN) unseen.delete(unseen.keys().next().value!)
    return
  }
  const before = entry.states[id]
  const preset = entry.presets.find(item => item.id === id)
  const same = (notice: { worktreeKey: string; id: string }) => notice.worktreeKey === worktreeKey && notice.id === id
  useRunPresets.setState(({ worktrees, notices, agentNotices }) => {
    const next = { ...worktrees, [worktreeKey]: { ...entry, states: { ...entry.states, [id]: state } } }
    let nextNotices = notices
    const crashed = state.status === 'crashed' && before?.status !== 'crashed' && preset?.notify !== false
    const noticeKey = crashKey(projectKey, stateKey(worktreeKey, id), state)
    if (crashed && !told.has(noticeKey)) {
      told.add(noticeKey)
      nextNotices = [...notices.filter(n => !same(n)), { key: noticeKey, folder: entry.folder, projectKey, worktreeKey, id }]
    } else if (state.status === 'starting' || state.status === 'running') {
      // A new run takes its old crash notice away
      nextNotices = notices.filter(n => !same(n))
    }
    return { worktrees: next, notices: nextNotices, agentNotices }
  })
  if (firstAgentAction) tellAgentAction({ projectKey, worktreeKey, id, state }, entry.folder)
  const pending = stateKey(worktreeKey, id)
  if (state.shellId && revealing.has(pending)) {
    revealing.delete(pending)
    revealRunShell({ shellId: state.shellId, label: preset?.name ?? '실행' })
  }
}

/** Follows main's state changes; once per window after the first unlock. Returns the cleanup. */
export function startRunPresets(): () => void {
  const off = runPresetApi().onRunPresetState?.(({ projectKey, worktreeKey, id, state, firstAgentAction }) =>
    applyState(projectKey, worktreeKey, id, state, firstAgentAction === true))
  return () => off?.()
}

export function dismissCrash(key: string) {
  useRunPresets.setState(({ notices }) => ({ notices: notices.filter(notice => notice.key !== key) }))
}

export function dismissAgentNotice(key: string) {
  useRunPresets.setState(({ agentNotices }) => ({ agentNotices: agentNotices.filter(notice => notice.key !== key) }))
}

// --- Drafts of the add / edit form (kept while the user fetches a JDK in Settings) ---

export const draftKey = (projectKey: string, presetId: string | null) => `${projectKey}\n${presetId ?? 'new'}`
export const takeDraft = (key: string) => drafts.get(key) ?? null
export const keepDraft = (key: string, draft: PresetDraft) => { drafts.set(key, draft) }
export const dropDraft = (key: string) => { drafts.delete(key) }

/** Clears what the store mirrors and keeps (the app locked) */
export function clearRunPresets() {
  revealing.clear()
  drafts.clear()
  unseen.clear()
  pendingAnswer?.(false)
  pendingAnswer = null
  useRunPresets.setState({ worktrees: {}, aliases: {}, projectRoots: {}, notices: [], agentNotices: [], commandAsk: null, failed: {} })
}

let pendingAnswer: ((yes: boolean) => void) | null = null
let askSerial = 0

/** Shows main's question in RunCommandConfirm and waits for the answer (one at a time) */
export function askRunCommand(kind: RunCommandAsk['kind'], command: string): Promise<boolean> {
  pendingAnswer?.(false)
  return new Promise(resolve => {
    pendingAnswer = resolve
    useRunPresets.setState({ commandAsk: { key: ++askSerial, kind, command } })
  })
}

export function answerRunCommand(yes: boolean) {
  const resolve = pendingAnswer
  pendingAnswer = null
  useRunPresets.setState({ commandAsk: null })
  resolve?.(yes)
}

type Action = 'start' | 'restart' | 'stop' | 'startAll' | 'stopAll'

const FAILED: Record<Action, string> = {
  start: '실행하지 못했습니다', restart: '재기동하지 못했습니다', stop: '중지하지 못했습니다',
  startAll: '모두 실행하지 못했습니다', stopAll: '모두 중지하지 못했습니다'
}

/**
 * Runs an action of a card in its worktree, answering main's questions on the way: a typed command is
 * shown in full before it first runs (`needsConfirm`), a missing install is asked about (`needsInstall`).
 * Each comes alone; the request is sent again with that answer only (main keeps the earlier ones).
 */
export async function runPresetAction(folder: string, action: Action, id?: string): Promise<boolean> {
  const api = runPresetApi()
  let options: { confirmCustom?: true; confirmInstall?: true } = {}
  const call = (): Promise<Result> | undefined => {
    switch (action) {
      case 'start': return api.runPresetStart?.(folder, id!, options)
      case 'restart': return api.runPresetRestart?.(folder, id!, options)
      case 'stop': return api.runPresetStop?.(folder, id!)
      case 'startAll': return api.runPresetStartAll?.(folder, options)
      case 'stopAll': return api.runPresetStopAll?.(folder)
    }
  }
  const entry = worktreeRuns(folder)
  const pending = id && entry ? stateKey(entry.worktreeKey, id) : null
  if (pending && (action === 'start' || action === 'restart')) revealing.add(pending)
  // 모두 실행 asks about each preset in turn (main keeps up to 50, each may ask for its command and its
  // install): the bound only keeps a confused answer from looping
  for (let round = 0; round < 120; round++) {
    let result: Result | undefined
    try {
      result = await call()
    } catch {
      result = { ok: false, error: '' }
    }
    if (!result) {
      toast.error(FAILED[action], '앱을 다시 시작해 주세요.')
      return false
    }
    if (result.needsConfirm) {
      const yes = await askRunCommand('custom', result.needsConfirm.command)
      if (!yes) return false
      options = { confirmCustom: true }
      continue
    }
    if (result.needsInstall) {
      const yes = await askRunCommand('install', result.needsInstall.command)
      if (!yes) return false
      options = { confirmInstall: true }
      continue
    }
    const error = result.ok === true ? null : runError(result)
    if (error !== null) {
      if (pending) revealing.delete(pending)
      toast.error(FAILED[action], error || undefined)
      return false
    }
    return true
  }
  return false
}

export async function fetchRunErrors(folder: string, id: string): Promise<RunErrorGroup[]> {
  try {
    const result = await runPresetApi().runPresetErrors?.(folder, id)
    return Array.isArray(result?.groups) ? result.groups : []
  } catch {
    return []
  }
}

/**
 * `끄기` on an agent notice: saves the preset with agent control off. From main's latest copy, not the
 * one the notice holds: an edit made since must not be undone by it (main checks the save again).
 */
export async function turnOffAgentControl(folder: string, preset: RunPreset): Promise<boolean> {
  try {
    const api = runPresetApi()
    const fresh = await api.runPresetsList?.(folder)
    const latest = fresh?.presets?.find(item => item.id === preset.id)
    if (!latest) {
      toast.error('에이전트 조작을 끄지 못했습니다', '구성을 찾지 못했습니다.')
      return false
    }
    const result = await api.runPresetsSave?.(folder, { ...latest, agentControl: false })
    if (!result || result.ok === false) {
      toast.error('에이전트 조작을 끄지 못했습니다', result?.error)
      return false
    }
    await reloadProjectPresets(folder)
    return true
  } catch {
    toast.error('에이전트 조작을 끄지 못했습니다')
    return false
  }
}
