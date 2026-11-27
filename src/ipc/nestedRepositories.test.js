import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import nested from './nestedRepositories.js'
import nestedGit from './nestedGit.js'
import nestedTrust from './nestedRepositoryTrust.js'
import localProjects from './localProjects.js'

const { createNestedRepositories, parseStatus, registerNestedRepositoryIpc } = nested
const { findNestedRepositories, readWorkspaceGit, inspectLocalProject } = localProjects
const exec = promisify(execFile)
const temporary = []
const check = () => {}
const discover = directory => findNestedRepositories(directory, new AbortController().signal)

async function fixtureDirectory() {
  const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ezshell-nested-')))
  temporary.push(folder)
  return folder
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(folder => fs.rm(folder, { recursive: true, force: true })))
})

const git = async (folder, ...args) => (await exec('git', args, { cwd: folder, windowsHide: true })).stdout.trim()
const commit = async (folder, name) => {
  await fs.writeFile(path.join(folder, name), name)
  await git(folder, 'add', '--', name)
  await git(folder, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', name)
}

test('reports branch, upstream and changes for actual repositories and only fast-forwards eligible checkouts', async () => {
  const fixture = await fixtureDirectory()
  const project = path.join(fixture, 'work')
  await fs.mkdir(project)
  await git(fixture, 'init', '--bare', '-b', 'main', 'remote.git')
  const remote = path.join(fixture, 'remote.git')
  await git(fixture, 'clone', remote, 'sender')
  const sender = path.join(fixture, 'sender')
  await commit(sender, 'initial')
  await git(sender, 'push', '-u', 'origin', 'main')
  const stable = path.join(fixture, 'stable.git')
  await git(fixture, 'clone', '--bare', remote, stable)
  for (const name of ['ahead', 'behind', 'dirty', 'diverged', 'detached', 'gone', 'standalone', 'stale']) {
    await git(project, 'clone', remote, name)
  }
  for (const name of ['ahead', 'diverged', 'stale']) await commit(path.join(project, name), name)
  await fs.writeFile(path.join(project, 'dirty', 'changed'), 'untracked')
  await git(path.join(project, 'detached'), 'checkout', '--detach')
  await git(path.join(project, 'gone'), 'update-ref', '-d', 'refs/remotes/origin/main')
  await git(path.join(project, 'standalone'), 'branch', '--unset-upstream')
  await git(path.join(project, 'ahead'), 'remote', 'set-url', 'origin', stable)
  await commit(sender, 'incoming')
  await git(sender, 'push')
  await Promise.all(['behind', 'dirty', 'diverged'].map(name => git(path.join(project, name), 'fetch')))

  const commands = []
  const worker = createNestedRepositories({ discover, runGit: (directory, args, options) => {
    if (directory === path.join(project, 'behind')) commands.push(args)
    return nestedGit.git(directory, args, options)
  } })
  expect(await discover(project)).toHaveLength(8)
  const [{ repositories }] = await worker.status(project, [project], 'local', check)
  const states = Object.fromEntries(repositories.map(state => [state.folder, state]))
  expect(Object.keys(states).sort()).toEqual(['ahead', 'behind', 'detached', 'dirty', 'diverged', 'gone', 'stale', 'standalone'])
  expect(states.ahead).toMatchObject({ branch: 'main', hasUpstream: true, ahead: 1, behind: 0 })
  expect(states.behind).toMatchObject({ branch: 'main', hasUpstream: true, ahead: 0, behind: 1 })
  expect(states.stale).toMatchObject({ ahead: 1, behind: 0 })
  expect(states.dirty).toMatchObject({ changed: 1, behind: 1 })
  expect(states.diverged).toMatchObject({ ahead: 1, behind: 1 })
  expect(states.detached).toMatchObject({ branch: null, hasUpstream: false })
  expect(states.gone).toMatchObject({ branch: 'main', hasUpstream: false, upstreamGone: true })
  expect(states.standalone).toMatchObject({ branch: 'main', hasUpstream: false })

  const steps = []
  const results = await worker.pull(project, Object.keys(states), check, result => steps.push([result.folder, result.kind]))
  const received = Object.fromEntries(results.map(result => [result.folder, result]))
  expect(received.ahead).toMatchObject({ kind: 'skipped', reason: 'current' })
  expect(received.behind).toMatchObject({ kind: 'received', count: 1, status: { behind: 0, changed: 0 } })
  expect(received.dirty).toMatchObject({ kind: 'skipped', reason: 'dirty' })
  for (const name of ['diverged', 'stale']) expect(received[name]).toMatchObject({ kind: 'skipped', reason: 'diverged' })
  expect(received.detached).toMatchObject({ kind: 'skipped', reason: 'detached' })
  expect(received.gone).toMatchObject({ kind: 'skipped', reason: 'gone', message: '원격 브랜치가 지워졌습니다.' })
  expect(received.standalone).toMatchObject({ kind: 'skipped', reason: 'no-upstream' })
  expect(steps.filter(([folder]) => folder === 'behind')).toEqual([
    ['behind', 'queued'], ['behind', 'running'], ['behind', 'received']
  ])
  expect(await git(path.join(project, 'behind'), 'rev-parse', 'HEAD')).toBe(await git(sender, 'rev-parse', 'HEAD'))
  expect(commands.filter(args => ['fetch', 'merge', 'pull'].includes(args[0])).map(args => args[0])).toEqual(['fetch', 'merge'])
  expect(commands.find(args => args[0] === 'merge')).toEqual(expect.arrayContaining(['--ff-only', '--no-verify-signatures']))
  expect(await fs.readFile(path.join(project, 'dirty', 'changed'), 'utf8')).toBe('untracked')
  await expect(worker.pull(project, ['../sender'], check, () => {})).rejects.toThrow()

  await commit(sender, 'second-incoming')
  await git(sender, 'push')
  let snapshots = 0
  const raced = createNestedRepositories({ discover, runGit: async (directory, args, options) => {
    if (args[0] === 'merge') throw new Error('A changed upstream must never be merged')
    const output = await nestedGit.git(directory, args, options)
    if (args[0] !== 'rev-parse' || args[1] !== 'HEAD' || ++snapshots !== 2) return output
    return `${output.split(/\r?\n/)[0]}\n${'a'.repeat(40)}\n`
  } })
  const previous = await git(path.join(project, 'behind'), 'rev-parse', 'HEAD')
  const [changed] = await raced.pull(project, ['behind'], check, () => {})
  expect(changed).toMatchObject({ kind: 'failed', message: expect.stringContaining('업스트림 커밋이 바뀌었습니다.') })
  expect(await git(path.join(project, 'behind'), 'rev-parse', 'HEAD')).toBe(previous)
}, 30000)

test('discovers real repositories at two levels and recognizes a submodule within a Git parent', async () => {
  const fixture = await fixtureDirectory()
  const project = path.join(fixture, 'work')
  await fs.mkdir(project)
  await git(project, 'init', '-b', 'main')
  await git(fixture, 'init', '-b', 'main', 'source')
  await commit(path.join(fixture, 'source'), 'initial')
  await git(project, '-c', 'protocol.file.allow=always', 'submodule', 'add', '../source', 'module')
  for (const name of ['build', 'area/valid', 'area/folder/too-deep', '.hidden/repo', 'build/repo', 'target/repo', 'dist/repo', 'node_modules/repo']) {
    const folder = path.join(project, name)
    await fs.mkdir(folder, { recursive: true })
    await git(folder, 'init', '-b', 'main')
  }
  await fs.symlink(path.join(fixture, 'source'), path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const paths = await discover(project)
  expect(paths.map(folder => path.relative(project, folder).split(path.sep).join('/'))).toEqual(['build', 'module', 'area/valid'])
  const { repo } = await readWorkspaceGit(project)
  expect(repo.nestedRepositories).toContain(path.join(project, 'area', 'folder', 'too-deep'))
  expect(repo.nestedRepositories).toContain(path.join(project, 'build', 'repo'))
  const worker = createNestedRepositories({ discover })
  const [{ repositories }] = await worker.status(project, [project], 'local', check)
  expect(repositories.map(state => state.folder)).toEqual(['build', 'module', 'area/valid'])
  for (let index = 0; index < 55; index++) await fs.mkdir(path.join(project, `capped-${index}`, '.git'), { recursive: true })
  expect(await discover(project)).toHaveLength(50)
}, 15000)

test('counts a porcelain rename once and parses NUL-separated paths', () => {
  expect(parseStatus(['# branch.oid abc', '# branch.head topic', '# branch.upstream origin/topic', '# branch.ab +2 -3',
    '2 R. renamed', '? old name', '? new\nfile', 'u conflict', '1 .M modified', ''].join('\0')))
    .toEqual({ oid: 'abc', branch: 'topic', hasUpstream: true, upstreamGone: false, ahead: 2, behind: 3, changed: 4 })
})

test('serializes per repository, limits Git concurrency to four, and fetches once per project per ten minutes', async () => {
  const project = await fixtureDirectory()
  const repositories = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
    const repo = path.join(project, `repo-${index}`)
    await fs.mkdir(path.join(repo, '.git'), { recursive: true })
    return repo
  }))
  let inFlight = 0
  let peak = 0
  let fetched = 0
  let statusReads = 0
  let time = 10
  const active = new Set()
  const runGit = async (directory, args) => {
    expect(active.has(directory)).toBe(false)
    active.add(directory)
    peak = Math.max(peak, ++inFlight)
    await new Promise(resolve => setTimeout(resolve, 5))
    inFlight--
    active.delete(directory)
    if (args[0] === 'fetch') fetched++
    if (args[0] === 'status') statusReads++
    if (args[0] === 'symbolic-ref') return 'main\n'
    if (args[0] === 'for-each-ref') return ['refs/heads/main', 'origin', 'refs/heads/main', 'refs/remotes/origin/main'].join('\0') + '\n'
    if (args[0] === 'config') return args.includes('branch.main.remote') ? 'origin\0' : ''
    if (args[0] === 'remote') return project + '\n'
    if (args[0] === 'rev-parse') return directory
    return '# branch.head main\0'
  }
  const worker = createNestedRepositories({ discover: async () => repositories, runGit, now: () => time, allowAutoFetch: async () => true })
  await Promise.all(Array.from({ length: 5 }, () => worker.status(project, [project], 'local', check)))
  expect(statusReads).toBe(6)
  await Promise.all(Array.from({ length: 2 }, () => worker.status(project, [project], 'automatic', check)))
  expect(peak).toBe(4)
  expect(fetched).toBe(6)
  time += 10 * 60_000
  await worker.status(project, [project], 'automatic', check, [repositories[0]])
  expect(fetched).toBe(11)
})

