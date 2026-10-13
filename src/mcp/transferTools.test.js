import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import toolsModule from './tools.js'
import jobStoreModule from './jobStore.js'
import fakeModule from './fakeSftp.testhelper.js'
import localPathModule from './localPath.js'

const { createToolHandlers } = toolsModule
const { createJobStore } = jobStoreModule
const { createFakeSftp } = fakeModule
const { MESSAGES: PATH_MESSAGES } = localPathModule

const named = { id: 's1', name: '[개발] 바우처 WAS', mcpEnabled: true, host: '10.0.0.1', username: 'deploy' }
const REMOTE_JAR = '/srv/app/app.jar'
const REMOTE_LOG = '/srv/app/logs/app.log'
const LOG_BYTES = 'line one\nline two\nline three\n'
const JAR_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x80, 0x00, 0x01, 0x02, 0x03])
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')
const baseTree = () => ({
  '/home': { type: 'dir' },
  '/home/deploy': { type: 'dir', uid: 1000 },
  '/srv': { type: 'dir' },
  '/srv/app': { type: 'dir' },
  [REMOTE_JAR]: { type: 'file', data: Buffer.from('old jar'), mode: 0o100750, mtime: 500, uid: 1000 },
  '/srv/app/logs': { type: 'dir' },
  [REMOTE_LOG]: { type: 'file', data: LOG_BYTES, mtime: 700 },
  '/srv/app/.env': { type: 'file', data: 'TOKEN=secret-value\n' },
  '/tmp': { type: 'dir' },
  '/tmp/notes.txt': { type: 'link', target: '/srv/app/.env' },
  '/proc': { type: 'dir' },
  '/proc/kcore': { type: 'file', data: 'x' }
})

const tempDirs = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A real folder tree: `work` is registered for transfers, `outside` and `userData` are not. */
function makeLocal() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-transfer-')))
  tempDirs.push(base)
  const dirs = { base, work: path.join(base, 'work'), outside: path.join(base, 'outside'), userData: path.join(base, 'userdata') }
  for (const dir of [dirs.work, dirs.outside, dirs.userData]) fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dirs.work, 'app.jar'), JAR_BYTES)
  fs.writeFileSync(path.join(dirs.outside, 'id_rsa'), 'PRIVATE KEY')
  fs.writeFileSync(path.join(dirs.userData, 'sessions.json'), '[]')
  return dirs
}

/** fs.promises with every call counted, to show the file system was not touched */
function countingFs() {
  const calls = []
  const fsp = new Proxy(fs.promises, {
    get(target, name) {
      const value = target[name]
      if (typeof value !== 'function') return value
      return (...args) => { calls.push(String(name)); return value.apply(target, args) }
    }
  })
  return { fsp, calls }
}

function setup({ sessions = [named], alertLevel = 'danger', answer = 'approved', tree = baseTree(), sftpOptions, roots, auditFails = false, transfer = {}, jobs = createJobStore() } = {}) {
  const local = makeLocal()
  const state = { unlocked: true, sessions, roots: roots === undefined ? [local.work] : roots }
  const sftp = createFakeSftp(tree, sftpOptions)
  const auditEntries = []
  const approvals = []
  const channels = { opened: 0, closed: 0 }
  const counted = countingFs()
  // Lets a test change the disk at the moment a file is opened
  let beforeOpen = null
  const hooked = new Proxy(counted.fsp, {
    get(target, name) {
      if (name !== 'open') return target[name]
      return async (...args) => { if (beforeOpen) await beforeOpen(); return target.open(...args) }
    }
  })
  const handlers = createToolHandlers({
    isUnlocked: () => state.unlocked,
    getSessions: () => state.sessions,
    getFolders: () => [{ id: 'f1', name: '개발' }],
    getAlertLevel: () => alertLevel,
    getTransferRoots: () => state.roots,
    userDataPath: local.userData,
    jobs,
    transfer: { fsp: hooked, quickWaitMs: 2000, ...transfer },
    approvals: {
      request: async (details, options) => {
        approvals.push({ details, options })
        return typeof answer === 'function' ? answer(details, options, state, sftp, local) : answer
      }
    },
    gateway: {
      getCwd: () => '/srv/app',
      resolveCwd: async () => '/srv/app',
      useSftp: async (session, options, task) => task(sftp, { cwd: '/srv/app', home: '/home/deploy', beginWrite: () => {} }),
      openTransfer: async () => {
        channels.opened += 1
        return { sftp, close: () => { channels.closed += 1 } }
      }
    },
    audit: { append: (entry) => { if (auditFails) throw new Error('disk full'); auditEntries.push(entry) } },
    newRequestId: () => 'r1'
  })
  const remoteParts = () => [...sftp.tree.keys()].filter(key => key.includes('.ezshell-part-'))
  const localParts = () => fs.readdirSync(local.work).filter(name => name.includes('.ezshell-part-'))
  const madeRemoteFile = () => sftp.calls.some(([name, , flags]) => name === 'write' || (name === 'open' && flags === 'wx'))
  const inWork = (name) => path.join(local.work, name)
  const swapOnOpen = (hook) => { beforeOpen = hook }
  return { handlers, state, sftp, local, auditEntries, approvals, channels, jobs, fsCalls: counted.calls, remoteParts, localParts, madeRemoteFile, inWork, swapOnOpen }
}

