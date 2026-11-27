const fs = require('fs')
const path = require('path')
const { stripVTControlCharacters } = require('util')
const { isLocalFilePath } = require('../localKeyPath.js')
const { sameOrInside } = require('../localFiles/roots.js')
const { realDirectory } = require('./runPresetStore.js')
const { redactRunSecrets } = require('./runSecrets.js')
const { git, inspectLocalSettings, fetchCurrent, optionalGit, readBranches, readRemotes, remoteAddress, remoteProblem,
  trimLine } = require('./nestedGit.js')
const { createNestedRepositoryTrust } = require('./nestedRepositoryTrust.js')

const FETCH_INTERVAL = 10 * 60_000
const MAX_PARALLEL = 4
const PAUSED = '잠금 해제 후 본창에서 이용할 수 있습니다.'
const SKIP_MESSAGES = {
  dirty: '수정한 파일이 있습니다.',
  diverged: '로컬과 업스트림의 커밋이 서로 갈라졌습니다.',
  'no-upstream': '업스트림이 없습니다.',
  gone: '원격 브랜치가 지워졌습니다.',
  detached: '분리된 HEAD 상태입니다.',
  current: '받을 커밋이 없습니다.'
}
const CONFIRM_SETTINGS = '저장소 설정 확인 필요'
const PARTIAL_CLONE = '부분 복제 · 원격 확인을 눌러 읽기'
const READ_FAILED = 'Git 상태를 읽지 못했습니다.'
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const REMOTE_NOT_LISTED = '이 원격은 현재 목록에 없습니다. 목록을 다시 열어 주세요.'
const samePath = (a, b) => path.relative(a, b) === ''
const key = value => process.platform === 'win32' ? value.toLowerCase() : value
const withinProject = (project, folder) => sameOrInside(key(project), key(folder))

function messageOf(error, fallback) {
  const message = error?.stderr?.trim() || (!error?.code && error?.message) || fallback
  if (/dubious ownership/i.test(message)) return '이 폴더의 소유자가 달라 Git이 읽기를 거부했습니다.'
  return redactRunSecrets(stripVTControlCharacters(message))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500) || fallback
}

function parseStatus(output) {
  let branch = null, oid = null, upstream = false, hasUpstream = false, ahead = 0, behind = 0, changed = 0
  const records = output.split('\0')
  for (let offset = 0; offset < records.length; offset++) {
    const record = records[offset]
    if (record.startsWith('# branch.head ')) {
      const head = record.slice(14)
      branch = head === '(detached)' ? null : head
    } else if (record.startsWith('# branch.oid ')) {
      const head = record.slice(13)
      if (head !== '(initial)') oid = head
    } else if (record.startsWith('# branch.upstream ')) {
      upstream = true
    } else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record)
      if (match) {
        hasUpstream = true
        ahead = Number(match[1])
        behind = Number(match[2])
      }
    } else if (/^[12u?] /.test(record)) {
      changed++
      if (record.startsWith('2 ')) offset++
    }
  }
  return { oid, branch, hasUpstream, upstreamGone: upstream && !hasUpstream, ahead, behind, changed }
}

// Inspect each path component with lstat before going further. In particular, do not follow a
// directory junction or a .git file to a share, even when Git would consider it a checkout.
async function plainPath(root, name) {
  if (!isLocalFilePath(name) || !sameOrInside(key(root), key(name))) return null
  let current = root
  let info = await fs.promises.lstat(root)
  for (const part of path.relative(root, name).split(path.sep).filter(Boolean)) {
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    current = path.join(current, part)
    info = await fs.promises.lstat(current)
  }
  return info.isSymbolicLink() ? null : info
}