test('keeps repositories with unreadable status visible and explains ownership errors', async () => {
  const project = await fixtureDirectory()
  const names = ['ownership', 'timeout', 'lock']
  await Promise.all(names.map(name => fs.mkdir(path.join(project, name, '.git'), { recursive: true })))
  const worker = createNestedRepositories({ discover, runGit: async (directory, args) => {
    if (args[0] === 'rev-parse') return directory
    const repo = path.basename(directory)
    if (repo === 'ownership') throw Object.assign(new Error(), { stderr: 'fatal: detected dubious ownership' })
    if (repo === 'timeout') throw new Error('Git 작업의 제한 시간이 지났습니다.')
    throw Object.assign(new Error(), { stderr: 'index.lock: ' + 'x'.repeat(800) })
  } })
  const [{ repositories }] = await worker.status(project, [project], 'local', check)
  const statuses = Object.fromEntries(repositories.map(item => [item.folder, item]))
  expect(statuses.ownership.error).toBe('이 폴더의 소유자가 달라 Git이 읽기를 거부했습니다.')
  expect(statuses.timeout.error).toContain('제한 시간')
  expect(statuses.lock.error).toHaveLength(500)
})

// 2026-11-27 user report: the remote moved from http:// to https://, where no login was saved, and the
// check showed Git Credential Manager's English lines as they came
test('says in Korean that a Git login is needed when the server asks for one', async () => {
  const project = await fixtureDirectory()
  const stderr = {
    missing: "warning: missing OAuth configuration for speciesgit.coreit.co.kr - see https://aka.ms/gcm/gitlab for more information\n" +
      "fatal: Cannot prompt because user interactivity has been disabled.\n" +
      "fatal: could not read Username for 'https://speciesgit.coreit.co.kr': terminal prompts disabled",
    denied: "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://git.example.invalid/x.git/'",
    other: 'fatal: unable to access: Could not resolve host: git.example.invalid'
  }
  await Promise.all(Object.keys(stderr).map(name => fs.mkdir(path.join(project, name, '.git'), { recursive: true })))
  const worker = createNestedRepositories({ discover, runGit: async (directory, args) => {
    if (args[0] === 'rev-parse') return directory
    throw Object.assign(new Error(), { stderr: stderr[path.basename(directory)] })
  } })
  const [{ repositories }] = await worker.status(project, [project], 'local', check)
  const statuses = Object.fromEntries(repositories.map(item => [item.folder, item]))
  for (const name of ['missing', 'denied']) {
    expect(statuses[name].error).toMatch(/^Git 로그인이 필요합니다\. /)
    expect(statuses[name].error).toContain('https 주소에 쓰이지 않습니다')
    expect(statuses[name].error).not.toMatch(/OAuth|terminal prompts/)
  }
  expect(statuses.other.error).toContain('Could not resolve host')
})

