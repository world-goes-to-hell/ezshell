import { describe, it, expect, vi } from 'vitest'
import toolsModule from './tools.js'
import jobStoreModule from './jobStore.js'
import activityModule from './activityLog.js'

const { createToolHandlers } = toolsModule
const { createJobStore } = jobStoreModule
const { createActivityLog } = activityModule

const allowed = { id: 's1', name: '[개발] 바우처 WAS', folderId: 'f1', mcpEnabled: true, host: '10.0.0.1', username: 'deploy', password: 'pw' }
const other = { id: 's2', name: '[개발] 배치', mcpEnabled: true, host: '10.0.0.3', username: 'batch' }
const hidden = { id: 's3', name: '[운영] DB', mcpEnabled: false, host: '10.0.0.2' }
const folders = [{ id: 'f1', name: '개발' }]
const ended = (fields = {}) => ({ exitCode: 0, signal: null, timedOut: false, cancelled: false, dropped: false, overflow: false, unconfirmed: false, ...fields })

/**
 * Handlers on a real job store and a gateway whose jobs the test controls:
 * `started[i]` is `{ session, command, options, stop (spy), end(result) }`.
 */
function setup({ alertLevel = 'danger', answer = 'approved', startError, holdStart = false, storeOptions = {}, withActivity = false } = {}) {
  const state = { unlocked: true, sessions: [allowed, other, hidden] }
  const auditEntries = []
  const approvalRequests = []
  const started = []
  const pendingStarts = []
  let counter = 0
  const jobs = createJobStore({ newId: () => `job-${++counter}`, ...storeOptions })
  const activity = withActivity ? createActivityLog() : undefined
  const handlers = createToolHandlers({
    isUnlocked: () => state.unlocked,
    getSessions: () => state.sessions,
    getFolders: () => folders,
    getAlertLevel: () => alertLevel,
    jobs,
    activity,
    approvals: {
      request: async (details, options) => {
        approvalRequests.push({ details, options })
        return answer
      }
    },
    gateway: {
      getCwd: () => '/home/app',
      resolveCwd: async () => '/home/app',
      run: async () => { throw new Error('a background request must not use run()') },
      startJob: (session, command, options) => {
        if (startError) return Promise.reject(startError)
        let end = () => {}
        const done = new Promise((resolve) => { end = resolve })
        const entry = { session, command, options, stop: vi.fn(), end }
        const handle = { cwd: '/home/app', stop: entry.stop, done }
        started.push(entry)
        if (!holdStart) return Promise.resolve(handle)
        return new Promise((resolve) => pendingStarts.push(() => resolve(handle)))
      }
    },
    audit: { append: (entry) => auditEntries.push(entry) },
    newRequestId: () => 'r1'
  })
  return { handlers, state, jobs, activity, auditEntries, approvalRequests, started, pendingStarts }
}

const textOf = (result) => result.content[0].text
const flush = () => new Promise(resolve => setImmediate(resolve))