async function metadataPath(root, directory) {
  if (!isLocalFilePath(directory) || samePath(root, directory) || !(await plainPath(root, directory))?.isDirectory()) return null
  let marker = path.join(directory, '.git')
  const info = await plainPath(root, marker)
  if (info?.isFile() && info.size <= 4096) {
    const content = await fs.promises.readFile(marker, 'utf8')
    const pointer = /^gitdir: (.+)\r?\n?$/.exec(content)?.[1]
    if (!pointer || /^[\\/]{2}|^[a-z]+:\/\//i.test(pointer)) return null
    marker = path.resolve(directory, pointer)
    // A submodule points into the containing repository's .git/modules. Linked worktrees are
    // represented by the project's regular worktree list and do not belong to this feature.
    const parts = path.relative(root, marker).split(path.sep)
    const dotGit = parts.findIndex(part => key(part) === '.git')
    if (dotGit < 0 || parts[dotGit + 1] !== 'modules' || !(await plainPath(root, marker))?.isDirectory()) return null
    const container = path.join(root, ...parts.slice(0, dotGit))
    if (!sameOrInside(key(container), key(directory)) || samePath(container, directory)) return null
  } else if (!info?.isDirectory()) {
    return null
  }
  const commonDir = await fs.promises.lstat(path.join(marker, 'commondir')).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  return commonDir ? null : marker
}

function createRepositoryQueue() {
  const pending = []
  const active = new Set()
  const shared = new Map()
  function drain() {
    while (active.size < MAX_PARALLEL) {
      const index = pending.findIndex(task => !active.has(task.key))
      if (index < 0) break
      const [task] = pending.splice(index, 1)
      active.add(task.key)
      Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
        active.delete(task.key)
        drain()
      })
    }
  }
  return (folder, run, reuse) => {
    if (reuse && shared.has(reuse)) return shared.get(reuse)
    const job = new Promise((resolve, reject) => pending.push({ key: key(folder), run, resolve, reject }))
    if (reuse) {
      shared.set(reuse, job)
      const release = () => shared.delete(reuse)
      job.then(release, release)
    }
    drain()
    return job
  }
}

const readStatus = async (cwd, runGit, untracked = 'all') => parseStatus(await runGit(cwd,
  ['status', '--porcelain=v2', '--branch', '--ahead-behind', '-z', `--untracked-files=${untracked}`, '--ignore-submodules=dirty']))
const relativeOf = (root, directory) => path.relative(root, directory).split(path.sep).join('/')

async function isOperationInProgress(metadata) {
  const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer']
  return (await Promise.all(markers.map(marker => fs.promises.lstat(path.join(metadata, marker)).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })))).some(Boolean)
}

function branchSwitchError(error, partialClone) {
  const details = error.stderr ?? ''
  if (/untracked working tree files would be overwritten/i.test(details)) {
    return new Error('이 브랜치로 바꾸면 Git이 추적하지 않는 파일을 덮어씁니다. 해당 파일을 다른 곳으로 옮긴 뒤 다시 시도해 주세요.')
  }
  if (partialClone && /promisor|missing|unable to read|could not (?:read|fetch)|transport.+not allowed/i.test(details)) {
    return new Error('브랜치를 바꾸는 데 필요한 Git 객체가 이 부분 복제 저장소에 없습니다.')
  }
  return error
}

function skipReason(status) {
  if (!status.branch) return 'detached'
  if (status.upstreamGone) return 'gone'
  if (!status.hasUpstream) return 'no-upstream'
  if (status.changed) return 'dirty'
  if (status.ahead && status.behind) return 'diverged'
  return null
}

function publicStatus(root, directory, { oid, target, ...state }) {
  return { folder: relativeOf(root, directory), path: directory, ...state }
}

