// Runs the screen tests against the built app: `npm run e2e` (all) or `npm run e2e -- shortcuts`.
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

async function runSpec(name) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `ezshell-e2e-${name}-`))
  const app = spawn(require('electron'), [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, ...APP_FLAGS], { cwd: ROOT, stdio: 'ignore' })
  try {
    if (!(await waitUntil(portAnswers, 60000))) throw new Error('the app did not open its debugging port')
    const code = await new Promise((resolve, reject) => {
      const spec = spawn(process.execPath, [path.join(SPECS_DIR, `${name}.js`)], {
        stdio: 'inherit',
        env: { ...process.env, E2E_CDP: `http://127.0.0.1:${PORT}`, E2E_PROFILE: profile, E2E_OUT: OUT_DIR }
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
    // The port must be free before the next app starts, or the next spec talks to this one
    await waitUntil(async () => !(await portAnswers()), 10000)
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    } catch {
      // Left in the temp folder: a file was still held
    }
  }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/index.js'))) throw new Error('out/ is missing: run `npm run build` first')
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