const textOf = (result) => result.content[0].text
const outcomes = (entries) => entries.filter(entry => entry.phase === 'end').map(entry => entry.outcome)
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(check, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (check()) return
    await tick()
  }
  throw new Error('condition never became true')
}

describe('upload_file / download_file: only inside the registered folders', () => {
  it('refuses both tools while no folder is registered, and touches nothing', async () => {
    const { handlers, approvals, fsCalls, sftp, inWork } = setup({ roots: [] })
    const up = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    const down = await handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: inWork('app.log') })
    expect(up.isError).toBe(true)
    expect(textOf(up)).toContain(PATH_MESSAGES.noRoots)
    expect(textOf(down)).toContain(PATH_MESSAGES.noRoots)
    expect(approvals).toHaveLength(0)
    expect(fsCalls).toEqual([])
    expect(sftp.calls).toEqual([])
  })

  it('refuses a file outside, the same way whether it exists or not, without touching it', async () => {
    const { handlers, approvals, fsCalls, sftp, local } = setup()
    const existing = await handlers.uploadFile({ session: 's1', local_path: path.join(local.outside, 'id_rsa'), remote_path: '/tmp/k' })
    const absent = await handlers.uploadFile({ session: 's1', local_path: path.join(local.outside, 'nothing'), remote_path: '/tmp/k' })
    expect(textOf(existing)).toContain(PATH_MESSAGES.outside)
    expect(textOf(existing)).toBe(textOf(absent))
    expect(approvals).toHaveLength(0)
    expect(fsCalls).toEqual([])
    expect(sftp.calls).toEqual([])
  })

  it('refuses to download to a place outside', async () => {
    const { handlers, approvals, local } = setup()
    const result = await handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: path.join(local.outside, 'startup.bat') })
    expect(textOf(result)).toContain(PATH_MESSAGES.outside)
    expect(approvals).toHaveLength(0)
    expect(fs.existsSync(path.join(local.outside, 'startup.bat'))).toBe(false)
  })

  it('refuses a junction inside the folder that leads outside', async () => {
    const { handlers, approvals, local, inWork, sftp } = setup()
    fs.symlinkSync(local.outside, inWork('link'), 'junction')
    const result = await handlers.uploadFile({ session: 's1', local_path: path.join(inWork('link'), 'id_rsa'), remote_path: '/tmp/k' })
    expect(textOf(result)).toContain(PATH_MESSAGES.unreachable)
    expect(approvals).toHaveLength(0)
    expect(sftp.calls).toEqual([])
  })

  // Review H-2: a hard link is an ordinary file by every check on its path
  it('refuses to upload a file that has another name somewhere (a hard link)', async () => {
    const { handlers, approvals, local, inWork, madeRemoteFile } = setup()
    fs.linkSync(path.join(local.outside, 'id_rsa'), inWork('notes.txt'))
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('notes.txt'), remote_path: '/tmp/k' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('하드 링크')
    expect(approvals).toHaveLength(0)
    expect(madeRemoteFile()).toBe(false)
  })

  // Review H-1
  it('refuses everything under a registered folder that was replaced by a junction', async () => {
    const { handlers, approvals, local, state, sftp } = setup()
    const moved = path.join(local.base, 'work-old')
    fs.renameSync(local.work, moved)
    fs.symlinkSync(local.outside, local.work, 'junction')
    state.roots = [local.work]
    const result = await handlers.uploadFile({ session: 's1', local_path: path.join(local.work, 'id_rsa'), remote_path: '/tmp/k' })
    expect(result.isError).toBe(true)
    expect(approvals).toHaveLength(0)
    expect(sftp.calls).toEqual([])
  })

  // Review M-1: the folder is swapped for a junction between looking at the path and opening the file
  it('does not upload a file reached through a folder that was swapped after the path was checked', async () => {
    const context = setup()
    const { handlers, approvals, local, inWork, madeRemoteFile } = context
    fs.mkdirSync(inWork('sub'))
    fs.writeFileSync(path.join(inWork('sub'), 'id_rsa'), 'harmless')
    const realOpen = fs.promises.open
    let swapped = false
    context.swapOnOpen(async () => {
      if (swapped) return
      swapped = true
      fs.renameSync(inWork('sub'), inWork('sub-old'))
      fs.symlinkSync(local.outside, inWork('sub'), 'junction')
    })
    const result = await handlers.uploadFile({ session: 's1', local_path: path.join(inWork('sub'), 'id_rsa'), remote_path: '/tmp/k' })
    expect(realOpen).toBe(fs.promises.open)
    expect(result.isError).toBe(true)
    expect(approvals).toHaveLength(0)
    expect(madeRemoteFile()).toBe(false)
  })

  // Review M-2: the folder is swapped while the download runs
  it('does not put a download in place when its folder was swapped during the transfer', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const { handlers, jobs, local, inWork } = setup({ sftpOptions: { beforeRead: () => gate }, transfer: { quickWaitMs: 20 } })
    fs.mkdirSync(inWork('sub'))
    const result = await handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: path.join(inWork('sub'), 'app.log') })
    const [, id] = textOf(result).match(/작업 ID: (\S+)/)
    // Windows does not let a folder be renamed while a file in it is open (the partial file is),
    // so there the swap itself fails and the download simply completes where it was shown
    let wasSwapped = true
    try {
      fs.renameSync(inWork('sub'), inWork('sub-old'))
      fs.symlinkSync(local.outside, inWork('sub'), 'junction')
    } catch {
      wasSwapped = false
    }
    release()
    await until(() => jobs.get(id).state !== 'running')
    expect(fs.existsSync(path.join(local.outside, 'app.log'))).toBe(false)
    if (wasSwapped) {
      expect(jobs.get(id).state).toBe('error')
      expect(fs.existsSync(path.join(inWork('sub-old'), 'app.log'))).toBe(false)
    } else {
      expect(jobs.get(id).state).toBe('done')
      expect(fs.readFileSync(path.join(inWork('sub'), 'app.log'), 'utf8')).toBe(LOG_BYTES)
    }
  })

  // Review L-8: every waiting upload holds a file open
  it('refuses more transfers than may wait for an answer at once', async () => {
    const answers = []
    let isHolding = true
    const answer = () => (isHolding ? new Promise(resolve => answers.push(resolve)) : 'denied')
    const { handlers, inWork } = setup({ answer, transfer: { maxWaiting: 2 } })
    const first = handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/a1' })
    const second = handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/a2' })
    await until(() => answers.length === 2)
    const third = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/a3' })
    expect(third.isError).toBe(true)
    expect(textOf(third)).toContain('대기')
    isHolding = false
    answers.forEach(resolve => resolve('denied'))
    await Promise.all([first, second])
    const afterwards = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/a4' })
    expect(textOf(afterwards)).not.toContain('대기 중인')
  })

  it('refuses the app data folder even when it lies inside a registered folder', async () => {
    const { handlers, approvals, local, state } = setup()
    state.roots = [local.base]
    const result = await handlers.uploadFile({ session: 's1', local_path: path.join(local.userData, 'sessions.json'), remote_path: '/tmp/s' })
    expect(textOf(result)).toContain(PATH_MESSAGES.appData)
    expect(approvals).toHaveLength(0)
  })

  it('refuses a relative local path', async () => {
    const { handlers, approvals } = setup()
    const result = await handlers.uploadFile({ session: 's1', local_path: 'app.jar', remote_path: '/tmp/a' })
    expect(result.isError).toBe(true)
    expect(approvals).toHaveLength(0)
  })
})

