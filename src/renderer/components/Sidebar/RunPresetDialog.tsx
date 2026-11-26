// Adds or edits a run preset (mockups/dev-run-presets.html scene 2). What a first-time user needs comes first
// (review of the dialog, 2026-11-26): the kind (a way main found, a Tomcat, a typed command), its folder and
// fields, a name (filled in from them until the user types one), the JDK for Java runs, and the two
// switches about errors and agents. The rest waits under 고급, which opens by itself when something in it
// is set. main checks all of it again; what runs as typed is shown in full and confirmed before it first runs.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiFolder3Line, RiPlayLine } from 'react-icons/ri'
import { RunPresetTomcatAdvanced, RunPresetTomcatFields } from './RunPresetTomcatFields'
import { RunPresetMavenFields } from './RunPresetMavenFields'
import {
  draftOf, emptyDraft, hasAdvancedValues, hasRunContent, hotReloadChoice, hotReloadToSave, LOG_ENCODINGS, presetFromDraft,
  PLAIN_TEXT_WARNING, secretCommandArgNames, secretEnvNames, suggestPresetName, usesJdk, usesMaven,
  type HotReload, type PresetDraft, type RunCandidate, type RunPreset
} from '../../lib/runPresets'
import { draftKey, dropDraft, keepDraft, reloadProjectPresets, runPresetApi, takeDraft, worktreeRuns } from '../../stores/runPresetStore'
import { JdkRequirementNotice } from '../Settings/JdkSettings'
import { openSettingsTab } from '../../lib/settingsNavigation'
import type { ApacheToolRuntime, HotswapAgentStatus, JdkRuntime, LogEncoding } from '../../types'

// The JDK store (codex-4's src/runtimes): entries without paths; optional until a build has it.
// `hotswapAgent` (stage 3): whether HotswapAgent is fetched, for the enhanced hot reload; `tools` (stage 2):
// the Apache tools fetched or found (Tomcat for a Tomcat preset).
type RuntimesApi = {
  runtimesList?: () => Promise<{ jdks: JdkRuntime[]; hotswapAgent?: HotswapAgentStatus; tools?: ApacheToolRuntime[] } | undefined>
  runtimesRequired?: (projectFolder: string) => Promise<{ feature: number | null } | undefined>
}

const HOT_RELOAD_OPTIONS: Array<{ value: HotReload; label: string; detail?: string }> = [
  { value: 'off', label: '끄기' },
  { value: 'standard', label: '표준', detail: '메서드 안의 코드 수정 · 모든 JDK' },
  { value: 'enhanced', label: '확장', detail: '메서드·필드 추가, Spring 빈 다시 읽기 · JBR 17·21 필요' }
]

// The store's vendor ids by the names Settings > 개발 도구 shows (a JDK found on the PC keeps its own)
const VENDOR_NAMES: Record<string, string> = { temurin: 'Eclipse Temurin', zulu: 'Azul Zulu', jbr: 'JetBrains Runtime' }
const jdkLabel = (jdk: JdkRuntime) => [VENDOR_NAMES[jdk.vendor] ?? jdk.vendor, `JDK ${jdk.feature}`, jdk.version && `(${jdk.version})`, jdk.managed ? '' : '· 이 PC'].filter(Boolean).join(' ')

