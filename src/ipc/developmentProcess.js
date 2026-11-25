const { execFile } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const { promisify, stripVTControlCharacters } = require('node:util')

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

module.exports = { developmentAddress, stopDevelopmentProcess, waitDevelopmentPort }