function createNestedRepositories({ discover, runGit = git, now = Date.now, confirmSettings = async () => false,
  allowAutoFetch = async () => false, isTrusted = allowAutoFetch }) {
  const queue = createRepositoryQueue()
  const fetchedAt = new Map()
  const runningPulls = new Set()
  let confirmations = Promise.resolve()

  async function settingsOf(root, directory, check) {
    check()
    const metadata = await metadataPath(root, directory)
    return metadata && { metadata, ...await inspectLocalSettings(directory, metadata, runGit) }
  }

  async function verify(directory, check) {
    check()
    const top = (await runGit(directory, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '')
    if (!isLocalFilePath(top) || !samePath(directory, top)) throw new Error('하위 Git 저장소 경로를 확인할 수 없습니다.')
    check()
  }

  async function settingsUnchanged(root, directory, settings, check) {
    const current = await settingsOf(root, directory, check)
    if (current?.fingerprint !== settings.fingerprint) throw new Error('저장소 설정이 바뀌었습니다. 다시 받아 주세요.')
  }

  async function approveSettings(root, directory, settings, check) {
    if (!settings.riskyKeys.length) return true
    const confirmation = confirmations.then(async () => {
      check()
      return confirmSettings({ directory, keys: settings.riskyKeys })
    })
    confirmations = confirmation.catch(() => {})
    if (!await confirmation) return false
    await settingsUnchanged(root, directory, settings, check)
    return true
  }

  async function statusOf(project, root, directory, mode, check) {
    const location = { folder: relativeOf(root, directory), path: directory }
    try {
      const settings = await settingsOf(root, directory, check)
      if (!settings) return null
      if (settings.partialClone && mode !== 'manual' && !await isTrusted(project, root, directory)) {
        return { ...location, error: PARTIAL_CLONE }
      }
      if (settings.riskyKeys.length && (mode !== 'manual' || !await approveSettings(root, directory, settings, check))) {
        return { ...location, error: CONFIRM_SETTINGS }
      }
      await verify(directory, check)
      let fetchError
      if (mode !== 'local') {
        try {
          const head = await optionalGit(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD'], runGit)
          await fetchCurrent(directory, head.replace(/\r?\n$/, '') || null, runGit, async () => {
            const permitted = mode === 'manual' || await allowAutoFetch(project, root, directory)
            check()
            return permitted
          }, { automatic: mode === 'automatic' })
        } catch (error) { fetchError = messageOf(error, '가져오기에 실패했습니다.') }
      }
      check()
      const info = publicStatus(root, directory, await readStatus(directory, runGit))
      return fetchError ? { ...info, fetchError } : info
    } catch (error) {
      return { ...location, error: messageOf(error, READ_FAILED) }
    }
  }

  async function status(project, roots, mode, check, excluded = []) {
    const groups = await Promise.all(roots.map(async root => [root, (await discover(root))
      .filter(directory => !excluded.some(folder => samePath(directory, folder)))]))
    const automaticRoots = mode === 'automatic' ? new Set((await Promise.all(groups.map(async ([root, directories]) =>
      directories.length && await allowAutoFetch(project, root) ? root : null))).filter(Boolean)) : new Set()
    check()
    const last = fetchedAt.get(key(project))
    const fetchNow = automaticRoots.size > 0 && (last === undefined || now() - last >= FETCH_INTERVAL)
    if (fetchNow) {
      const time = now()
      for (const [id, at] of fetchedAt) if (time - at >= FETCH_INTERVAL) fetchedAt.delete(id)
      fetchedAt.set(key(project), time)
    }
    return Promise.all(groups.map(async ([root, directories]) => {
      const operation = mode === 'manual' ? 'manual' : fetchNow && automaticRoots.has(root) ? 'automatic' : 'local'
      const repositories = await Promise.all(directories.map(directory => queue(directory,
        () => statusOf(project, root, directory, operation, check),
        `${key(project)}\0${key(root)}\0${key(directory)}\0${operation}`)))
      return { root, repositories: repositories.filter(Boolean) }
    }))
  }

  async function pull(root, folders, check, progress) {
    const found = new Map((await discover(root)).map(directory => [relativeOf(root, directory), directory]))
    check()
    const requested = [...new Set(folders)]
    if (!requested.length || requested.some(folder => !found.has(folder))) throw new Error('발견된 하위 저장소만 받을 수 있습니다.')
    for (const folder of requested) progress({ folder, kind: 'queued' })
    return Promise.all(requested.map(async folder => {
      const directory = found.get(folder)
      const id = key(directory)
      if (runningPulls.has(id)) {
        const result = { folder, kind: 'skipped', reason: 'busy', message: '이미 받는 중입니다.' }
        progress(result)
        return result
      }
      runningPulls.add(id)
      try {
        return await queue(directory, async () => {
          progress({ folder, kind: 'running' })
          let result
          try {
            result = await pullOne(root, directory, check)
          } catch (error) {
            result = { kind: 'failed', message: messageOf(error, '최신 커밋을 받지 못했습니다.') }
          }
          const update = { folder, ...result }
          progress(update)
          return update
        })
      } finally {
        runningPulls.delete(id)
      }
    }))
  }

  async function discoveredRepository(root, folder, check) {
    check()
    const directory = (await discover(root)).find(candidate => relativeOf(root, candidate) === folder)
    if (!directory) throw new Error('발견된 하위 저장소만 사용할 수 있습니다.')
    return directory
  }

  async function branches(root, folder, check) {
    const directory = await discoveredRepository(root, folder, check)
    return queue(directory, async () => {
      if (!await settingsOf(root, directory, check)) throw new Error('하위 Git 저장소 경로를 확인할 수 없습니다.')
      await verify(directory, check)
      return readBranches(directory, runGit)
    })
  }

  async function switchBranch(root, folder, { name, remote }, check) {
    if (typeof name !== 'string' || !name || name.startsWith('-') || (remote !== undefined && typeof remote !== 'string')) {
      throw new Error('목록에서 바꿀 브랜치를 선택해 주세요.')
    }
    const directory = await discoveredRepository(root, folder, check)
    return queue(directory, async () => {
      const settings = await settingsOf(root, directory, check)
      if (!settings) throw new Error('하위 Git 저장소 경로를 확인할 수 없습니다.')
      if (await isOperationInProgress(settings.metadata)) {
        throw new Error('병합, 리베이스 또는 체리픽이 진행 중입니다. 진행 중인 Git 작업을 끝낸 뒤 다시 시도해 주세요.')
      }
      if (!await approveSettings(root, directory, settings, check)) throw new Error(CONFIRM_SETTINGS)
      await verify(directory, check)
      const chosen = (await readBranches(directory, runGit)).find(branch => branch.name === name && branch.remote === remote)
      if (!chosen) throw new Error('이 브랜치는 현재 목록에 없습니다. 목록을 다시 열어 주세요.')
      await runGit(directory, ['check-ref-format', '--branch', chosen.name])
      await settingsUnchanged(root, directory, settings, check)
      if ((await readStatus(directory, runGit, 'no')).changed) {
        throw new Error('수정하거나 스테이징한 파일이 있습니다. 변경을 정리한 뒤 브랜치를 바꿔 주세요.')
      }
      check()
      const args = chosen.remote
        ? ['-c', chosen.name, '--track', '--', `refs/remotes/${chosen.remote}/${chosen.name}`]
        : ['--', chosen.name]
      try { await runGit(directory, ['switch', '--no-guess', '--no-overwrite-ignore', ...args]) }
      catch (error) { throw branchSwitchError(error, settings.partialClone) }
      try { return publicStatus(root, directory, await readStatus(directory, runGit)) }
      catch (error) { return { folder, path: directory, error: messageOf(error, READ_FAILED) } }
    })
  }

  // Remote addresses (2026-11-27 user request): see and fix an address fetching refuses, e.g. http://
  function remoteTask(root, folder, check, { confirm = true } = {}, run) {
    return discoveredRepository(root, folder, check).then(directory => queue(directory, async () => {
      const settings = await settingsOf(root, directory, check)
      if (!settings) throw new Error('하위 Git 저장소 경로를 확인할 수 없습니다.')
      if (confirm && !await approveSettings(root, directory, settings, check)) throw new Error(CONFIRM_SETTINGS)
      await verify(directory, check)
      return run(directory, settings, await readRemotes(directory, runGit))
    }))
  }

  const listedRemote = (listed, name) => {
    const remote = typeof name === 'string' && !name.startsWith('-') && listed.find(item => item.name === name)
    if (!remote) throw new Error(REMOTE_NOT_LISTED)
    return remote
  }

  async function remoteResult(root, directory) {
    const remotes = await readRemotes(directory, runGit)
    try { return { remotes, status: publicStatus(root, directory, await readStatus(directory, runGit)) } }
    catch (error) { return { remotes, status: { folder: relativeOf(root, directory), path: directory, error: messageOf(error, READ_FAILED) } } }
  }

  function remotes(root, folder, check) {
    return remoteTask(root, folder, check, { confirm: false }, (directory, settings, listed) => listed)
  }

  function setRemote(root, folder, { name, url, pushUrl, add = false } = {}, check) {
    if ((url !== undefined && typeof url !== 'string') || (pushUrl !== undefined && typeof pushUrl !== 'string') || typeof add !== 'boolean') {
      return Promise.reject(new Error('원격 주소를 확인해 주세요.'))
    }
    return remoteTask(root, folder, check, {}, async (directory, settings, listed) => {
      let current
      if (add) {
        if (typeof name !== 'string' || !REMOTE_NAME.test(name)) throw new Error('원격 이름은 영문, 숫자, 점, 밑줄, 하이픈만 쓸 수 있습니다.')
        if (listed.some(remote => remote.name.toLowerCase() === name.toLowerCase())) throw new Error('이미 있는 원격 이름입니다.')
        if (url === undefined) throw new Error('원격 주소를 확인해 주세요.')
      } else {
        current = listedRemote(listed, name)
      }
      const address = url === undefined ? undefined : await remoteAddress(directory, url)
      const push = pushUrl === undefined || pushUrl.trim() === '' ? pushUrl?.trim() : await remoteAddress(directory, pushUrl)
      await settingsUnchanged(root, directory, settings, check)
      check()
      if (address !== undefined) await runGit(directory, ['remote', add ? 'add' : 'set-url', '--', name, address])
      if (push === '' && current?.pushUrl !== undefined) {
        await runGit(directory, ['config', '--local', '--unset-all', `remote.${name}.pushurl`])
      } else if (push) {
        await runGit(directory, ['config', '--local', '--replace-all', `remote.${name}.pushurl`, push])
      }
      return remoteResult(root, directory)
    })
  }

  function removeRemote(root, folder, { name } = {}, check) {
    return remoteTask(root, folder, check, {}, async (directory, settings, listed) => {
      listedRemote(listed, name)
      await settingsUnchanged(root, directory, settings, check)
      check()
      await runGit(directory, ['remote', 'remove', '--', name])
      return remoteResult(root, directory)
    })
  }

  /** Whether the server answers at an address (typed, or a saved remote's) before keeping it */
  function testRemote(root, folder, { name, url } = {}, check) {
    return remoteTask(root, folder, check, {}, async (directory, settings, listed) => {
      let target
      if (url !== undefined) {
        target = await remoteAddress(directory, url)
      } else {
        const remote = listedRemote(listed, name)
        const vcs = trimLine(await optionalGit(directory, ['config', '--local', '--get', `remote.${name}.vcs`], runGit))
        const saved = trimLine(await runGit(directory, ['config', '--local', '--get', `remote.${name}.url`]))
        const problem = await remoteProblem(directory, { url: saved, vcs })
        if (problem) throw new Error(problem)
        target = remote.name
      }
      const sshCommand = trimLine(await optionalGit(directory, ['config', '--get', 'core.sshCommand'], runGit))
      await settingsUnchanged(root, directory, settings, check)
      check()
      const output = await runGit(directory, ['ls-remote', '--heads', '--', target], { network: true, sshCommand, timeout: 30_000 })
      return { heads: output.split(/\r?\n/).filter(Boolean).length }
    })
  }

  async function pullOne(root, directory, check) {
    const settings = await settingsOf(root, directory, check)
    if (!settings) throw new Error('하위 Git 저장소 경로를 확인할 수 없습니다.')
    if (!await approveSettings(root, directory, settings, check)) {
      return { kind: 'skipped', reason: 'settings', message: CONFIRM_SETTINGS }
    }
    await verify(directory, check)
    const before = await readStatus(directory, runGit)
    const skipped = (reason, state) => ({ kind: 'skipped', reason, message: SKIP_MESSAGES[reason], status: publicStatus(root, directory, state) })
    const reason = skipReason(before)
    if (reason) return skipped(reason, before)
    check()
    await settingsUnchanged(root, directory, settings, check)
    await fetchCurrent(directory, before.branch, runGit, check)
    await settingsUnchanged(root, directory, settings, check)
    await verify(directory, check)
    const current = await checkedStatus(directory)
    const afterFetch = skipReason(current) || (!current.behind ? 'current' : null)
    if (afterFetch) return skipped(afterFetch, current)
    if (current.branch !== before.branch || current.oid !== before.oid) throw new Error('가져오는 동안 브랜치나 HEAD가 바뀌었습니다.')
    const latest = await checkedStatus(directory)
    if (latest.branch !== current.branch || latest.oid !== current.oid || latest.target !== current.target) {
      throw new Error('받기 직전에 브랜치, HEAD 또는 업스트림 커밋이 바뀌었습니다.')
    }
    const skip = skipReason(latest)
    if (skip) return skipped(skip, latest)
    check()
    await runGit(directory, ['merge', '--quiet', '--ff-only', '--no-verify-signatures', '--no-autostash', current.target], { timeout: 90_000 })
    const after = await readStatus(directory, runGit)
    const count = current.oid && after.oid && current.oid !== after.oid
      ? Number((await runGit(directory, ['rev-list', '--count', `${current.oid}..${after.oid}`])).trim())
      : 0
    return { kind: 'received', count, status: publicStatus(root, directory, after) }
  }

  async function checkedStatus(directory) {
    const state = await readStatus(directory, runGit)
    if (!state.branch || !state.hasUpstream) return state
    const output = await runGit(directory, ['rev-parse', 'HEAD', '@{upstream}^{commit}'])
    const [head, target] = output.trim().split(/\r?\n/)
    if (head !== state.oid || !/^(?:[\da-f]{40}|[\da-f]{64})$/.test(target ?? '')) {
      throw new Error('브랜치의 HEAD와 업스트림 커밋을 확인할 수 없습니다.')
    }
    return { ...state, target }
  }

  return { status, pull, branches, switchBranch, remotes, setRemote, removeRemote, testRemote }
}

async function resolveRoot(folder) {
  if (!isLocalFilePath(folder)) throw new Error('이 PC의 로컬 작업 폴더만 사용할 수 있습니다.')
  const root = await realDirectory(folder)
  if (!isLocalFilePath(root) || root.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) {
    throw new Error('이 PC의 로컬 작업 폴더만 사용할 수 있습니다.')
  }
  return root
}

function registerNestedRepositoryIpc({ ipcMain, fromMainWindow, isLocked, discover, worktrees, confirmSettings,
  trustFile, confirmTrust = async () => false }) {
  const trust = createNestedRepositoryTrust(trustFile)
  async function isTrusted(project, root, directory = root) {
    if (!withinProject(project, root) || !withinProject(project, directory)) return false
    const actual = await resolveRoot(directory).catch(() => null)
    return !!actual && withinProject(project, actual) && samePath(actual, directory) && await trust.trusted(project)
  }
  const service = createNestedRepositories({ discover, confirmSettings, isTrusted,
    allowAutoFetch: async (...scope) => trust.preferences().autoFetchEnabled && await isTrusted(...scope) })
  const handle = (channel, fallback, run) => ipcMain.handle(channel, async (event, input) => {
    const frame = event.senderFrame
    const allowed = () => !!frame && fromMainWindow(event) && !isLocked()
      && !event.sender.isDestroyed() && event.sender.mainFrame === frame
    const check = () => { if (!allowed()) throw new Error(PAUSED) }
    try {
      check()
      const data = await run(input, check, progress => {
        if (allowed()) frame.send('local-nested-repositories-progress', progress)
      })
      check()
      return { success: true, ...data }
    } catch (error) {
      return { success: false, error: messageOf(error, fallback) }
    }
  })
  async function projectRoot(base, requested, getWorktrees) {
    if (!isLocalFilePath(requested)) throw new Error('로컬 작업의 워크트리만 사용할 수 있습니다.')
    if (samePath(base, requested)) return base
    const root = await resolveRoot(requested)
    if (!samePath(base, root) && !(await getWorktrees()).some(tree => samePath(root, tree.path))) {
      throw new Error('로컬 작업의 워크트리만 사용할 수 있습니다.')
    }
    return root
  }
  function projectWorktrees(base) {
    let request
    return () => request ??= (async () => {
      const top = (await git(base, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '')
      return worktrees(await resolveRoot(top))
    })()
  }
  async function readProjects({ project, roots, excluded } = {}, mode, check) {
    if (!Array.isArray(roots) || !roots.length || roots.length > 100) throw new Error('작업 폴더를 확인할 수 없습니다.')
    const base = await resolveRoot(project)
    const listWorktrees = projectWorktrees(base)
    const verified = await Promise.all([...new Set(roots)].map(async root => [root, await projectRoot(base, root, listWorktrees)]))
    const hidden = Array.isArray(excluded) ? excluded.filter(isLocalFilePath).slice(0, 500) : []
    const groups = await service.status(base, [...new Set(verified.map(([, real]) => real))], mode, check, hidden)
    const byRoot = new Map(groups.map(group => [key(group.root), group.repositories]))
    return { trusted: await trust.trusted(base), ...trust.preferences(),
      groups: verified.map(([root, real]) => ({
        root, manualOnly: !withinProject(base, real), repositories: byRoot.get(key(real)) ?? []
      })) }
  }
  handle('local-nested-repositories-status', '하위 저장소를 읽지 못했습니다.', (request, check) =>
    readProjects(request, request?.fetch === true ? 'automatic' : 'local', check))
  handle('local-nested-repositories-fetch', '하위 저장소의 원격을 확인하지 못했습니다.', (request, check) =>
    readProjects(request, 'manual', check))
  handle('local-nested-repositories-preferences', '자동 원격 확인 설정을 저장하지 못했습니다.', (enabled, check) => {
    check()
    return trust.preferences(enabled)
  })
  const confirming = new Set()
  handle('local-nested-repositories-trust', '로컬 작업의 신뢰 설정을 저장하지 못했습니다.', async ({ project, enabled } = {}, check) => {
    if (typeof enabled !== 'boolean') throw new Error('자동 원격 확인 설정을 확인해 주세요.')
    const base = await resolveRoot(project)
    const already = await trust.trusted(base)
    check()
    if (confirming.has(key(base))) throw new Error('이 로컬 작업의 신뢰 설정을 확인 중입니다.')
    if (enabled && !already) {
      confirming.add(key(base))
      try {
        const identity = await trust.identify(base)
        check()
        if (!await confirmTrust({ directory: base })) return { trusted: false, ...trust.preferences() }
        check()
        if (!samePath(base, await resolveRoot(project)) || identity !== await trust.identify(base)) {
          throw new Error('확인하는 동안 로컬 작업 폴더가 바뀌었습니다.')
        }
        trust.update(base, identity)
      } finally { confirming.delete(key(base)) }
    } else if (!enabled) {
      trust.update(base, null)
    }
    return { trusted: await trust.trusted(base), ...trust.preferences() }
  })
  handle('local-nested-repositories-pull', '하위 저장소의 최신 커밋을 받지 못했습니다.', async ({ project, root, folders, requestId } = {}, check, progress) => {
    if (!Array.isArray(folders) || folders.length > 50 || typeof requestId !== 'string' || !/^[\w-]{1,64}$/.test(requestId)) {
      throw new Error('받을 하위 저장소를 확인할 수 없습니다.')
    }
    const base = await resolveRoot(project)
    const verified = await projectRoot(base, root, projectWorktrees(base))
    return { results: await service.pull(verified, folders, check, result => progress({ requestId, result })) }
  })
  async function branchRoot(project, root, folder) {
    if (typeof folder !== 'string' || !folder) throw new Error('하위 Git 저장소를 선택해 주세요.')
    const base = await resolveRoot(project)
    return projectRoot(base, root, projectWorktrees(base))
  }
  handle('local-nested-repository-branches', '브랜치 목록을 읽지 못했습니다.', async ({ project, root, folder } = {}, check) => ({
    branches: await service.branches(await branchRoot(project, root, folder), folder, check)
  }))
  handle('local-nested-repository-remotes', '원격 목록을 읽지 못했습니다.', async ({ project, root, folder } = {}, check) => ({
    remotes: await service.remotes(await branchRoot(project, root, folder), folder, check)
  }))
  handle('local-nested-repository-set-remote', '원격 주소를 저장하지 못했습니다.', async ({ project, root, folder, remote } = {}, check) =>
    service.setRemote(await branchRoot(project, root, folder), folder, remote ?? {}, check))
  handle('local-nested-repository-remove-remote', '원격을 지우지 못했습니다.', async ({ project, root, folder, name } = {}, check) =>
    service.removeRemote(await branchRoot(project, root, folder), folder, { name }, check))
  handle('local-nested-repository-test-remote', '원격 연결을 확인하지 못했습니다.', async ({ project, root, folder, target } = {}, check) =>
    service.testRemote(await branchRoot(project, root, folder), folder, { name: target?.name, url: target?.url }, check))
  handle('local-nested-repository-switch-branch', '브랜치를 바꾸지 못했습니다.', async ({ project, root, folder, branch } = {}, check) => ({
    status: await service.switchBranch(await branchRoot(project, root, folder), folder, branch ?? {}, check)
  }))
}

module.exports = { createNestedRepositories, parseStatus, registerNestedRepositoryIpc }
