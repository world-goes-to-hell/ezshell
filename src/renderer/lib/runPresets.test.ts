import { describe, expect, it } from 'vitest'
import {
  firstErrorRow, agentActionNotice, agentNoticeName, withObject, withSubject, runCommandLabel, agentActionNote, crashKey, draftOf, emptyDraft, parseEnvText, presetFromDraft, runButtons, runError, runFolderLabel,
  runHead, runKind, runPills, runPort, sendPreview, type RunPreset, type RunState,
  usesMaven, hasAdvancedValues, hasRunContent, suggestPresetName, usesJdk, shortPath, workspaceServerFill, eclipseFill, eclipseSummary, tomcatFromDraft, isRunActive, hotReloadChoice, hotReloadToSave, isSpringBootTask, reloadAge, reloadChip, reloadTicks, HOT_RELOAD_SPRING_ONLY
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
      notify: true, agentControl: true, inAll: true, waitReady: false, hotReload: 'off'
    } })
    const custom = presetFromDraft({ ...emptyDraft(), name: 'x', kind: 'custom', command: ' gradlew run ', taskId: 'old' })
    expect('preset' in custom && custom.preset).toMatchObject({ kind: 'custom', command: 'gradlew run' })
    expect('preset' in custom && custom.preset.taskId).toBeUndefined()
  })

  it('round-trips a saved preset through the form', () => {
    const saved = preset({ env: { A: '1', B: 'x=y' }, hotReload: 'standard' })
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

describe('hot reload (stage 3)', () => {
  const jbr17 = { id: 'jbr-17', feature: 17, vendor: 'jbr' as const, managed: true }
  const zulu17 = { id: 'zulu-17', feature: 17, vendor: 'zulu' as const, managed: true }
  const jbr11 = { id: 'jbr-11', feature: 11, vendor: 'jbr' as const, managed: true }
  const agent = { installed: true, version: '2.0.1' }
  const noAgent = { installed: false }

  it('knows a Spring Boot run by its found task, as main does', () => {
    expect(isSpringBootTask('task', 'backend:maven')).toBe(true)
    expect(isSpringBootTask('task', '.:gradle')).toBe(true)
    expect(isSpringBootTask('task', 'frontend:npm:dev')).toBe(false)
    expect(isSpringBootTask('custom', 'backend:maven')).toBe(false)
    expect(isSpringBootTask('task', undefined)).toBe(false)
  })

  it('is fixed to 끄기 for a typed command and for Node, with the reason', () => {
    for (const choice of [
      hotReloadChoice({ kind: 'custom', jdk: 'jbr-17', jdks: [jbr17], hotswapAgent: agent }),
      hotReloadChoice({ kind: 'task', taskId: 'frontend:npm:dev', jdk: 'system', jdks: [], hotswapAgent: noAgent })
    ]) {
      expect(choice).toEqual({ usable: false, reason: HOT_RELOAD_SPRING_ONLY, enhanced: false })
      expect(hotReloadToSave('standard', choice)).toBe('off')
    }
  })

  it('allows 확장 only with a JBR 17 or 21 chosen and HotswapAgent fetched', () => {
    const spring = { kind: 'task' as const, taskId: 'backend:maven' }
    expect(hotReloadChoice({ ...spring, jdk: 'jbr-17', jdks: [jbr17], hotswapAgent: agent })).toEqual({ usable: true, enhanced: true })
    expect(hotReloadToSave('enhanced', hotReloadChoice({ ...spring, jdk: 'jbr-17', jdks: [jbr17], hotswapAgent: agent }))).toBe('enhanced')
    // Nothing fetched: both, with the link to the settings
    expect(hotReloadChoice({ ...spring, jdk: 'system', jdks: [zulu17], hotswapAgent: noAgent }))
      .toEqual({ usable: true, enhanced: false, needsDownload: true, enhancedMissing: '확장에는 JBR 17·21 과 HotswapAgent 가 필요합니다.' })
    // A JBR 11 is not one (JDK 8·11 projects get the standard grade only)
    expect(hotReloadChoice({ ...spring, jdk: 'jbr-11', jdks: [jbr11], hotswapAgent: agent }))
      .toMatchObject({ enhanced: false, needsDownload: true, enhancedMissing: '확장에는 JBR 17·21 이 필요합니다.' })
    // In the store but another JDK picked: only which JDK to pick, nothing to fetch
    expect(hotReloadChoice({ ...spring, jdk: 'zulu-17', jdks: [zulu17, jbr17], hotswapAgent: agent }))
      .toEqual({ usable: true, enhanced: false, needsDownload: false, enhancedMissing: '확장은 JDK 를 JBR 17·21 로 고르면 쓸 수 있습니다.' })
    expect(hotReloadChoice({ ...spring, jdk: 'jbr-17', jdks: [jbr17], hotswapAgent: noAgent }))
      .toMatchObject({ enhanced: false, needsDownload: true, enhancedMissing: '확장에는 HotswapAgent 가 필요합니다.' })
    // The standard grade works with any JDK
    expect(hotReloadToSave('standard', hotReloadChoice({ ...spring, jdk: 'system', jdks: [], hotswapAgent: noAgent }))).toBe('standard')
  })

  it('keeps hotReload through the draft and reads old presets as 끄기', () => {
    expect(emptyDraft().hotReload).toBe('off')
    expect(draftOf(preset()).hotReload).toBe('off')
    expect(draftOf(preset({ hotReload: 'enhanced' })).hotReload).toBe('enhanced')
    const made = presetFromDraft({ ...draftOf(preset()), hotReload: 'standard' })
    expect('preset' in made && made.preset.hotReload).toBe('standard')
  })

  it('tells how long ago', () => {
    expect(reloadAge(10_000, 13_000)).toBe('방금')
    expect(reloadAge(10_000, 22_000)).toBe('12초 전')
    expect(reloadAge(0, 185_000)).toBe('3분 전')
    expect(reloadAge(0, 7_300_000)).toBe('2시간 전')
  })

  it('shows a chip for each reload state of a running server', () => {
    const running = (reload: RunState['reload']) => state({ status: 'running', address: 'http://localhost:8080/', reload })
    expect(reloadChip(running({ status: 'watching', at: 0 }), 0)).toMatchObject({ tone: 'muted', text: '바로 반영' })
    expect(reloadChip(running({ status: 'compiling', at: 0 }), 0)).toMatchObject({ tone: 'busy', text: '컴파일 중' })
    expect(reloadChip(running({ status: 'applied', classes: 3, at: 1_000 }), 2_000)).toMatchObject({ tone: 'ok', text: '반영됨 · 클래스 3 · 방금' })
    expect(reloadChip(running({ status: 'applied', classes: 1, at: 1_000 }), 31_000)?.text).toBe('반영됨 · 클래스 1 · 30초 전')
    expect(reloadChip(running({ status: 'applied', devtools: true, at: 1_000 }), 2_000)).toMatchObject({ tone: 'ok', text: '반영됨 · DevTools 재시작' })
    const restart = reloadChip(running({ status: 'restartNeeded', reason: '메서드 추가', at: 0 }), 0)
    expect(restart).toMatchObject({ tone: 'warn', text: '재기동 필요: 메서드 추가', restart: true })
    expect(restart?.toErrors).toBeUndefined()
    const compile = reloadChip(running({ status: 'compileError', reason: 'Foo.java:12 세미콜론', at: 0 }), 0)
    expect(compile).toMatchObject({ tone: 'err', text: '컴파일 오류', toErrors: true })
    expect(compile?.title).toContain('Foo.java:12 세미콜론')
    expect(reloadChip(running({ status: 'failed', reason: 'javac 를 찾을 수 없습니다', at: 0 }), 0))
      .toMatchObject({ tone: 'err', text: '바로 반영 실패: javac 를 찾을 수 없습니다' })
    expect(reloadChip(running({ status: 'restartNeeded', at: 0 }), 0)?.text).toBe('재기동 필요')
  })

  it('shows no chip when hot reload is off or the server is not up, and ticks only for a fresh 반영됨', () => {
    expect(reloadChip(state({ status: 'running' }), 0)).toBeNull()
    expect(reloadChip(state({ status: 'crashed', reload: { status: 'restartNeeded', at: 0 } }), 0)).toBeNull()
    expect(reloadChip(state({ status: 'stopped', reload: { status: 'watching', at: 0 } }), 0)).toBeNull()
    expect(reloadTicks(state({ status: 'running', reload: { status: 'applied', at: 0 } }), 10_000)).toBe(true)
    expect(reloadTicks(state({ status: 'running', reload: { status: 'applied', at: 0 } }), 4_000_000)).toBe(false)
    expect(reloadTicks(state({ status: 'running', reload: { status: 'watching', at: 0 } }), 10_000)).toBe(false)
    expect(reloadTicks(undefined, 0)).toBe(false)
  })
})

describe('Tomcat presets (stage 2)', () => {
  const tomcatPreset = preset({
    kind: 'tomcat', taskId: undefined, relative: 'legacy', tomcat: 'tomcat-9.0.98', webapp: 'WebContent', contextPath: '/shop', port: 8081,
    vmArgs: '-Xmx1g -Dfile.encoding=UTF-8', prepare: { tool: 'ant', target: 'compile' }, hotReload: 'standard'
  })
  const fields = (over: Partial<Parameters<typeof tomcatFromDraft>[0]> = {}) => ({
    tomcat: 'tomcat-9', webapp: 'src/main/webapp/', contextPath: '/', portText: '8080', vmArgs: '', prepareTool: 'none' as const, antTarget: '', mavenGoals: '', ...over
  })

  it('round-trips a Tomcat preset through the form', () => {
    const draft = draftOf(tomcatPreset)
    expect(draft).toMatchObject({ kind: 'tomcat', tomcat: 'tomcat-9.0.98', portText: '8081', prepareTool: 'ant', antTarget: 'compile', mavenGoals: '' })
    expect(presetFromDraft(draft)).toEqual({ preset: tomcatPreset })
    // A task preset keeps no Tomcat fields
    const task = presetFromDraft(draftOf(preset()))
    expect('preset' in task && 'tomcat' in task.preset).toBe(false)
  })

  it('checks the Tomcat fields as main does', () => {
    expect(tomcatFromDraft(fields())).toEqual({ tomcat: 'tomcat-9', webapp: 'src/main/webapp', contextPath: '/', port: 8080, vmArgs: '' })
    expect(tomcatFromDraft(fields({ tomcat: '' }))).toEqual({ error: 'Tomcat 을 골라 주세요.' })
    expect(tomcatFromDraft(fields({ webapp: ' ' }))).toEqual({ error: '웹 폴더(WEB-INF 가 든 폴더)를 골라 주세요.' })
    for (const contextPath of ['shop', '/ROOT', '/a/b', '/' + 'x'.repeat(65)]) {
      expect(tomcatFromDraft(fields({ contextPath }))).toEqual({ error: '컨텍스트 경로를 / 또는 /이름 형식으로 입력해 주세요.' })
    }
    expect(tomcatFromDraft(fields({ contextPath: '/쇼핑-몰' }))).toMatchObject({ contextPath: '/쇼핑-몰' })
    for (const portText of ['0', '65536', '', '80a']) {
      expect(tomcatFromDraft(fields({ portText }))).toEqual({ error: 'HTTP 포트는 1~65535 사이의 숫자로 입력해 주세요.' })
    }
    expect(tomcatFromDraft(fields({ vmArgs: '-Xmx1g\n-Da=b' }))).toEqual({ error: 'VM 인자는 한 줄로 입력해 주세요.' })
  })

  it('takes the build before the server: an Ant target or Maven goals', () => {
    expect(tomcatFromDraft(fields({ prepareTool: 'ant', antTarget: 'war' }))).toMatchObject({ prepare: { tool: 'ant', target: 'war' } })
    expect(tomcatFromDraft(fields({ prepareTool: 'ant', antTarget: '' }))).toEqual({ error: 'Ant 타깃을 골라 주세요.' })
    expect(tomcatFromDraft(fields({ prepareTool: 'maven', mavenGoals: '  clean   package ' }))).toMatchObject({ prepare: { tool: 'maven', goals: 'clean package' } })
    expect(tomcatFromDraft(fields({ prepareTool: 'maven', mavenGoals: 'clean -DskipTests' }))).toEqual({ error: 'Maven 목표를 확인해 주세요 (예: clean package).' })
    expect(tomcatFromDraft(fields({ prepareTool: 'maven', mavenGoals: '' }))).toEqual({ error: 'Maven 목표를 확인해 주세요 (예: clean package).' })
    // 없음 saves no prepare even with leftovers typed
    expect(tomcatFromDraft(fields({ prepareTool: 'none', antTarget: 'war' }))).not.toHaveProperty('prepare')
  })

  it('shows the build stage and a failed build on the row', () => {
    const preparing = state({ status: 'preparing', startedAt: 1_000 })
    expect(runPills(preparing, 13_500)).toEqual([{ kind: 'wait', text: '준비 중 12초' }])
    expect(runButtons(preparing)).toEqual(['log', 'stop'])
    expect(isRunActive(preparing)).toBe(true)
    expect(runPills(state({ status: 'crashed', failedAt: 'prepare', exitCode: 1 }), 0)).toEqual([{ kind: 'err', text: '빌드 실패 · 종료 1' }])
    expect(runPills(state({ status: 'crashed', exitCode: 1 }), 0)).toEqual([{ kind: 'err', text: '멈춤 · 종료 1' }])
    expect(runHead([tomcatPreset], { p1: preparing }).label).toBe('실행 · 1개 실행 중')
  })

  it('names what runs, and allows hot reload for Tomcat', () => {
    expect(runCommandLabel(tomcatPreset)).toBe('Tomcat /shop :8081')
    expect(runKind(tomcatPreset)).toBe('tomcat')
    expect(hotReloadChoice({ kind: 'tomcat', jdk: 'system', jdks: [], hotswapAgent: { installed: false } })).toMatchObject({ usable: true, enhanced: false })
    expect(HOT_RELOAD_SPRING_ONLY).toBe('Spring Boot·Tomcat 실행에서만 됩니다.')
  })
})

describe('Eclipse project import (stage 2, second batch)', () => {
  const imported = { webapp: 'WebContent', contextPath: 'shop', release: 8, encoding: 'MS949', sources: ['src', 'resources'], libs: ['WebContent/WEB-INF/lib/a.jar', 'lib/b.jar', 'lib/c.jar'] }

  it('fills only the web folder and the context path', () => {
    expect(eclipseFill(imported)).toEqual({ webapp: 'WebContent', contextPath: '/shop' })
    expect(eclipseFill({ webapp: ' ', contextPath: '/' })).toEqual({ contextPath: '/' })
    // From a module folder: the preset keeps the web folder from the worktree
    expect(eclipseFill(imported, 'legacy/shop-web/')).toEqual({ webapp: 'legacy/shop-web/WebContent', contextPath: '/shop' })
    expect(eclipseFill(imported, '.')).toMatchObject({ webapp: 'WebContent' })
    // The web folder is the Eclipse project's folder itself
    expect(eclipseFill({ webapp: '.', contextPath: '/' }, 'legacy')).toEqual({ webapp: 'legacy', contextPath: '/' })
    expect(eclipseFill({ webapp: '.', contextPath: '/' }, '.')).toEqual({ webapp: '.', contextPath: '/' })
    expect(eclipseFill({ webapp: '', contextPath: '/' }, 'legacy')).toEqual({ contextPath: '/' })
  })

  it('shows what it read, line by line, with main\u2019s notes', () => {
    expect(eclipseSummary(imported, ['JDK 8 이 맞습니다 (Java facet 1.8)', '  '])).toEqual([
      '웹 폴더: WebContent · 컨텍스트 경로: shop',
      '소스 폴더: src, resources',
      'lib: 3개 (WebContent/WEB-INF/lib/a.jar, lib/b.jar 외 1개)',
      '컴파일 버전: Java 8 · 인코딩: MS949',
      'JDK 8 이 맞습니다 (Java facet 1.8)'
    ])
    expect(eclipseSummary({ webapp: '', contextPath: '', sources: [], libs: [] })).toEqual([
      '웹 폴더: 못 찾음 · 컨텍스트 경로: /',
      '소스 폴더: 없음',
      'lib: 없음',
      '컴파일 버전: 설정 없음 · 인코딩: 설정 없음 (MS949 일 수 있음)'
    ])
  })

  it('saves the Eclipse-style build and reads it back', () => {
    expect(tomcatFromDraft({ tomcat: 't', webapp: 'WebContent', contextPath: '/', portText: '8080', vmArgs: '', prepareTool: 'eclipse', antTarget: 'x', mavenGoals: 'y' }))
      .toEqual({ tomcat: 't', webapp: 'WebContent', contextPath: '/', port: 8080, vmArgs: '', prepare: { tool: 'eclipse' } })
    const saved = preset({ kind: 'tomcat', taskId: undefined, tomcat: 't', webapp: 'WebContent', contextPath: '/', port: 8080, vmArgs: '', prepare: { tool: 'eclipse' }, hotReload: 'off' })
    expect(draftOf(saved).prepareTool).toBe('eclipse')
    expect(presetFromDraft(draftOf(saved))).toEqual({ preset: saved })
  })
})

describe('workspace servers, context.xml, log encoding, extra libs (stage 2, third batch)', () => {
  it('fills the VM arguments, port, context and context.xml from a workspace server', () => {
    expect(workspaceServerFill({ name: 'Tomcat v7.0 Server at localhost', port: 8090, vmArgs: '-Xmx512m\n-Dfile.encoding=MS949', contextPath: 'shop', contextXml: 'C:/ws/Servers/Tomcat v7.0-config/context.xml' }))
      .toEqual({ vmArgs: '-Xmx512m -Dfile.encoding=MS949', portText: '8090', contextPath: '/shop', contextXml: 'C:/ws/Servers/Tomcat v7.0-config/context.xml', contextXmlLabel: 'Tomcat v7.0 Server at localhost 서버의 context.xml' })
    expect(workspaceServerFill({ name: 'empty', port: 70000, vmArgs: '  ' })).toEqual({})
  })

  it('shortens a long path to its last two parts', () => {
    expect(shortPath('C:\\ws\\Servers\\Tomcat-config\\context.xml')).toBe('…/Tomcat-config/context.xml')
    expect(shortPath('lib/a.jar')).toBe('lib/a.jar')
  })

  it('keeps the new fields through the form, and leaves them out when unset', () => {
    const saved = preset({ kind: 'tomcat', taskId: undefined, tomcat: 't', webapp: 'WebContent', contextPath: '/', port: 8080, vmArgs: '', hotReload: 'off',
      contextXml: 'C:/ws/Servers/x/context.xml', extraLibs: ['~/.m2/repository/com/oracle/ojdbc6/11.2/ojdbc6-11.2.jar'], logEncoding: 'ms949' })
    expect(presetFromDraft(draftOf(saved))).toEqual({ preset: saved })
    const draft = draftOf(saved)
    const plain = presetFromDraft({ ...draft, contextXml: '', extraLibs: [], logEncoding: 'auto' })
    expect('preset' in plain && ['contextXml', 'extraLibs', 'logEncoding'].some(key => key in plain.preset)).toBe(false)
    // Log encoding is for every kind; the Tomcat fields are not
    const task = presetFromDraft({ ...draftOf(preset()), logEncoding: 'utf-8', contextXml: 'x', extraLibs: ['y'] })
    expect('preset' in task && task.preset).toMatchObject({ logEncoding: 'utf-8' })
    expect('preset' in task && ('contextXml' in task.preset || 'extraLibs' in task.preset)).toBe(false)
  })
})

describe('the dialog layout (review, 2026-11-26)', () => {
  it('suggests a name from the folder, the Tomcat context or the kind found', () => {
    expect(suggestPresetName({ kind: 'task', relative: 'backend/', taskId: 'backend:gradle' })).toBe('backend')
    expect(suggestPresetName({ kind: 'task', relative: '.', taskId: '.:gradle', command: 'gradlew bootRun' })).toBe('Spring Boot')
    expect(suggestPresetName({ kind: 'task', relative: '.', taskId: 'frontend:npm:dev', command: 'npm run dev' })).toBe('Node')
    expect(suggestPresetName({ kind: 'task', relative: '.' })).toBe('')
    expect(suggestPresetName({ kind: 'tomcat', relative: 'legacy', contextPath: '/shop' })).toBe('shop')
    expect(suggestPresetName({ kind: 'tomcat', relative: 'legacy', contextPath: '/' })).toBe('legacy')
    expect(suggestPresetName({ kind: 'tomcat', relative: '.', contextPath: '/' })).toBe('Tomcat')
    expect(suggestPresetName({ kind: 'custom', relative: '.' })).toBe('')
    expect([...suggestPresetName({ kind: 'custom', relative: 'a'.repeat(30) })]).toHaveLength(20)
  })

  it('knows which runs need a JDK', () => {
    expect(usesJdk({ kind: 'tomcat' })).toBe(true)
    expect(usesJdk({ kind: 'task', taskId: '.:maven', command: 'mvnw spring-boot:run' })).toBe(true)
    expect(usesJdk({ kind: 'task', taskId: 'frontend:npm:dev', command: 'npm run dev' })).toBe(false)
    expect(usesJdk({ kind: 'custom', command: 'java -jar app.jar' })).toBe(false)
  })

  it('opens 고급 by itself only when something in it is set', () => {
    const fresh = emptyDraft()
    expect(hasAdvancedValues(fresh)).toBe(false)
    expect(hasAdvancedValues({ ...fresh, envText: 'A=1' })).toBe(true)
    expect(hasAdvancedValues({ ...fresh, logEncoding: 'ms949' })).toBe(true)
    expect(hasAdvancedValues({ ...fresh, hotReload: 'standard' })).toBe(true)
    expect(hasAdvancedValues({ ...fresh, inAll: false })).toBe(true)
    expect(hasAdvancedValues({ ...fresh, waitReady: true })).toBe(true)
    expect(hasAdvancedValues({ ...fresh, kind: 'tomcat', vmArgs: '-Xmx1g' })).toBe(true)
    expect(hasAdvancedValues({ ...fresh, kind: 'tomcat', extraLibs: ['lib/a.jar'] })).toBe(true)
    expect(hasAdvancedValues({ ...fresh, kind: 'custom', jdk: 'zulu-8' })).toBe(true)
    // A task's JDK is not under 고급
    expect(hasAdvancedValues({ ...fresh, kind: 'task', jdk: 'zulu-8' })).toBe(false)
  })

  it('says once that what runs as typed is confirmed', () => {
    const fresh = emptyDraft()
    expect(hasRunContent(fresh)).toBe(false)
    expect(hasRunContent({ ...fresh, kind: 'custom', command: ' ' })).toBe(false)
    expect(hasRunContent({ ...fresh, kind: 'custom', command: 'npm start' })).toBe(true)
    expect(hasRunContent({ ...fresh, kind: 'tomcat' })).toBe(false)
    expect(hasRunContent({ ...fresh, kind: 'tomcat', prepareTool: 'eclipse' })).toBe(true)
    expect(hasRunContent({ ...fresh, kind: 'tomcat', contextXml: 'conf/context.xml' })).toBe(true)
  })
})

describe('Maven settings (stage 2, Maven runs)', () => {
  const maven = preset({ taskId: 'backend:maven' })

  it('knows a Maven run as main does', () => {
    expect(usesMaven({ kind: 'task', taskId: 'backend:maven', prepareTool: 'none' })).toBe(true)
    expect(usesMaven({ kind: 'task', taskId: 'backend:gradle', prepareTool: 'none' })).toBe(false)
    expect(usesMaven({ kind: 'tomcat', prepareTool: 'maven' })).toBe(true)
    expect(usesMaven({ kind: 'tomcat', prepareTool: 'ant' })).toBe(false)
  })

  it('saves only what differs from main\u2019s defaults, and only for a Maven run', () => {
    const plain = presetFromDraft(draftOf(maven))
    expect('preset' in plain && ['mavenRunner', 'mavenSplit', 'mavenPin', 'mavenSource'].some(key => key in plain.preset)).toBe(false)
    const set = presetFromDraft({ ...draftOf(maven), mavenRunner: 'temurin-17', mavenSplit: 'off', mavenPin: true, mavenSource: 'pinned' })
    expect('preset' in set && set.preset).toMatchObject({ mavenRunner: 'temurin-17', mavenSplit: false, mavenSource: 'pinned' })
    const keep = presetFromDraft({ ...draftOf(maven), mavenPin: true })
    expect('preset' in keep && keep.preset).toMatchObject({ mavenPin: true })
    // Building from the pin: the keep switch is not saved
    const pinned = presetFromDraft({ ...draftOf(maven), mavenPin: true, mavenSource: 'pinned' })
    expect('preset' in pinned && 'mavenPin' in pinned.preset).toBe(false)
    const saved = preset({ taskId: 'backend:maven', hotReload: 'off', mavenRunner: 'temurin-21', mavenSplit: true, mavenSource: 'pinned' })
    expect(presetFromDraft(draftOf(saved))).toEqual({ preset: saved })
    // A Gradle run keeps none of them
    const gradle = presetFromDraft({ ...draftOf(preset({ taskId: 'backend:gradle' })), mavenRunner: 'temurin-17', mavenPin: true })
    expect('preset' in gradle && ('mavenRunner' in gradle.preset || 'mavenPin' in gradle.preset)).toBe(false)
  })

  it('opens 고급 and says the run changes when Maven settings are set', () => {
    expect(hasAdvancedValues(draftOf(maven))).toBe(false)
    expect(hasAdvancedValues({ ...draftOf(maven), mavenSource: 'pinned' })).toBe(true)
    expect(hasRunContent({ ...draftOf(maven), mavenRunner: 'temurin-17' })).toBe(true)
    expect(hasRunContent(draftOf(maven))).toBe(false)
  })
})
