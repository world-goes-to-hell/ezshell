const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { isLocalFilePath } = require('../localKeyPath.js')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { SAFE } = require('../localFiles/git.js')
const { stopDevelopmentProcess } = require('./developmentProcess.js')

const PROTOCOLS = [
  '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
  '-c', 'protocol.file.allow=always', '-c', 'protocol.ext.allow=never', '-c', 'protocol.git.allow=never',
  '-c', 'protocol.http.allow=never', '-c', 'core.gitProxy='
]
const GIT_FLAGS = [
  ...SAFE, ...PROTOCOLS, '-c', 'core.hooksPath=/dev/null', '-c', 'core.askPass=',
  '-c', 'fetch.recurseSubmodules=false', '-c', 'submodule.recurse=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'
]
const MAX_OUTPUT = 8 * 1024 * 1024
const DANGEROUS = /^(?:remote\..+\.(?:uploadpack|receivepack|vcs)|core\.(?:gitproxy|sshcommand|askpass|alternaterefscommand)|credential(?:\..+)?\.helper|gpg(?:\..+)?\.program|filter\..+|merge\..+\.driver|diff\..+\.(?:command|textconv))$/i
const INCLUDE = /^(?:include|includeif\..+)\.path$/i
const REMOTE_BLOCKED = '네트워크 공유(UNC)나 장치 경로의 Git 원격 저장소는 사용할 수 없습니다.'
const PROTOCOL_BLOCKED = 'Git 원격 저장소는 HTTPS, SSH 또는 이 PC의 경로만 사용할 수 있습니다.'

function gitEnvironment({ network = false, sshCommand = '', inherited = process.env } = {}) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([name]) => !/^GIT_/i.test(name) || /^GIT_SSH(?:_VARIANT)?$/i.test(name)))
  const hasSsh = Object.keys(env).some(name => /^GIT_SSH$/i.test(name) && env[name])
  return {
    ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
    ...(!network && { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }),
    ...(network && !hasSsh && !sshCommand && { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' })
  }
}

function git(directory, args, options = {}) {
  const { network = false, timeout = network ? 90_000 : 12_000,
    start = spawn, stop = stopDevelopmentProcess, drainTimeout = 2000 } = options
  return new Promise((resolve, reject) => {
    const child = start('git', [...GIT_FLAGS, ...args], {
      cwd: directory, env: gitEnvironment(options), windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
    })
    let failure
    let exited = false
    let settled = false
    let drainTimer
    let bytes = 0
    const stdout = []
    const stderr = []
    function terminate(error) {
      if (failure || settled) return
      failure = error
      clearTimeout(timer)
      clearTimeout(drainTimer)
      void Promise.resolve().then(() => exited ? undefined : stop(child, process.platform, () => !exited))
        .catch(() => child.kill('SIGKILL')).finally(() => {
          child.stdout.destroy()
          child.stderr.destroy()
          reject(error)
        })
    }
    const timer = setTimeout(() => terminate(new Error('Git 작업의 제한 시간이 지났습니다.')), timeout)
    function finish(code) {
      clearTimeout(timer)
      clearTimeout(drainTimer)
      if (failure || settled) return
      settled = true
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'))
      else reject(Object.assign(new Error('Git 작업을 완료하지 못했습니다.'), { code, stderr: Buffer.concat(stderr).toString('utf8') }))
    }
    function collect(target, chunk) {
      if (failure) return
      bytes += chunk.length
      if (bytes > MAX_OUTPUT) terminate(new Error('Git 출력 한도를 넘었습니다.'))
      else target.push(chunk)
    }
    child.stdout.on('data', chunk => collect(stdout, chunk))
    child.stderr.on('data', chunk => collect(stderr, chunk))
    child.on('error', error => {
      clearTimeout(timer)
      clearTimeout(drainTimer)
      if (!failure && !settled) {
        settled = true
        reject(error)
      }
    })
    child.on('exit', code => {
      exited = true
      clearTimeout(timer)
      if (failure || settled) return
      drainTimer = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(code)
      }, drainTimeout)
    })
    child.on('close', finish)
  })
}

function configEntries(output) {
  return output.split('\0').filter(Boolean).map(entry => {
    const newline = entry.indexOf('\n')
    return newline === -1 ? [entry, ''] : [entry.slice(0, newline), entry.slice(newline + 1)]
  })
}

async function inspectLocalSettings(directory, metadata, runGit) {
  const contents = []
  for (const filename of ['config', 'config.worktree']) {
    const file = path.join(metadata, filename)
    const stat = await fs.lstat(file).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!stat) continue
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Git 설정 파일의 실제 경로를 확인할 수 없습니다.')
    // Opening the identified file explicitly lets Git parse keys without reading repository includes.
    contents.push(await runGit(path.dirname(directory), ['config', '--file', file, '--no-includes', '--null', '--list']))
  }
  const entries = contents.flatMap(configEntries)
  if (entries.some(([name]) => INCLUDE.test(name))) {
    throw new Error('이 저장소의 Git 설정이 다른 설정 파일을 불러옵니다. 참조를 확인해 주세요.')
  }
  for (const [name, value] of entries) {
    if (/^core\.worktree$/i.test(name) && (/^[\\/]{2}/.test(value) ||
      path.relative(directory, path.resolve(metadata, value)) !== '')) {
      throw new Error('Git 작업 폴더가 찾은 저장소 경로와 다릅니다.')
    }
  }
  const riskyKeys = [...new Set(entries.filter(([name]) => DANGEROUS.test(name)).map(([name]) => name))]
  const partialClone = entries.some(([name, value]) => /^extensions\.partialclone$/i.test(name)
    || (/^remote\..+\.promisor$/i.test(name) && !/^(?:false|no|off|0)$/i.test(value.trim())))
  return { riskyKeys, partialClone, fingerprint: JSON.stringify(contents) }
}

