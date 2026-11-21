// Installing an update without losing track of the open tabs (docs/plan/2026-11-18-restore-tabs-after-update.md):
// first what the restart would cut off is checked, then the tabs are written down, then the update runs.

import { buildRestoreRecord, reopenable, type RecordSource } from './restoreTabs'
import { confirmDialog } from '../stores/confirmStore'
import { toast } from '../stores/toastStore'

// App knows the tabs, the popped-out ones included; the update notice does not
let sourceOf: (() => RecordSource) | null = null

export function setRestoreSource(read: () => RecordSource): () => void {
  sourceOf = read
  return () => { if (sourceOf === read) sourceOf = null }
}

export async function installUpdateKeepingTabs(): Promise<void> {
  const api = window.electronAPI
  const busy = await api.updateBusyWork?.().catch(() => null)
  if (busy && busy.unsavedEdits > 0) {
    // An edit window with unsaved text does not close on its own, so the restart would stop half way
    toast.warning('업데이트를 미뤘습니다', `저장하지 않은 파일이 ${busy.unsavedEdits}개 있습니다. 저장하거나 닫은 뒤에 다시 눌러 주세요.`)
    return
  }
  if (busy && busy.transfers > 0) {
    const goOn = await confirmDialog({
      title: '진행 중인 파일 전송',
      message: `파일 전송 ${busy.transfers}개가 아직 끝나지 않았습니다. 지금 업데이트하면 전송이 끊기고, 다시 시작되지 않습니다.`,
      confirmLabel: '끊고 업데이트',
      cancelLabel: '나중에',
      danger: true
    })
    if (!goOn) return
  }
  if (sourceOf && typeof api.restoreTabsSave === 'function') {
    const record = buildRestoreRecord(sourceOf())
    if (record.tabs.length > 0) {
      const saved = await api.restoreTabsSave(record).catch(() => ({ success: false, error: undefined as string | undefined }))
      if (!saved.success) {
        const goOn = await confirmDialog({
          title: '탭을 기억하지 못했습니다',
          message: `${saved.error ?? '열린 탭 정보를 저장하지 못했습니다.'} 업데이트 뒤에 탭을 다시 열 수 없습니다. 그래도 업데이트할까요?`,
          confirmLabel: '업데이트',
          cancelLabel: '나중에'
        })
        if (!goOn) return
      } else if (reopenable(record).length > 0) {
        toast.info('업데이트를 설치합니다', `열린 탭 ${reopenable(record).length}개를 기억했습니다. 다시 시작한 뒤 잠금을 풀면 다시 열 수 있습니다.`)
      }
    }
  }
  await api.installUpdate?.()
}