describe('upload_file / download_file: nothing moves without the user saying yes', () => {
  it.each([['all'], ['medium'], ['danger']])('upload asks at alert level %s, then sends exactly the bytes', async (alertLevel) => {
    const { handlers, sftp, approvals, auditEntries, remoteParts, channels, inWork } = setup({ alertLevel })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    expect(result.isError).toBeUndefined()
    expect(approvals).toHaveLength(1)
    expect(Buffer.from(sftp.tree.get('/srv/app/new.jar').data).equals(JAR_BYTES)).toBe(true)
    expect(textOf(result)).toContain(sha256(JAR_BYTES))
    expect(remoteParts()).toEqual([])
    expect(outcomes(auditEntries)).toEqual(['approved'])
    expect(channels).toEqual({ opened: 1, closed: 1 })
  })

  it.each([['all'], ['medium'], ['danger']])('download asks at alert level %s, then writes exactly the bytes', async (alertLevel) => {
    const { handlers, approvals, localParts, inWork, auditEntries } = setup({ alertLevel })
    const result = await handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: inWork('app.log') })
    expect(result.isError).toBeUndefined()
    expect(approvals).toHaveLength(1)
    expect(fs.readFileSync(inWork('app.log'), 'utf8')).toBe(LOG_BYTES)
    expect(textOf(result)).toContain(sha256(LOG_BYTES))
    expect(localParts()).toEqual([])
    expect(outcomes(auditEntries)).toEqual(['approved'])
  })

  it.each([['denied'], ['expired'], ['cancelled']])('upload sends nothing when the answer is %s', async (answer) => {
    const { handlers, madeRemoteFile, channels, auditEntries, inWork } = setup({ answer })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    expect(result.isError).toBe(true)
    expect(madeRemoteFile()).toBe(false)
    expect(channels.opened).toBe(0)
    expect(outcomes(auditEntries)).toEqual([answer])
    // The source is no longer held open
    fs.rmSync(inWork('app.jar'))
  })

  it.each([['denied'], ['expired'], ['cancelled']])('download writes nothing when the answer is %s', async (answer) => {
    const { handlers, local, channels, inWork } = setup({ answer })
    const before = fs.readdirSync(local.work)
    const result = await handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: inWork('app.log') })
    expect(result.isError).toBe(true)
    expect(fs.readdirSync(local.work)).toEqual(before)
    expect(channels.opened).toBe(0)
  })

  it('sends nothing when the app locks while the dialog is open', async () => {
    const { handlers, madeRemoteFile, inWork } = setup({ answer: (details, options, state) => { state.unlocked = false; return 'approved' } })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    expect(textOf(result)).toContain('잠겨')
    expect(madeRemoteFile()).toBe(false)
  })

  it('sends nothing when MCP access was switched off for the session meanwhile', async () => {
    const { handlers, madeRemoteFile, inWork } = setup({ answer: (details, options, state) => { state.sessions = [{ ...named, mcpEnabled: false }]; return 'approved' } })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    expect(result.isError).toBe(true)
    expect(madeRemoteFile()).toBe(false)
  })

  it('writes nothing when the request is cancelled while the dialog is open', async () => {
    const controller = new AbortController()
    const { handlers, local, inWork } = setup({ answer: () => { controller.abort(); return 'approved' } })
    const before = fs.readdirSync(local.work)
    const result = await handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: inWork('app.log') }, { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(fs.readdirSync(local.work)).toEqual(before)
  })

  it('refuses when the audit log cannot be written', async () => {
    const { handlers, approvals, inWork } = setup({ auditFails: true })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    expect(result.isError).toBe(true)
    expect(approvals).toHaveLength(0)
  })

  it('does not reach a session that is not allowed', async () => {
    const { handlers, approvals, inWork } = setup({ sessions: [{ ...named, mcpEnabled: false }] })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    expect(result.isError).toBe(true)
    expect(approvals).toHaveLength(0)
  })
})