test('blocks risky configuration during automatic refresh and prompts before a manual update', async () => {
  const fixture = await fixtureDirectory()
  const project = path.join(fixture, 'work')
  await fs.mkdir(project)
  const source = path.join(fixture, 'source')
  const directory = path.join(project, 'risky')
  await git(fixture, 'init', '-b', 'main', source)
  await commit(source, 'initial')
  await git(project, 'clone', source, directory)
  await git(directory, 'config', '--local', 'remote.origin.uploadpack', 'git-upload-pack')
  await commit(source, 'next')
  const commands = []
  let approved = false
  let now = 0
  const confirmSettings = vi.fn(async () => approved)
  const worker = createNestedRepositories({ discover, confirmSettings, now: () => now, allowAutoFetch: async () => true, runGit: (cwd, args, options) => {
    commands.push(args[0])
    return nestedGit.git(cwd, args, options)
  } })
  const [{ repositories }] = await worker.status(project, [project], 'automatic', check)
  expect(repositories).toEqual([{ folder: 'risky', path: directory, error: '저장소 설정 확인 필요' }])
  expect(commands).toEqual(['config'])
  const [declined] = await worker.pull(project, ['risky'], check, () => {})
  expect(declined).toMatchObject({ kind: 'skipped', reason: 'settings' })
  expect(commands).toEqual(['config', 'config'])
  expect(confirmSettings).toHaveBeenCalledWith({ directory, keys: ['remote.origin.uploadpack'] })
  approved = true
  const [received] = await worker.pull(project, ['risky'], check, () => {})
  expect(received).toMatchObject({ kind: 'received', count: 1 })
  expect(await git(directory, 'rev-parse', 'HEAD')).toBe(await git(source, 'rev-parse', 'HEAD'))
  await git(directory, 'config', '--local', '--unset', 'remote.origin.uploadpack')
  await git(directory, 'config', '--local', 'core.alternateRefsCommand', 'git')
  now += 10 * 60_000
  commands.length = 0
  const [blocked] = await worker.status(project, [project], 'automatic', check)
  expect(blocked.repositories[0].error).toBe('저장소 설정 확인 필요')
  expect(commands).toEqual(['config'])
}, 15000)

test('rejects UNC and disabled transports, including an effective remote rewritten to a share', async () => {
  const fixture = await fixtureDirectory()
  const project = path.join(fixture, 'work')
  const directory = path.join(project, 'remote-check')
  const source = path.join(fixture, 'source')
  await fs.mkdir(project)
  await git(fixture, 'init', '-b', 'main', source)
  await commit(source, 'initial')
  await git(project, 'clone', source, directory)
  await git(directory, 'remote', 'set-url', 'origin', 'fixture-alias:')
  await git(directory, 'config', 'url.file://fixture.invalid/share.insteadOf', 'fixture-alias:')
  const commands = []
  const worker = createNestedRepositories({ discover, allowAutoFetch: async () => true, runGit: (cwd, args, options) => {
    commands.push(args[0])
    if (args[0] === 'fetch') throw new Error('Blocked transports must be rejected before invoking fetch')
    return nestedGit.git(cwd, args, options)
  } })
  const [{ repositories }] = await worker.status(project, [project], 'automatic', check)
  expect(repositories[0].fetchError).toContain('UNC')
  expect((await worker.pull(project, ['remote-check'], check, () => {}))[0]).toMatchObject({ kind: 'failed', message: expect.stringContaining('UNC') })
  expect(commands).not.toContain('fetch')
  for (const url of ['\\\\fixture.invalid\\share', '//fixture.invalid/share', 'file://fixture.invalid/share', 'file:////fixture.invalid/share']) {
    await expect(nestedGit.checkRemote(directory, url)).rejects.toThrow('UNC')
  }
  for (const url of ['git://fixture.invalid/repo', 'http://fixture.invalid/repo']) {
    await expect(nestedGit.checkRemote(directory, url)).rejects.toThrow('HTTPS')
  }
}, 15000)

