// Runs the screen tests against the built app: `npm run e2e` (all) or `npm run e2e -- shortcuts`.
// With E2E_APP=<path to a packaged ezShell.exe> the packaged app is tested instead of out/.
// Each spec gets its own app with a fresh profile in the system temp folder, so the real app data
// (%APPDATA%\my-ssh-client) is never touched. The app is started directly (not through npx): killing
// npx leaves Electron running with the debugging port held, and the next spec would attach to it.
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SPECS_DIR = path.join(__dirname, 'specs')
const OUT_DIR = path.join(__dirname, '.out')
const PORT = Number(process.env.E2E_PORT) || 9333
const SSH_PORT = Number(process.env.E2E_SSH_PORT) || 2222
const SPEC_TIMEOUT_MS = 5 * 60 * 1000
// A window covered by another stops repainting and throttles timers: the specs read the screen
const APP_FLAGS = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function portAnswers() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`)
    return true
  } catch {
    return false
  }
}

async function waitUntil(test, ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await test()) return true
    await sleep(250)
  }
  return false
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', resolve)
    child.kill()
    setTimeout(resolve, 5000)
  })
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = require('net').connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

/** The test SSH server (e2e/support/sshd.js), for specs named ssh-* */
async function startSshd(workDir) {
  if (await portOpen(SSH_PORT)) throw new Error(`port ${SSH_PORT} is in use: set E2E_SSH_PORT`)
  const sshd = spawn(process.execPath, [path.join(__dirname, 'support/sshd.js')], {
    stdio: 'ignore',
    env: { ...process.env, E2E_SSH_PORT: String(SSH_PORT), E2E_SSH_DIR: workDir }
  })
  if (!(await waitUntil(() => portOpen(SSH_PORT), 15000))) {
    await stop(sshd)
    throw new Error('the test SSH server did not start')
  }
  return sshd
}

async function runSpec(name) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `ezshell-e2e-${name}-`))
  const sshDir = name.startsWith('ssh-') ? fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-e2e-sshd-')) : null
  const sshd = sshDir ? await startSshd(sshDir) : null
  // E2E_APP: a packaged ezShell.exe (release/<version>/win-unpacked) instead of the build in out/
  const packaged = process.env.E2E_APP
  const appEntry = { 'quick-capture': 'e2e/support/quickCaptureApp.js', 'browser-review': 'e2e/support/localAgentApp.js', 'local-agent-messages': 'e2e/support/localAgentApp.js', 'local-agent-pane-map': 'e2e/support/localAgentApp.js', 'local-agent-tab-close': 'e2e/support/localAgentApp.js', 'local-agent-usage': 'e2e/support/localAgentApp.js', 'local-work-overview': 'e2e/support/localAgentApp.js', 'local-agent-history': 'e2e/support/agentHistoryApp.js', 'ssh-agent-drop': 'e2e/support/agentHistoryApp.js', 'local-restore-agents': 'e2e/support/agentHistoryApp.js', 'local-agent-chat': 'e2e/support/agentChatApp.js', 'local-agent-chat-scroll': 'e2e/support/agentChatApp.js', 'local-agent-chat-images': 'e2e/support/agentChatApp.js', 'local-agent-sleep': 'e2e/support/agentSleepApp.js' }[name] ?? 'out/main/index.js'
  const app = spawn(packaged || require('electron'), [...(packaged ? [] : [path.join(ROOT, appEntry)]), `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, ...APP_FLAGS], { cwd: ROOT, stdio: 'ignore' })
  try {
    if (!(await waitUntil(portAnswers, 60000))) throw new Error('the app did not open its debugging port')
    const code = await new Promise((resolve, reject) => {
      const spec = spawn(process.execPath, [path.join(SPECS_DIR, `${name}.js`)], {
        stdio: 'inherit',
        env: { ...process.env, E2E_CDP: `http://127.0.0.1:${PORT}`, E2E_PROFILE: profile, E2E_OUT: OUT_DIR, E2E_SSH_PORT: String(SSH_PORT) }
      })
      const timer = setTimeout(() => {
        spec.kill()
        reject(new Error(`no result in ${SPEC_TIMEOUT_MS / 60000} minutes`))
      }, SPEC_TIMEOUT_MS)
      spec.on('exit', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode)
      })
      spec.on('error', reject)
    })
    return code === 0
  } finally {
    await stop(app)
    if (sshd) await stop(sshd)
    // The port must be free before the next app starts, or the next spec talks to this one
    await waitUntil(async () => !(await portAnswers()), 10000)
    for (const dir of [profile, sshDir]) {
      try {
        if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      } catch {
        // Left in the temp folder: a file was still held
      }
    }
  }
}

async function main() {
  if (process.env.E2E_APP && !fs.existsSync(process.env.E2E_APP)) throw new Error(`E2E_APP does not exist: ${process.env.E2E_APP}`)
  if (!process.env.E2E_APP && !fs.existsSync(path.join(ROOT, 'out/main/index.js'))) throw new Error('out/ is missing: run `npm run build` first')
  if (await portAnswers()) throw new Error(`port ${PORT} is in use (a test app left running?): close it or set E2E_PORT`)
  const all = fs.readdirSync(SPECS_DIR).filter((file) => file.endsWith('.js')).map((file) => file.slice(0, -3)).sort()
  const wanted = process.argv.slice(2)
  const unknown = wanted.filter((name) => !all.includes(name))
  if (unknown.length) throw new Error(`no such spec: ${unknown.join(', ')} (have: ${all.join(', ')})`)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const results = []
  for (const name of wanted.length ? wanted : all) {
    console.log(`\n=== ${name} ===`)
    let passed = false
    try {
      passed = await runSpec(name)
    } catch (error) {
      console.error(`${name}: ${error.message}`)
    }
    results.push({ name, passed })
  }
  console.log('\n=== result ===')
  for (const { name, passed } of results) console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  process.exit(results.every((r) => r.passed) ? 0 : 1)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
