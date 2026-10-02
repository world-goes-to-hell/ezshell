import { describe, it, expect, vi } from 'vitest'
import crypto from 'crypto'
import toolsModule from './tools.js'
import activityModule from './activityLog.js'
import fakeModule from './fakeSftp.testhelper.js'
import remoteFileModule from './remoteFile.js'

const { createToolHandlers } = toolsModule
const { createActivityLog } = activityModule
const { createFakeSftp } = fakeModule
const { MAX_FILE_BYTES } = remoteFileModule

const named = { id: 's1', name: '[개발] 바우처 WAS', mcpEnabled: true, host: '10.0.0.1', username: 'deploy' }
const unnamed = { id: 'abcdef12-3456-7890', name: 'deploy@10.0.0.5', mcpEnabled: true, host: '10.0.0.5', username: 'deploy' }
const CONFIG = '/srv/app/config.yml'
const baseTree = () => ({
  '/srv': { type: 'dir' },
  '/srv/app': { type: 'dir' },
  [CONFIG]: { type: 'file', data: 'port: 8080\nhost: a\n', mode: 0o100640 },
  '/srv/app/logs': { type: 'dir' },
  '/srv/app/.env': { type: 'file', data: 'TOKEN=old\n' },
  '/tmp': { type: 'dir' },
  '/tmp/notes.txt': { type: 'link', target: '/srv/app/.env' },
  '/proc': { type: 'dir' },
  '/proc/sysrq-trigger': { type: 'file', data: '' },
  '/tmp/trigger': { type: 'link', target: '/proc/sysrq-trigger' }
})

/**
 * Tool handlers over an in-memory SFTP tree. `answer` is the approval outcome, or a function
 * (details, options, state) => outcome that can change things while the dialog is "open".
 */
function setup({ sessions = [named], alertLevel = 'danger', answer = 'approved', tree = baseTree(), sftpOptions, useSftpError, auditFails = false, activity } = {}) {
  const state = { unlocked: true, sessions }
  const sftp = createFakeSftp(tree, sftpOptions)
  const auditEntries = []
  const approvals = []
  const writeStarts = []
  const handlers = createToolHandlers({
    isUnlocked: () => state.unlocked,
    getSessions: () => state.sessions,
    getFolders: () => [{ id: 'f1', name: '개발' }],
    getAlertLevel: () => alertLevel,
    activity,
    approvals: {
      request: async (details, options) => {
        approvals.push({ details, options })
        return typeof answer === 'function' ? answer(details, options, state, sftp) : answer
      }
    },
    gateway: {
      getCwd: () => '/srv/app',
      resolveCwd: async () => '/srv/app',
      useSftp: async (session, options, task) => {
        if (useSftpError) throw useSftpError
        if (options && options.signal && options.signal.aborted) throw Object.assign(new Error('x'), { userMessage: '요청이 취소되었습니다.' })
        return task(sftp, { cwd: '/srv/app', home: '/home/deploy', beginWrite: () => writeStarts.push(Date.now()) })
      }
    },
    audit: { append: (entry) => { if (auditFails) throw new Error('disk full'); auditEntries.push(entry) } },
    newRequestId: () => 'r1'
  })
  /** Anything that changes a file: a write, a resize, or an open that creates or truncates */
  const wrote = () => sftp.calls.some(([name, , flags]) => name === 'write' || name === 'fsetstat' || (name === 'open' && (flags === 'w' || flags === 'wx')))
  return { handlers, state, sftp, auditEntries, approvals, wrote, writeStarts }
}

const textOf = (result) => result.content[0].text
const outcomes = (entries) => entries.filter(entry => entry.phase === 'end').map(entry => entry.outcome)

