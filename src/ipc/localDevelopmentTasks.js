// Inspect project metadata on demand. The renderer chooses an identified task; manifest text
// is never turned into a shell command here. Package scripts run through their package manager.
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')

const exec = promisify(execFile)
const MAX_MANIFEST_BYTES = 256 * 1024
const MODULE_LIMIT = 64
const SPARSE_MODULES = ['backend', 'frontend', 'server', 'client', 'api', 'web']
const MARKERS = ['build.gradle', 'build.gradle.kts', 'pom.xml', 'gradlew.bat', 'gradlew', 'mvnw.cmd', 'mvnw',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']
const PACKAGE_LOCKS = { npm: ['package-lock.json'], pnpm: ['pnpm-lock.yaml'], yarn: ['yarn.lock'], bun: ['bun.lock', 'bun.lockb'] }
const NODE_INSTALLS = { npm: 'install', pnpm: 'install --frozen-lockfile', yarn: 'install --frozen-lockfile', bun: 'install --frozen-lockfile' }
const GIT_PATH_OVERRIDES = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])

async function git(cwd, args, mutating = false) {
  // If ezShell was opened from a Git hook, use the selected worktree's index and settings.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }
  for (const name of Object.keys(env)) if (GIT_PATH_OVERRIDES.has(name.toUpperCase())) delete env[name]
  const { stdout } = await exec('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_MANIFEST_BYTES,
    timeout: mutating ? 30_000 : 5_000,
    env
  })
  return stdout
}

async function projectRoot(folder) {
  const entry = typeof folder === 'string' && await resolveLocalPreviewPath(folder).catch(() => null)
  if (!entry?.stat.isDirectory()) throw new Error('로컬 작업 폴더를 찾을 수 없습니다.')
  return entry.path
}

async function diskModule(cwd) {
  const entries = await fs.readdir(cwd, { withFileTypes: true }).catch(() => [])
  const files = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name))
  return {
    entries,
    has: file => files.has(file),
    installed: entries.some(entry => entry.name === 'node_modules' && (entry.isDirectory() || entry.isSymbolicLink()) || entry.name === '.pnp.cjs' && entry.isFile()),
    async read(file) {
      if (!files.has(file)) return ''
      const handle = await fs.open(path.join(cwd, file), 'r').catch(() => null)
      if (!handle) return ''
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return ''
        const buffer = Buffer.alloc(stat.size)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        return buffer.toString('utf8', 0, bytesRead)
      } finally { await handle.close() }
    }
  }
}

async function tasksIn(relative, source, { windows, includeSource = false, rootInstalled = false }) {
  const tasks = []
  const add = (id, name, command, installCommand) => tasks.push({
    id: `${relative}:${id}`, name, relative, command, ...(installCommand ? { installCommand } : {}), includeSource
  })
  const [gradle, kotlin, maven, manifest] = await Promise.all(
    ['build.gradle', 'build.gradle.kts', 'pom.xml', 'package.json'].map(source.read)
  )
  if (/org\.springframework\.boot/.test(`${gradle}\n${kotlin}`)) {
    const wrapper = windows ? 'gradlew.bat' : 'gradlew'
    // A shared Gradle daemon can launch the server outside the PTY's process tree.
    add('gradle', 'Spring Boot', `${source.has(wrapper) ? windows ? '.\\gradlew.bat' : './gradlew' : 'gradle'} bootRun --no-daemon`)
  } else if (/spring-boot-(?:starter|maven-plugin)/.test(maven)) {
    const wrapper = windows ? 'mvnw.cmd' : 'mvnw'
    add('maven', 'Spring Boot', `${source.has(wrapper) ? windows ? '.\\mvnw.cmd' : './mvnw' : 'mvn'} spring-boot:run`)
  }

  try {
    const pkg = JSON.parse(manifest.replace(/^\uFEFF/, ''))
    const script = ['dev', 'serve'].find(name => typeof pkg?.scripts?.[name] === 'string' && pkg.scripts[name].trim())
    if (!script) return tasks
    const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : ''
    const hasLock = manager => PACKAGE_LOCKS[manager].some(source.has)
    const manager = Object.hasOwn(PACKAGE_LOCKS, declared) ? declared : ['pnpm', 'yarn', 'bun', 'npm'].find(hasLock) ?? 'npm'
    const cli = windows && manager !== 'bun' ? `${manager}.cmd` : manager
    const install = manager === 'npm' && hasLock(manager) ? 'ci' : hasLock(manager) ? NODE_INSTALLS[manager] : 'install'
    const vue = [pkg.dependencies, pkg.devDependencies].some(dependencies => dependencies?.vue || dependencies?.['@vue/cli-service'])
    add('node', vue ? 'Vue' : 'Node', `${cli} run ${script}`, source.installed || rootInstalled ? undefined : `${cli} ${install}`)
  } catch { /* A missing or malformed package.json does not hide another task. */ }
  return tasks
}

