// Run presets of a local project (docs/plan/2026-11-25-local-project-run.md, stage 1, screen side):
// the types of the IPC contract and the words and buttons a preset row shows. Kept free of React so the
// rules are tested on their own.

import type { RunAction, RunErrorGroup, RunPreset, RunState } from '../types'
export type { RunAction, RunCandidate, RunErrorGroup, RunPreset, RunState, RunStatus } from '../types'

export const IDLE_STATE: RunState = { status: 'idle', errors: 0 }

/** How long an agent's action stays on the row (scene 8) */
export const AGENT_ACTION_MS = 10_000

export type RunButton = 'start' | 'restart' | 'stop' | 'open' | 'log'

export interface RunPill {
  kind: 'wait' | 'port' | 'err'
  text: string
  /** The `오류 N` badge: pressing it goes to the first error line */
  errors?: true
}

/** ":8080" from "http://localhost:8080/" (nothing when the address is not a URL) */
export function runPort(address?: string): string {
  if (!address) return ''
  try {
    const url = new URL(address)
    return `:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return ''
  }
}

/** The pills of a row: starting N초 / :port / 멈춤·종료 N / 오류 N */
export function runPills(state: RunState, now: number): RunPill[] {
  const pills: RunPill[] = []
  if (state.status === 'starting') {
    const seconds = state.startedAt ? Math.max(0, Math.floor((now - state.startedAt) / 1000)) : 0
    pills.push({ kind: 'wait', text: `시작 중 ${seconds}초` })
  } else if (state.status === 'running') {
    const port = runPort(state.address)
    if (port) pills.push({ kind: 'port', text: port })
  } else if (state.status === 'crashed') {
    pills.push({ kind: 'err', text: state.exitCode === null || state.exitCode === undefined ? '멈춤' : `멈춤 · 종료 ${state.exitCode}` })
  }
  if (state.errors > 0 && (state.status === 'running' || state.status === 'starting')) {
    pills.push({ kind: 'err', text: `오류 ${state.errors}`, errors: true })
  }
  return pills
}

/** The buttons of a row, in order (scenes 3·4·5) */
export function runButtons(state: RunState): RunButton[] {
  switch (state.status) {
    case 'starting': return ['log', 'stop']
    case 'running': return state.address ? ['open', 'restart', 'stop'] : ['log', 'restart', 'stop']
    case 'crashed': return ['log', 'restart']
    default: return state.shellId ? ['start', 'log'] : ['start']
  }
}

export const isRunActive = (state: RunState) => state.status === 'starting' || state.status === 'running'

const ACTION_WORDS: Record<RunAction['action'], string> = { start: '실행', restart: '재기동', stop: '중지' }

/** "codex-5 가 재기동 · 4초 전" for 10 seconds after an agent acted; nothing for the user's own presses */
export function agentActionNote(action: RunAction | undefined, now: number): string | null {
  if (!action || action.by === 'user') return null
  const age = now - action.at
  if (age < 0 || age >= AGENT_ACTION_MS) return null
  return `${withSubject(action.by)} ${ACTION_WORDS[action.action]} · ${Math.floor(age / 1000)}초 전`
}

/** The head of the run list: "실행 · 2개 실행 중", and whether it offers 모두 실행 or 모두 중지 */
export function runHead(presets: readonly RunPreset[], states: Readonly<Record<string, RunState>>) {
  const active = presets.filter(preset => isRunActive(states[preset.id] ?? IDLE_STATE)).length
  return {
    label: active ? `실행 · ${active}개 실행 중` : '실행',
    all: active ? 'stop' as const : 'start' as const,
    // 모두 실행 starts only the presets in it
    canStartAll: presets.some(preset => preset.inAll && !isRunActive(states[preset.id] ?? IDLE_STATE))
  }
}

/** The kind icon of a row, from the candidate's name or the custom command */
export function runKind(preset: Pick<RunPreset, 'kind' | 'taskId' | 'command' | 'name'>): 'spring' | 'vue' | 'vite' | 'node' | 'java' | 'custom' {
  const text = `${preset.taskId ?? ''} ${preset.command ?? ''}`.toLowerCase()
  if (/spring|bootrun|spring-boot/.test(text)) return 'spring'
  if (/\bvue\b|vue-cli|serve\b/.test(text)) return 'vue'
  if (/vite/.test(text)) return 'vite'
  if (/npm|pnpm|yarn|node|package\.json|\bdev\b/.test(text)) return 'node'
  if (/gradle|mvn|maven|java|tomcat|catalina|ant\b/.test(text)) return 'java'
  return 'custom'
}

/** The folder shown on a row: "backend/", "." for the project root */
export function runFolderLabel(relative: string): string {
  const clean = relative.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '')
  return clean ? `${clean}/` : './'
}

/** The divider localShell writes at a restart (src/localShell.js): the search starts below the last one */
export const RESTART_DIVIDER = '개발 서버 재기동'

/**
 * The first row of the logical line (rows wrapped at the width joined) that holds the start of an error
 * line (120 characters, as a terminal may cut what follows), below the last restart divider; null if none
 */
export function firstErrorRow(rows: ReadonlyArray<{ text: string; wrapped: boolean }>, errorLine: string): number | null {
  const wanted = errorLine.replace(/\s+$/, '').trimStart().slice(0, 120)
  if (!wanted) return null
  const lines: Array<{ row: number; text: string }> = []
  rows.forEach(({ text, wrapped }, row) => {
    if (wrapped && lines.length) lines[lines.length - 1].text += text
    else lines.push({ row, text })
  })
  let from = 0
  lines.forEach((line, index) => { if (line.text.includes(RESTART_DIVIDER)) from = index + 1 })
  for (let index = from; index < lines.length; index++) {
    if (lines[index].text.includes(wanted)) return lines[index].row
  }
  return null
}

// --- The add / edit form ---

export const MAX_NAME = 20
export const MAX_ENV = 20
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

export interface PresetDraft {
  id?: string
  name: string
  relative: string
  kind: 'task' | 'custom'
  taskId?: string
  command: string
  jdk: string
  /** One `NAME=value` per line */
  envText: string
  notify: boolean
  agentControl: boolean
  inAll: boolean
  waitReady: boolean
}

export function emptyDraft(): PresetDraft {
  return { name: '', relative: '', kind: 'task', command: '', jdk: 'system', envText: '', notify: true, agentControl: true, inAll: true, waitReady: false }
}

export function draftOf(preset: RunPreset): PresetDraft {
  return {
    id: preset.id, name: preset.name, relative: preset.relative, kind: preset.kind, taskId: preset.taskId,
    command: preset.command ?? '', jdk: preset.jdk || 'system',
    envText: Object.entries(preset.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    notify: preset.notify, agentControl: preset.agentControl, inAll: preset.inAll, waitReady: preset.waitReady
  }
}

/** The env lines as a record, or the first problem (main checks them again) */
export function parseEnvText(text: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {}
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length > MAX_ENV) return { error: `환경 변수는 ${MAX_ENV}개까지입니다.` }
  for (const line of lines) {
    const at = line.indexOf('=')
    const name = at > 0 ? line.slice(0, at).trim() : ''
    if (!ENV_NAME.test(name)) return { error: `환경 변수 이름이 올바르지 않습니다: ${name || line}` }
    if (Object.prototype.hasOwnProperty.call(env, name)) return { error: `같은 이름이 두 번 있습니다: ${name}` }
    env[name] = line.slice(at + 1).trim()
  }
  return { env }
}

/** The preset to save, or why it cannot be saved yet (the same rules main checks) */
export function presetFromDraft(draft: PresetDraft): { preset: Omit<RunPreset, 'id'> & { id?: string } } | { error: string } {
  const name = draft.name.trim()
  if (!name) return { error: '이름을 입력해 주세요.' }
  if ([...name].length > MAX_NAME) return { error: `이름은 ${MAX_NAME}자까지입니다.` }
  if (/[\u0000-\u001f\u007f]/.test(name)) return { error: '이름에 쓸 수 없는 글자가 있습니다.' }
  if (draft.kind === 'task' && !draft.taskId) return { error: '실행할 것을 골라 주세요.' }
  const command = draft.command.trim()
  if (draft.kind === 'custom') {
    if (!command) return { error: '명령을 입력해 주세요.' }
    if (/[\r\n\u0000-\u0008\u000b-\u001f\u007f]/.test(draft.command.replace(/\r?\n$/, ''))) return { error: '명령은 한 줄로 입력해 주세요.' }
  }
  const env = parseEnvText(draft.envText)
  if ('error' in env) return env
  return {
    preset: {
      ...(draft.id ? { id: draft.id } : {}),
      name,
      relative: draft.relative.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '') || '.',
      kind: draft.kind,
      ...(draft.kind === 'task' ? { taskId: draft.taskId } : { command }),
      jdk: draft.jdk || 'system',
      env: env.env,
      notify: draft.notify,
      agentControl: draft.agentControl,
      inAll: draft.inAll,
      waitReady: draft.waitReady
    }
  }
}

/** "백엔드가" / "웹앱이": the subject particle that follows a name (by its last letter's final consonant) */
export function withSubject(name: string): string {
  const final = hasFinalConsonant(name)
  return name + (final === null ? '이(가)' : final ? '이' : '가')
}

/**
 * Whether a name ends in a final consonant when read: a Hangul syllable by its own, a digit as it is read
 * (영·일·삼·육·칠·팔 have one, 이·사·오·구 do not). Latin letters: unknown (both particles are shown).
 */
function hasFinalConsonant(name: string): boolean | null {
  const last = name.trim().slice(-1)
  const code = last.charCodeAt(0) - 0xac00
  if (code >= 0 && code <= 11171) return code % 28 !== 0
  if (/[0-9]/.test(last)) return '013678'.includes(last)
  return null
}

/** "백엔드를" / "웹앱을": the object particle that follows a name */
export function withObject(name: string): string {
  const final = hasFinalConsonant(name)
  return name + (final === null ? '을(를)' : final ? '을' : '를')
}

const DONE_WORDS: Record<RunAction['action'], string> = { start: '실행했습니다', restart: '재기동했습니다', stop: '중지했습니다' }

/** "PL · claude-3이(가) 백엔드를 재기동했습니다 · 에이전트 조작 허용 중": an agent's first action on a preset */
export function agentActionNotice(agentName: string, presetName: string, action: RunAction['action']): string {
  return `${withSubject(agentName)} ${withObject(presetName)} ${DONE_WORDS[action]} · 에이전트 조작 허용 중`
}

/** An agent as notices name it: its role first when it has one (AgentIdentity's rule) */
export const agentNoticeName = (agent: { id: string; role?: string | null } | undefined, id: string) =>
  agent?.role && agent.role !== id ? `${agent.role} · ${id}` : id

const KIND_NAMES = { spring: 'Spring Boot', vue: 'Vue', vite: 'Vite', node: 'Node', java: 'Java', custom: '직접 입력' } as const

/** What runs, in words: the typed command, or the kind of the way main found ("Spring Boot") */
export function runCommandLabel(preset: Pick<RunPreset, 'kind' | 'taskId' | 'command' | 'name'>): string {
  return preset.kind === 'custom' ? preset.command || '직접 입력' : KIND_NAMES[runKind(preset)]
}

/** The message sent to an agent with a crash (scene 7): the server, its folder and command, the error lines */
export function sendPreview(preset: RunPreset, state: RunState, group: RunErrorGroup | undefined, commandLabel: string): string {
  const exit = state.exitCode === null || state.exitCode === undefined ? '' : ` · 종료 ${state.exitCode}`
  const head = `[${preset.name} · ${runFolderLabel(preset.relative)} · ${commandLabel}${exit}]`
  return [head, ...(group?.lines.slice(0, 80) ?? [])].join('\n')
}

/** A crash is told once: by the preset and the time it started (a new run that crashes again is told again) */
export const crashKey = (projectKey: string, id: string, state: RunState) => `${projectKey}:${id}:${state.startedAt ?? 0}`

/** Main's answers come as `{ error }` or `{ success: false, error }`: the error text of either */
export function runError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return '응답이 없습니다.'
  const value = result as { error?: unknown; success?: unknown }
  if (typeof value.error === 'string' && value.error) return value.error
  if (value.success === false) return '요청을 처리하지 못했습니다.'
  return null
}