describe('runCommand in the background', () => {
  it('starts a job and answers with its id right away', async () => {
    const { handlers, jobs, started, auditEntries, approvalRequests } = setup()
    const result = await handlers.runCommand({ session: 's1', command: 'tail -f app.log', background: true })
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toContain('작업 ID: job-1')
    expect(textOf(result)).toContain('제한 시간: 10분')
    expect(textOf(result)).toContain('위치: /home/app')
    // Asked even though the alert level ('danger') would let a command of this level run
    expect(approvalRequests).toHaveLength(1)
    expect(approvalRequests[0].details).toMatchObject({ command: 'tail -f app.log', level: 'medium', background: { limitMinutes: 10 } })
    expect(started[0]).toMatchObject({ command: 'tail -f app.log', options: { limitMs: 10 * 60 * 1000 } })
    expect(jobs.list()).toMatchObject([{ id: 'job-1', sessionId: 's1', sessionName: '[개발] 바우처 WAS', state: 'running', cwd: '/home/app' }])
    expect(auditEntries).toEqual([expect.objectContaining({ phase: 'start', background: true, limitMinutes: 10, command: 'tail -f app.log' })])
  })

  it('writes the end of the request when the job ends', async () => {
    const { handlers, jobs, started, auditEntries } = setup()
    await handlers.runCommand({ session: 's1', command: 'ls -R', background: true })
    started[0].end(ended({ exitCode: 2 }))
    await flush()
    expect(auditEntries[1]).toMatchObject({ phase: 'end', outcome: 'approved', exitCode: 2, timedOut: false, cancelled: false })
    expect(jobs.get('job-1')).toMatchObject({ state: 'done', exitCode: 2 })
  })

  it.each([
    [{ cancelled: true, exitCode: null, signal: 'KILL' }, 'stopped', { outcome: 'approved', cancelled: true }],
    [{ timedOut: true, exitCode: null, signal: 'KILL' }, 'timeout', { outcome: 'approved', timedOut: true }],
    [{ overflow: true, exitCode: null }, 'overflow', { outcome: 'approved', cancelled: true, truncated: true }],
    [{ dropped: true, exitCode: null }, 'failed', { outcome: 'failed' }]
  ])('records how the job ended: %j', async (result, state, logged) => {
    const { handlers, jobs, started, auditEntries } = setup()
    await handlers.runCommand({ session: 's1', command: 'ls -R', background: true })
    started[0].end(ended(result))
    await flush()
    expect(jobs.get('job-1').state).toBe(state)
    expect(auditEntries[1]).toMatchObject({ phase: 'end', ...logged })
  })

  it('takes the time limit in minutes', async () => {
    const { handlers, started } = setup()
    const result = await handlers.runCommand({ session: 's1', command: 'ls -R', background: true, timeout_minutes: 45 })
    expect(textOf(result)).toContain('제한 시간: 45분')
    expect(started[0].options.limitMs).toBe(45 * 60 * 1000)
  })

  it.each([[0], [61], [1.5], ['10'], [null]])('refuses the time limit %j', async (minutes) => {
    const { handlers, started, auditEntries } = setup()
    const result = await handlers.runCommand({ session: 's1', command: 'ls -R', background: true, timeout_minutes: minutes })
    expect(result.isError).toBe(true)
    expect(started).toHaveLength(0)
    expect(auditEntries).toHaveLength(0)
  })

  it('refuses a time limit on a command that is not a background job', async () => {
    const { handlers, started } = setup()
    const result = await handlers.runCommand({ session: 's1', command: 'ls', timeout_minutes: 5 })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('background')
    expect(started).toHaveLength(0)
  })

  it('asks before a dangerous command and tells the user it runs in the background', async () => {
    const { handlers, approvalRequests, started, auditEntries } = setup()
    await handlers.runCommand({ session: 's1', command: 'rm -r build', background: true, timeout_minutes: 20 })
    expect(approvalRequests[0].details).toMatchObject({ command: 'rm -r build', level: 'danger', cwd: '/home/app', background: { limitMinutes: 20 } })
    expect(started[0].options.expectedCwd).toBe('/home/app')
    started[0].end(ended())
    await flush()
    expect(auditEntries[1].outcome).toBe('approved')
  })

  it.each([['denied'], ['expired'], ['cancelled']])('starts nothing when the answer is %s', async (answer) => {
    const { handlers, jobs, started, auditEntries } = setup({ answer })
    const result = await handlers.runCommand({ session: 's1', command: 'rm -r build', background: true })
    expect(result.isError).toBe(true)
    expect(started).toHaveLength(0)
    expect(jobs.list()).toEqual([])
    expect(auditEntries[1].outcome).toBe(answer)
  })

  it('blocks forbidden commands in the background too', async () => {
    const { handlers, jobs, started, approvalRequests } = setup()
    const result = await handlers.runCommand({ session: 's1', command: 'rm -rf /', background: true })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('차단')
    expect(approvalRequests).toHaveLength(0)
    expect(started).toHaveLength(0)
    expect(jobs.list()).toEqual([])
  })

  it('refuses while the app is locked and for a session that is not allowed', async () => {
    const { handlers, state, started } = setup()
    expect((await handlers.runCommand({ session: 's3', command: 'ls', background: true })).isError).toBe(true)
    state.unlocked = false
    expect(textOf(await handlers.runCommand({ session: 's1', command: 'ls', background: true }))).toContain('잠겨')
    expect(started).toHaveLength(0)
  })

  it('refuses more jobs than the limit without asking the user', async () => {
    const { handlers, started, approvalRequests, auditEntries } = setup({ storeOptions: { perSession: 1 } })
    await handlers.runCommand({ session: 's1', command: 'ls -R', background: true })
    const result = await handlers.runCommand({ session: 's1', command: 'rm -r build', background: true })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('stop_job')
    expect(approvalRequests).toHaveLength(1)
    expect(started).toHaveLength(1)
    expect(auditEntries.filter(entry => entry.phase === 'start')).toHaveLength(1)
  })

  it('keeps what the job prints for job_output and shows it in the activity view', async () => {
    const { handlers, started, activity } = setup({ withActivity: true })
    await handlers.runCommand({ session: 's1', command: 'ls -R', background: true })
    started[0].options.onOutput('stdout', 'line 1\n')
    started[0].options.onOutput('stderr', 'warn\n')
    expect(textOf(await handlers.jobOutput({ job: 'job-1', wait_seconds: 0 }))).toContain('line 1\nwarn\n')
    expect(activity.list()[0]).toMatchObject({ state: 'running', background: true, jobId: 'job-1', outputParts: [{ stream: 'stdout', text: 'line 1\n' }, { stream: 'stderr', text: 'warn\n' }] })
    started[0].end(ended())
    await flush()
    expect(activity.list()[0]).toMatchObject({ state: 'done', exitCode: 0 })
  })

  it('the stop button of the activity view stops the job', async () => {
    const { handlers, started, activity } = setup({ withActivity: true })
    await handlers.runCommand({ session: 's1', command: 'ls -R', background: true })
    expect(activity.cancel('r1')).toBe(true)
    expect(started[0].stop).toHaveBeenCalledTimes(1)
  })

  it('the request ending or being aborted afterwards does not stop the job', async () => {
    const { handlers, started } = setup()
    const controller = new AbortController()
    await handlers.runCommand({ session: 's1', command: 'ls -R', background: true }, { signal: controller.signal })
    controller.abort()
    expect(started[0].stop).not.toHaveBeenCalled()
  })

  it('forgets the job and ends the request when it cannot start', async () => {
    const { handlers, jobs, auditEntries } = setup({ startError: Object.assign(new Error('x'), { userMessage: '명령을 실행할 채널을 열지 못했습니다.' }) })
    const result = await handlers.runCommand({ session: 's1', command: 'ls -R', background: true })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('채널을 열지 못했습니다')
    expect(jobs.list()).toEqual([])
    expect(auditEntries[1]).toMatchObject({ phase: 'end', outcome: 'failed' })
  })

  it('stops a job whose channel opens after the app locked', async () => {
    const { handlers, jobs, started, pendingStarts } = setup({ holdStart: true })
    const pending = handlers.runCommand({ session: 's1', command: 'ls -R', background: true })
    await vi.waitFor(() => expect(pendingStarts).toHaveLength(1))
    jobs.clear()
    pendingStarts[0]()
    await pending
    expect(started[0].stop).toHaveBeenCalledTimes(1)
    expect(jobs.list()).toEqual([])
  })

  it('never shows the host or the account', async () => {
    const { handlers } = setup()
    const texts = [
      textOf(await handlers.runCommand({ session: 's1', command: 'ls -R', background: true })),
      textOf(await handlers.jobOutput({ job: 'job-1', wait_seconds: 0 })),
      textOf(handlers.listJobs()),
      textOf(await handlers.stopJob({ job: 'job-1' }, { waitMs: 0 }))
    ]
    for (const text of texts) {
      expect(text).not.toContain('10.0.0.1')
      expect(text).not.toContain('deploy')
    }
  })
})