test('retains user SSH selection, configures the default timeout, and stops the full Git tree on timeout', async () => {
  const windowsSsh = { GIT_SSH: 'plink', GIT_SSH_VARIANT: 'plink', GIT_DIR: 'ignored' }
  const custom = nestedGit.gitEnvironment({ network: true, inherited: windowsSsh })
  expect(custom).toMatchObject({ GIT_SSH: 'plink', GIT_SSH_VARIANT: 'plink', GIT_TERMINAL_PROMPT: '0' })
  expect(custom).not.toHaveProperty('GIT_DIR')
  expect(custom).not.toHaveProperty('GIT_SSH_COMMAND')
  expect(nestedGit.gitEnvironment({ network: true, sshCommand: 'ssh -F custom', inherited: {} })).not.toHaveProperty('GIT_SSH_COMMAND')
  expect(nestedGit.gitEnvironment({ network: true, inherited: {} }).GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes -o ConnectTimeout=15')
  const child = Object.assign(new EventEmitter(), {
    pid: 12, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
  })
  const stop = vi.fn(async () => {})
  await expect(nestedGit.git('.', ['fetch'], { network: true, timeout: 1, start: () => child, stop })).rejects.toThrow('제한 시간')
  expect(stop).toHaveBeenCalledWith(child, process.platform, expect.any(Function))
  expect(child.kill).not.toHaveBeenCalled()
})

test('uses the Git exit code and drains pipes for a bounded time when a child keeps them open', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 12, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
  })
  const stop = vi.fn(async () => {})
  const result = nestedGit.git('.', ['fetch'], { network: true, start: () => child, stop, drainTimeout: 5 })
  child.stdout.write(Buffer.from('finished'))
  child.emit('exit', 0)
  expect(await result).toBe('finished')
  expect(child.stdout.destroyed).toBe(true)
  expect(child.stderr.destroyed).toBe(true)
  expect(stop).not.toHaveBeenCalled()
})

test('rejects locked, detached, UNC and unexpected roots at the IPC boundary', async () => {
  const folder = await fixtureDirectory()
  const handlers = new Map()
  let locked = true
  registerNestedRepositoryIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, fromMainWindow: event => !!event.fromMain,
    isLocked: () => locked, discover, worktrees: async () => [] })
  const status = handlers.get('local-nested-repositories-status')
  const mainFrame = {}
  const sender = { mainFrame, isDestroyed: () => false }
  const event = { sender, senderFrame: mainFrame, fromMain: true }
  const request = { project: folder, roots: [folder] }
  expect(await status(event, request)).toMatchObject({ success: false })
  locked = false
  expect(await status({ ...event, senderFrame: {} }, request)).toMatchObject({ success: false })
  expect(await status({ ...event, fromMain: false }, request)).toMatchObject({ success: false })
  for (const root of ['\\\\server\\share', path.dirname(folder)]) {
    expect(await status(event, { ...request, roots: [root] })).toMatchObject({ success: false })
  }
  expect(await status(event, request)).toMatchObject({ success: true, trusted: false, groups: [{ root: folder, repositories: [] }] })
  const alias = path.join(folder, 'alias')
  await fs.symlink(folder, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(await status(event, { ...request, roots: [alias, folder] })).toMatchObject({
    success: true, groups: [{ root: alias, repositories: [] }, { root: folder, repositories: [] }]
  })
})

test('only confirmed project trust enables the current upstream check and cannot be forged by the renderer', async () => {
  const fixture = await fixtureDirectory()
  const project = path.join(fixture, 'project')
  const forged = path.join(fixture, 'other')
  const source = path.join(fixture, 'source')
  const directory = path.join(project, 'service')
  await fs.mkdir(project)
  await fs.mkdir(forged)
  await git(fixture, 'init', '-b', 'main', source)
  await commit(source, 'initial')
  await git(source, 'branch', 'other')
  await git(project, 'clone', source, directory)
  const head = await git(directory, 'rev-parse', 'HEAD')
  await commit(source, 'later')
  const later = await git(source, 'rev-parse', 'HEAD')
  await git(source, 'branch', '-f', 'other', later)
  await git(source, 'tag', 'later-tag')

  const handlers = new Map()
  const trustFile = path.join(fixture, 'trust.json')
  let accepted = false
  const confirmTrust = vi.fn(async () => accepted)
  const register = () => registerNestedRepositoryIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    fromMainWindow: () => true, isLocked: () => false, discover, worktrees: async () => [], trustFile, confirmTrust
  })
  register()
  const frame = {}
  const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } }
  const request = { project, roots: [project], fetch: true, trusted: true, autoFetchEnabled: true }
  const ask = (channel, input) => handlers.get('local-nested-repositories-' + channel)(event, input)
  expect(await ask('status', request)).toMatchObject({ success: true, trusted: false })
  expect(await git(directory, 'rev-parse', 'refs/remotes/origin/main')).toBe(head)
  expect(await ask('trust', { project, enabled: true, confirmed: true })).toMatchObject({ success: true, trusted: false })
  accepted = true
  expect(await ask('trust', { project, enabled: true })).toMatchObject({ success: true, trusted: true })
  expect(confirmTrust).toHaveBeenCalledWith({ directory: project })
  register()
  await ask('preferences', false)
  expect(await ask('status', request)).toMatchObject({ success: true, trusted: true, autoFetchEnabled: false })
  expect(await git(directory, 'rev-parse', 'refs/remotes/origin/main')).toBe(head)
  expect(await ask('status', { ...request, roots: [forged] })).toMatchObject({ success: false })
  expect(await ask('status', { ...request, project: forged })).toMatchObject({ success: false })
  await ask('preferences', true)
  const confirmed = await ask('status', request)
  expect(confirmed).toMatchObject({ success: true, trusted: true, groups: [{ repositories: [{ behind: 1 }] }] })
  expect(await git(directory, 'rev-parse', 'refs/remotes/origin/main')).toBe(later)
  expect(await git(directory, 'rev-parse', 'refs/remotes/origin/other')).toBe(head)
  expect(await git(directory, 'tag', '--list')).toBe('')
  expect(await git(directory, 'rev-parse', 'HEAD')).toBe(head)
  expect(await ask('trust', { project, enabled: false })).toMatchObject({ success: true, trusted: false })
}, 20000)

