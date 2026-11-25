// Adds or edits a run preset (mockups/dev-run-presets.html scene 2): the folder inside the project, what
// runs there (one of the ways main found, or a typed command), the JDK, env and the switches. main checks
// all of it again; a typed command is shown in full and confirmed before it first runs.
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiFolder3Line, RiPlayLine } from 'react-icons/ri'
import { draftOf, emptyDraft, presetFromDraft, runFolderLabel, type PresetDraft, type RunCandidate, type RunPreset } from '../../lib/runPresets'
import { draftKey, dropDraft, keepDraft, reloadProjectPresets, runPresetApi, takeDraft, worktreeRuns } from '../../stores/runPresetStore'
import { JdkRequirementNotice } from '../Settings/JdkSettings'
import { openSettingsTab } from '../../lib/settingsNavigation'
import type { JdkRuntime } from '../../types'

// The JDK store (codex-4's src/runtimes): entries without paths; optional until a build has it
type RuntimesApi = {
  runtimesList?: () => Promise<{ jdks: JdkRuntime[] } | undefined>
  runtimesRequired?: (projectFolder: string) => Promise<{ feature: number | null } | undefined>
}

const jdkLabel = (jdk: JdkRuntime) => [jdk.vendor, `JDK ${jdk.feature}`, jdk.version && `(${jdk.version})`, jdk.managed ? '' : '· 이 PC'].filter(Boolean).join(' ')

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
  // The JDK the project's build asks for (pom.xml, Gradle, Spring Boot 3), when known
  const [required, setRequired] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<PresetDraft>) => setDraft(current => ({ ...current, ...patch }))

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
    }).catch(() => {})
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

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const made = presetFromDraft(draft)
    if ('error' in made) { setError(made.error); return }
    const save = runPresetApi().runPresetsSave
    if (!save) return
    setSaving(true)
    setError(null)
    try {
      const result = await save(folder, made.preset)
      if (result?.ok === false || !result?.preset) {
        setError(result?.error || '구성을 저장하지 못했습니다.')
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

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !saving) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content run-preset-dialog" aria-describedby={undefined}>
          <Dialog.Title className="modal-title">
            <RiPlayLine size={18} aria-hidden="true" />
            {preset ? '실행 구성 수정' : '실행 구성 추가'} · {projectName}
          </Dialog.Title>
          <form onSubmit={submit} className="run-preset-form">
            <div className="form-group">
              <label htmlFor="run-preset-name">이름</label>
              <input id="run-preset-name" value={draft.name} maxLength={20} autoFocus placeholder="예: 백엔드"
                onChange={event => set({ name: event.target.value })} spellCheck={false} autoComplete="off" />
            </div>
            <div className="form-group">
              <label htmlFor="run-preset-folder">폴더</label>
              <div className="run-preset-folder-input">
                <RiFolder3Line size={13} aria-hidden="true" />
                <input id="run-preset-folder" list="run-preset-folders" value={draft.relative} placeholder=". (프로젝트 폴더)"
                  onChange={event => set({ relative: event.target.value })} spellCheck={false} autoComplete="off" />
                <datalist id="run-preset-folders">
                  {folders.map(name => <option key={name} value={name} />)}
                </datalist>
              </div>
              <small className="run-preset-hint">이 프로젝트 안의 폴더만 쓸 수 있습니다 ({runFolderLabel(relative)}).</small>
            </div>
            <div className="form-group" role="radiogroup" aria-label="실행할 것">
              <span className="run-preset-field-label">실행할 것</span>
              <div className="run-preset-choices">
                {candidates === null && <div className="run-preset-hint">찾는 중…</div>}
                {candidates?.length === 0 && <div className="run-preset-hint">이 폴더에서 찾은 실행 방법이 없습니다. 폴더를 바꾸거나 직접 입력하세요.</div>}
                {candidates?.map(candidate => (
                  <label key={candidate.taskId} className="run-preset-choice" data-on={draft.kind === 'task' && draft.taskId === candidate.taskId || undefined}>
                    <input type="radio" name="run-preset-kind" checked={draft.kind === 'task' && draft.taskId === candidate.taskId}
                      onChange={() => set({ kind: 'task', taskId: candidate.taskId })} />
                    <code>{candidate.command}</code>
                    <em>{candidate.name}</em>
                  </label>
                ))}
                <label className="run-preset-choice" data-on={draft.kind === 'custom' || undefined}>
                  <input type="radio" name="run-preset-kind" checked={draft.kind === 'custom'} onChange={() => set({ kind: 'custom' })} />
                  <span>직접 입력</span>
                </label>
                {draft.kind === 'custom' && (<>
                  <input className="run-preset-command" value={draft.command} placeholder="예: ./gradlew bootRun --args='--spring.profiles.active=local'"
                    onChange={event => set({ command: event.target.value })} spellCheck={false} autoComplete="off" aria-label="실행할 명령" />
                  <small className="run-preset-warn">직접 입력한 명령은 그대로 실행됩니다. 처음 실행할 때 한 번 더 확인합니다.</small>
                </>)}
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="run-preset-jdk">JDK</label>
              <select id="run-preset-jdk" value={draft.jdk} onChange={event => set({ jdk: event.target.value })}>
                {jdkChoices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
              </select>
              <JdkRequirementNotice feature={required} jdks={jdks} onInstall={required === null ? undefined : () => {
                // The settings window opens over the app: this dialog closes first, its input kept for
                // when it opens again (memory only, cleared on lock)
                keepDraft(keyOfDraft, draft)
                onClose()
                openSettingsTab('development', { jdkFeature: required })
              }} />
            </div>
            <div className="form-group">
              <label htmlFor="run-preset-env">환경 변수 <span className="run-preset-hint">(한 줄에 하나, 이름=값)</span></label>
              <textarea id="run-preset-env" rows={2} value={draft.envText} placeholder="SPRING_PROFILES_ACTIVE=local"
                onChange={event => set({ envText: event.target.value })} spellCheck={false} />
            </div>
            <div className="run-preset-switches">
              <Switch on={draft.notify} onChange={notify => set({ notify })} label="오류가 나면 알리기" />
              <Switch on={draft.agentControl} onChange={agentControl => set({ agentControl })} label="이 프로젝트의 에이전트가 실행·재기동·중지하고 로그를 읽게 허용" />
              <Switch on={draft.inAll} onChange={inAll => set({ inAll })} label="모두 실행에 포함" />
              <Switch on={draft.waitReady} onChange={waitReady => set({ waitReady })} label="모두 실행 때 앞 구성이 뜬 뒤 실행" />
            </div>
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