export function RunPresetDialog({ folder, projectName, preset, onClose }: {
  folder: string; projectName: string; roots: string[]; preset: RunPreset | null; onClose: () => void
}) {
  // The input kept when the user went to fetch a JDK comes back when the dialog opens again
  const keyOfDraft = draftKey(worktreeRuns(folder)?.projectKey ?? folder, preset?.id ?? null)
  const [draft, setDraft] = useState<PresetDraft>(() => takeDraft(keyOfDraft) ?? (preset ? draftOf(preset) : emptyDraft()))
  const close = () => { dropDraft(keyOfDraft); onClose() }
  const [folders, setFolders] = useState<string[]>([])
  const [candidates, setCandidates] = useState<RunCandidate[] | null>(null)
  const [jdks, setJdks] = useState<JdkRuntime[]>([])
  const [hotswapAgent, setHotswapAgent] = useState<HotswapAgentStatus | undefined>(undefined)
  const [tomcats, setTomcats] = useState<ApacheToolRuntime[] | null>(null)
  // The JDK the project's build asks for (pom.xml, Gradle, Spring Boot 3), when known
  const [required, setRequired] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<PresetDraft>) => setDraft(current => ({ ...current, ...patch }))
  // A new preset's name follows what was chosen until the user types in it (an edited preset keeps its own)
  const [nameTouched, setNameTouched] = useState(() => !!preset || !!draft.name)
  // 고급 opens by itself when the preset has something set in it
  const [advancedOpen, setAdvancedOpen] = useState(() => hasAdvancedValues(draft))
  const contentRef = useRef<HTMLDivElement>(null)

  // The project's top folders, to pick from (a deeper folder can be typed)
  useEffect(() => {
    let active = true
    void window.electronAPI.workspaceDirectoryList?.(folder).then(result => {
      if (active && result.success) setFolders(result.entries.filter(entry => entry.kind === 'directory' && !entry.name.startsWith('.')).map(entry => entry.name))
    }).catch(() => {})
    const runtimes = window.electronAPI as unknown as RuntimesApi
    void runtimes.runtimesList?.().then(result => {
      const list = result?.jdks
      if (active && Array.isArray(list)) setJdks(list.filter(jdk => jdk && typeof jdk.id === 'string'))
      if (active) setHotswapAgent({ installed: result?.hotswapAgent?.installed === true })
      if (active) setTomcats(Array.isArray(result?.tools) ? result.tools.filter(tool => tool?.tool === 'tomcat' && typeof tool.id === 'string') : [])
    }).catch(() => { if (active) setTomcats([]) })
    void runtimes.runtimesRequired?.(folder).then(result => {
      if (active && typeof result?.feature === 'number') setRequired(result.feature)
    }).catch(() => {})
    return () => { active = false }
  }, [folder])

  // The ways main finds in the chosen folder (0.3s after typing stops)
  const relative = draft.relative.trim() || '.'
  useEffect(() => {
    const ask = runPresetApi().runPresetsCandidates
    if (!ask) return
    let active = true
    setCandidates(null)
    const timer = window.setTimeout(() => {
      void ask(folder, relative).then(result => {
        if (!active) return
        const list = Array.isArray(result?.candidates) ? result.candidates : []
        setCandidates(list)
        setDraft(current => current.kind === 'task' && !list.some(item => item.taskId === current.taskId)
          ? { ...current, taskId: list[0]?.taskId } : current)
        if (result?.ok === false && result.error) setError(result.error)
      }, () => { if (active) setCandidates([]) })
    }, 300)
    return () => { active = false; window.clearTimeout(timer) }
  }, [folder, relative])

  const jdkChoices = useMemo(() => {
    const known = jdks.some(jdk => jdk.id === draft.jdk)
    return [{ id: 'system', label: 'PC 기본값 (JAVA_HOME)' }, ...jdks.map(jdk => ({ id: jdk.id, label: jdkLabel(jdk) })),
      ...(!known && draft.jdk !== 'system' ? [{ id: draft.jdk, label: `${draft.jdk} (보관함에 없음)` }] : [])]
  }, [jdks, draft.jdk])

  // 바로 반영: what the chosen way to run and JDK allow
  const runtimesKnown = hotswapAgent !== undefined
  const reloadChoice = hotReloadChoice({ kind: draft.kind, taskId: draft.taskId, jdk: draft.jdk, jdks, hotswapAgent })
  const hotReload = hotReloadToSave(draft.hotReload, reloadChoice)

  // Tomcat chosen: the first one fetched or found, unless the preset names one
  const chooseTomcat = () => set({ kind: 'tomcat', tomcat: draft.tomcat || tomcats?.[0]?.id || '' })
  // Back to the ways found: the chosen one if it is still there, otherwise the first
  const chooseTask = () => set({ kind: 'task', taskId: candidates?.some(item => item.taskId === draft.taskId) ? draft.taskId : candidates?.[0]?.taskId ?? draft.taskId })
  const candidate = candidates?.find(item => item.taskId === draft.taskId)

  const suggested = suggestPresetName({ kind: draft.kind, relative: draft.relative, taskId: draft.taskId, command: candidate?.command, contextPath: draft.contextPath })
  useEffect(() => {
    if (!nameTouched && suggested !== draft.name) setDraft(current => ({ ...current, name: suggested }))
  }, [nameTouched, suggested, draft.name])

  const javaRun = usesJdk({ kind: draft.kind, taskId: draft.taskId, command: candidate?.command })
  // The JDK stays in sight for a Java run, or when one was chosen; a typed command picks it under 고급
  const jdkUp = javaRun || (draft.kind === 'task' && draft.jdk !== 'system')

  const toSettings = () => {
    // As for a JDK: the dialog closes over the settings window, its input kept for when it opens again
    keepDraft(keyOfDraft, draft)
    onClose()
    openSettingsTab('development')
  }

  // A refused save may be about a field under 고급: it opens when something is set there, so the field is in sight
  const failSave = (message: string) => {
    setError(message)
    if (hasAdvancedValues(draft)) setAdvancedOpen(true)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    // Before the store's list comes the answer is not known: main checks the enhanced grade again
    if (runtimesKnown && hotReload === 'enhanced' && !reloadChoice.enhanced) { setError(reloadChoice.enhancedMissing ?? '확장을 쓸 수 없습니다.'); return }
    const made = presetFromDraft({ ...draft, hotReload })
    if ('error' in made) { failSave(made.error); return }
    const save = runPresetApi().runPresetsSave
    if (!save) return
    setSaving(true)
    setError(null)
    try {
      const result = await save(folder, made.preset)
      if (result?.ok === false || !result?.preset) {
        failSave(result?.error || '구성을 저장하지 못했습니다.')
        return
      }
      await reloadProjectPresets(folder)
      close()
    } catch {
      setError('구성을 저장하지 못했습니다.')
    } finally {
      setSaving(false)
    }
  }

  const jdkField = (
    <div className="form-group">
      <label htmlFor="run-preset-jdk">JDK</label>
      <select id="run-preset-jdk" value={draft.jdk} onChange={event => set({ jdk: event.target.value })}>
        {jdkChoices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
      {javaRun && (
        <JdkRequirementNotice feature={required} jdks={jdks} onInstall={required === null ? undefined : () => {
          // The settings window opens over the app: this dialog closes first, its input kept for
          // when it opens again (memory only, cleared on lock)
          keepDraft(keyOfDraft, draft)
          onClose()
          openSettingsTab('development', { jdkFeature: required })
        }} />
      )}
    </div>
  )

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !saving) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content ref={contentRef} className="modal-content run-preset-dialog" aria-describedby={undefined} tabIndex={-1}
          onOpenAutoFocus={event => {
            // Editing: no field takes the focus (the name is already there); adding: the kind comes first
            if (preset) { event.preventDefault(); contentRef.current?.focus() }
          }}>
          <Dialog.Title className="modal-title">
            <RiPlayLine size={18} aria-hidden="true" />
            {preset ? '실행 구성 수정' : '실행 구성 추가'} · {projectName}
          </Dialog.Title>
          <form onSubmit={submit} className="run-preset-form">
            <div className="run-preset-kinds" role="radiogroup" aria-label="실행할 것">
              {([['task', '찾은 실행 방법', chooseTask], ['tomcat', 'Tomcat', chooseTomcat], ['custom', '직접 입력', () => set({ kind: 'custom' })]] as const).map(([value, label, choose]) => (
                <label key={value} className="run-preset-kind-tab" data-on={draft.kind === value || undefined}>
                  <input type="radio" name="run-preset-kind" value={value} checked={draft.kind === value} onChange={choose} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <div className="form-group">
              <label htmlFor="run-preset-folder">폴더 <span className="run-preset-hint">(프로젝트 안)</span></label>
              <div className="run-preset-folder-input">
                <RiFolder3Line size={13} aria-hidden="true" />
                <input id="run-preset-folder" list="run-preset-folders" value={draft.relative} placeholder=". (프로젝트 폴더)"
                  onChange={event => set({ relative: event.target.value })} spellCheck={false} autoComplete="off" />
                <datalist id="run-preset-folders">
                  {folders.map(name => <option key={name} value={name} />)}
                </datalist>
              </div>
            </div>
            {draft.kind === 'task' && (
              <div className="form-group" role="radiogroup" aria-label="찾은 실행 방법">
                <div className="run-preset-choices">
                  {candidates === null && <div className="run-preset-hint">찾는 중…</div>}
                  {candidates?.length === 0 && <div className="run-preset-hint">이 폴더에서 찾은 실행 방법이 없습니다. 폴더를 바꾸거나 Tomcat·직접 입력을 고르세요.</div>}
                  {candidates?.map(item => (
                    <label key={item.taskId} className="run-preset-choice" data-on={draft.taskId === item.taskId || undefined}>
                      <input type="radio" name="run-preset-task" checked={draft.taskId === item.taskId}
                        onChange={() => set({ kind: 'task', taskId: item.taskId })} />
                      <code>{item.command}</code>
                      <em>{item.name}</em>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {draft.kind === 'custom' && (
              <div className="form-group">
                <input className="run-preset-command" value={draft.command} placeholder="예: ./gradlew bootRun --args='--spring.profiles.active=local'"
                  onChange={event => set({ command: event.target.value })} spellCheck={false} autoComplete="off" aria-label="실행할 명령" />
                <small className="run-preset-warn">직접 입력한 명령은 그대로 실행됩니다.</small>
                {secretCommandArgNames(draft.command).length > 0 && (
                  <small className="run-preset-warn run-preset-secret-warn" role="note">{PLAIN_TEXT_WARNING} ({secretCommandArgNames(draft.command).join(', ')})</small>
                )}
              </div>
            )}
            {draft.kind === 'tomcat' && (
              <RunPresetTomcatFields folder={folder} relative={relative} draft={draft} set={set} tomcats={tomcats}
                onToSettings={toSettings} />
            )}
            <div className="form-group">
              <label htmlFor="run-preset-name">이름</label>
              <input id="run-preset-name" value={draft.name} maxLength={20} placeholder="예: 백엔드"
                onChange={event => { setNameTouched(true); set({ name: event.target.value }) }} spellCheck={false} autoComplete="off" />
            </div>
            {jdkUp && jdkField}
            <div className="run-preset-switches">
              <Switch on={draft.notify} onChange={notify => set({ notify })} label="오류가 나면 알리기" />
              <Switch on={draft.agentControl} onChange={agentControl => set({ agentControl })} label="이 프로젝트의 에이전트가 실행·재기동·중지하고 로그를 읽게 허용" />
            </div>
            <details className="run-preset-advanced" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
              <summary>고급</summary>
              <div className="run-preset-advanced-body">
                <div className="form-group run-preset-reload" role="radiogroup" aria-label="바로 반영" data-usable={reloadChoice.usable || undefined}>
                  <span className="run-preset-field-label">바로 반영 <span className="run-preset-hint">(Java 수정을 재기동 없이)</span></span>
                  <div className="run-preset-reload-options">
                    {HOT_RELOAD_OPTIONS.map(option => {
                      const disabled = option.value !== 'off' && (!reloadChoice.usable || (option.value === 'enhanced' && !reloadChoice.enhanced && hotReload !== 'enhanced'))
                      return (
                        <label key={option.value} className="run-preset-reload-option" data-on={hotReload === option.value || undefined} data-disabled={disabled || undefined}
                          title={option.value === 'enhanced' && disabled && reloadChoice.usable ? reloadChoice.enhancedMissing : undefined}>
                          <input type="radio" name="run-preset-reload" value={option.value} checked={hotReload === option.value} disabled={disabled}
                            onChange={() => set({ hotReload: option.value })} />
                          <strong>{option.label}</strong>
                          {option.detail && <small>{option.detail}</small>}
                        </label>
                      )
                    })}
                  </div>
                  {!reloadChoice.usable && <small className="run-preset-hint run-preset-reload-reason">{reloadChoice.reason}</small>}
                  {/* What 확장 needs, once the user turned hot reload on (otherwise it is the disabled option's tooltip) */}
                  {runtimesKnown && reloadChoice.usable && !reloadChoice.enhanced && hotReload !== 'off' && (
                    <div className="run-preset-reload-missing" data-selected={hotReload === 'enhanced' || undefined}>
                      <small>{reloadChoice.enhancedMissing}</small>
                      {reloadChoice.needsDownload && <button type="button" className="run-preset-link" onClick={toSettings}>설정 &gt; 개발 도구에서 받기</button>}
                    </div>
                  )}
                  {hotReload !== 'off' && <small className="run-preset-hint">바로 반영을 켜면 이 실행에 IDE 디버거를 붙일 수 없습니다.</small>}
                </div>
                {draft.kind === 'tomcat' && <RunPresetTomcatAdvanced folder={folder} draft={draft} set={set} />}
                {usesMaven(draft) && <RunPresetMavenFields folder={folder} presetId={preset?.id ?? null} draft={draft} set={set} jdks={jdks} />}
                {!jdkUp && jdkField}
                <div className="form-group">
                  <label htmlFor="run-preset-env">환경 변수 <span className="run-preset-hint">(한 줄에 하나, 이름=값)</span></label>
                  <textarea id="run-preset-env" rows={2} value={draft.envText} placeholder="SPRING_PROFILES_ACTIVE=local"
                    onChange={event => set({ envText: event.target.value })} spellCheck={false} />
                  {secretEnvNames(draft.envText).length > 0 && (
                    <small className="run-preset-warn run-preset-secret-warn" role="note">{PLAIN_TEXT_WARNING} ({secretEnvNames(draft.envText).join(', ')})</small>
                  )}
                </div>
                <div className="form-group">
                  <label htmlFor="run-preset-log-encoding">로그 인코딩</label>
                  <select id="run-preset-log-encoding" value={draft.logEncoding} onChange={event => set({ logEncoding: event.target.value as LogEncoding })}
                    title="앱의 기본 문자 집합은 VM 설정을 따릅니다">
                    {LOG_ENCODINGS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <small className="run-preset-hint">로그 표시만 바뀝니다. 한글이 깨지면 MS949 를 고르세요.</small>
                </div>
                <div className="run-preset-switches">
                  <Switch on={draft.inAll} onChange={inAll => set({ inAll })} label="모두 실행에 포함" />
                  <Switch on={draft.waitReady} onChange={waitReady => set({ waitReady })} label="모두 실행 때 앞 구성이 뜬 뒤 실행" />
                </div>
              </div>
            </details>
            {/* Said once: what runs as typed (a command, a Tomcat's VM arguments, build, context.xml, jars) */}
            {/* A Maven mirror or -s applied from a diagnosis is run content too (main asks again for it) */}
            {(hasRunContent(draft) || (!!preset?.mavenMirrors?.length && draft.kind !== 'custom') || preset?.mavenUserSettings === false) && (
              <small className="run-preset-warn run-preset-confirm-note">그대로 실행되는 내용(직접 입력한 명령, VM 인자·기동 전 빌드·컨텍스트 설정 파일·추가 lib·진단에서 적용한 Maven 설정)은 처음 실행할 때와 바뀐 뒤에 한 번 더 확인합니다.</small>
            )}
            {error && <p className="run-preset-error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary modal-btn" onClick={close} disabled={saving}>취소</button>
              <button type="submit" className="btn-primary modal-btn" disabled={saving}>{preset ? '저장' : '추가'}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <label className="run-preset-switch">
      <input type="checkbox" role="switch" checked={on} onChange={event => onChange(event.target.checked)} />
      <span className="run-preset-switch-track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  )
}
