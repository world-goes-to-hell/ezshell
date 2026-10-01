import { describe, it, expect } from 'vitest'
import toolsModule from './tools.js'

const { createToolHandlers } = toolsModule

const named = { id: 's1', name: '[개발] 바우처 WAS', mcpEnabled: true, host: '10.0.0.1', username: 'deploy' }
const unnamed = { id: 'abcdef12-3456-7890', name: 'deploy@10.0.0.5', mcpEnabled: true, host: '10.0.0.5', username: 'deploy' }
const okResult = { cwd: '/srv/app', exitCode: 0, signal: null, stdout: 'ok\n', stderr: '', truncated: false, timedOut: false, cancelled: false }

/** Tool handlers over a recording fake gateway; `order` shows what happened in which sequence. */
function setup({ sessions = [named], alertLevel = 'danger', cwd = '/home/app', resolvedCwd = '/srv/app', resolveError, onResolve, answer = 'approved' } = {}) {
  const state = { unlocked: true, sessions }
  const order = []
  const auditEntries = []
  const approvalRequests = []
  const resolves = []
  const runs = []
  const cds = []
  const handlers = createToolHandlers({
    isUnlocked: () => state.unlocked,
    getSessions: () => state.sessions,
    getFolders: () => [],
    getAlertLevel: () => alertLevel,
    approvals: {
      request: async (details) => {
        order.push('approval')
        approvalRequests.push(details)
        return answer
      }
    },
    gateway: {
      getCwd: () => cwd,
      resolveCwd: async (session, options) => {
        order.push('resolve')
        resolves.push({ session, options })
        if (onResolve) onResolve(state)
        if (resolveError) throw resolveError
        return resolvedCwd
      },
      run: async (session, command, options) => {
        order.push('run')
        runs.push({ session, command, options })
        return okResult
      },
      changeDirectory: async (session, path, options) => {
        order.push('cd')
        cds.push({ session, path, options })
        return { cwd: `/srv/${path}` }
      }
    },
    audit: { append: (entry) => auditEntries.push(entry) },
    newRequestId: () => 'r1'
  })
  return { handlers, state, order, auditEntries, approvalRequests, resolves, runs, cds }
}

const textOf = (result) => result.content[0].text

describe('C2: approval is bound to a known working directory', () => {
  it('resolves an unknown directory before asking, shows it, and binds the run to it', async () => {
    const { handlers, order, approvalRequests, runs, resolves } = setup({ cwd: null })
    await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(order).toEqual(['resolve', 'approval', 'run'])
    expect(resolves[0].options.signal).toBeDefined()
    expect(approvalRequests[0].cwd).toBe('/srv/app')
    expect(runs[0].options.expectedCwd).toBe('/srv/app')
  })

  it('uses a known directory without resolving it again', async () => {
    const { handlers, order, approvalRequests, runs } = setup()
    await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(order).toEqual(['approval', 'run'])
    expect(approvalRequests[0].cwd).toBe('/home/app')
    expect(runs[0].options.expectedCwd).toBe('/home/app')
  })

  it('does not resolve or bind a command that needs no approval', async () => {
    const { handlers, order, runs } = setup({ cwd: null })
    await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(order).toEqual(['run'])
    expect(runs[0].options.expectedCwd).toBeUndefined()
  })

  it('fails without asking when the directory cannot be resolved, and never leaks the detail', async () => {
    const resolveError = Object.assign(new Error('x'), { userMessage: '홈 디렉터리를 확인하지 못했습니다.', detail: 'SECRET 10.0.0.1' })
    const { handlers, approvalRequests, runs, auditEntries } = setup({ cwd: null, resolveError })
    const result = await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('실행하지 못했습니다: 홈 디렉터리를 확인하지 못했습니다.')
    expect(approvalRequests).toHaveLength(0)
    expect(runs).toHaveLength(0)
    expect(auditEntries.map(entry => [entry.phase, entry.outcome])).toEqual([['start', undefined], ['end', 'failed']])
    expect(JSON.stringify(auditEntries)).not.toContain('SECRET')
  })

  it('does not ask when the app locks while the directory is being resolved', async () => {
    const { handlers, approvalRequests, runs, auditEntries } = setup({ cwd: null, onResolve: (state) => { state.unlocked = false } })
    const result = await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(result.isError).toBe(true)
    expect(approvalRequests).toHaveLength(0)
    expect(runs).toHaveLength(0)
    expect(auditEntries.map(entry => entry.outcome).filter(Boolean)).toEqual(['cancelled'])
  })

  it('binds an approved change_directory to the directory it showed', async () => {
    const { handlers, cds, approvalRequests } = setup({ alertLevel: 'medium', cwd: null })
    await handlers.changeDirectory({ session: 's1', path: '~/.ssh' })
    expect(approvalRequests[0].cwd).toBe('/srv/app')
    expect(cds[0].options.expectedCwd).toBe('/srv/app')
  })

  it('does not bind a change_directory that needed no approval', async () => {
    const { handlers, cds } = setup()
    await handlers.changeDirectory({ session: 's1', path: 'logs' })
    expect(cds[0].options.expectedCwd).toBeUndefined()
  })
})