describe('jobOutput', () => {
  it('tells the state, the exit code and the new output', async () => {
    const { handlers, started } = setup()
    await handlers.runCommand({ session: 's1', command: 'make', background: true })
    started[0].options.onOutput('stdout', 'building\n')
    const running = textOf(await handlers.jobOutput({ job: 'job-1', wait_seconds: 0 }))
    expect(running).toContain('상태: 실행 중')
    expect(running).toContain('building\n')
    started[0].options.onOutput('stdout', 'done\n')
    started[0].end(ended({ exitCode: 0 }))
    await flush()
    const finished = textOf(await handlers.jobOutput({ job: 'job-1', wait_seconds: 0 }))
    expect(finished).toContain('상태: 완료')
    expect(finished).toContain('종료 코드: 0')
    expect(finished).toContain('done\n')
    expect(finished).not.toContain('building')
  })

  it('waits for the job to end, up to the given time', async () => {
    const { handlers, started } = setup()
    await handlers.runCommand({ session: 's1', command: 'make', background: true })
    const pending = handlers.jobOutput({ job: 'job-1', wait_seconds: 20 })
    started[0].options.onOutput('stdout', 'late\n')
    started[0].end(ended({ exitCode: 0 }))
    const text = textOf(await pending)
    expect(text).toContain('late\n')
    expect(text).toContain('상태: 완료')
  })

  it('answers with what is there when the wait time is over', async () => {
    const { handlers, started } = setup()
    await handlers.runCommand({ session: 's1', command: 'make', background: true })
    const pending = handlers.jobOutput({ job: 'job-1', wait_seconds: 0.05 })
    started[0].options.onOutput('stdout', 'so far\n')
    const text = textOf(await pending)
    expect(text).toContain('so far\n')
    expect(text).toContain('상태: 실행 중')
  })

  it('warns that a job on a dropped connection may still be running', async () => {
    const { handlers, started } = setup()
    await handlers.runCommand({ session: 's1', command: 'make', background: true })
    started[0].end(ended({ dropped: true, exitCode: null }))
    await flush()
    expect(textOf(await handlers.jobOutput({ job: 'job-1', wait_seconds: 0 }))).toContain('계속 실행 중일 수 있습니다')
  })

  it('does not start a low-risk job the user denied', async () => {
    const { handlers, started } = setup({ answer: 'denied' })
    const result = await handlers.runCommand({ session: 's1', command: 'tail -f app.log', background: true })
    expect(result.isError).toBe(true)
    expect(started).toHaveLength(0)
  })

  it('warns when the stop of a job could not be confirmed', async () => {
    const { handlers, started } = setup()
    await handlers.runCommand({ session: 's1', command: 'make', background: true })
    started[0].end(ended({ cancelled: true, exitCode: null, unconfirmed: true }))
    await flush()
    const text = textOf(await handlers.jobOutput({ job: 'job-1', wait_seconds: 0 }))
    expect(text).toContain('상태: 중지됨')
    expect(text).toContain('계속 실행 중일 수 있습니다')
  })

  it('refuses while the app is locked', async () => {
    const { handlers, state } = setup()
    await handlers.runCommand({ session: 's1', command: 'make', background: true })
    state.unlocked = false
    const result = await handlers.jobOutput({ job: 'job-1', wait_seconds: 0 })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('잠겨')
  })

  it('gives nothing when the app locks while it waits', async () => {
    const { handlers, state, jobs, started } = setup()
    await handlers.runCommand({ session: 's1', command: 'cat secrets', background: true })
    const pending = handlers.jobOutput({ job: 'job-1', wait_seconds: 20 })
    started[0].options.onOutput('stdout', 'TOKEN=abc\n')
    state.unlocked = false
    jobs.clear()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain('TOKEN')
  })

  it('does not know a job that does not exist', async () => {
    const { handlers } = setup()
    const result = await handlers.jobOutput({ job: 'job-9', wait_seconds: 0 })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('찾을 수 없습니다')
  })

  it('hides and stops the job of a session that is no longer allowed', async () => {
    const { handlers, state, started } = setup()
    await handlers.runCommand({ session: 's1', command: 'make', background: true })
    started[0].options.onOutput('stdout', 'secret\n')
    state.sessions = [{ ...allowed, mcpEnabled: false }, other]
    const result = await handlers.jobOutput({ job: 'job-1', wait_seconds: 0 })
    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain('secret')
    expect(started[0].stop).toHaveBeenCalledTimes(1)
  })

  it('gives nothing when the session stops being allowed while it waits', async () => {
    const { handlers, state, started } = setup()
    await handlers.runCommand({ session: 's1', command: 'make', background: true })
    const pending = handlers.jobOutput({ job: 'job-1', wait_seconds: 20 })
    state.sessions = [other]
    started[0].options.onOutput('stdout', 'secret\n')
    started[0].end(ended({ exitCode: 0 }))
    const result = await pending
    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain('secret')
  })
})

