const { execFile } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const { promisify, stripVTControlCharacters } = require('node:util')
const fs = require('node:fs/promises')
const { descendants, processList } = require('../agentIdle.js')

const exec = promisify(execFile)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function developmentAddress(rows) {
  for (const row of rows) {
    const text = stripVTControlCharacters(row)
    const url = /\b(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(?![\w.])/i.exec(text)
    const startup = /\b(?:Tomcat|Netty|Jetty|Undertow)(?:WebServer)? (?:started|listening) on ports?\s*:?\s*(\d{1,5})(?!\d)/i.exec(text)
    const port = Number(url?.[3] ?? startup?.[1])
    if (!(port > 0 && port <= 65535)) continue
    const host = url && url[2] !== '0.0.0.0' ? url[2].toLowerCase() : 'localhost'
    return `${url?.[1].toLowerCase() ?? 'http'}://${host}:${port}`
  }
  return null
}

async function stopDevelopmentProcess(pty, platform, processAlive) {
  const pid = pty.pid
  if (!Number.isInteger(pid) || pid <= 0) return pty.kill()
  if (platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      await exec(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
    } catch (error) {
      if (processAlive(pid)) throw error
    }
    return
  }
  // forkpty starts a new session. The non-interactive command shell keeps its children in its group.
  const signal = sig => {
    try { process.kill(-pid, sig); return true }
    catch (error) { if (error.code !== 'ESRCH') throw error; return false }
  }
  if (!signal('SIGTERM')) return
  await delay(350)
  signal('SIGKILL')
}

function listening(port, host) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host })
    const finish = open => { socket.destroy(); resolve(open) }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.setTimeout(120)
  })
}

async function waitDevelopmentPort(address) {
  if (!address) return
  const url = new URL(address)
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  const hosts = url.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [url.hostname.replace(/^\[|\]$/g, '')]
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (!(await Promise.all(hosts.map(host => listening(port, host)))).some(Boolean)) return
    await delay(100)
  }
  throw new Error(`포트 ${port}가 아직 사용 중입니다.`)
}

function listeningPids(stdout, port, platform) {
  const output = stdout.split(/\r?\n/)
  const address = `127.0.0.1:${port}`
  if (platform === 'win32') return output.flatMap(line => {
    const [protocol, local, remote, , pid] = line.trim().split(/\s+/)
    return protocol === 'TCP' && local === address && remote === '0.0.0.0:0' && /^\d+$/.test(pid) ? [Number(pid)] : []
  })
  let pid
  const owners = []
  for (const line of output) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1))
    if (line === `n${address}` && pid) owners.push(pid)
  }
  return owners
}

async function linuxListener(port, signal) {
  const suffix = port.toString(16).toUpperCase().padStart(4, '0')
  const tables = await Promise.all([fs.readFile('/proc/net/tcp', { encoding: 'utf8', signal }),
    fs.readFile('/proc/net/tcp6', { encoding: 'utf8', signal }).catch(() => '')])
  const addresses = [`0100007F:${suffix}`, `0000000000000000FFFF00000100007F:${suffix}`]
  const owners = tables.flatMap((table, index) => table.split('\n').map(line => line.trim().split(/\s+/))
    .filter(row => row[1] === addresses[index] && row[3] === '0A' && /^\d+$/.test(row[9])).map(row => row[9]))
  return owners.length === 1 ? `socket:[${owners[0]}]` : null
}

async function ownsJdwpListener({ port, pid, signal }, { platform = process.platform, run = exec, processes = processList } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535 || signal?.aborted) return false
  try {
    let owner
    let socket
    if (platform === 'linux') {
      socket = await linuxListener(port, signal)
      if (!socket) return false
    } else {
      const [command, args] = platform === 'win32'
        ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'netstat.exe'), ['-ano', '-p', 'tcp']]
        : ['/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']]
      const { stdout } = await run(command, args, { encoding: 'utf8', signal, timeout: 1500, windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
      const candidates = new Set(listeningPids(stdout, port, platform))
      if (candidates.size !== 1) return false
      owner = candidates.values().next().value
    }
    const tree = await processes({ platform })
    if (signal?.aborted || !tree.has(pid)) return false
    const branch = descendants(tree, pid)
    if (owner !== undefined) return branch.includes(owner)
    if (branch.length > 128) return false
    let checks = 0
    for (const member of branch) {
      if (signal?.aborted) return false
      const dir = `/proc/${member}/fd`
      const files = await fs.readdir(dir).catch(() => [])
      for (const file of files) {
        if (++checks > 4096 || signal?.aborted) return false
        if (await fs.readlink(path.join(dir, file)).catch(() => null) === socket) return !signal?.aborted
      }
    }
  } catch { /* A missing or ambiguous listener has no authority. */ }
  return false
}

module.exports = { developmentAddress, stopDevelopmentProcess, waitDevelopmentPort, ownsJdwpListener }
