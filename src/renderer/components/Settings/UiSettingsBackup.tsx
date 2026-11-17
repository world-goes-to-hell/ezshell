import { useRef, useState } from 'react'
import { RiDownload2Line, RiUpload2Line } from 'react-icons/ri'
import { useToastStore } from '../../stores/toastStore'
import {
  parseUiSettingsFile, groupsOf, UI_SETTING_ENTRIES, UI_SETTING_GROUP_LABELS, UI_SETTINGS_MAX_BYTES,
  type UiSettingGroup, type UiSettingsImport
} from '../../lib/uiSettingsBackup'
import { applyUiSettings, exportUiSettings, uiSettingsContext } from '../../lib/uiSettingsApply'

const GROUP_ORDER: UiSettingGroup[] = ['theme', 'shortcuts', 'layout', 'view']

const pad = (value: number) => String(value).padStart(2, '0')
const fileStamp = (date: Date) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`

/**
 * 설정 > 백업 > 화면 설정: theme, shortcuts, panel sizes and view options to a file and back.
 * What travels and how it is checked: lib/uiSettingsBackup.ts. Sessions and anything naming a
 * server are not part of it (세션 백업 is the tab for those).
 */
export function UiSettingsBackup() {
  const addToast = useToastStore(state => state.addToast)
  const fileInput = useRef<HTMLInputElement>(null)
  const [isSaving, setIsSaving] = useState(false)
  // A file that was read and checked, waiting for the user to apply it
  const [pending, setPending] = useState<{ name: string; data: UiSettingsImport } | null>(null)

  const handleExport = async () => {
    const save = window.electronAPI?.saveExportFile
    if (typeof save !== 'function') {
      addToast({ type: 'error', title: '앱을 다시 시작한 뒤에 사용할 수 있습니다' })
      return
    }
    setIsSaving(true)
    try {
      const file = exportUiSettings()
      const count = Object.keys(file.settings).length
      if (count === 0) {
        addToast({ type: 'info', title: '내보낼 설정이 없습니다', message: '아직 바꾼 화면 설정이 없습니다' })
        return
      }
      const result = await save(`ezshell-ui-settings-${fileStamp(new Date())}.json`, 'json', JSON.stringify(file, null, 2), 'ui-settings')
      if (result.success) addToast({ type: 'success', title: '화면 설정을 내보냈습니다', message: `${count}개 항목` })
      else if (!result.cancelled) addToast({ type: 'error', title: '화면 설정 내보내기 실패', message: result.error })
    } catch (error) {
      addToast({ type: 'error', title: '화면 설정 내보내기 실패', message: error instanceof Error ? error.message : undefined })
    } finally {
      setIsSaving(false)
    }
  }

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > UI_SETTINGS_MAX_BYTES) {
      addToast({ type: 'error', title: '화면 설정 파일을 읽을 수 없습니다', message: '파일이 너무 큽니다.' })
      return
    }
    try {
      const result = parseUiSettingsFile(await file.text(), uiSettingsContext())
      if (!result.ok) {
        setPending(null)
        addToast({ type: 'error', title: '화면 설정 파일을 읽을 수 없습니다', message: result.error })
        return
      }
      setPending({ name: file.name, data: result.import })
    } catch {
      addToast({ type: 'error', title: '화면 설정 파일을 읽을 수 없습니다' })
    }
  }

  const handleApply = () => {
    if (!pending) return
    const applied = applyUiSettings(pending.data.values)
    setPending(null)
    addToast({
      type: applied > 0 ? 'success' : 'error',
      title: applied > 0 ? '화면 설정을 가져왔습니다' : '화면 설정을 적용하지 못했습니다',
      message: applied > 0 ? `${applied}개 항목 적용 · 패널 크기와 보기 옵션은 해당 화면을 다시 열 때 반영됩니다` : undefined
    })
  }

  const skipped = pending ? pending.data.invalid + pending.data.unknown : 0

  return (
    <>
      <div className="backup-section">
        <div className="backup-section-header">
          <h4>화면 설정 내보내기</h4>
          <p>이 PC 의 화면 설정을 JSON 파일로 저장합니다. 다른 PC 의 ezShell 에서 가져올 수 있습니다.</p>
        </div>
        <ul className="ui-settings-list">
          {GROUP_ORDER.map(group => (
            <li key={group}>
              <strong>{UI_SETTING_GROUP_LABELS[group]}</strong>
              <span>{UI_SETTING_ENTRIES.filter(entry => entry.group === group).map(entry => entry.label).join(', ')}</span>
            </li>
          ))}
        </ul>
        <button className="backup-btn backup-btn-primary" onClick={handleExport} disabled={isSaving}>
          <RiDownload2Line size={20} />
          {isSaving ? '저장하는 중…' : '화면 설정 내보내기'}
        </button>
      </div>

      <div className="backup-section">
        <div className="backup-section-header">
          <h4>화면 설정 가져오기</h4>
          <p>내보낸 파일을 고르면 들어 있는 항목을 먼저 보여 주고, 적용을 눌러야 바뀝니다.</p>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={event => {
            void handleFile(event.target.files?.[0])
            // The same file can be picked again after a cancel
            event.target.value = ''
          }}
        />
        <button className="backup-btn backup-btn-secondary" onClick={() => fileInput.current?.click()}>
          <RiUpload2Line size={20} />
          파일 고르기…
        </button>

        {pending && (
          <div className="ui-settings-pending" role="status">
            <p className="ui-settings-pending-file">{pending.name}</p>
            <p>
              {pending.data.values.length}개 항목을 적용합니다: {groupsOf(pending.data.values).join(', ')}
            </p>
            <ul>
              {pending.data.values.map(item => <li key={item.entry.key}>{item.entry.label}</li>)}
            </ul>
            {skipped > 0 && <p className="ui-settings-pending-skipped">알 수 없거나 형식이 맞지 않는 항목 {skipped}개는 건너뜁니다.</p>}
            <div className="ui-settings-pending-actions">
              <button className="backup-btn backup-btn-primary" onClick={handleApply}>적용</button>
              <button className="backup-btn backup-btn-secondary" onClick={() => setPending(null)}>취소</button>
            </div>
          </div>
        )}
      </div>

      <div className="backup-info">
        <h5>주의사항</h5>
        <ul>
          <li>세션, 비밀번호, 접속 기록, 명령 기록, 스니펫은 들어가지 않습니다. 세션은 `세션 백업` 탭에서 옮깁니다.</li>
          <li>가져오면 같은 항목의 지금 설정을 덮어씁니다. 단축키는 파일의 단축키로 바뀌고, 파일에 없는 단축키는 기본값으로 돌아갑니다.</li>
          <li>사용자 지정 테마는 추가되고, 이 PC 에 있던 테마는 그대로 남습니다.</li>
        </ul>
      </div>
    </>
  )
}
