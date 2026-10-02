import { useSessionLogStore } from '../stores/sessionLogStore'
import { toast } from '../stores/toastStore'

const NEEDS_RESTART = '앱을 다시 시작한 뒤에 사용할 수 있습니다.'

/** Start logging the tab, or stop when it is already being logged. */
export async function toggleSessionLog(sessionId: string, name: string): Promise<void> {
  const api = window.electronAPI
  if (typeof api?.sessionLogStart !== 'function' || typeof api?.sessionLogStop !== 'function') {
    toast.error('로그를 저장할 수 없습니다', NEEDS_RESTART)
    return
  }
  const { files, setLogging, clearLogging } = useSessionLogStore.getState()
  const isLogging = sessionId in files
  try {
    if (isLogging) {
      const result = await api.sessionLogStop(sessionId)
      clearLogging(sessionId)
      if (result.success) toast.success('로그 저장을 마쳤습니다', result.filePath)
      else toast.error('로그를 끝까지 저장하지 못했습니다', result.error)
      return
    }
    const result = await api.sessionLogStart(sessionId, name)
    if (result.success && result.filePath) {
      setLogging(sessionId, result.filePath)
      toast.success('로그 저장을 시작했습니다', result.filePath)
    } else {
      toast.error('로그를 저장할 수 없습니다', result.error)
    }
  } catch {
    toast.error(isLogging ? '로그 저장을 중지하지 못했습니다' : '로그를 저장할 수 없습니다')
  }
}

export async function openSessionLogFolder(): Promise<void> {
  const open = window.electronAPI?.sessionLogOpenFolder
  if (typeof open !== 'function') {
    toast.error('로그 폴더를 열 수 없습니다', NEEDS_RESTART)
    return
  }
  try {
    const result = await open()
    if (!result.success) toast.error('로그 폴더를 열 수 없습니다', result.error)
  } catch {
    toast.error('로그 폴더를 열 수 없습니다')
  }
}
