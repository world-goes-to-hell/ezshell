// Run presets of a local project (docs/plan/2026-11-25-local-project-run.md, stage 1, screen side):
// the types of the IPC contract and the words and buttons a preset row shows. Kept free of React so the
// rules are tested on their own.

import type { EclipseImportDraft, HotReload, HotswapAgentStatus, JdkRuntime, RunAction, RunErrorGroup, RunPrepare, RunPreset, RunState } from '../types'
export type { HotReload, RunAction, RunCandidate, RunErrorGroup, RunPrepare, RunPreset, RunReload, RunState, RunStatus } from '../types'

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
  if (state.status === 'starting' || state.status === 'preparing') {
    const seconds = state.startedAt ? Math.max(0, Math.floor((now - state.startedAt) / 1000)) : 0
    pills.push({ kind: 'wait', text: `${state.status === 'preparing' ? '준비 중' : '시작 중'} ${seconds}초` })
  } else if (state.status === 'running') {
    const port = runPort(state.address)
    if (port) pills.push({ kind: 'port', text: port })
  } else if (state.status === 'crashed') {
    // The build before the server failed: the server never started
    const word = state.failedAt === 'prepare' ? '빌드 실패' : '멈춤'
    pills.push({ kind: 'err', text: state.exitCode === null || state.exitCode === undefined ? word : `${word} · 종료 ${state.exitCode}` })
  }
  if (state.errors > 0 && isRunActive(state)) {
    pills.push({ kind: 'err', text: `오류 ${state.errors}`, errors: true })
  }
  return pills
}

/** The buttons of a row, in order (scenes 3·4·5) */
export function runButtons(state: RunState): RunButton[] {
  switch (state.status) {
    case 'preparing':
    case 'starting': return ['log', 'stop']
    case 'running': return state.address ? ['open', 'restart', 'stop'] : ['log', 'restart', 'stop']
    case 'crashed': return ['log', 'restart']
    default: return state.shellId ? ['start', 'log'] : ['start']
  }
}

export const isRunActive = (state: RunState) => state.status === 'preparing' || state.status === 'starting' || state.status === 'running'

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
export function runKind(preset: Pick<RunPreset, 'kind' | 'taskId' | 'command' | 'name'>): 'spring' | 'vue' | 'vite' | 'node' | 'java' | 'tomcat' | 'custom' {
  if (preset.kind === 'tomcat') return 'tomcat'
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

/**
 * A token of a build tool (an Ant target, a Maven goal), as main accepts it. Keep it and CONTEXT_PATH the
 * same as TOOL_TOKEN and the context rule of src/ipc/tomcatRun.js: a stricter screen refuses what main takes.
 */
const TOOL_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
const CONTEXT_PATH = /^\/[\p{L}\p{N}_-][\p{L}\p{N}._-]{0,63}$/u

type TomcatFields = Pick<RunPreset, 'tomcat' | 'webapp' | 'contextPath' | 'port' | 'vmArgs' | 'prepare'>

/** The Tomcat fields to save, or the first problem (the same rules main checks; the VM arguments' quoting is main's) */
export function tomcatFromDraft(draft: Pick<PresetDraft, 'tomcat' | 'webapp' | 'contextPath' | 'portText' | 'vmArgs' | 'prepareTool' | 'antTarget' | 'mavenGoals'>): TomcatFields | { error: string } {
  if (!draft.tomcat) return { error: 'Tomcat 을 골라 주세요.' }
  const webapp = draft.webapp.trim().replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '')
  if (!webapp) return { error: '웹 폴더(WEB-INF 가 든 폴더)를 골라 주세요.' }
  const contextPath = draft.contextPath.trim() || '/'
  if (contextPath !== '/' && (!CONTEXT_PATH.test(contextPath) || contextPath === '/ROOT')) return { error: '컨텍스트 경로를 / 또는 /이름 형식으로 입력해 주세요.' }
  const port = Number(draft.portText.trim())
  if (!/^\d+$/.test(draft.portText.trim()) || !Number.isInteger(port) || port < 1 || port > 65535) return { error: 'HTTP 포트는 1~65535 사이의 숫자로 입력해 주세요.' }
  const vmArgs = draft.vmArgs.trim()
  if (/[\r\n\u0000-\u0008\u000b-\u001f\u007f]/.test(vmArgs)) return { error: 'VM 인자는 한 줄로 입력해 주세요.' }
  let prepare: RunPrepare | undefined
  if (draft.prepareTool === 'ant') {
    if (!TOOL_TOKEN.test(draft.antTarget)) return { error: 'Ant 타깃을 골라 주세요.' }
    prepare = { tool: 'ant', target: draft.antTarget }
  } else if (draft.prepareTool === 'eclipse') {
    prepare = { tool: 'eclipse' }
  } else if (draft.prepareTool === 'maven') {
    const goals = draft.mavenGoals.trim().split(/\s+/).filter(Boolean)
    if (!goals.length || goals.length > 12 || !goals.every(goal => TOOL_TOKEN.test(goal))) return { error: 'Maven 목표를 확인해 주세요 (예: clean package).' }
    prepare = { tool: 'maven', goals: goals.join(' ') }
  }
  return { tomcat: draft.tomcat, webapp, contextPath, port, vmArgs, ...(prepare ? { prepare } : {}) }
}