describe('upload_file / download_file: what was shown is what is transferred', () => {
  it('shows direction, both real paths, the size and that the file is new', async () => {
    const { handlers, approvals, inWork } = setup()
    await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: 'new.jar' })
    expect(approvals[0].details).toMatchObject({
      kind: 'transfer',
      direction: 'upload',
      sessionName: named.name,
      localPath: inWork('app.jar'),
      remotePath: '/srv/app/new.jar',
      size: JAR_BYTES.length,
      isNew: true,
      level: 'danger'
    })
  })

  it('needs overwrite to replace, says so in the dialog, and keeps the mode of the replaced file', async () => {
    const { handlers, approvals, sftp, inWork } = setup()
    const refused = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: REMOTE_JAR })
    expect(refused.isError).toBe(true)
    expect(approvals).toHaveLength(0)
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: REMOTE_JAR, overwrite: true })
    expect(result.isError).toBeUndefined()
    expect(approvals[0].details.isNew).toBe(false)
    expect(approvals[0].details.reasons.join('\n')).toContain('덮어쓰기')
    const node = sftp.tree.get(REMOTE_JAR)
    expect(Buffer.from(node.data).equals(JAR_BYTES)).toBe(true)
    expect(node.mode & 0o777).toBe(0o750)
  })

  it('warns when replacing a file owned by another account', async () => {
    const tree = { ...baseTree(), [REMOTE_JAR]: { type: 'file', data: 'old', mode: 0o100644, mtime: 500, uid: 0 } }
    const { handlers, approvals, inWork } = setup({ tree })
    await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: REMOTE_JAR, overwrite: true })
    expect(approvals[0].details.reasons.join('\n')).toContain('소유자')
  })

  it('does not send a local file that changed while the dialog was open', async () => {
    const { handlers, madeRemoteFile, sftp, inWork } = setup({
      answer: (details) => { fs.appendFileSync(details.localPath, 'MORE'); return 'approved' }
    })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('바뀌어')
    expect(madeRemoteFile()).toBe(false)
    expect(sftp.tree.has('/srv/app/new.jar')).toBe(false)
  })

  it('does not replace a remote file that appeared while the dialog was open', async () => {
    const { handlers, sftp, remoteParts, inWork } = setup({
      answer: (details, options, state, fake) => { fake.tree.set('/srv/app/new.jar', { type: 'file', data: 'someone else' }); return 'approved' }
    })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    expect(result.isError).toBe(true)
    expect(sftp.text('/srv/app/new.jar')).toBe('someone else')
    expect(remoteParts()).toEqual([])
  })

  it('does not replace a remote file that changed while the dialog was open', async () => {
    const { handlers, sftp, remoteParts, inWork } = setup({
      answer: (details, options, state, fake) => { fake.tree.set(REMOTE_JAR, { type: 'file', data: 'newer build', mode: 0o100750, mtime: 999 }); return 'approved' }
    })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: REMOTE_JAR, overwrite: true })
    expect(result.isError).toBe(true)
    expect(sftp.text(REMOTE_JAR)).toBe('newer build')
    expect(remoteParts()).toEqual([])
  })

  it('does not download a remote file that changed while the dialog was open', async () => {
    const { handlers, localParts, inWork } = setup({
      answer: (details, options, state, fake) => { fake.tree.set(REMOTE_LOG, { type: 'file', data: 'rotated', mtime: 999 }); return 'approved' }
    })
    const result = await handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: inWork('app.log') })
    expect(result.isError).toBe(true)
    expect(fs.existsSync(inWork('app.log'))).toBe(false)
    expect(localParts()).toEqual([])
  })

  it('does not replace a local file that appeared while the dialog was open', async () => {
    const { handlers, localParts, inWork } = setup({
      answer: (details) => { fs.writeFileSync(details.localPath, 'mine'); return 'approved' }
    })
    const result = await handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: inWork('app.log') })
    expect(result.isError).toBe(true)
    expect(fs.readFileSync(inWork('app.log'), 'utf8')).toBe('mine')
    expect(localParts()).toEqual([])
  })

  it('needs overwrite to replace a local file', async () => {
    const { handlers, approvals, inWork } = setup()
    fs.writeFileSync(inWork('app.log'), 'old log')
    const refused = await handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: inWork('app.log') })
    expect(refused.isError).toBe(true)
    expect(approvals).toHaveLength(0)
    expect(fs.readFileSync(inWork('app.log'), 'utf8')).toBe('old log')
    const result = await handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: inWork('app.log'), overwrite: true })
    expect(result.isError).toBeUndefined()
    expect(approvals[0].details.isNew).toBe(false)
    expect(fs.readFileSync(inWork('app.log'), 'utf8')).toBe(LOG_BYTES)
  })

  it('shows the real remote path behind a link and why it matters', async () => {
    const { handlers, approvals, inWork } = setup()
    const result = await handlers.downloadFile({ session: 's1', remote_path: '/tmp/notes.txt', local_path: inWork('notes.txt') })
    expect(result.isError).toBeUndefined()
    expect(approvals[0].details.remotePath).toBe('/srv/app/.env')
    expect(approvals[0].details.requestedRemotePath).toBe('/tmp/notes.txt')
    const reasons = approvals[0].details.reasons.join('\n')
    expect(reasons).toContain('심볼릭 링크')
    expect(reasons).toContain('비밀')
  })

  it('warns about a download into a place that tools run from', async () => {
    const { handlers, approvals, inWork } = setup()
    fs.mkdirSync(path.join(inWork('.git'), 'hooks'), { recursive: true })
    await handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: path.join(inWork('.git'), 'hooks', 'pre-commit') })
    expect(approvals[0].details.reasons.join('\n')).toContain('실행')
  })

  it('warns about a local file that looks like a secret, and about a downloaded program', async () => {
    const up = setup()
    fs.writeFileSync(up.inWork('.env'), 'A=1')
    await up.handlers.uploadFile({ session: 's1', local_path: up.inWork('.env'), remote_path: '/srv/app/env.txt' })
    expect(up.approvals[0].details.reasons.join('\n')).toContain('비밀')
    const down = setup()
    await down.handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: down.inWork('run.bat') })
    expect(down.approvals[0].details.reasons.join('\n')).toContain('실행')
  })

  it('gives a new file under a secret path mode 600, any other 644', async () => {
    const { handlers, sftp, inWork } = setup()
    await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/prod.pem' })
    await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/plain.bin' })
    expect(sftp.tree.get('/srv/app/prod.pem').mode & 0o777).toBe(0o600)
    expect(sftp.tree.get('/srv/app/plain.bin').mode & 0o777).toBe(0o644)
  })
})

