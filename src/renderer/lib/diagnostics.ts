// The diagnostics bundle on the screen (docs/plan/2026-11-28-diagnostics.md): main builds the text (versions, agent
// states, recent errors; no messages or secrets), the screen shows and copies it. Saving to a file is main's own
// (it builds the bundle again and asks where), so no text goes from the screen to a file.
import { copyToClipboard } from './terminalClipboard'
import { toast } from '../stores/toastStore'

export const hasDiagnostics = (): boolean => typeof window.electronAPI?.diagnosticsReport === 'function'

/** "최근 24시간 오류 없음" / "최근 24시간 오류 3건" */
export const errorsLabel = (count: number): string => (count > 0 ? `최근 24시간 오류 ${count.toLocaleString()}건` : '최근 24시간 오류 없음')

export async function readDiagnostics(): Promise<{ text: string; errors: number } | { error: string }> {
  const read = window.electronAPI?.diagnosticsReport
  if (typeof read !== 'function') return { error: '앱을 다시 시작한 뒤에 사용할 수 있습니다.' }
  try {
    const result = await read()
    return result?.success ? { text: result.text, errors: result.errors } : { error: result?.error || '진단 정보를 만들지 못했습니다.' }
  } catch {
    return { error: '진단 정보를 만들지 못했습니다.' }
  }
}

/** The command palette's 진단 정보 복사: builds the bundle now and puts it on the clipboard */
export async function copyDiagnostics(): Promise<boolean> {
  const report = await readDiagnostics()
  if ('error' in report) {
    toast.error('진단 정보를 복사하지 못했습니다', report.error)
    return false
  }
  return copyToClipboard(report.text)
}

/** 파일로 저장: main writes a fresh bundle where the user picks */
export async function saveDiagnostics(): Promise<void> {
  const save = window.electronAPI?.diagnosticsSave
  if (typeof save !== 'function') return
  try {
    const result = await save()
    if (result?.success) toast.success('진단 정보를 저장했습니다', result.path)
    else if (!(result && 'cancelled' in result && result.cancelled)) toast.error('진단 정보를 저장하지 못했습니다', result && 'error' in result ? result.error : undefined)
  } catch {
    toast.error('진단 정보를 저장하지 못했습니다')
  }
}

export async function openDiagnosticsLogs(): Promise<void> {
  const open = window.electronAPI?.diagnosticsOpenLogs
  if (typeof open !== 'function') return
  try {
    const result = await open()
    if (!result?.success) toast.error('로그 폴더를 열지 못했습니다')
  } catch {
    toast.error('로그 폴더를 열지 못했습니다')
  }
}