export const MAX_NAME = 20
export const MAX_ENV = 20
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

export interface PresetDraft {
  id?: string
  name: string
  relative: string
  kind: RunPreset['kind']
  taskId?: string
  command: string
  jdk: string
  /** One `NAME=value` per line */
  envText: string
  notify: boolean
  agentControl: boolean
  inAll: boolean
  waitReady: boolean
  hotReload: HotReload
  // kind 'tomcat'
  tomcat: string
  webapp: string
  contextPath: string
  /** As typed (checked on save) */
  portText: string
  vmArgs: string
  prepareTool: 'none' | RunPrepare['tool']
  antTarget: string
  mavenGoals: string
}

const TOMCAT_DEFAULTS = { tomcat: '', webapp: '', contextPath: '/', portText: '8080', vmArgs: '', prepareTool: 'none' as const, antTarget: '', mavenGoals: '' }

export function emptyDraft(): PresetDraft {
  return { name: '', relative: '', kind: 'task', command: '', jdk: 'system', envText: '', notify: true, agentControl: true, inAll: true, waitReady: false, hotReload: 'off', ...TOMCAT_DEFAULTS }
}

export function draftOf(preset: RunPreset): PresetDraft {
  return {
    id: preset.id, name: preset.name, relative: preset.relative, kind: preset.kind, taskId: preset.taskId,
    command: preset.command ?? '', jdk: preset.jdk || 'system',
    envText: Object.entries(preset.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    notify: preset.notify, agentControl: preset.agentControl, inAll: preset.inAll, waitReady: preset.waitReady,
    hotReload: preset.hotReload ?? 'off',
    ...TOMCAT_DEFAULTS,
    ...(preset.kind === 'tomcat' ? {
      tomcat: preset.tomcat ?? '', webapp: preset.webapp ?? '', contextPath: preset.contextPath || '/',
      portText: String(preset.port ?? 8080), vmArgs: preset.vmArgs ?? '', prepareTool: preset.prepare?.tool ?? 'none',
      antTarget: preset.prepare?.tool === 'ant' ? preset.prepare.target : '',
      mavenGoals: preset.prepare?.tool === 'maven' ? preset.prepare.goals : ''
    } : {})
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
  const tomcat = draft.kind === 'tomcat' ? tomcatFromDraft(draft) : null
  if (tomcat && 'error' in tomcat) return tomcat
  const env = parseEnvText(draft.envText)
  if ('error' in env) return env
  return {
    preset: {
      ...(draft.id ? { id: draft.id } : {}),
      name,
      relative: draft.relative.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '') || '.',
      kind: draft.kind,
      ...(draft.kind === 'task' ? { taskId: draft.taskId } : draft.kind === 'custom' ? { command } : {}),
      jdk: draft.jdk || 'system',
      env: env.env,
      notify: draft.notify,
      agentControl: draft.agentControl,
      inAll: draft.inAll,
      waitReady: draft.waitReady,
      hotReload: draft.hotReload,
      ...(tomcat ?? {})
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

const KIND_NAMES = { spring: 'Spring Boot', vue: 'Vue', vite: 'Vite', node: 'Node', java: 'Java', tomcat: 'Tomcat', custom: '직접 입력' } as const

/** What runs, in words: the typed command, or the kind of the way main found ("Spring Boot") */
export function runCommandLabel(preset: Pick<RunPreset, 'kind' | 'taskId' | 'command' | 'name' | 'contextPath' | 'port'>): string {
  if (preset.kind === 'tomcat') return `Tomcat ${preset.contextPath || '/'} :${preset.port ?? 8080}`
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

// --- Eclipse project import (stage 2, second batch) ---

/**
 * The dialog fields an Eclipse import fills (the user saves them): the web folder and the context path.
 * main reads the Eclipse project in `relative` and gives the web folder from there; the preset keeps it
 * from the worktree, so a module's folder goes in front.
 */
export function eclipseFill(imported: Pick<EclipseImportDraft, 'webapp' | 'contextPath'>, relative = '.'): Partial<PresetDraft> {
  const patch: Partial<PresetDraft> = {}
  const module = relative.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '')
  const webapp = imported.webapp?.trim().replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '')
  if (webapp) patch.webapp = module ? `${module}/${webapp}` : webapp
  // '.': the web folder is the Eclipse project's folder itself
  else if (/^\.\/?$/.test(imported.webapp?.trim() ?? '')) patch.webapp = module || '.'
  if (imported.contextPath?.trim()) patch.contextPath = imported.contextPath.trim().startsWith('/') ? imported.contextPath.trim() : `/${imported.contextPath.trim()}`
  return patch
}

/** A list in a line: the first few and how many more */
function listLine(items: readonly string[], shown = 3): string {
  if (!items.length) return '없음'
  const head = items.slice(0, shown).join(', ')
  return items.length > shown ? `${head} 외 ${items.length - shown}개` : head
}

/** What was read, line by line (shown under the button; only the web folder and context path are filled) */
export function eclipseSummary(imported: EclipseImportDraft, notes: readonly string[] = []): string[] {
  return [
    `웹 폴더: ${imported.webapp || '못 찾음'} · 컨텍스트 경로: ${imported.contextPath || '/'}`,
    `소스 폴더: ${listLine(imported.sources)}`,
    `lib: ${imported.libs.length ? `${imported.libs.length}개 (${listLine(imported.libs, 2)})` : '없음'}`,
    `컴파일 버전: ${imported.release ? `Java ${imported.release}` : '설정 없음'} · 인코딩: ${imported.encoding || '설정 없음 (MS949 일 수 있음)'}`,
    ...notes.filter(note => typeof note === 'string' && note.trim()).map(note => note.trim())
  ]
}

// --- Hot reload (stage 3: saved Java changes applied to the running server) ---

/**
 * A Spring Boot run, by the same rule main saves with (src/ipc/runPresetStore.js): a found task whose id
 * ends in `:maven` (`spring-boot:run`) or `:gradle` (`bootRun`) (src/ipc/localDevelopmentTasks.js)
 */
export function isSpringBootTask(kind: RunPreset['kind'], taskId: string | undefined): boolean {
  return kind === 'task' && typeof taskId === 'string' && /:(?:maven|gradle)$/.test(taskId)
}

export const HOT_RELOAD_SPRING_ONLY = 'Spring Boot·Tomcat 실행에서만 됩니다.'

export interface HotReloadChoice {
  /** Whether the field can be anything but 끄기 (a Spring Boot task) */
  usable: boolean
  /** Why it is fixed to 끄기 */
  reason?: string
  /** Whether 확장 can be picked */
  enhanced: boolean
  /** What 확장 is missing */
  enhancedMissing?: string
  /** Something has to be fetched first (the link to Settings > 개발 도구); otherwise only the JDK to pick */
  needsDownload?: boolean
}

/**
 * What the 바로 반영 field allows for a preset (main checks again): Spring Boot tasks only; 확장 needs the
 * chosen JDK to be a JBR 17 or 21 fetched into the store (vendor `jbr`) and HotswapAgent fetched.
 * `system` cannot be told apart.
 */
export function hotReloadChoice({ kind, taskId, jdk, jdks, hotswapAgent }: {
  kind: RunPreset['kind']; taskId?: string; jdk: string
  jdks: ReadonlyArray<Pick<JdkRuntime, 'id' | 'feature' | 'vendor' | 'managed'>>; hotswapAgent: HotswapAgentStatus | undefined
}): HotReloadChoice {
  if (kind !== 'tomcat' && !isSpringBootTask(kind, taskId)) return { usable: false, reason: HOT_RELOAD_SPRING_ONLY, enhanced: false }
  const isJbr = (item: Pick<JdkRuntime, 'feature' | 'vendor' | 'managed'> | undefined) =>
    item?.vendor === 'jbr' && item.managed && (item.feature === 17 || item.feature === 21)
  const chosen = isJbr(jdks.find(item => item.id === jdk))
  const agent = !!hotswapAgent?.installed
  if (chosen && agent) return { usable: true, enhanced: true }
  const inStore = jdks.some(isJbr)
  // What to fetch from Settings > 개발 도구, or only which JDK to pick here
  const enhancedMissing = !inStore && !agent ? '확장에는 JBR 17·21 과 HotswapAgent 가 필요합니다.'
    : !inStore ? '확장에는 JBR 17·21 이 필요합니다.'
    : !agent ? (chosen ? '확장에는 HotswapAgent 가 필요합니다.' : '확장에는 HotswapAgent 가 필요하고, JDK 를 JBR 17·21 로 골라야 합니다.')
    : '확장은 JDK 를 JBR 17·21 로 고르면 쓸 수 있습니다.'
  return { usable: true, enhanced: false, enhancedMissing, needsDownload: !inStore || !agent }
}

/** The value saved: 끄기 where the field is not usable (main runs without the debug agent then) */
export function hotReloadToSave(value: HotReload, choice: HotReloadChoice): HotReload {
  return choice.usable ? value : 'off'
}

export interface ReloadChip {
  tone: 'muted' | 'busy' | 'ok' | 'warn' | 'err'
  text: string
  /** The whole text (the chip cuts long ones) */
  title: string
  /** compileError: pressing the chip goes to the first error line, as the `오류 N` badge does */
  toErrors?: true
  /** restartNeeded: the row's restart button stands out */
  restart?: true
}

/** "방금", "12초 전", "3분 전", "2시간 전" */
export function reloadAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 5) return '방금'
  if (seconds < 60) return `${seconds}초 전`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`
  return `${Math.floor(seconds / 3600)}시간 전`
}

/** The hot reload chip beside a running preset's state, or nothing (not on, or the server is not up) */
export function reloadChip(state: RunState, now: number): ReloadChip | null {
  const reload = state.reload
  if (!reload || !isRunActive(state)) return null
  const reason = reload.reason?.trim()
  switch (reload.status) {
    case 'watching':
      return { tone: 'muted', text: '바로 반영', title: '바로 반영 켜짐 · Java 파일을 저장하면 실행 중인 서버에 반영합니다' }
    case 'compiling':
      return { tone: 'busy', text: '컴파일 중', title: '바뀐 Java 파일을 컴파일하고 있습니다' }
    case 'applied': {
      const text = reload.devtools
        ? '반영됨 · DevTools 재시작'
        : ['반영됨', typeof reload.classes === 'number' && `클래스 ${reload.classes}`, reloadAge(reload.at, now)].filter(Boolean).join(' · ')
      return { tone: 'ok', text, title: reload.devtools ? `${text} · ${reloadAge(reload.at, now)}` : text }
    }
    case 'restartNeeded': {
      const text = reason ? `재기동 필요: ${reason}` : '재기동 필요'
      return { tone: 'warn', text, title: `${text} · 바로 반영할 수 없는 변경입니다. ↻ 로 재기동하세요`, restart: true }
    }
    case 'compileError':
      return { tone: 'err', text: '컴파일 오류', title: reason ? `컴파일 오류: ${reason} · 눌러서 첫 오류 줄로` : '컴파일 오류 · 눌러서 첫 오류 줄로', toErrors: true }
    case 'failed': {
      const text = reason ? `바로 반영 실패: ${reason}` : '바로 반영 실패'
      return { tone: 'err', text, title: text }
    }
    default:
      return null
  }
}

/** Whether a row's clock has to tick for its hot reload chip ("N초 전") */
export const reloadTicks = (state: RunState | undefined, now: number) =>
  state?.reload?.status === 'applied' && isRunActive(state) && now - state.reload.at < 3_600_000