describe('upload_file / download_file: refused without asking', () => {
  it.each([
    ['a local file that does not exist', (t) => t.handlers.uploadFile({ session: 's1', local_path: t.inWork('nope.bin'), remote_path: '/srv/app/x' })],
    ['a local folder', (t) => { fs.mkdirSync(t.inWork('dir')); return t.handlers.uploadFile({ session: 's1', local_path: t.inWork('dir'), remote_path: '/srv/app/x' }) }],
    ['a remote parent folder that does not exist', (t) => t.handlers.uploadFile({ session: 's1', local_path: t.inWork('app.jar'), remote_path: '/srv/none/x' })],
    ['a remote folder as the target', (t) => t.handlers.uploadFile({ session: 's1', local_path: t.inWork('app.jar'), remote_path: '/srv/app/logs', overwrite: true })],
    ['a remote system path as the target', (t) => t.handlers.uploadFile({ session: 's1', local_path: t.inWork('app.jar'), remote_path: '/proc/x' })],
    ['a remote file that does not exist', (t) => t.handlers.downloadFile({ session: 's1', remote_path: '/srv/app/none.log', local_path: t.inWork('a.log') })],
    ['a remote folder as the source', (t) => t.handlers.downloadFile({ session: 's1', remote_path: '/srv/app/logs', local_path: t.inWork('a.log') })],
    ['a remote system path as the source', (t) => t.handlers.downloadFile({ session: 's1', remote_path: '/proc/kcore', local_path: t.inWork('a.bin') })],
    ['a local parent folder that does not exist', (t) => t.handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: path.join(t.inWork('none'), 'a.log') })],
    ['a local folder as the target', (t) => { fs.mkdirSync(t.inWork('dir')); return t.handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: t.inWork('dir'), overwrite: true }) }]
  ])('%s', async (label, call) => {
    const context = setup()
    const before = fs.readdirSync(context.local.work).filter(name => name !== 'dir')
    const result = await call(context)
    expect(result.isError).toBe(true)
    expect(context.approvals).toHaveLength(0)
    expect(context.madeRemoteFile()).toBe(false)
    expect(fs.readdirSync(context.local.work).filter(name => name !== 'dir')).toEqual(before)
    expect(outcomes(context.auditEntries)).toEqual(['failed'])
  })

  it('a file over the size limit, in either direction', async () => {
    const context = setup({ transfer: { maxBytes: 8 } })
    const up = await context.handlers.uploadFile({ session: 's1', local_path: context.inWork('app.jar'), remote_path: '/srv/app/x' })
    const down = await context.handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: context.inWork('a.log') })
    expect(up.isError).toBe(true)
    expect(down.isError).toBe(true)
    expect(context.approvals).toHaveLength(0)
  })

  it('more transfers than the job limit allows', async () => {
    const jobs = createJobStore({ perSession: 1 })
    jobs.create({ sessionId: 's1', sessionName: 'x', command: 'sleep 100', limitMs: 1000 })
    const { handlers, approvals, inWork } = setup({ jobs })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/x' })
    expect(result.isError).toBe(true)
    expect(approvals).toHaveLength(0)
  })
})

