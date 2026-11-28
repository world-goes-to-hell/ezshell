import { afterEach, describe, expect, it, vi } from 'vitest'

const copied: string[] = []
const toasts: string[] = []
vi.mock('./terminalClipboard', () => ({ copyToClipboard: async (text: string) => { copied.push(text); return true } }))
vi.mock('../stores/toastStore', () => ({
  toast: { success: (title: string) => toasts.push(`ok:${title}`), error: (title: string, message?: string) => toasts.push(`error:${title}:${message ?? ''}`) }
}))

const { copyDiagnostics, errorsLabel, hasDiagnostics, readDiagnostics, saveDiagnostics } = await import('./diagnostics')

const api = (methods: Record<string, unknown>) => vi.stubGlobal('window', { electronAPI: methods })

afterEach(() => {
  vi.unstubAllGlobals()
  copied.length = 0
  toasts.length = 0
})

describe('the diagnostics bundle on the screen', () => {
  it('counts the recent errors in words', () => {
    expect(errorsLabel(0)).toBe('최근 24시간 오류 없음')
    expect(errorsLabel(1234)).toBe('최근 24시간 오류 1,234건')
  })

  it('is offered only when main has it', () => {
    api({})
    expect(hasDiagnostics()).toBe(false)
    api({ diagnosticsReport: async () => ({ success: true, text: '', errors: 0 }) })
    expect(hasDiagnostics()).toBe(true)
  })

  it('copies the text main built, and says why when it could not', async () => {
    api({ diagnosticsReport: async () => ({ success: true, text: 'ezShell 2.41.1', errors: 2 }) })
    expect(await copyDiagnostics()).toBe(true)
    expect(copied).toEqual(['ezShell 2.41.1'])
    api({ diagnosticsReport: async () => { throw new Error('ipc') } })
    expect(await copyDiagnostics()).toBe(false)
    expect(toasts).toEqual(['error:진단 정보를 복사하지 못했습니다:진단 정보를 만들지 못했습니다.'])
    api({})
    expect(await readDiagnostics()).toEqual({ error: '앱을 다시 시작한 뒤에 사용할 수 있습니다.' })
  })

  it('lets main save the file, quietly when the user cancels', async () => {
    api({ diagnosticsSave: async () => ({ success: false, cancelled: true }) })
    await saveDiagnostics()
    expect(toasts).toEqual([])
    api({ diagnosticsSave: async () => ({ success: true, path: 'C:\\out\\ezshell-diagnostics.txt' }) })
    await saveDiagnostics()
    api({ diagnosticsSave: async () => ({ success: false, error: '쓰지 못했습니다' }) })
    await saveDiagnostics()
    expect(toasts).toEqual(['ok:진단 정보를 저장했습니다', 'error:진단 정보를 저장하지 못했습니다:쓰지 못했습니다'])
  })
})