describe('write_file / edit_file: nothing is written without the user saying yes', () => {
  it.each([['all'], ['medium'], ['danger']])('asks at alert level %s, then writes exactly the new content', async (alertLevel) => {
    const { handlers, sftp, approvals, auditEntries } = setup({ alertLevel })
    const result = await handlers.writeFile({ session: 's1', path: CONFIG, content: 'port: 9090\nhost: a\n' })
    expect(result.isError).toBeUndefined()
    expect(approvals).toHaveLength(1)
    expect(sftp.text(CONFIG)).toBe('port: 9090\nhost: a\n')
    expect(outcomes(auditEntries)).toEqual(['approved'])
  })

  it.each([['denied'], ['expired'], ['cancelled']])('does not touch the file when the answer is %s', async (answer) => {
    const { handlers, sftp, wrote, auditEntries } = setup({ answer })
    const result = await handlers.writeFile({ session: 's1', path: CONFIG, content: 'port: 9090\n' })
    expect(result.isError).toBe(true)
    expect(wrote()).toBe(false)
    expect(sftp.text(CONFIG)).toBe('port: 8080\nhost: a\n')
    expect(outcomes(auditEntries)).toEqual([answer])
  })

  it('does not write when the app locks while the dialog is open', async () => {
    const { handlers, wrote } = setup({ answer: (details, options, state) => { state.unlocked = false; return 'approved' } })
    const result = await handlers.writeFile({ session: 's1', path: CONFIG, content: 'x\n' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('잠겨')
    expect(wrote()).toBe(false)
  })

  it('does not write when MCP access was switched off for the session meanwhile', async () => {
    const { handlers, wrote } = setup({ answer: (details, options, state) => { state.sessions = [{ ...named, mcpEnabled: false }]; return 'approved' } })
    const result = await handlers.writeFile({ session: 's1', path: CONFIG, content: 'x\n' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('세션 설정이 바뀌어 실행하지 않았습니다.')
    expect(wrote()).toBe(false)
  })

  it('does not write when the request is cancelled while the dialog is open', async () => {
    const controller = new AbortController()
    const { handlers, wrote, auditEntries } = setup({ answer: () => { controller.abort(); return 'approved' } })
    const result = await handlers.writeFile({ session: 's1', path: CONFIG, content: 'x\n' }, { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(wrote()).toBe(false)
    expect(outcomes(auditEntries)).toEqual(['cancelled'])
  })

  it('refuses while the app is locked, without looking at the server', async () => {
    const { handlers, state, sftp } = setup()
    state.unlocked = false
    const result = await handlers.writeFile({ session: 's1', path: CONFIG, content: 'x\n' })
    expect(result.isError).toBe(true)
    expect(sftp.calls).toEqual([])
  })

  it('refuses a session that is not allowed', async () => {
    const { handlers, sftp } = setup({ sessions: [{ ...named, mcpEnabled: false }] })
    expect((await handlers.editFile({ session: 's1', path: CONFIG, old_string: 'a', new_string: 'b' })).isError).toBe(true)
    expect(sftp.calls).toEqual([])
  })

  it('does not start when the audit log cannot be written', async () => {
    const { handlers, sftp, approvals } = setup({ auditFails: true })
    const result = await handlers.writeFile({ session: 's1', path: CONFIG, content: 'x\n' })
    expect(result.isError).toBe(true)
    expect(sftp.calls).toEqual([])
    expect(approvals).toHaveLength(0)
  })
})

describe('write_file / edit_file: what is written is what was shown', () => {
  it('shows the real path, the change and its size, with a longer time limit than a command', async () => {
    const { handlers, approvals } = setup()
    await handlers.writeFile({ session: 's1', path: 'config.yml', content: 'port: 9090\nhost: a\nnew: 1\n' })
    const { details, options } = approvals[0]
    expect(details).toMatchObject({
      kind: 'file', sessionName: '[개발] 바우처 WAS', path: CONFIG, requestedPath: CONFIG, isNew: false, added: 2, removed: 1, level: 'danger'
    })
    expect(details.reasons).toContain('기존 파일 덮어쓰기')
    expect(details.hunks[0].lines).toEqual([
      { type: 'remove', text: 'port: 8080' }, { type: 'add', text: 'port: 9090' }, { type: 'context', text: 'host: a' }, { type: 'add', text: 'new: 1' }
    ])
    expect(options.timeoutMs).toBe(180000)
    expect(options.signal).toBeDefined()
  })

  it('shows a new file as new, with every line added', async () => {
    const { handlers, approvals, sftp } = setup()
    await handlers.writeFile({ session: 's1', path: '~/../../srv/app/new.txt', content: 'a\nb\n' })
    expect(approvals[0].details).toMatchObject({ path: '/srv/app/new.txt', isNew: true, added: 2, removed: 0 })
    expect(approvals[0].details.reasons).toContain('새 파일 만들기')
    expect(sftp.text('/srv/app/new.txt')).toBe('a\nb\n')
  })

  it('does not write when the file changed while the dialog was open', async () => {
    const answer = (details, options, state, sftp) => { sftp.tree.set(CONFIG, { type: 'file', data: 'port: 1\n' }); return 'approved' }
    const { handlers, sftp, auditEntries } = setup({ answer })
    const result = await handlers.writeFile({ session: 's1', path: CONFIG, content: 'port: 9090\n' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('파일이 바뀌어 쓰지 않았습니다')
    expect(sftp.text(CONFIG)).toBe('port: 1\n')
    expect(outcomes(auditEntries)).toEqual(['failed'])
  })

  it('judges and shows the real file behind a link', async () => {
    const { handlers, approvals, sftp } = setup()
    await handlers.editFile({ session: 's1', path: '/tmp/notes.txt', old_string: 'old', new_string: 'new' })
    const { details } = approvals[0]
    expect(details).toMatchObject({ path: '/srv/app/.env', requestedPath: '/tmp/notes.txt' })
    expect(details.reasons).toContain('심볼릭 링크를 따라 다른 파일에 씀: /tmp/notes.txt → /srv/app/.env')
    expect(details.reasons).toContain('비밀 정보가 있을 수 있는 경로: /srv/app/.env')
    expect(sftp.text('/srv/app/.env')).toBe('TOKEN=new\n')
    expect(sftp.tree.get('/tmp/notes.txt').type).toBe('link')
  })

  it('edits one occurrence, or all of them when asked', async () => {
    const one = setup()
    await one.handlers.editFile({ session: 's1', path: CONFIG, old_string: 'host: a', new_string: 'host: b' })
    expect(one.sftp.text(CONFIG)).toBe('port: 8080\nhost: b\n')
    const all = setup({ tree: { ...baseTree(), [CONFIG]: { type: 'file', data: 'a=1\na=2\n' } } })
    await all.handlers.editFile({ session: 's1', path: CONFIG, old_string: 'a=', new_string: 'b=', replace_all: true })
    expect(all.sftp.text(CONFIG)).toBe('b=1\nb=2\n')
  })

  it('reports what happened: real path, kind of change, line counts', async () => {
    const { handlers } = setup()
    const text = textOf(await handlers.writeFile({ session: 's1', path: CONFIG, content: 'port: 9090\nhost: a\n' }))
    expect(text).toContain('세션: [개발] 바우처 WAS')
    expect(text).toContain(`파일: ${CONFIG} (수정)`)
    expect(text).toContain('변경: +1줄 -1줄')
  })
})

describe('write_file / edit_file: refused without asking the user', () => {
  const refused = async (call, part) => {
    const context = setup()
    const result = await call(context.handlers)
    expect(result.isError).toBe(true)
    if (part) expect(textOf(result)).toContain(part)
    expect(context.approvals).toHaveLength(0)
    expect(context.wrote()).toBe(false)
    return context
  }

  it.each([
    ['an empty path', '', '경로가 비어 있습니다'],
    ['a NUL in the path', '/srv/app/a\0b', '사용할 수 없는 문자'],
    ['a folder path', '/srv/app/', '파일 경로를 지정'],
    ['an existing folder', '/srv/app/logs', '폴더에는 쓸 수 없습니다'],
    ['a missing parent folder', '/srv/nope/a.txt', '상위 폴더가 없습니다']
  ])('%s', async (label, path, part) => {
    await refused((handlers) => handlers.writeFile({ session: 's1', path, content: 'x\n' }), part)
  })

  it('content that is not text or too large', async () => {
    await refused((handlers) => handlers.writeFile({ session: 's1', path: CONFIG, content: 42 }), '내용')
    await refused((handlers) => handlers.writeFile({ session: 's1', path: CONFIG }), '내용')
    await refused((handlers) => handlers.writeFile({ session: 's1', path: CONFIG, content: 'a'.repeat(MAX_FILE_BYTES + 1) }), '너무 큽니다')
  })

  it('an edit whose text is not found, is ambiguous, or changes nothing', async () => {
    await refused((handlers) => handlers.editFile({ session: 's1', path: CONFIG, old_string: 'nope', new_string: 'x' }), '찾지 못했습니다')
    await refused((handlers) => handlers.editFile({ session: 's1', path: CONFIG, old_string: ': ', new_string: '=' }), '2번 나옵니다')
    await refused((handlers) => handlers.editFile({ session: 's1', path: CONFIG, old_string: 'a', new_string: 'a' }), '같습니다')
    await refused((handlers) => handlers.editFile({ session: 's1', path: CONFIG, old_string: '', new_string: 'a' }), '바꿀 문자열')
    await refused((handlers) => handlers.editFile({ session: 's1', path: CONFIG, old_string: 'a' }), '새 문자열')
  })

  it('an edit of a file that does not exist', async () => {
    await refused((handlers) => handlers.editFile({ session: 's1', path: '/srv/app/none.txt', old_string: 'a', new_string: 'b' }), '파일이 없습니다')
  })

  it('an edit that would make the file too large', async () => {
    await refused((handlers) => handlers.editFile({ session: 's1', path: CONFIG, old_string: 'host: a', new_string: 'x'.repeat(MAX_FILE_BYTES) }), '너무 큽니다')
  })

  it('a write that changes nothing is not an error, and still asks nobody', async () => {
    const { handlers, approvals, wrote, auditEntries } = setup()
    const result = await handlers.writeFile({ session: 's1', path: CONFIG, content: 'port: 8080\nhost: a\n' })
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toContain('변경 없음')
    expect(approvals).toHaveLength(0)
    expect(wrote()).toBe(false)
    expect(outcomes(auditEntries)).toEqual(['executed'])
  })
})

describe('write_file / edit_file: what must not leak', () => {
  it('keeps the content and the change out of the audit log, but names the tool and the file', async () => {
    const { handlers, auditEntries } = setup()
    await handlers.writeFile({ session: 's1', path: CONFIG, content: 'password: SECRET-NEW\n' })
    await handlers.editFile({ session: 's1', path: CONFIG, old_string: 'SECRET-NEW', new_string: 'SECRET-NEWER' })
    const logged = JSON.stringify(auditEntries)
    expect(logged).not.toContain('SECRET')
    expect(logged).not.toContain('port: 8080')
    expect(auditEntries.filter(entry => entry.phase === 'end').map(entry => [entry.command, entry.target, entry.level])).toEqual([
      [`write_file ${CONFIG}`, CONFIG, 'danger'],
      [`edit_file ${CONFIG}`, CONFIG, 'danger']
    ])
  })

  it('never tells Claude the host or the account', async () => {
    const { handlers } = setup({ sessions: [unnamed] })
    const ok = textOf(await handlers.writeFile({ session: unnamed.id, path: CONFIG, content: 'x\n' }))
    const failed = textOf(await handlers.writeFile({ session: unnamed.id, path: '/srv/nope/a', content: 'x\n' }))
    for (const text of [ok, failed]) {
      expect(text).not.toContain('10.0.0.5')
      expect(text).not.toContain('deploy')
    }
    expect(ok).toContain('세션: 세션-abcdef12')
  })

  it('passes on the user message of a gateway failure, never its detail', async () => {
    const useSftpError = Object.assign(new Error('x'), { userMessage: '이 서버에서는 파일 전송(SFTP)을 사용할 수 없습니다.', detail: 'SECRET-DETAIL 10.0.0.1' })
    const { handlers, auditEntries } = setup({ useSftpError })
    const result = await handlers.writeFile({ session: 's1', path: CONFIG, content: 'x\n' })
    expect(textOf(result)).toBe('쓰지 못했습니다: 이 서버에서는 파일 전송(SFTP)을 사용할 수 없습니다.')
    expect(JSON.stringify(auditEntries)).not.toContain('SECRET-DETAIL')
  })

  it('shows the change in the activity view from memory only, and forgets it on lock', async () => {
    const activity = createActivityLog()
    const { handlers } = setup({ activity })
    await handlers.writeFile({ session: 's1', path: CONFIG, content: 'port: 9090\nhost: a\n' })
    const [item] = activity.list()
    expect(item).toMatchObject({ command: `write_file ${CONFIG}`, state: 'done', level: 'danger', exitCode: null })
    expect(item.outputParts).toEqual([{ stream: 'stdout', text: '@@ -1,2 +1,2 @@\n-port: 8080\n+port: 9090\n host: a\n' }])
    activity.clear()
    expect(activity.list()).toEqual([])
  })

  it('walks the activity item through running, waiting, running, done', async () => {
    const seen = []
    const activity = createActivityLog({ emit: (item) => seen.push(item.state) })
    const { handlers } = setup({ activity })
    await handlers.writeFile({ session: 's1', path: CONFIG, content: 'x\n' })
    expect(seen).toEqual(['running', 'waiting', 'running', 'done'])
  })

  it('lets the stop button of the activity view cancel a request that waits for the answer', async () => {
    const activity = createActivityLog()
    const answer = (details, options) => new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
    })
    const { handlers, wrote } = setup({ activity, answer })
    const pending = handlers.writeFile({ session: 's1', path: CONFIG, content: 'x\n' })
    await vi.waitFor(() => expect(activity.list()[0]?.state).toBe('waiting'))
    expect(activity.cancel(activity.list()[0].id)).toBe(true)
    expect((await pending).isError).toBe(true)
    expect(wrote()).toBe(false)
    expect(activity.list()[0].state).toBe('cancelled')
  })
})

describe('write_file / edit_file: findings of the security review', () => {
  it.each([
    ['asked for directly', '/proc/sysrq-trigger'],
    ['reached through a link', '/tmp/trigger'],
    ['a device', '/dev/sda']
  ])('refuses a system path %s, without a dialog and without opening anything', async (label, path) => {
    const { handlers, approvals, sftp } = setup()
    const result = await handlers.writeFile({ session: 's1', path, content: 'b\n' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('시스템 경로(/proc, /sys, /dev)에는 쓸 수 없습니다.')
    expect(approvals).toHaveLength(0)
    expect(sftp.calls.some(([name]) => name === 'open')).toBe(false)
  })

  describe('no guessing at content the user would have to approve reading', () => {
    const GATED = '현재 알림 수준에서는 이 파일을 읽을 때 확인이 필요해서 edit_file 을 쓸 수 없습니다. run_command 로 내용을 확인한 뒤 write_file 로 전체 내용을 지정하세요.'

    it('refuses edit_file on a secret file at the stricter alert levels, with one answer whatever the file holds', async () => {
      const answers = []
      for (const oldString of ['TOKEN=old', 'TOKEN=zzz', 'O']) {
        const { handlers, approvals, sftp } = setup({ alertLevel: 'medium' })
        const result = await handlers.editFile({ session: 's1', path: '/srv/app/.env', old_string: oldString, new_string: 'x' })
        answers.push(textOf(result))
        expect(result.isError).toBe(true)
        expect(approvals).toHaveLength(0)
        expect(sftp.text('/srv/app/.env')).toBe('TOKEN=old\n')
      }
      expect(new Set(answers)).toEqual(new Set([`쓰지 못했습니다: ${GATED}`]))
    })

    it('also when the secret file is reached through a harmless name', async () => {
      const { handlers, approvals } = setup({ alertLevel: 'medium' })
      const result = await handlers.editFile({ session: 's1', path: '/tmp/notes.txt', old_string: 'nope', new_string: 'x' })
      expect(textOf(result)).toBe(`쓰지 못했습니다: ${GATED}`)
      expect(approvals).toHaveLength(0)
    })

    it('refuses edit_file everywhere when every read needs approval', async () => {
      const { handlers, approvals } = setup({ alertLevel: 'all' })
      const result = await handlers.editFile({ session: 's1', path: CONFIG, old_string: 'nope', new_string: 'x' })
      expect(textOf(result)).toBe(`쓰지 못했습니다: ${GATED}`)
      expect(approvals).toHaveLength(0)
    })

    it('still edits an ordinary file at the medium level, and a secret file at the default level', async () => {
      const ordinary = setup({ alertLevel: 'medium' })
      await ordinary.handlers.editFile({ session: 's1', path: CONFIG, old_string: 'host: a', new_string: 'host: b' })
      expect(ordinary.sftp.text(CONFIG)).toBe('port: 8080\nhost: b\n')
      const secret = setup({ alertLevel: 'danger' })
      await secret.handlers.editFile({ session: 's1', path: '/srv/app/.env', old_string: 'old', new_string: 'new' })
      expect(secret.sftp.text('/srv/app/.env')).toBe('TOKEN=new\n')
    })

    it('fails closed when the alert level cannot be read', async () => {
      const { handlers, approvals } = setup({ alertLevel: { broken: true } })
      const result = await handlers.editFile({ session: 's1', path: CONFIG, old_string: 'host: a', new_string: 'host: b' })
      expect(result.isError).toBe(true)
      expect(approvals).toHaveLength(0)
    })

    it('asks before saying "no change" for a file whose content must not be confirmed without approval', async () => {
      const same = 'TOKEN=old\n'
      const approved = setup({ alertLevel: 'medium' })
      const result = await approved.handlers.writeFile({ session: 's1', path: '/srv/app/.env', content: same })
      expect(approved.approvals).toHaveLength(1)
      expect(approved.approvals[0].details).toMatchObject({ noChange: true, added: 0, removed: 0, hunks: [] })
      expect(textOf(result)).toContain('변경 없음')
      expect(approved.wrote()).toBe(false)

      const denied = setup({ alertLevel: 'medium', answer: 'denied' })
      const refusal = await denied.handlers.writeFile({ session: 's1', path: '/srv/app/.env', content: same })
      const other = await setup({ alertLevel: 'medium', answer: 'denied' }).handlers.writeFile({ session: 's1', path: '/srv/app/.env', content: 'TOKEN=guess\n' })
      expect(textOf(refusal)).toBe(textOf(other))
    })
  })

  it('refuses a replace_all that would outgrow the limit, without building the result', async () => {
    const tree = { ...baseTree(), [CONFIG]: { type: 'file', data: 'a'.repeat(200_000) } }
    const { handlers, approvals } = setup({ tree })
    const started = Date.now()
    const result = await handlers.editFile({ session: 's1', path: CONFIG, old_string: 'a', new_string: 'x'.repeat(2000), replace_all: true })
    expect(textOf(result)).toContain('너무 큽니다')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(approvals).toHaveLength(0)
  })

  it('refuses a file with more lines than a person can review', async () => {
    const { handlers, approvals } = setup()
    const tooMany = 'x\n'.repeat(10_001)
    const result = await handlers.writeFile({ session: 's1', path: '/srv/app/many.txt', content: tooMany })
    expect(textOf(result)).toContain('줄이 너무 많습니다 (10000줄까지)')
    expect(approvals).toHaveLength(0)
    const fine = await setup().handlers.writeFile({ session: 's1', path: '/srv/app/many.txt', content: 'x\n'.repeat(10_000) })
    expect(fine.isError).toBeUndefined()
  })

  it('refuses to edit an existing file with too many lines as well', async () => {
    const tree = { ...baseTree(), [CONFIG]: { type: 'file', data: 'x\n'.repeat(10_001) } }
    const { handlers, approvals } = setup({ tree })
    const result = await handlers.writeFile({ session: 's1', path: CONFIG, content: 'short\n' })
    expect(textOf(result)).toContain('줄이 너무 많습니다')
    expect(approvals).toHaveLength(0)
  })

  it('records in the audit log that the user approved, and a fingerprint of what was written', async () => {
    const content = 'port: 9090\nhost: a\n'
    const { handlers, auditEntries } = setup()
    await handlers.writeFile({ session: 's1', path: CONFIG, content })
    const end = auditEntries.find(entry => entry.phase === 'end')
    expect(end).toMatchObject({ outcome: 'approved', approved: true })
    expect(end.contentSha256).toBe(crypto.createHash('sha256').update(content).digest('hex'))
  })

  it('tells an approved write that failed from a request that never got that far', async () => {
    const answer = (details, options, state, sftp) => { sftp.tree.set(CONFIG, { type: 'file', data: 'port: 1\n' }); return 'approved' }
    const afterApproval = setup({ answer })
    await afterApproval.handlers.writeFile({ session: 's1', path: CONFIG, content: 'x\n' })
    expect(afterApproval.auditEntries.find(entry => entry.phase === 'end')).toMatchObject({ outcome: 'failed', approved: true })

    const beforeApproval = setup()
    await beforeApproval.handlers.writeFile({ session: 's1', path: '/srv/nope/a', content: 'x\n' })
    const end = beforeApproval.auditEntries.find(entry => entry.phase === 'end')
    expect(end.outcome).toBe('failed')
    expect('approved' in end).toBe(false)

    const denied = setup({ answer: 'denied' })
    await denied.handlers.writeFile({ session: 's1', path: CONFIG, content: 'x\n' })
    expect('approved' in denied.auditEntries.find(entry => entry.phase === 'end')).toBe(false)
  })

  it('creates a new secret file readable by its owner only, and tells the user', async () => {
    const { handlers, sftp, approvals } = setup()
    await handlers.writeFile({ session: 's1', path: '/srv/app/prod.pem', content: 'KEY\n' })
    expect(sftp.calls.find(([name, , flags]) => name === 'open' && flags === 'wx').slice(1)).toEqual(['/srv/app/prod.pem', 'wx', { mode: 0o600 }])
    expect(approvals[0].details.reasons).toContain('비밀 경로이므로 소유자만 읽을 수 있게 만듦 (권한 600)')
  })

  it('warns about files that run at login', async () => {
    const tree = { ...baseTree(), '/home': { type: 'dir' }, '/home/deploy': { type: 'dir' } }
    const { handlers, approvals } = setup({ tree })
    await handlers.writeFile({ session: 's1', path: '~/.bashrc', content: 'alias ll=ls\n' })
    expect(approvals[0].details.reasons).toContain('로그인·예약 실행·권한에 영향을 주는 파일: /home/deploy/.bashrc')
  })

  it('asks for the longer time limit exactly when it starts writing', async () => {
    const written = setup()
    await written.handlers.writeFile({ session: 's1', path: CONFIG, content: 'x\n' })
    expect(written.writeStarts).toHaveLength(1)
    const denied = setup({ answer: 'denied' })
    await denied.handlers.writeFile({ session: 's1', path: CONFIG, content: 'x\n' })
    expect(denied.writeStarts).toHaveLength(0)
  })
})

describe('file tools leave the command tools alone', () => {
  it('still offers list_sessions, cd and run_command', () => {
    const { handlers } = setup()
    for (const name of ['listSessions', 'runCommand', 'changeDirectory', 'writeFile', 'editFile']) expect(typeof handlers[name]).toBe('function')
  })
})