describe('upload_file / download_file: failing and stopping', () => {
  it('removes the partial remote file and keeps the old one when writing fails', async () => {
    const { handlers, sftp, remoteParts, channels, auditEntries, inWork } = setup({ sftpOptions: { failWriteCalls: [1] } })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: REMOTE_JAR, overwrite: true })
    expect(result.isError).toBe(true)
    expect(sftp.text(REMOTE_JAR)).toBe('old jar')
    expect(remoteParts()).toEqual([])
    expect(channels).toEqual({ opened: 1, closed: 1 })
    expect(outcomes(auditEntries)).toEqual(['failed'])
  })

  it('cannot replace a remote file on a server without posix-rename, but can still create one', async () => {
    const { handlers, sftp, remoteParts, inWork } = setup({ sftpOptions: { noPosixRename: true } })
    const replaced = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: REMOTE_JAR, overwrite: true })
    expect(replaced.isError).toBe(true)
    expect(sftp.text(REMOTE_JAR)).toBe('old jar')
    expect(remoteParts()).toEqual([])
    const created = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    expect(created.isError).toBeUndefined()
    expect(Buffer.from(sftp.tree.get('/srv/app/new.jar').data).equals(JAR_BYTES)).toBe(true)
  })

  it('hands out a job id for a transfer that takes long, and the job ends as done', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const { handlers, jobs, sftp, remoteParts, inWork } = setup({ sftpOptions: { beforeWrite: () => gate }, transfer: { quickWaitMs: 20 } })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    expect(result.isError).toBeUndefined()
    const [, id] = textOf(result).match(/작업 ID: (\S+)/)
    expect(jobs.get(id).state).toBe('running')
    expect(sftp.tree.has('/srv/app/new.jar')).toBe(false)
    release()
    await until(() => jobs.get(id).state !== 'running')
    expect(jobs.get(id).state).toBe('done')
    expect(Buffer.from(sftp.tree.get('/srv/app/new.jar').data).equals(JAR_BYTES)).toBe(true)
    expect(remoteParts()).toEqual([])
    const output = await handlers.jobOutput({ job: id, wait_seconds: 0 })
    expect(textOf(output)).toContain(sha256(JAR_BYTES))
  })

  it('stops through stop_job: the partial file goes, the old one stays, the channel closes after cleanup', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const { handlers, jobs, sftp, remoteParts, channels, auditEntries, inWork } = setup({ sftpOptions: { beforeWrite: () => gate }, transfer: { quickWaitMs: 20 } })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: REMOTE_JAR, overwrite: true })
    const [, id] = textOf(result).match(/작업 ID: (\S+)/)
    expect(remoteParts()).toHaveLength(1)
    jobs.stop(id)
    expect(channels.closed).toBe(0)
    release()
    await until(() => jobs.get(id).state !== 'running')
    expect(jobs.get(id).state).toBe('stopped')
    expect(sftp.text(REMOTE_JAR)).toBe('old jar')
    expect(remoteParts()).toEqual([])
    expect(channels.closed).toBe(1)
    expect(outcomes(auditEntries)).toEqual(['approved'])
    expect(auditEntries.at(-1).cancelled).toBe(true)
  })

  it('stops when the app locks: the partial local file is removed before the channel closes', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const { handlers, jobs, localParts, channels, inWork } = setup({ sftpOptions: { beforeRead: () => gate }, transfer: { quickWaitMs: 20 } })
    const result = await handlers.downloadFile({ session: 's1', remote_path: REMOTE_LOG, local_path: inWork('app.log') })
    expect(textOf(result)).toContain('작업 ID')
    expect(localParts()).toHaveLength(1)
    jobs.clear()
    release()
    await until(() => channels.closed === 1)
    expect(localParts()).toEqual([])
    expect(fs.existsSync(inWork('app.log'))).toBe(false)
  })

  it('stops at its time limit', async () => {
    const gate = new Promise(() => {})
    const { handlers, jobs, remoteParts, inWork } = setup({ sftpOptions: { beforeWrite: (n) => (n === 1 ? gate : undefined) }, transfer: { quickWaitMs: 20, limitMs: 60, giveUpMs: 30 } })
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    const [, id] = textOf(result).match(/작업 ID: (\S+)/)
    await until(() => jobs.get(id).state !== 'running')
    expect(jobs.get(id).state).toBe('timeout')
    expect(remoteParts().length).toBeLessThanOrEqual(1)
  })

  it('sends a file in several pieces and keeps them in order', async () => {
    const big = crypto.randomBytes(1000)
    const { handlers, sftp, inWork } = setup({ transfer: { chunkBytes: 64, window: 4 } })
    fs.writeFileSync(inWork('big.bin'), big)
    const up = await handlers.uploadFile({ session: 's1', local_path: inWork('big.bin'), remote_path: '/srv/app/big.bin' })
    expect(textOf(up)).toContain(sha256(big))
    expect(Buffer.from(sftp.tree.get('/srv/app/big.bin').data).equals(big)).toBe(true)
    const down = await handlers.downloadFile({ session: 's1', remote_path: '/srv/app/big.bin', local_path: inWork('back.bin') })
    expect(textOf(down)).toContain(sha256(big))
    expect(fs.readFileSync(inWork('back.bin')).equals(big)).toBe(true)
  })

  it('transfers an empty file', async () => {
    const { handlers, sftp, inWork } = setup()
    fs.writeFileSync(inWork('empty'), '')
    const result = await handlers.uploadFile({ session: 's1', local_path: inWork('empty'), remote_path: '/srv/app/empty' })
    expect(result.isError).toBeUndefined()
    expect(sftp.tree.get('/srv/app/empty').data.length).toBe(0)
  })
})

describe('upload_file / download_file: what must not leak', () => {
  it('keeps file content out of the audit log and the address out of the result', async () => {
    const { handlers, auditEntries, inWork } = setup()
    const down = await handlers.downloadFile({ session: 's1', remote_path: '/srv/app/.env', local_path: inWork('env.txt') })
    const up = await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    const logged = JSON.stringify(auditEntries)
    expect(logged).not.toContain('secret-value')
    expect(logged).toContain(sha256('TOKEN=secret-value\n'))
    for (const result of [down, up]) {
      expect(textOf(result)).not.toContain('10.0.0.1')
      expect(textOf(result)).not.toContain('deploy@')
    }
  })

  it('records both paths, the size and the approval in the audit log', async () => {
    const { handlers, auditEntries, inWork } = setup()
    await handlers.uploadFile({ session: 's1', local_path: inWork('app.jar'), remote_path: '/srv/app/new.jar' })
    expect(auditEntries.at(-1)).toMatchObject({ phase: 'end', outcome: 'approved', approved: true, target: '/srv/app/new.jar', localTarget: inWork('app.jar'), bytes: JAR_BYTES.length, contentSha256: sha256(JAR_BYTES) })
  })
})
