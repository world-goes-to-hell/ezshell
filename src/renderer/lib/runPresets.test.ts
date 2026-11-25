import { describe, expect, it } from 'vitest'
import {
  firstErrorRow, agentActionNotice, agentNoticeName, withObject, withSubject, runCommandLabel, agentActionNote, crashKey, draftOf, emptyDraft, parseEnvText, presetFromDraft, runButtons, runError, runFolderLabel,
  runHead, runKind, runPills, runPort, sendPreview, type RunPreset, type RunState
} from './runPresets'

const preset = (over: Partial<RunPreset> = {}): RunPreset => ({
  id: 'p1', name: '백엔드', relative: 'backend', kind: 'task', taskId: 'spring-boot:backend', jdk: 'system', env: {},
  notify: true, agentControl: true, inAll: true, waitReady: false, ...over
})
const state = (over: Partial<RunState> = {}): RunState => ({ status: 'idle', errors: 0, ...over })

describe('run preset rows', () => {
  it('reads the port of the address', () => {
    expect(runPort('http://localhost:8080/')).toBe(':8080')
    expect(runPort('https://127.0.0.1/')).toBe(':443')
    expect(runPort('not a url')).toBe('')
    expect(runPort(undefined)).toBe('')
  })

  it('shows starting seconds, the port, a crash and the error count', () => {
    expect(runPills(state({ status: 'starting', startedAt: 1000 }), 13_500)).toEqual([{ kind: 'wait', text: '시작 중 12초' }])
    expect(runPills(state({ status: 'running', address: 'http://localhost:5173/', errors: 3 }), 0)).toEqual([
      { kind: 'port', text: ':5173' }, { kind: 'err', text: '오류 3', errors: true }
    ])
    expect(runPills(state({ status: 'crashed', exitCode: 1, errors: 2 }), 0)).toEqual([{ kind: 'err', text: '멈춤 · 종료 1' }])
    expect(runPills(state({ status: 'crashed', exitCode: null }), 0)).toEqual([{ kind: 'err', text: '멈춤' }])
    expect(runPills(state({ status: 'stopped' }), 0)).toEqual([])
  })

  it('offers the buttons of each state', () => {
    expect(runButtons(state())).toEqual(['start'])
    expect(runButtons(state({ status: 'stopped', shellId: 'local:3' }))).toEqual(['start', 'log'])
    expect(runButtons(state({ status: 'starting' }))).toEqual(['log', 'stop'])
    expect(runButtons(state({ status: 'running', address: 'http://localhost:8080/' }))).toEqual(['open', 'restart', 'stop'])
    expect(runButtons(state({ status: 'running' }))).toEqual(['log', 'restart', 'stop'])
    expect(runButtons(state({ status: 'crashed', exitCode: 1 }))).toEqual(['log', 'restart'])
  })

  it('shows an agent action for 10 seconds, never the user’s', () => {
    const action = { by: 'codex-5', action: 'restart' as const, at: 10_000 }
    expect(agentActionNote(action, 14_200)).toBe('codex-5가 재기동 · 4초 전')
    expect(agentActionNote({ ...action, by: 'claude-3' }, 14_200)).toBe('claude-3이 재기동 · 4초 전')
    expect(agentActionNote(action, 20_000)).toBeNull()
    expect(agentActionNote({ ...action, by: 'user' }, 11_000)).toBeNull()
    expect(agentActionNote(undefined, 0)).toBeNull()
  })

  it('heads the list with what runs and offers 모두 실행 or 모두 중지', () => {
    const presets = [preset(), preset({ id: 'p2', inAll: false })]
    expect(runHead(presets, {})).toEqual({ label: '실행', all: 'start', canStartAll: true })
    expect(runHead(presets, { p1: state({ status: 'running' }) })).toEqual({ label: '실행 · 1개 실행 중', all: 'stop', canStartAll: false })
  })

  it('names the kind and the folder', () => {
    expect(runKind(preset())).toBe('spring')
    expect(runKind(preset({ kind: 'custom', taskId: undefined, command: 'npm run dev' }))).toBe('node')
    expect(runKind(preset({ kind: 'custom', taskId: undefined, command: './catalina.sh run' }))).toBe('java')
    expect(runFolderLabel('backend')).toBe('backend/')
    expect(runFolderLabel('.')).toBe('./')
    expect(runFolderLabel('apps\\web\\')).toBe('apps/web/')
  })
})

