import { describe, it, expect } from 'vitest'
import ipcModule from './ipc.js'

const { registerMcpIpc } = ipcModule

function fakeIpcMain() {
  const handlers = {}
  return { handlers, handle: (channel, fn) => { handlers[channel] = fn } }
}

const UNLOCKED = () => true
const status = { config: { enabled: false, port: 47521, alertLevel: 'danger', token: 't' }, running: false, error: null, registerCommand: 'x' }

describe('registerMcpIpc', () => {
  it('lists activity, or nothing without a controller', async () => {
    const ipcMain = fakeIpcMain()
    registerMcpIpc(ipcMain, () => ({ listActivity: () => [{ id: 'r1' }] }), UNLOCKED)
    expect(await ipcMain.handlers['mcp-list-activity']({})).toEqual({ success: true, items: [{ id: 'r1' }] })
    const none = fakeIpcMain()
    registerMcpIpc(none, () => null, UNLOCKED)
    expect(await none.handlers['mcp-list-activity']({})).toEqual({ success: false, items: [] })
  })

  it('cancels an activity by string id only', async () => {
    const ipcMain = fakeIpcMain()
    const cancelled = []
    registerMcpIpc(ipcMain, () => ({ cancelActivity: (id) => { cancelled.push(id); return true } }), UNLOCKED)
    expect(await ipcMain.handlers['mcp-cancel-activity']({}, { id: 'r1' })).toEqual({ success: true })
    expect(await ipcMain.handlers['mcp-cancel-activity']({}, { id: 5 })).toEqual({ success: false })
    expect(await ipcMain.handlers['mcp-cancel-activity']({}, undefined)).toEqual({ success: false })
    expect(cancelled).toEqual(['r1'])
  })

  it('returns the status', async () => {
    const ipcMain = fakeIpcMain()
    registerMcpIpc(ipcMain, () => ({ getStatus: () => status }), UNLOCKED)
    expect(await ipcMain.handlers['mcp-get-status']({})).toEqual({ success: true, status })
  })

  it('turns a rejected change into an error result', async () => {
    const ipcMain = fakeIpcMain()
    registerMcpIpc(ipcMain, () => ({ updateConfig: async () => { throw new Error('포트는 1024~65535 사이의 정수여야 합니다.') } }), UNLOCKED)
    expect(await ipcMain.handlers['mcp-update-config']({}, { port: 1 }))
      .toEqual({ success: false, error: '포트는 1024~65535 사이의 정수여야 합니다.' })
  })

  it('reports when the controller is not ready', async () => {
    const ipcMain = fakeIpcMain()
    registerMcpIpc(ipcMain, () => null, UNLOCKED)
    expect((await ipcMain.handlers['mcp-get-status']({})).success).toBe(false)
    expect(await ipcMain.handlers['mcp-respond-approval']({}, { id: 'a1', approved: true })).toEqual({ success: false })
  })

  it('only approves with a string id and approved === true', async () => {
    const ipcMain = fakeIpcMain()
    const answers = []
    registerMcpIpc(ipcMain, () => ({ respondApproval: (id, approved) => { answers.push([id, approved]); return true } }), UNLOCKED)
    await ipcMain.handlers['mcp-respond-approval']({}, { id: 'a1', approved: 'yes' })
    expect(await ipcMain.handlers['mcp-respond-approval']({}, { id: 5, approved: true })).toEqual({ success: false })
    expect(answers).toEqual([['a1', false]])
  })

  it('clamps the audit limit', async () => {
    const ipcMain = fakeIpcMain()
    const limits = []
    registerMcpIpc(ipcMain, () => ({ readAudit: (limit) => { limits.push(limit); return [] } }), UNLOCKED)
    await ipcMain.handlers['mcp-read-audit']({}, { limit: 100000 })
    await ipcMain.handlers['mcp-read-audit']({}, { limit: 'x' })
    expect(limits).toEqual([500, 200])
  })
})

describe('registerMcpIpc while the app is locked (final fix I4)', () => {
  const LOCKED = '앱 잠금을 해제하세요.'
  const secretStatus = { config: { enabled: true, port: 47521, alertLevel: 'danger', token: 'a'.repeat(64) }, running: true, error: null, registerCommand: `claude mcp add ... Bearer ${'a'.repeat(64)}` }

  function lockedIpc(controller) {
    const ipcMain = fakeIpcMain()
    let unlocked = false
    registerMcpIpc(ipcMain, () => controller, () => unlocked)
    return { ipcMain, unlock: () => { unlocked = true } }
  }

  it('shows the status without the token or the register command', async () => {
    const { ipcMain, unlock } = lockedIpc({ getStatus: () => secretStatus })
    const locked = await ipcMain.handlers['mcp-get-status']({})
    expect(locked).toEqual({ success: true, status: { ...secretStatus, config: { ...secretStatus.config, token: '' }, registerCommand: '' } })
    expect(JSON.stringify(locked)).not.toContain('a'.repeat(64))
    unlock()
    expect(await ipcMain.handlers['mcp-get-status']({})).toEqual({ success: true, status: secretStatus })
  })

  it('refuses to read the audit log or the activity list', async () => {
    const reads = []
    const { ipcMain } = lockedIpc({ readAudit: () => { reads.push('audit'); return [{ command: 'secret' }] }, listActivity: () => { reads.push('activity'); return [{ id: 'r1' }] } })
    expect(await ipcMain.handlers['mcp-read-audit']({}, { limit: 10 })).toEqual({ success: false, error: LOCKED, entries: [] })
    expect(await ipcMain.handlers['mcp-list-activity']({})).toEqual({ success: false, error: LOCKED, items: [] })
    expect(reads).toEqual([])
  })

  it('refuses to change settings or the token', async () => {
    const calls = []
    const { ipcMain } = lockedIpc({ updateConfig: async () => { calls.push('update') }, regenerateToken: async () => { calls.push('token') } })
    expect(await ipcMain.handlers['mcp-update-config']({}, { enabled: false })).toEqual({ success: false, error: LOCKED })
    expect(await ipcMain.handlers['mcp-regenerate-token']({})).toEqual({ success: false, error: LOCKED })
    expect(calls).toEqual([])
  })

  it('treats a missing lock check as locked', async () => {
    const ipcMain = fakeIpcMain()
    registerMcpIpc(ipcMain, () => ({ listActivity: () => [{ id: 'r1' }] }))
    expect((await ipcMain.handlers['mcp-list-activity']({})).success).toBe(false)
  })
})
