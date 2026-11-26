// Maven's settings of a run preset, under 고급 (a Spring Boot Maven task, a Tomcat's Maven build): which of the
// store's JDKs runs Maven, whether the project's JDK compiles and tests, keeping the dependencies of a build
// that worked, and building from that pin. They change what runs, so main asks again before the next run.
// An existing preset's pin can be exported to the worktree's .mvn-repo/ or deleted, each confirmed first.
import { useEffect, useState } from 'react'
import { RiArchiveLine } from 'react-icons/ri'
import type { PresetDraft } from '../../lib/runPresets'
import { askRunCommand } from '../../stores/runPresetStore'
import { toast } from '../../stores/toastStore'
import type { JdkRuntime, RunPresetResult } from '../../types'

const jdkName = (jdk: JdkRuntime) => `JDK ${jdk.feature}${jdk.version ? ` (${jdk.version})` : ''}${jdk.vendor === 'jbr' ? ' · JetBrains Runtime' : ''}`

export function RunPresetMavenFields({ folder, presetId, draft, set, jdks }: {
  folder: string
  /** The saved preset (its pin can be managed); null while adding */
  presetId: string | null
  draft: PresetDraft
  set: (patch: Partial<PresetDraft>) => void
  jdks: readonly JdkRuntime[]
}) {
  const tomcat = draft.kind === 'tomcat'
  const managed = jdks.filter(jdk => jdk.managed)
  const runnerKnown = !draft.mavenRunner || managed.some(jdk => jdk.id === draft.mavenRunner)

  // The pin of a saved preset: null while asked (or when it cannot be asked)
  const [pinned, setPinned] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const ask = window.electronAPI.runPresetMavenPinStatus
    if (!presetId || !ask) return
    let active = true
    ask(folder, presetId).then(result => { if (active && result?.ok !== false) setPinned(result?.pinned === true) }, () => {})
    return () => { active = false }
  }, [folder, presetId])

  // Export or delete: main describes it and asks; the same call again with the user's yes
  const changePin = async (action: 'export' | 'delete') => {
    const call = action === 'export' ? window.electronAPI.runPresetExportMavenPin : window.electronAPI.runPresetDeleteMavenPin
    if (!presetId || !call || busy) return
    setBusy(true)
    try {
      let result: RunPresetResult = await call(folder, presetId)
      if (result?.needsConfirm) {
        if (!await askRunCommand('action', result.needsConfirm.command)) return
        result = await call(folder, presetId, { confirmCustom: true })
      }
      if (result?.ok === false) { toast.error(action === 'export' ? 'Maven 보관본을 내보내지 못했습니다' : 'Maven 보관본을 지우지 못했습니다', result.error); return }
      toast.success(action === 'export' ? 'Maven 보관본을 .mvn-repo/ 에 내보냈습니다' : 'Maven 보관본을 지웠습니다')
      if (action === 'delete') setPinned(false)
    } catch {
      toast.error('Maven 보관본 작업을 하지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="run-preset-maven">
      <span className="run-preset-field-label">Maven</span>
      <div className="run-preset-maven-row">
        <div className="form-group">
          <label htmlFor="run-preset-maven-runner">Maven 실행 JDK</label>
          <select id="run-preset-maven-runner" value={draft.mavenRunner} onChange={event => set({ mavenRunner: event.target.value })}>
            <option value="">{tomcat ? '자동' : '자동 (구성 JDK)'}</option>
            {managed.map(jdk => <option key={jdk.id} value={jdk.id}>{jdkName(jdk)}</option>)}
            {!runnerKnown && <option value={draft.mavenRunner}>{draft.mavenRunner} (보관함에 없음)</option>}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="run-preset-maven-split">프로젝트 JDK로 컴파일·테스트</label>
          <select id="run-preset-maven-split" value={draft.mavenSplit} onChange={event => set({ mavenSplit: event.target.value as PresetDraft['mavenSplit'] })}>
            <option value="auto">{tomcat ? '자동 (JDK 17 미만이면 켬)' : '기본 (끔)'}</option>
            <option value="on">켜기</option>
            <option value="off">끄기</option>
          </select>
        </div>
      </div>
      <small className="run-preset-hint">
        {tomcat ? '자동은 구성 JDK를 사용합니다. JDK 17 미만이면 보관함의 JDK 17·21을 선택합니다.'
          : '플러그인 설정에 따라 Spring Boot 앱도 Maven 실행 JDK를 사용할 수 있습니다.'}
      </small>
      <div className="run-preset-maven-source" role="radiogroup" aria-label="Maven 빌드 저장소">
        {([['online', '온라인 저장소'], ['pinned', '보관본 사용']] as const).map(([value, label]) => (
          <label key={value} className="run-preset-maven-choice" data-on={draft.mavenSource === value || undefined}>
            <input type="radio" name="run-preset-maven-source" value={value} checked={draft.mavenSource === value}
              onChange={() => set({ mavenSource: value })} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <label className="run-preset-switch" data-disabled={draft.mavenSource === 'pinned' || undefined}>
        <input type="checkbox" role="switch" checked={draft.mavenPin && draft.mavenSource !== 'pinned'} disabled={draft.mavenSource === 'pinned'}
          onChange={event => set({ mavenPin: event.target.checked })} />
        <span className="run-preset-switch-track" aria-hidden="true" />
        <span>성공한 빌드의 의존성을 보관하기</span>
      </label>
      {presetId && pinned !== null && (
        <div className="run-preset-maven-pin">
          <RiArchiveLine size={13} aria-hidden="true" />
          <span>{pinned ? '보관본이 있습니다.' : '아직 보관본이 없습니다.'}</span>
          {pinned && (<>
            <button type="button" className="run-preset-link" disabled={busy} onClick={() => void changePin('export')}>.mvn-repo/ 로 내보내기</button>
            <button type="button" className="run-preset-link run-preset-link-danger" disabled={busy} onClick={() => void changePin('delete')}>보관본 지우기</button>
          </>)}
        </div>
      )}
    </div>
  )
}