describe('the preset form', () => {
  it('reads env lines and rejects bad names and repeats', () => {
    expect(parseEnvText('SPRING_PROFILES_ACTIVE=local\n\nPORT = 8081')).toEqual({ env: { SPRING_PROFILES_ACTIVE: 'local', PORT: '8081' } })
    expect(parseEnvText('lower=1')).toEqual({ error: '환경 변수 이름이 올바르지 않습니다: lower' })
    expect(parseEnvText('A=1\nA=2')).toEqual({ error: '같은 이름이 두 번 있습니다: A' })
    expect('error' in parseEnvText(Array.from({ length: 21 }, (_, i) => `V${i}=1`).join('\n'))).toBe(true)
  })

  it('makes a preset of a draft, or says what is missing', () => {
    expect(presetFromDraft({ ...emptyDraft(), name: '' })).toEqual({ error: '이름을 입력해 주세요.' })
    expect(presetFromDraft({ ...emptyDraft(), name: '백엔드' })).toEqual({ error: '실행할 것을 골라 주세요.' })
    expect(presetFromDraft({ ...emptyDraft(), name: '가'.repeat(21), taskId: 't' })).toEqual({ error: '이름은 20자까지입니다.' })
    expect(presetFromDraft({ ...emptyDraft(), name: 'x', kind: 'custom', command: 'a\nb' })).toEqual({ error: '명령은 한 줄로 입력해 주세요.' })
    const made = presetFromDraft({ ...emptyDraft(), name: ' 프론트 ', relative: './frontend/', taskId: 'npm:dev', envText: 'PORT=5173' })
    expect(made).toEqual({ preset: {
      name: '프론트', relative: 'frontend', kind: 'task', taskId: 'npm:dev', jdk: 'system', env: { PORT: '5173' },
      notify: true, agentControl: true, inAll: true, waitReady: false
    } })
    const custom = presetFromDraft({ ...emptyDraft(), name: 'x', kind: 'custom', command: ' gradlew run ', taskId: 'old' })
    expect('preset' in custom && custom.preset).toMatchObject({ kind: 'custom', command: 'gradlew run' })
    expect('preset' in custom && custom.preset.taskId).toBeUndefined()
  })

  it('round-trips a saved preset through the form', () => {
    const saved = preset({ env: { A: '1', B: 'x=y' } })
    const again = presetFromDraft(draftOf(saved))
    expect(again).toEqual({ preset: saved })
  })
})

describe('the first error line', () => {
  const rows = (...lines: Array<string | [string]>) => lines.map(line => Array.isArray(line) ? { text: line[0], wrapped: true } : { text: line, wrapped: false })

  it('finds the start of the error on a line wrapped over rows', () => {
    const error = 'ERROR 2026-11-25 Port 8080 was already in use by another process on this machine'
    const at = firstErrorRow(rows('starting', 'ERROR 2026-11-25 Port 8080 was alre', ['ady in use by another process on this machine'], 'done'), error)
    expect(at).toBe(1)
  })

  it('looks below the last restart divider only', () => {
    const error = 'Failed to compile'
    expect(firstErrorRow(rows('Failed to compile', '── 개발 서버 재기동 ──', 'ok', 'Failed to compile'), error)).toBe(3)
    expect(firstErrorRow(rows('Failed to compile', '── 개발 서버 재기동 ──', 'ok'), error)).toBeNull()
  })

  it('matches the first 120 characters (a terminal may cut the rest)', () => {
    const long = 'x'.repeat(150)
    expect(firstErrorRow(rows('x'.repeat(120) + ' cut'), long)).toBe(0)
    expect(firstErrorRow(rows('anything'), '   ')).toBeNull()
  })
})

describe('crash notice and agent message', () => {
  it('puts the subject particle that fits the name', () => {
    expect(withSubject('백엔드')).toBe('백엔드가')
    expect(withSubject('API 서버')).toBe('API 서버가')
    expect(withSubject('웹앱')).toBe('웹앱이')
    expect(withSubject('api')).toBe('api이(가)')
    // A final digit as it is read: 영·일·삼·육·칠·팔 end in a consonant, 이·사·오·구 do not
    for (const digit of '013678') expect(withSubject(`claude-${digit}`)).toBe(`claude-${digit}이`)
    for (const digit of '2459') expect(withSubject(`codex-${digit}`)).toBe(`codex-${digit}가`)
    expect(withObject('서버 1')).toBe('서버 1을')
    expect(withObject('서버 2')).toBe('서버 2를')
  })

  it('tells an agent’s first action with the particles that fit and the role first', () => {
    expect(withObject('백엔드')).toBe('백엔드를')
    expect(withObject('웹앱')).toBe('웹앱을')
    expect(agentNoticeName({ id: 'claude-3', role: 'PL' }, 'claude-3')).toBe('PL · claude-3')
    expect(agentNoticeName({ id: 'codex-5', role: null }, 'codex-5')).toBe('codex-5')
    expect(agentNoticeName(undefined, 'codex-9')).toBe('codex-9')
    expect(agentActionNotice('PL · claude-3', '백엔드', 'restart')).toBe('PL · claude-3이 백엔드를 재기동했습니다 · 에이전트 조작 허용 중')
    expect(agentActionNotice('개발', '프론트', 'start')).toBe('개발이 프론트를 실행했습니다 · 에이전트 조작 허용 중')
  })

  it('names what runs: the typed command or the kind of task', () => {
    expect(runCommandLabel(preset())).toBe('Spring Boot')
    expect(runCommandLabel(preset({ kind: 'custom', taskId: undefined, command: 'npm run dev' }))).toBe('npm run dev')
  })

  it('tells one crash once per run', () => {
    expect(crashKey('k', 'p1', state({ startedAt: 5 }))).toBe('k:p1:5')
    expect(crashKey('k', 'p1', state({ startedAt: 6 }))).not.toBe(crashKey('k', 'p1', state({ startedAt: 5 })))
  })

  it('heads the error lines with the server, folder, command and exit code', () => {
    const text = sendPreview(preset(), state({ status: 'crashed', exitCode: 1 }), { at: 0, lines: ['APPLICATION FAILED TO START', 'Port 8080 was already in use.'] }, 'gradlew bootRun')
    expect(text).toBe('[백엔드 · backend/ · gradlew bootRun · 종료 1]\nAPPLICATION FAILED TO START\nPort 8080 was already in use.')
  })

  it('reads either error shape of main', () => {
    expect(runError({ error: '폴더 밖입니다' })).toBe('폴더 밖입니다')
    expect(runError({ success: false })).toBe('요청을 처리하지 못했습니다.')
    expect(runError({ ok: true })).toBeNull()
    expect(runError(undefined)).toBe('응답이 없습니다.')
  })
})