describe('stopJob', () => {
  it('stops the job and tells how it ended', async () => {
    const { handlers, started } = setup()
    await handlers.runCommand({ session: 's1', command: 'make', background: true })
    started[0].stop.mockImplementation(() => started[0].end(ended({ cancelled: true, exitCode: null, signal: 'KILL' })))
    const result = await handlers.stopJob({ job: 'job-1' })
    expect(started[0].stop).toHaveBeenCalledTimes(1)
    expect(textOf(result)).toContain('상태: 중지됨')
  })

  it('says so when the job has not ended yet', async () => {
    const { handlers } = setup()
    await handlers.runCommand({ session: 's1', command: 'make', background: true })
    const result = await handlers.stopJob({ job: 'job-1' }, { waitMs: 10 })
    expect(textOf(result)).toContain('아직 끝나지 않았습니다')
  })

  it('refuses while locked and for a job it does not know', async () => {
    const { handlers, state } = setup()
    expect((await handlers.stopJob({ job: 'job-9' })).isError).toBe(true)
    state.unlocked = false
    expect(textOf(await handlers.stopJob({ job: 'job-1' }))).toContain('잠겨')
  })
})

describe('listJobs', () => {
  it('lists the jobs of allowed sessions', async () => {
    const { handlers, state, started } = setup()
    await handlers.runCommand({ session: 's1', command: 'make', background: true })
    await handlers.runCommand({ session: 's2', command: 'ls -R', background: true })
    expect(JSON.parse(textOf(handlers.listJobs()))).toMatchObject([
      { job: 'job-2', session: '[개발] 배치', command: 'ls -R', state: '실행 중' },
      { job: 'job-1', session: '[개발] 바우처 WAS', command: 'make', state: '실행 중' }
    ])
    state.sessions = [allowed]
    expect(JSON.parse(textOf(handlers.listJobs())).map(entry => entry.job)).toEqual(['job-1'])
    expect(started[1].stop).toHaveBeenCalledTimes(1)
  })

  it('says when there are none, and refuses while locked', () => {
    const { handlers, state } = setup()
    expect(textOf(handlers.listJobs())).toContain('없습니다')
    state.unlocked = false
    expect(handlers.listJobs().isError).toBe(true)
  })
})
