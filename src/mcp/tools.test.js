import { describe, it, expect, vi } from 'vitest'
import toolsModule from './tools.js'
import activityModule from './activityLog.js'

const { createToolHandlers } = toolsModule
const { createActivityLog } = activityModule

const allowed = { id: 's1', name: '[개발] 바우처 WAS', folderId: 'f2', mcpEnabled: true, host: '10.0.0.1', username: 'deploy', password: 'pw' }
const hidden = { id: 's2', name: '[운영] DB', mcpEnabled: false, host: '10.0.0.2' }
const folders = [{ id: 'f1', name: '개발' }, { id: 'f2', name: '[개발] 소상공인 바우처', parentId: 'f1' }]
const okResult = { cwd: '/home/app', exitCode: 0, signal: null, stdout: 'ok\n', stderr: '', truncated: false, timedOut: false, cancelled: false }

function setup({ sessions = [allowed, hidden], alertLevel = 'danger', answer = 'approved', runResult = okResult, runError, auditFails = false, onApproval, approvalError, alertLevelError, foldersError, sessionsError, throwNull, activity, request, runImpl, knownCwd = '/home/app' } = {}) {
  const state = { unlocked: true, sessions }
  const auditEntries = []
  const approvalRequests = []
  const runs = []
  const handlers = createToolHandlers({
    isUnlocked: () => state.unlocked,
    getSessions: () => { if (sessionsError) throw sessionsError; return state.sessions },
    getFolders: () => { if (foldersError) throw foldersError; return folders },
    getAlertLevel: () => { if (alertLevelError) throw alertLevelError; return alertLevel },
    activity,
    approvals: {
      request: request || (async (details, options) => {
        approvalRequests.push({ details, options })
        if (approvalError !== undefined) throw approvalError
        if (onApproval) onApproval(state)
        return answer
      })
    },
    gateway: {
      getCwd: () => knownCwd,
      resolveCwd: async () => '/home/app',
      run: async (session, command, options) => {
        runs.push({ session, command, options })
        if (runImpl) return runImpl(options)
        if (throwNull) throw null
        if (runError) throw runError
        return runResult
      },
      changeDirectory: async (session, path) => ({ cwd: `/home/app/${path}` })
    },
    audit: {
      append: (entry) => {
        if (auditFails) throw new Error('disk full')
        auditEntries.push(entry)
      }
    },
    newRequestId: () => 'r1'
  })
  return { handlers, state, auditEntries, approvalRequests, runs }
}

const textOf = (result) => result.content[0].text

describe('listSessions', () => {
  it('lists only allowed sessions without connection details', () => {
    const { handlers } = setup()
    const result = handlers.listSessions()
    expect(JSON.parse(textOf(result))).toEqual([
      { id: 's1', name: '[개발] 바우처 WAS', folder: '개발 / [개발] 소상공인 바우처', server: '서버-1', cwd: '/home/app' }
    ])
    expect(textOf(result)).not.toContain('10.0.0.1')
    expect(textOf(result)).not.toContain('deploy')
  })

  it('explains how to allow sessions when none are allowed', () => {
    const { handlers } = setup({ sessions: [hidden] })
    expect(textOf(handlers.listSessions())).toContain('MCP 접근 허용')
  })

  it('refuses while the app is locked', () => {
    const { handlers, state } = setup()
    state.unlocked = false
    const result = handlers.listSessions()
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('잠겨')
  })
})