test('keeps an untrusted partial clone offline until a manual remote check or project trust', async () => {
  const fixture = await fixtureDirectory()
  const project = path.join(fixture, 'project')
  const source = path.join(fixture, 'source')
  const directory = path.join(project, 'partial')
  await fs.mkdir(project)
  await git(fixture, 'init', '-b', 'main', source)
  await git(source, 'config', 'uploadpack.allowFilter', 'true')
  await commit(source, 'initial')
  await git(project, 'clone', '--filter=blob:none', '--no-checkout', pathToFileURL(source).href, directory)
  expect(await git(directory, 'config', '--bool', 'remote.origin.promisor')).toBe('true')

  const commands = []
  let trusted = false
  const worker = createNestedRepositories({ discover, isTrusted: async () => trusted, runGit: (cwd, args, options) => {
    commands.push(args[0])
    return nestedGit.git(cwd, args, options)
  } })
  for (const mode of ['local', 'automatic']) {
    commands.length = 0
    const [{ repositories }] = await worker.status(project, [project], mode, check)
    expect(repositories).toEqual([{ folder: 'partial', path: directory, error: '부분 복제 · 원격 확인을 눌러 읽기' }])
    expect(commands).toEqual(['config'])
  }
  expect(nestedGit.gitEnvironment({ inherited: { GIT_NO_LAZY_FETCH: '0' } })).toHaveProperty('GIT_NO_LAZY_FETCH', '1')
  expect(nestedGit.gitEnvironment({ network: true, inherited: {} })).not.toHaveProperty('GIT_NO_LAZY_FETCH')
  commands.length = 0
  const [manual] = await worker.status(project, [project], 'manual', check)
  expect(manual.repositories[0]).toMatchObject({ branch: 'main' })
  expect(commands.filter(command => command === 'fetch' || command === 'status')).toEqual(['fetch', 'status'])
  trusted = true
  commands.length = 0
  const [local] = await worker.status(project, [project], 'local', check)
  expect(local.repositories[0]).toMatchObject({ branch: 'main' })
  expect(commands).toContain('status')
  expect(commands).not.toContain('fetch')
}, 15000)

test('does not automatically fetch for a linked worktree outside the approved folder, including through an alias', async () => {
  const fixture = await fixtureDirectory()
  const project = path.join(fixture, 'project')
  const outside = path.join(fixture, 'outside-worktree')
  const alias = path.join(project, 'linked')
  const source = path.join(fixture, 'source')
  const insideRepo = path.join(project, 'service')
  const outsideRepo = path.join(outside, 'service')
  await git(fixture, 'init', '-b', 'main', project)
  await commit(project, 'project-readme')
  await git(project, 'worktree', 'add', '-b', 'outside', outside)
  await fs.symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await git(fixture, 'init', '-b', 'main', source)
  await commit(source, 'initial')
  await git(project, 'clone', source, insideRepo)
  await git(outside, 'clone', source, outsideRepo)
  const initial = await git(source, 'rev-parse', 'HEAD')
  await commit(source, 'incoming')
  const incoming = await git(source, 'rev-parse', 'HEAD')

  const handlers = new Map()
  registerNestedRepositoryIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, fromMainWindow: () => true,
    isLocked: () => false, discover, confirmTrust: async () => true,
    worktrees: async root => (await inspectLocalProject(root)).repo.worktrees
  })
  const frame = {}
  const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } }
  const ask = (channel, input) => handlers.get('local-nested-repositories-' + channel)(event, input)
  expect(await ask('trust', { project, enabled: true })).toMatchObject({ success: true, trusted: true })
  expect(await ask('status', { project, roots: [outside, alias, project], fetch: true })).toMatchObject({
    success: true, groups: [
      { root: outside, manualOnly: true, repositories: [{ path: outsideRepo, behind: 0 }] },
      { root: alias, manualOnly: true, repositories: [{ path: outsideRepo, behind: 0 }] },
      { root: project, manualOnly: false, repositories: [{ path: insideRepo, behind: 1 }] }
    ]
  })
  expect(await git(outsideRepo, 'rev-parse', '@{upstream}')).toBe(initial)
  expect(await git(insideRepo, 'rev-parse', '@{upstream}')).toBe(incoming)
  expect(await ask('fetch', { project, roots: [outside] })).toMatchObject({
    success: true, groups: [{ root: outside, repositories: [{ behind: 1 }] }]
  })
  expect(await git(outsideRepo, 'rev-parse', '@{upstream}')).toBe(incoming)
}, 20000)

test('discards every stored approval when the trust file schema is incomplete or invalid', async () => {
  const folder = await fixtureDirectory()
  const file = path.join(folder, 'trust.json')
  const trust = nestedTrust.createNestedRepositoryTrust(file)
  const valid = { folder, identity: await trust.identify(folder) }
  await fs.writeFile(file, JSON.stringify({ autoFetchEnabled: false, trusted: [valid] }))
  expect(await trust.trusted(folder)).toBe(true)
  expect(trust.preferences().autoFetchEnabled).toBe(false)

  for (const state of [
    { trusted: [valid] },
    { autoFetchEnabled: 'false', trusted: [valid] },
    { autoFetchEnabled: false, trusted: [valid, { folder, identity: 'invalid' }] },
    { autoFetchEnabled: true, trusted: [valid, null] },
    { autoFetchEnabled: false, trusted: { folder } }
  ]) {
    await fs.writeFile(file, JSON.stringify(state))
    expect(await trust.trusted(folder)).toBe(false)
    expect(trust.preferences().autoFetchEnabled).toBe(true)
  }
})