async function optionalGit(directory, args, runGit) {
  try { return await runGit(directory, args) }
  catch (error) {
    if (error.code === 1 && !error.stderr?.trim()) return ''
    throw error
  }
}

const trimLine = value => value.replace(/\r?\n$/, '')

async function readBranches(directory, runGit) {
  const refs = await runGit(directory, ['for-each-ref', '--format=%(refname)%00%(symref)%00%(HEAD)',
    'refs/heads', 'refs/remotes'])
  const local = []
  const tracking = []
  for (const line of refs.split(/\r?\n/)) {
    const [ref, symbolic, current] = line.split('\0')
    if (!ref || symbolic) continue
    if (ref.startsWith('refs/heads/')) local.push({ name: ref.slice(11), current: current === '*' })
    else if (ref.startsWith('refs/remotes/')) tracking.push(ref.slice(13))
  }
  if (!tracking.length) return local
  const remotes = (await runGit(directory, ['remote'])).split(/\r?\n/).filter(Boolean).sort((a, b) => b.length - a.length)
  const names = new Set(local.map(branch => branch.name))
  return [...local, ...tracking.flatMap(ref => {
    const remote = remotes.find(candidate => ref.startsWith(`${candidate}/`))
    if (!remote) return []
    const name = ref.slice(remote.length + 1)
    return names.has(name) ? [] : [{ name, remote, current: false }]
  })]
}

async function checkRemote(directory, url) {
  if (/^[\\/]{2}/.test(url)) throw new Error(REMOTE_BLOCKED)
  if (!url || /[\u0000-\u001f\u007f]/.test(url)) throw new Error(PROTOCOL_BLOCKED)
  if (/^(https|ssh):\/\//i.test(url)) {
    try { if (new URL(url).hostname) return } catch { /* invalid URL */ }
    throw new Error(PROTOCOL_BLOCKED)
  }
  let local = url
  if (/^file:/i.test(url)) {
    try {
      if (!/^file:\/\/\/(?![\\/])/i.test(url) || new URL(url).hostname) throw new Error()
      local = fileURLToPath(url)
    } catch { throw new Error(REMOTE_BLOCKED) }
  } else if (process.platform === 'win32' && /^[a-z]:/i.test(url)) {
    if (!isLocalFilePath(url)) throw new Error(REMOTE_BLOCKED)
  } else if (/^[\w+.-]+:\/\//.test(url) || /^[\w+.-]+::/.test(url)) {
    throw new Error(PROTOCOL_BLOCKED)
  } else if (/^[^\s/\\:]+:(?!:).+/.test(url) || /^(?:[^\s@]+@)?\[[\da-f:]+\]:.+/i.test(url)) {
    return // Git's SCP-style SSH URL
  }
  if (/^[\\/]{2}/.test(local)) throw new Error(REMOTE_BLOCKED)
  const absolute = path.resolve(directory, local)
  if (!isLocalFilePath(absolute)) throw new Error(REMOTE_BLOCKED)
  try { await resolveLocalPreviewPath(absolute) } catch (error) {
    if (error.code === 'ENOENT') throw new Error('이 PC에서 Git 원격 저장소 경로를 찾을 수 없습니다.')
    throw new Error(REMOTE_BLOCKED)
  }
}

async function upstreamFetch(directory, branch, runGit) {
  if (!branch) return null
  const head = `refs/heads/${branch}`
  const output = await runGit(directory, ['for-each-ref', '--count=1',
    '--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', '--', head])
  const [actual, remote, source, target] = trimLine(output).split('\0')
  const invalidRef = value => /[:*\s]/.test(value)
  if (actual !== head || !remote || remote === '.' || !source?.startsWith('refs/heads/')
    || !target?.startsWith('refs/remotes/') || invalidRef(source) || invalidRef(target)) return null
  return { remote, refspec: `+${source}:${target}` }
}

async function fetchCurrent(directory, branch, runGit, check, { automatic = false } = {}) {
  const upstream = automatic ? await upstreamFetch(directory, branch, runGit) : null
  if (automatic && !upstream) return
  const configured = !automatic && branch
    ? await optionalGit(directory, ['config', '--null', '--get', `branch.${branch}.remote`], runGit) : ''
  let remote = upstream?.remote ?? configured.replace(/\0$/, '')
  if (!remote) {
    const remotes = (await runGit(directory, ['remote'])).split(/\r?\n/).filter(Boolean)
    remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : ''
  }
  if (!remote || remote === '.') return
  const helper = trimLine(await optionalGit(directory, ['config', '--get', `remote.${remote}.vcs`], runGit))
  if (helper && !['https', 'ssh', 'file'].includes(helper)) throw new Error(PROTOCOL_BLOCKED)
  const url = trimLine(await runGit(directory, ['remote', 'get-url', '--', remote]))
  await checkRemote(directory, url)
  const sshCommand = trimLine(await optionalGit(directory, ['config', '--get', 'core.sshCommand'], runGit))
  if (await check() === false) return
  const scope = upstream ? ['--no-tags', '--no-prune', '--no-prune-tags', '--refmap='] : []
  await runGit(directory, ['fetch', '--quiet', '--no-recurse-submodules', ...scope, '--', remote,
    ...(upstream ? [upstream.refspec] : [])], { network: true, sshCommand })
}

module.exports = { git, gitEnvironment, inspectLocalSettings, checkRemote, fetchCurrent, optionalGit, readBranches }