describe('runCommand', () => {
  it('runs a read command without asking', async () => {
    const { handlers, approvalRequests, runs, auditEntries } = setup()
    const result = await handlers.runCommand({ session: 's1', command: 'ls -al' })
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toContain('종료 코드: 0')
    expect(textOf(result)).toContain('ok')
    expect(approvalRequests).toHaveLength(0)
    expect(runs[0].command).toBe('ls -al')
    expect(auditEntries.map(entry => entry.phase)).toEqual(['start', 'end'])
    expect(auditEntries[1]).toMatchObject({ outcome: 'executed', exitCode: 0, level: 'low', sessionId: 's1' })
  })

  it('asks before a dangerous command and runs it when approved', async () => {
    const { handlers, approvalRequests, runs, auditEntries } = setup()
    await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(approvalRequests[0].details).toEqual({
      sessionName: '[개발] 바우처 WAS',
      folder: '개발 / [개발] 소상공인 바우처',
      cwd: '/home/app',
      command: 'rm app.log',
      level: 'danger',
      reasons: ['rm: 파일 삭제']
    })
    expect(runs).toHaveLength(1)
    expect(auditEntries[1].outcome).toBe('approved')
  })

  it.each([
    ['denied', '거부'],
    ['expired', '승인되지 않아'],
    ['cancelled', '취소']
  ])('does not run when the answer is %s', async (answer, message) => {
    const { handlers, runs, auditEntries } = setup({ answer })
    const result = await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(message)
    expect(runs).toHaveLength(0)
    expect(auditEntries[1].outcome).toBe(answer)
  })

  it('follows the alert level', async () => {
    const { handlers, approvalRequests } = setup({ alertLevel: 'all' })
    await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(approvalRequests).toHaveLength(1)
  })

  it('blocks forbidden commands without asking', async () => {
    const { handlers, approvalRequests, runs, auditEntries } = setup()
    const result = await handlers.runCommand({ session: 's1', command: 'rm -rf /' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('차단')
    expect(approvalRequests).toHaveLength(0)
    expect(runs).toHaveLength(0)
    expect(auditEntries).toEqual([expect.objectContaining({ phase: 'end', outcome: 'blocked' })])
  })

  it('refuses sessions that are not allowed', async () => {
    const { handlers, runs } = setup()
    const result = await handlers.runCommand({ session: 's2', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('허용되지 않은 세션')
    expect(runs).toHaveLength(0)
  })

  it('accepts the exact session name', async () => {
    const { handlers, runs } = setup()
    await handlers.runCommand({ session: '[개발] 바우처 WAS', command: 'ls' })
    expect(runs[0].session.id).toBe('s1')
  })

  it('refuses a name shared by several allowed sessions', async () => {
    const twin = { ...allowed, id: 's3' }
    const { handlers, runs } = setup({ sessions: [allowed, twin] })
    const result = await handlers.runCommand({ session: '[개발] 바우처 WAS', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('이름이 같은 세션')
    expect(runs).toHaveLength(0)
  })

  it('does not run when the audit log cannot be written', async () => {
    const { handlers, runs } = setup({ auditFails: true })
    const result = await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('감사 로그')
    expect(runs).toHaveLength(0)
  })

  it('does not run when the app locks during the approval', async () => {
    const { handlers, runs, auditEntries } = setup({ onApproval: (state) => { state.unlocked = false } })
    const result = await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(result.isError).toBe(true)
    expect(runs).toHaveLength(0)
    expect(auditEntries[1].outcome).toBe('cancelled')
  })

  it('does not run a request that was cancelled', async () => {
    const { handlers, runs, auditEntries } = setup()
    const controller = new AbortController()
    controller.abort()
    const result = await handlers.runCommand({ session: 's1', command: 'ls' }, { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(runs).toHaveLength(0)
    expect(auditEntries.map(entry => entry.phase)).toEqual(['start', 'end'])
    expect(auditEntries[1].outcome).toBe('cancelled')
  })

  it('passes a signal that follows the caller to the approval and the gateway', async () => {
    const { handlers, approvalRequests, runs } = setup()
    const controller = new AbortController()
    await handlers.runCommand({ session: 's1', command: 'rm app.log' }, { signal: controller.signal })
    expect(approvalRequests[0].options.signal.aborted).toBe(false)
    controller.abort()
    expect(approvalRequests[0].options.signal.aborted).toBe(true)
    expect(runs[0].options.signal.aborted).toBe(true)
  })

  it('reports gateway failures', async () => {
    const { handlers, auditEntries } = setup({ runError: Object.assign(new Error('auth'), { userMessage: '인증에 실패했습니다.' }) })
    const result = await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('인증에 실패했습니다.')
    expect(auditEntries[1]).toMatchObject({ outcome: 'failed', error: '인증에 실패했습니다.' })
  })

  it('notes truncated and timed out output', async () => {
    const { handlers } = setup({ runResult: { ...okResult, exitCode: null, truncated: true, timedOut: true, stderr: 'warn' } })
    const text = textOf(await handlers.runCommand({ session: 's1', command: 'ls' }))
    expect(text).toContain('시간 제한')
    expect(text).toContain('일부만')
    expect(text).toContain('--- stderr ---')
  })
})

describe('changeDirectory', () => {
  it('moves and reports the new directory', async () => {
    const { handlers, auditEntries } = setup()
    const result = await handlers.changeDirectory({ session: 's1', path: 'logs' })
    expect(textOf(result)).toContain('작업 디렉터리: /home/app/logs')
    expect(auditEntries[0].command).toBe("cd 'logs'")
  })

  it('asks before entering a secrets directory when the level is medium', async () => {
    const { handlers, approvalRequests } = setup({ alertLevel: 'medium' })
    await handlers.changeDirectory({ session: 's1', path: '~/.ssh' })
    expect(approvalRequests).toHaveLength(1)
  })
})

describe('result notes and privacy', () => {
  it('notes that a cancelled command may still be running', async () => {
    const { handlers, auditEntries } = setup({ runResult: { ...okResult, exitCode: null, cancelled: true } })
    const text = textOf(await handlers.runCommand({ session: 's1', command: 'ls' }))
    expect(text).toContain('요청이 취소되어 중단을 요청했습니다')
    expect(text).toContain('서버에서 아직 실행 중일 수 있습니다')
    expect(auditEntries[1]).toMatchObject({ cancelled: true })
  })

  it('says a timed out command may still be running', async () => {
    const { handlers } = setup({ runResult: { ...okResult, exitCode: null, timedOut: true } })
    const text = textOf(await handlers.runCommand({ session: 's1', command: 'ls' }))
    expect(text).toContain('서버에서 아직 실행 중일 수 있습니다')
  })

  it('never leaks the raw gateway error detail', async () => {
    const error = Object.assign(new Error('x'), { userMessage: '연결하지 못했습니다.', detail: 'connect ECONNREFUSED 10.0.0.1:22' })
    const { handlers, auditEntries } = setup({ runError: error })
    const result = await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(result.content[0].text).not.toContain('10.0.0.1')
    expect(result.content[0].text).not.toContain('ECONNREFUSED')
    expect(JSON.stringify(auditEntries)).not.toContain('10.0.0.1')
    expect(JSON.stringify(auditEntries)).not.toContain('ECONNREFUSED')
  })
})

describe('unexpected failures', () => {
  const phases = (entries) => entries.map(entry => entry.phase)

  it('turns a rejecting approval into a failed result with one end entry', async () => {
    const { handlers, auditEntries, runs } = setup({ approvalError: new Error('ipc gone') })
    const result = await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(result.isError).toBe(true)
    expect(phases(auditEntries)).toEqual(['start', 'end'])
    expect(auditEntries[1].outcome).toBe('failed')
    expect(runs).toHaveLength(0)
  })

  it('turns a throwing getAlertLevel into a failed result', async () => {
    const { handlers, auditEntries } = setup({ alertLevelError: new Error('config') })
    const result = await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(phases(auditEntries)).toEqual(['start', 'end'])
    expect(auditEntries[1].outcome).toBe('failed')
  })

  it('survives a gateway that throws null', async () => {
    const { handlers, auditEntries } = setup({ runError: null, throwNull: true })
    const result = await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(phases(auditEntries)).toEqual(['start', 'end'])
    expect(auditEntries[1].outcome).toBe('failed')
  })

  it('writes a single end entry when formatting throws', async () => {
    const { handlers, auditEntries } = setup({ runResult: { cwd: '/', exitCode: 0, get stdout() { throw new Error('boom') } } })
    const result = await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toContain('결과를 표시하지 못했습니다')
    expect(phases(auditEntries).filter(phase => phase === 'end')).toHaveLength(1)
  })

  it('returns an error result when listing sessions fails', () => {
    const { handlers } = setup({ foldersError: new Error('x') })
    expect(handlers.listSessions().isError).toBe(true)
  })
})

describe('session re-validation after approval', () => {
  it('does not run when MCP access is switched off during the approval', async () => {
    const { handlers, runs, auditEntries } = setup({ onApproval: (state) => { state.sessions = [{ ...allowed, mcpEnabled: false }] } })
    const result = await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('세션 설정이 바뀌어')
    expect(runs).toHaveLength(0)
    expect(auditEntries[1].outcome).toBe('cancelled')
  })

  it('does not run when the session is deleted during the approval', async () => {
    const { handlers, runs } = setup({ onApproval: (state) => { state.sessions = [] } })
    const result = await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(result.isError).toBe(true)
    expect(runs).toHaveLength(0)
  })

  it('runs against the fresh session object when it was edited', async () => {
    const edited = { ...allowed, host: '10.9.9.9' }
    const { handlers, runs } = setup({ onApproval: (state) => { state.sessions = [edited] } })
    await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(runs[0].session).toBe(edited)
  })
})

describe('lookup and input validation', () => {
  it.each([undefined, null, 5, '', '   '])('rejects the session reference %j', async (ref) => {
    const { handlers, runs } = setup()
    const result = await handlers.runCommand({ session: ref, command: 'ls' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('허용되지 않은 세션')
    expect(runs).toHaveLength(0)
  })

  it('refuses a reference that is one session id and another session name', async () => {
    const other = { ...allowed, id: 's9', name: 's1' }
    const { handlers, runs } = setup({ sessions: [allowed, other] })
    const result = await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('이름이 같은 세션')
    expect(runs).toHaveLength(0)
  })

  it.each([undefined, null, 42, '', '  \n'])('rejects the command %j without auditing', async (command) => {
    const { handlers, auditEntries, runs } = setup()
    const result = await handlers.runCommand({ session: 's1', command })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('명령이 비어 있습니다.')
    expect(auditEntries).toHaveLength(0)
    expect(runs).toHaveLength(0)
  })

  it.each([undefined, null, 42, '', '   '])('rejects the path %j without auditing', async (path) => {
    const { handlers, auditEntries } = setup()
    const result = await handlers.changeDirectory({ session: 's1', path })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('경로가 비어 있습니다.')
    expect(auditEntries).toHaveLength(0)
  })

  it('reports unreadable session data without running, asking or auditing', async () => {
    const { handlers, auditEntries, approvalRequests, runs } = setup({ sessionsError: new Error('sessions.json corrupt') })
    const result = await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('세션 정보를 읽지 못했습니다.')
    expect(auditEntries).toHaveLength(0)
    expect(approvalRequests).toHaveLength(0)
    expect(runs).toHaveLength(0)
  })

  it('shows a home-relative cd the way the gateway runs it', async () => {
    const { handlers, auditEntries, approvalRequests } = setup({ alertLevel: 'medium' })
    await handlers.changeDirectory({ session: 's1', path: '~/.ssh' })
    expect(auditEntries[0].command).toBe("cd ~/'.ssh'")
    expect(approvalRequests).toHaveLength(1)
    expect(approvalRequests[0].details.command).toBe("cd ~/'.ssh'")
  })
})

describe('activity log', () => {
  function recorded() {
    const seen = []
    const activity = createActivityLog({ emit: (item) => seen.push(item.state) })
    return { activity, seen }
  }

  it('records a read command as running then done, keyed by the audit request id', async () => {
    const { activity, seen } = recorded()
    const { handlers, auditEntries } = setup({ activity })
    await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(seen).toEqual(['running', 'done'])
    const [item] = activity.list()
    expect(item.id).toBe(auditEntries[0].requestId)
    expect(item).toMatchObject({ sessionId: 's1', command: 'ls', level: 'low', exitCode: 0 })
    expect(item.output).toContain('종료 코드: 0')
    expect(item.finishedAt).not.toBeNull()
  })

  it('collects live output on the activity item and keeps it out of the audit log', async () => {
    const activity = createActivityLog()
    const runImpl = async (options) => {
      options.onOutput('stdout', 'LIVE-OUT\n')
      options.onOutput('stderr', 'LIVE-ERR\n')
      return okResult
    }
    const { handlers, auditEntries } = setup({ activity, runImpl })
    await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(activity.list()[0].outputParts).toEqual([{ stream: 'stdout', text: 'LIVE-OUT\n' }, { stream: 'stderr', text: 'LIVE-ERR\n' }])
    expect(JSON.stringify(auditEntries)).not.toContain('LIVE-')
  })

  it('shows the directory a request starts in, and fills it in after a run when it was not known yet', async () => {
    const known = createActivityLog()
    await setup({ activity: known }).handlers.runCommand({ session: 's1', command: 'ls' })
    expect(known.list()[0].cwd).toBe('/home/app')

    const seen = []
    const unknown = createActivityLog({ emit: (item) => seen.push(item.cwd) })
    const { handlers, auditEntries } = setup({ activity: unknown, knownCwd: null, runResult: { ...okResult, cwd: '/srv/app' } })
    await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(seen).toEqual([null, '/srv/app'])
    expect(auditEntries.every(entry => !('cwd' in entry))).toBe(true)
  })

  it('does not show the new directory as the place a cd ran in', async () => {
    const activity = createActivityLog()
    await setup({ activity, knownCwd: null }).handlers.changeDirectory({ session: 's1', path: 'logs' })
    expect(activity.list()[0].cwd).toBeNull()
  })

  it('records an approved dangerous command as waiting, running, done', async () => {
    const { activity, seen } = recorded()
    const { handlers } = setup({ activity })
    await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(seen).toEqual(['waiting', 'running', 'done'])
  })

  it.each([['denied'], ['expired'], ['cancelled']])('ends as %s', async (answer) => {
    const activity = createActivityLog()
    const { handlers } = setup({ activity, answer })
    const result = await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(activity.list()[0].state).toBe(answer)
    expect(activity.list()[0].output).toBe(textOf(result))
  })

  it('records a blocked command as finished from the start', async () => {
    const { activity, seen } = recorded()
    const { handlers } = setup({ activity })
    const result = await handlers.runCommand({ session: 's1', command: 'rm -rf /' })
    expect(seen).toEqual(['blocked'])
    expect(activity.list()[0].finishedAt).not.toBeNull()
    expect(activity.list()[0].output).toBe(textOf(result))
  })

  it('records a gateway failure with the user message only', async () => {
    const activity = createActivityLog()
    const error = Object.assign(new Error('boom'), { userMessage: '연결이 끊어졌습니다.', detail: 'SECRET-DETAIL-10.0.0.1' })
    const { handlers } = setup({ activity, runError: error })
    await handlers.runCommand({ session: 's1', command: 'ls' })
    const [item] = activity.list()
    expect(item.state).toBe('failed')
    expect(item.error).toBe('연결이 끊어졌습니다.')
    expect(JSON.stringify(item)).not.toContain('SECRET-DETAIL')
  })

  it('maps timed out and cancelled results', async () => {
    const timed = createActivityLog()
    await setup({ activity: timed, runResult: { ...okResult, timedOut: true } }).handlers.runCommand({ session: 's1', command: 'ls' })
    expect(timed.list()[0]).toMatchObject({ state: 'timeout', timedOut: true })
    const cancelled = createActivityLog()
    await setup({ activity: cancelled, runResult: { ...okResult, cancelled: true } }).handlers.runCommand({ session: 's1', command: 'ls' })
    expect(cancelled.list()[0].state).toBe('cancelled')
  })

  it('stops a request that is waiting for approval', async () => {
    const activity = createActivityLog()
    let waiting
    const request = (details, options) => new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
      waiting = true
    })
    const { handlers, runs } = setup({ activity, request })
    const pending = handlers.runCommand({ session: 's1', command: 'rm app.log' })
    await vi.waitFor(() => expect(activity.list()[0]?.state).toBe('waiting'))
    expect(waiting).toBe(true)
    expect(activity.cancel(activity.list()[0].id)).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(runs).toHaveLength(0)
    expect(activity.list()[0].state).toBe('cancelled')
  })

  it('stops a running request through the signal given to the gateway', async () => {
    const activity = createActivityLog()
    const runImpl = (options) => new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve({ ...okResult, cancelled: true }), { once: true })
    })
    const { handlers, runs } = setup({ activity, runImpl })
    const pending = handlers.runCommand({ session: 's1', command: 'sleep 5' })
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0].options.signal.aborted).toBe(false)
    expect(activity.cancel(activity.list()[0].id)).toBe(true)
    expect(runs[0].options.signal.aborted).toBe(true)
    await pending
    expect(activity.list()[0].state).toBe('cancelled')
  })

  it('still reports an executed command when formatting the result fails', async () => {
    const activity = createActivityLog()
    const hostile = { ...okResult, get stdout() { throw new Error('format boom') } }
    const { handlers, auditEntries } = setup({ activity, runResult: hostile })
    const result = await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(textOf(result)).toBe('명령은 실행되었지만 결과를 표시하지 못했습니다. (종료 코드: 0)')
    expect(auditEntries[1]).toMatchObject({ outcome: 'executed', exitCode: 0 })
    expect(activity.list()[0]).toMatchObject({ state: 'done', exitCode: 0 })
  })

  it('does not let a throwing activity log affect the command or the audit log', async () => {
    const broken = { begin() { throw new Error('x') }, update() { throw new Error('x') }, cancel() { return false } }
    const { handlers, auditEntries } = setup({ activity: broken })
    const result = await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(result.isError).toBeUndefined()
    expect(auditEntries.map(entry => entry.phase)).toEqual(['start', 'end'])
  })
})