test('lists current and remote-only branches offline and switches from detached HEAD or tracks a remote branch', async () => {
  const fixture = await fixtureDirectory()
  const project = path.join(fixture, 'project')
  const source = path.join(fixture, 'source')
  const directory = path.join(project, 'service')
  await fs.mkdir(project)
  await git(fixture, 'init', '-b', 'main', source)
  await commit(source, 'initial')
  await git(source, 'branch', 'team/remote')
  await git(project, 'clone', source, directory)
  await git(directory, 'branch', 'local')

  const commands = []
  const worker = createNestedRepositories({ discover, runGit: (cwd, args, options) => {
    commands.push({ args, options })
    return nestedGit.git(cwd, args, options)
  } })
  expect(await worker.branches(project, 'service', check)).toEqual([
    { name: 'local', current: false },
    { name: 'main', current: true },
    { name: 'team/remote', remote: 'origin', current: false }
  ])
  await expect(worker.switchBranch(project, 'service', { name: '--detach' }, check)).rejects.toThrow('목록')
  await expect(worker.switchBranch(project, 'service', { name: 'not-listed' }, check)).rejects.toThrow('현재 목록에 없습니다')
  await expect(worker.switchBranch(project, 'service', { name: 'main', remote: 'origin' }, check)).rejects.toThrow('현재 목록에 없습니다')
  await expect(worker.branches(project, '../source', check)).rejects.toThrow('발견된 하위 저장소')
  expect(commands.some(command => command.args[0] === 'switch')).toBe(false)

  await git(directory, 'switch', '--detach')
  expect(await worker.switchBranch(project, 'service', { name: 'local' }, check)).toMatchObject({ branch: 'local' })
  expect(await git(directory, 'branch', '--show-current')).toBe('local')
  const remote = await worker.switchBranch(project, 'service', { name: 'team/remote', remote: 'origin' }, check)
  expect(remote).toMatchObject({ branch: 'team/remote', hasUpstream: true })
  expect(await git(directory, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/team/remote')
  expect(commands.some(command => command.args[0] === 'fetch' || command.options?.network)).toBe(false)
  expect(nestedGit.gitEnvironment({ inherited: {} })).toHaveProperty('GIT_ALLOW_PROTOCOL', '')
}, 15000)

// main and other share `initial`; `shared` has five lines and other changed line 5.
async function smartCheckoutFixture() {
  const project = await fixtureDirectory()
  const directory = path.join(project, 'service')
  await git(project, 'init', '-b', 'main', directory)
  await git(directory, 'config', '--local', 'core.autocrlf', 'false')
  await commit(directory, 'initial')
  const shared = path.join(directory, 'shared')
  await fs.writeFile(shared, 'one\ntwo\nthree\nfour\nfive\n')
  await git(directory, 'add', 'shared')
  await git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'shared')
  await git(directory, 'switch', '-c', 'other')
  await fs.writeFile(shared, 'one\ntwo\nthree\nfour\nfive on other\n')
  await git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'other')
  await git(directory, 'switch', 'main')
  const worker = createNestedRepositories({ discover })
  const switchTo = (name, mode) => worker.switchBranch(project, 'service', { name }, check, mode && { mode })
  return { project, directory, shared, switchTo }
}
const stashes = directory => git(directory, 'stash', 'list', '--format=%s')

test('carries changes the target branch does not touch and reports overlapping ones without changing anything', async () => {
  const { directory, shared, switchTo } = await smartCheckoutFixture()
  await fs.writeFile(path.join(directory, 'initial'), 'edited')
  expect(await switchTo('other')).toMatchObject({ branch: 'other', changed: 1 })
  expect(await fs.readFile(path.join(directory, 'initial'), 'utf8')).toBe('edited')
  expect(await switchTo('main')).toMatchObject({ branch: 'main' })

  await fs.writeFile(shared, 'one edited\ntwo\nthree\nfour\nfive\n')
  expect(await switchTo('other')).toEqual({ localChanges: ['shared'] })
  await git(directory, 'add', 'shared')
  expect(await switchTo('other')).toEqual({ localChanges: ['shared'] })
  expect(await git(directory, 'branch', '--show-current')).toBe('main')
  expect(await fs.readFile(shared, 'utf8')).toBe('one edited\ntwo\nthree\nfour\nfive\n')
  expect(await stashes(directory)).toBe('')
}, 15000)

test('smart checkout puts the changes aside, switches and applies them again', async () => {
  const { directory, shared, switchTo } = await smartCheckoutFixture()
  await fs.writeFile(shared, 'one edited\ntwo\nthree\nfour\nfive\n')
  await fs.writeFile(path.join(directory, 'notes'), 'untracked stays')
  expect(await switchTo('other', 'smart')).toMatchObject({ branch: 'other', checkout: { kind: 'smart', conflicts: [] } })
  expect(await fs.readFile(shared, 'utf8')).toBe('one edited\ntwo\nthree\nfour\nfive on other\n')
  expect(await fs.readFile(path.join(directory, 'notes'), 'utf8')).toBe('untracked stays')
  expect(await stashes(directory)).toBe('')
}, 15000)