describe('I5: unnamed sessions do not reveal host or user to Claude', () => {
  const listed = (handlers) => JSON.parse(textOf(handlers.listSessions()))

  it('lists an unnamed session under a neutral name', () => {
    const { handlers } = setup({ sessions: [named, unnamed] })
    const text = textOf(handlers.listSessions())
    expect(listed(handlers).map(entry => entry.name)).toEqual(['[개발] 바우처 WAS', '세션-abcdef12'])
    expect(text).not.toContain('10.0.0.5')
    expect(text).not.toContain('deploy')
  })

  it.each([
    ['a blank name', { name: '   ' }],
    ['no name', { name: undefined }],
    ['a name that contains the host', { name: 'prod (10.0.0.5)' }]
  ])('hides %s', (label, change) => {
    const { handlers } = setup({ sessions: [{ ...unnamed, ...change }] })
    expect(listed(handlers)[0].name).toBe('세션-abcdef12')
  })

  it('keeps a real name, also when the host is empty', () => {
    const { handlers } = setup({ sessions: [{ ...named, host: '' }] })
    expect(listed(handlers)[0].name).toBe('[개발] 바우처 WAS')
  })

  it('uses the neutral name in results but the real name in the dialog and the audit log', async () => {
    const { handlers, approvalRequests, auditEntries } = setup({ sessions: [unnamed] })
    const result = await handlers.runCommand({ session: '세션-abcdef12', command: 'rm app.log' })
    expect(textOf(result)).toContain('세션: 세션-abcdef12')
    expect(textOf(result)).not.toContain('10.0.0.5')
    expect(approvalRequests[0].sessionName).toBe('deploy@10.0.0.5')
    expect(auditEntries[0].sessionName).toBe('deploy@10.0.0.5')
  })

  it('uses the neutral name in the change_directory result', async () => {
    const { handlers } = setup({ sessions: [unnamed] })
    const result = await handlers.changeDirectory({ session: 'abcdef12-3456-7890', path: 'logs' })
    expect(textOf(result)).toBe('세션: 세션-abcdef12\n작업 디렉터리: /srv/logs')
  })

  it('still accepts the real name', async () => {
    const { handlers, runs } = setup({ sessions: [unnamed] })
    await handlers.runCommand({ session: 'deploy@10.0.0.5', command: 'ls' })
    expect(runs[0].session.id).toBe('abcdef12-3456-7890')
  })

  it('refuses a neutral name that two sessions share', async () => {
    const lookalike = { ...named, id: 's7', name: '세션-abcdef12' }
    const { handlers, runs } = setup({ sessions: [unnamed, lookalike] })
    const result = await handlers.runCommand({ session: '세션-abcdef12', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('이름이 같은 세션이 2개')
    expect(runs).toHaveLength(0)
  })
})