async function sparseModules(root) {
  if ((await git(root, ['config', '--bool', '--get', 'core.sparseCheckout']).catch(() => '')).trim() !== 'true') return new Map()
  if ((await git(root, ['rev-parse', '--show-prefix']).catch(() => '?')).trim()) return new Map()
  const files = await git(root, ['ls-files', '-t', '-z', '--', ...SPARSE_MODULES.flatMap(dir => MARKERS.map(name => `${dir}/${name}`))])
  const modules = new Map()
  for (const record of files.split('\0')) {
    if (!record.startsWith('S ')) continue
    const [relative, file] = record.slice(2).split('/')
    if (!modules.has(relative)) modules.set(relative, new Set())
    modules.get(relative).add(file)
  }
  return modules
}

async function inspectDevelopmentTasks(folder, platform = process.platform) {
  const root = await projectRoot(folder)
  const windows = platform === 'win32'
  const rootSource = await diskModule(root)
  const directories = rootSource.entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'build', 'dist', 'target'].includes(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => Number(SPARSE_MODULES.includes(b)) - Number(SPARSE_MODULES.includes(a)))
    .slice(0, MODULE_LIMIT)
  const sparse = await sparseModules(root)
  const tasks = await Promise.all([
    tasksIn('.', rootSource, { windows }),
    ...directories.map(async dir => tasksIn(dir, await diskModule(path.join(root, dir)), { windows, rootInstalled: rootSource.installed })),
    ...[...sparse].map(([dir, files]) => tasksIn(dir, {
      has: file => files.has(file), installed: false,
      read: file => files.has(file) ? git(root, ['show', `:${dir}/${file}`]).catch(() => '') : Promise.resolve('')
    }, { windows, includeSource: true, rootInstalled: rootSource.installed }))
  ])
  const unique = new Map()
  // Prefer runnable on-disk tasks when an excluded directory still contains some local files.
  for (const task of tasks.flat()) if (!unique.has(task.id)) unique.set(task.id, task)
  return { root, tasks: [...unique.values()] }
}

async function prepareDevelopmentTask(folder, id, { includeSource, install, allowed }) {
  const plan = await inspectDevelopmentTasks(folder)
  let task = plan.tasks.find(candidate => candidate.id === id)
  if (!task) throw new Error('기동 명령이 바뀌었습니다. 메뉴를 다시 열어 주세요.')
  if (task.installCommand && !install) throw new Error('의존성 설치를 확인한 뒤 기동해 주세요.')
  if (task.includeSource) {
    if (!includeSource || !SPARSE_MODULES.includes(task.relative)) throw new Error('소스 폴더 포함을 확인한 뒤 기동해 주세요.')
    const cone = (await git(plan.root, ['config', '--bool', '--get', 'core.sparseCheckoutCone']).catch(() => '')).trim() === 'true'
    if (!allowed()) throw new Error('먼저 잠금을 해제해 주세요.')
    await git(plan.root, ['sparse-checkout', 'add', '--', cone ? task.relative : `/${task.relative}/`], true)
    task = (await inspectDevelopmentTasks(plan.root)).tasks.find(candidate => candidate.id === id && !candidate.includeSource)
    if (!task) throw new Error('소스 폴더의 실행 파일을 찾지 못했습니다. 워크트리 상태를 확인해 주세요.')
    if (task.installCommand && !install) throw new Error('의존성 설치를 확인한 뒤 기동해 주세요.')
  }
  const cwd = path.resolve(plan.root, task.relative)
  const actual = await projectRoot(cwd)
  if (path.relative(cwd, actual)) throw new Error('작업 폴더의 위치가 바뀌었습니다. 메뉴를 다시 열어 주세요.')
  if (!allowed()) throw new Error('먼저 잠금을 해제해 주세요.')
  return { ...task, cwd }
}

module.exports = { inspectDevelopmentTasks, prepareDevelopmentTask }