test('smart checkout keeps the stash and lists files when applying the changes conflicts', async () => {
  const { directory, shared, switchTo } = await smartCheckoutFixture()
  await fs.writeFile(shared, 'one\ntwo\nthree\nfour\nfive on main\n')
  const result = await switchTo('other', 'smart')
  expect(result).toMatchObject({ branch: 'other', checkout: { kind: 'smart', conflicts: ['shared'] } })
  expect(result.checkout.stash).toMatch(/^ezShell 스마트 체크아웃: main → other/)
  expect(await stashes(directory)).toContain('ezShell 스마트 체크아웃: main → other')
  expect(await fs.readFile(shared, 'utf8')).toContain('<<<<<<<')
}, 15000)

test('smart checkout restores the changes on the original branch when the switch itself fails', async () => {
  const { directory, shared, switchTo } = await smartCheckoutFixture()
  await git(directory, 'switch', 'other')
  await commit(directory, 'collision')
  await git(directory, 'switch', 'main')
  await fs.writeFile(shared, 'one\ntwo\nthree\nfour\nfive on main\n')
  await git(directory, 'add', 'shared')
  await fs.writeFile(path.join(directory, 'collision'), 'keep my file')
  await expect(switchTo('other', 'smart')).rejects.toThrow('추적하지 않는 파일을 덮어씁니다')
  expect(await git(directory, 'branch', '--show-current')).toBe('main')
  expect(await git(directory, 'diff', '--cached', '--name-only')).toBe('shared')
  expect(await fs.readFile(shared, 'utf8')).toBe('one\ntwo\nthree\nfour\nfive on main\n')
  expect(await fs.readFile(path.join(directory, 'collision'), 'utf8')).toBe('keep my file')
  expect(await stashes(directory)).toBe('')
}, 15000)

test('force checkout switches to the target version and keeps the discarded changes as a stash backup', async () => {
  const { directory, shared, switchTo } = await smartCheckoutFixture()
  await fs.writeFile(shared, 'one\ntwo\nthree\nfour\nfive on main\n')
  await fs.writeFile(path.join(directory, 'notes'), 'untracked stays')
  const result = await switchTo('other', 'force')
  expect(result).toMatchObject({ branch: 'other', checkout: { kind: 'force' } })
  expect(await git(directory, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  expect(result.checkout.stash).toMatch(/^ezShell 강제 체크아웃 백업: main → other/)
  expect(await fs.readFile(shared, 'utf8')).toBe('one\ntwo\nthree\nfour\nfive on other\n')
  expect(await fs.readFile(path.join(directory, 'notes'), 'utf8')).toBe('untracked stays')
  expect(await stashes(directory)).toContain('ezShell 강제 체크아웃 백업: main → other')
  await expect(switchTo('main', 'sideways')).rejects.toThrow('체크아웃 방식')
}, 15000)

test('blocks in-progress checkouts and protects untracked files when switching branches', async () => {
  const project = await fixtureDirectory()
  const directory = path.join(project, 'service')
  await git(project, 'init', '-b', 'main', directory)
  await commit(directory, 'initial')
  await git(directory, 'switch', '-c', 'other')
  await commit(directory, 'collision')
  await git(directory, 'switch', 'main')
  const worker = createNestedRepositories({ discover })
  const switchBranch = () => worker.switchBranch(project, 'service', { name: 'other' }, check)

  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'sequencer']) {
    const file = path.join(directory, '.git', marker)
    await fs.writeFile(file, 'operation marker')
    await expect(switchBranch()).rejects.toThrow('진행 중')
    await fs.unlink(file)
  }
  const untracked = path.join(directory, 'collision')
  await fs.writeFile(untracked, 'keep my file')
  await expect(switchBranch()).rejects.toThrow('추적하지 않는 파일을 덮어씁니다')
  await fs.appendFile(path.join(directory, '.git', 'info', 'exclude'), '\ncollision\n')
  await expect(switchBranch()).rejects.toThrow('추적하지 않는 파일을 덮어씁니다')
  expect(await fs.readFile(untracked, 'utf8')).toBe('keep my file')
  expect(await git(directory, 'branch', '--show-current')).toBe('main')
}, 15000)

test('switching a partial clone leaves a missing branch offline and reports unavailable objects', async () => {
  const fixture = await fixtureDirectory()
  const project = path.join(fixture, 'project')
  const source = path.join(fixture, 'source')
  const directory = path.join(project, 'service')
  await fs.mkdir(project)
  await git(fixture, 'init', '-b', 'main', source)
  await git(source, 'config', 'uploadpack.allowFilter', 'true')
  await commit(source, 'initial')
  await git(source, 'switch', '-c', 'needs-blob')
  await commit(source, 'missing-in-clone')
  await git(source, 'switch', 'main')
  await git(project, 'clone', '--filter=blob:none', pathToFileURL(source).href, directory)
  const worker = createNestedRepositories({ discover })
  await expect(worker.switchBranch(project, 'service', { name: 'needs-blob', remote: 'origin' }, check))
    .rejects.toThrow('필요한 Git 객체가 이 부분 복제 저장소에 없습니다')
  expect(await git(directory, 'branch', '--show-current')).toBe('main')
  expect(await git(directory, 'branch', '--list', 'needs-blob')).toBe('')
}, 15000)

test('requests confirmation before a branch switch with a local filter configuration', async () => {
  const project = await fixtureDirectory()
  const directory = path.join(project, 'service')
  await git(project, 'init', '-b', 'main', directory)
  await commit(directory, 'initial')
  await git(directory, 'branch', 'other')
  await git(directory, 'config', '--local', 'filter.fixture.smudge', 'git')
  let allow = false
  const confirmSettings = vi.fn(async () => allow)
  const worker = createNestedRepositories({ discover, confirmSettings })
  const switchBranch = () => worker.switchBranch(project, 'service', { name: 'other' }, check)
  expect(await worker.branches(project, 'service', check)).toHaveLength(2)
  expect(confirmSettings).not.toHaveBeenCalled()
  await expect(switchBranch()).rejects.toThrow('저장소 설정 확인 필요')
  expect(await git(directory, 'branch', '--show-current')).toBe('main')
  expect(confirmSettings).toHaveBeenCalledWith({ directory, keys: ['filter.fixture.smudge'] })
  allow = true
  expect(await switchBranch()).toMatchObject({ branch: 'other' })
}, 15000)

test('lists and changes remotes with the same address checks as fetching', async () => {
  const fixture = await fixtureDirectory()
  const project = path.join(fixture, 'work')
  const directory = path.join(project, 'service')
  const bare = path.join(fixture, 'remote.git')
  await git(fixture, 'init', '--bare', '-b', 'main', bare)
  await git(fixture, 'init', '-b', 'main', directory)
  await commit(directory, 'initial')
  await git(bare, 'fetch', directory, 'main:main')
  await git(directory, 'remote', 'add', 'origin', 'http://git.example.invalid/team/service.git')
  await git(directory, 'config', 'remote.origin.pushurl', 'git@git.example.invalid:team/service.git')
  await git(directory, 'remote', 'add', 'mirror', 'https://user:secret@git.example.invalid/team/service.git')
  const commands = []
  const worker = createNestedRepositories({ discover, runGit: (cwd, args, options) => {
    commands.push({ args, options })
    return nestedGit.git(cwd, args, options)
  } })

  const listed = await worker.remotes(project, 'service', check)
  expect(listed).toEqual([
    { name: 'origin', url: 'http://git.example.invalid/team/service.git', pushUrl: 'git@git.example.invalid:team/service.git',
      problem: expect.stringContaining('HTTPS, SSH') },
    { name: 'mirror', url: 'https://user:***@git.example.invalid/team/service.git', hasPassword: true }
  ])
  expect(JSON.stringify(listed)).not.toContain('secret')
  await expect(worker.remotes(project, '../remote.git', check)).rejects.toThrow('발견된 하위 저장소')

  const change = remote => worker.setRemote(project, 'service', remote, check)
  await expect(change({ name: 'origin', url: 'http://git.example.invalid/other.git' })).rejects.toThrow('HTTPS, SSH')
  await expect(change({ name: 'origin', url: 'https://user:pass@git.example.invalid/x.git' })).rejects.toThrow('비밀번호')
  await expect(change({ name: 'origin', url: '\\\\server\\share\\repo.git' })).rejects.toThrow('UNC')
  await expect(change({ name: 'origin', url: '--upload-pack=calc' })).rejects.toThrow('원격 주소')
  await expect(change({ name: 'unknown', url: 'https://git.example.invalid/x.git' })).rejects.toThrow('목록')
  await expect(change({ name: '-x', url: bare, add: true })).rejects.toThrow('원격 이름')
  await expect(change({ name: 'mirror', url: bare, add: true })).rejects.toThrow('이미 있는')
  expect(await git(directory, 'config', 'remote.origin.url')).toBe('http://git.example.invalid/team/service.git')

  const changed = await change({ name: 'origin', url: 'https://git.example.invalid/team/service.git', pushUrl: '' })
  expect(changed.remotes[0]).toEqual({ name: 'origin', url: 'https://git.example.invalid/team/service.git' })
  expect(changed.status).toMatchObject({ folder: 'service', branch: 'main' })
  expect(await git(directory, 'config', '--get-all', 'remote.origin.pushurl').catch(() => '')).toBe('')
  await change({ name: 'origin', pushUrl: 'ssh://git@git.example.invalid/team/service.git' })
  expect(await git(directory, 'config', 'remote.origin.pushurl')).toBe('ssh://git@git.example.invalid/team/service.git')
  expect(await git(directory, 'config', 'remote.origin.url')).toBe('https://git.example.invalid/team/service.git')

  const added = await change({ name: 'backup', url: bare, add: true })
  expect(added.remotes.map(remote => remote.name)).toEqual(['origin', 'mirror', 'backup'])
  expect(await worker.testRemote(project, 'service', { url: bare }, check)).toEqual({ heads: 1 })
  expect(await worker.testRemote(project, 'service', { name: 'backup' }, check)).toEqual({ heads: 1 })
  await expect(worker.testRemote(project, 'service', { url: 'http://git.example.invalid/x.git' }, check)).rejects.toThrow('HTTPS, SSH')
  await expect(worker.testRemote(project, 'service', { name: 'unknown' }, check)).rejects.toThrow('목록')
  expect(commands.filter(command => command.options?.network).map(command => command.args[0])).toEqual(['ls-remote', 'ls-remote'])

  const removed = await worker.removeRemote(project, 'service', { name: 'mirror' }, check)
  expect(removed.remotes.map(remote => remote.name)).toEqual(['origin', 'backup'])
  await expect(worker.removeRemote(project, 'service', { name: 'mirror' }, check)).rejects.toThrow('목록')
}, 20000)

test('asks to confirm risky repository settings before changing a remote', async () => {
  const project = await fixtureDirectory()
  const directory = path.join(project, 'service')
  await git(project, 'init', '-b', 'main', directory)
  await commit(directory, 'initial')
  await git(directory, 'remote', 'add', 'origin', 'http://git.example.invalid/service.git')
  await git(directory, 'config', '--local', 'filter.fixture.smudge', 'git')
  let allow = false
  const worker = createNestedRepositories({ discover, confirmSettings: async () => allow })
  const change = () => worker.setRemote(project, 'service', { name: 'origin', url: 'https://git.example.invalid/service.git' }, check)
  await expect(change()).rejects.toThrow('저장소 설정 확인 필요')
  expect(await git(directory, 'config', 'remote.origin.url')).toBe('http://git.example.invalid/service.git')
  allow = true
  await change()
  expect(await git(directory, 'config', 'remote.origin.url')).toBe('https://git.example.invalid/service.git')
}, 15000)
