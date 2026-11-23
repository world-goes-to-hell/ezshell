const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const MAX_METADATA_BYTES = 4 * 1024 * 1024
const browsers = [
  { id: 'chrome', name: 'Google Chrome', data: ['Google', 'Chrome'], app: 'Google Chrome', exe: 'chrome.exe',
    url: 'chrome://password-manager/settings', menu: '더보기(⋯) → 비밀번호 및 자동 완성 → Google 비밀번호 관리자 → 설정',
    download: '‘비밀번호 내보내기’ 옆의 ‘파일 다운로드’를 누르세요.' },
  { id: 'edge', name: 'Microsoft Edge', data: ['Microsoft', 'Edge'], app: 'Microsoft Edge', exe: 'msedge.exe',
    url: 'edge://settings/autofill/passwords', menu: '설정 및 기타(⋯) → 암호',
    download: '암호 목록 위의 더보기(⋯)에서 ‘암호 내보내기’를 선택하세요.' },
  { id: 'firefox', name: 'Mozilla Firefox', data: ['Firefox'], app: 'Firefox', exe: 'firefox.exe', url: 'about:logins' },
]

function passwordExportGuide(browser, autoImport) {
  // Chromium filters privileged startup URLs. A local guide opens in the chosen profile while
  // navigation to the manager happens through the browser's address bar or menu.
  const save = autoImport
    ? '내보내기를 승인하고, 저장 창의 파일 이름에 ezShell이 복사한 경로를 붙여넣으세요. 저장하면 자동으로 가져옵니다.'
    : '내보내기를 승인하고, CSV 파일을 저장한 뒤 ezShell에서 그 파일을 선택하세요.'
  const page = `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>ezShell 비밀번호 가져오기</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 8vh auto; max-width: 640px; padding: 0 24px; font: 16px/1.65 system-ui, sans-serif; }
  h1 { font-size: 26px; line-height: 1.35; }
  li + li { margin-top: 12px; }
  code { display: block; margin-top: 6px; overflow-wrap: anywhere; }
</style>
<main><h1>${browser.name}에서 비밀번호 가져오기</h1>
<ol><li><b>${browser.menu}</b> 순서로 선택하세요. 주소창에 아래 주소를 입력해도 됩니다.<code>${browser.url}</code></li>
<li>${browser.download}</li><li>${save}</li></ol>
${autoImport ? '<p>주소를 복사해서 붙여넣었다면 ezShell에서 <b>저장 경로 다시 복사</b>를 누른 뒤 저장하세요.</p>' : ''}
</main></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(page)
}

async function stat(file) {
  try { return await fs.stat(file) } catch { return null }
}

async function readMetadata(file) {
  try {
    const info = await stat(file)
    if (!info?.isFile() || info.size > MAX_METADATA_BYTES) return ''
    return await fs.readFile(file, 'utf8')
  } catch { return '' }
}

async function chromiumProfiles(root) {
  let cache
  try {
    cache = JSON.parse(await readMetadata(path.join(root, 'Local State')))?.profile?.info_cache
  } catch {}
  const withNames = cache && typeof cache === 'object' && !Array.isArray(cache)
  const keys = withNames ? Object.keys(cache) : await fs.readdir(root).catch(() => [])
  const profiles = await Promise.all(keys.map(async key => {
    if (!key || /[\\/:\x00-\x1f]/.test(key) || /[. ]$/.test(key) || ['Guest Profile', 'System Profile'].includes(key)) return null
    if (!withNames && !/^(Default|Profile \d+)$/.test(key)) return null
    if (cache?.[key]?.is_omitted || cache?.[key]?.is_ephemeral || !(await stat(path.join(root, key)))?.isDirectory()) return null
    const label = cache?.[key]?.name
    return { key, name: (typeof label === 'string' && label.trim().slice(0, 120)) || key, args: [`--profile-directory=${key}`, '--ignore-profile-directory-if-not-exists'] }
  }))
  return profiles.filter(Boolean)
}

async function firefoxProfiles(root) {
  const ini = await readMetadata(path.join(root, 'profiles.ini'))
  const sections = []
  let profile
  for (const line of ini.split(/\r?\n/)) {
    const section = /^\[([^\]]+)\]$/.exec(line.trim())
    if (section) {
      profile = /^Profile\d+$/.test(section[1]) ? new Map() : undefined
      if (profile) sections.push(profile)
    } else {
      const field = /^(Name|Path|IsRelative)=(.*)$/.exec(line.trim())
      if (field) profile?.set(field[1], field[2])
    }
  }
  const profiles = await Promise.all(sections.map(async section => {
    const location = section.get('Path')
    const relative = section.get('IsRelative')
    if (!location || location.includes('\0')) return null
    if (relative === '1' && (path.isAbsolute(location) || location.split(/[\\/]/).includes('..') || location.includes(':'))) return null
    if (relative !== '1' && (relative !== '0' || !path.isAbsolute(location) || /^[\\/]{2}/.test(location))) return null
    const key = path.resolve(root, location)
    if (key === root || !(await stat(key))?.isDirectory()) return null
    return { key, name: section.get('Name')?.trim().slice(0, 120) || path.basename(key), args: ['-profile', key] }
  }))
  return [...new Map(profiles.filter(Boolean).map(entry => [entry.key, entry])).values()]
}

function installPaths(browser, platform, home, env) {
  const firefox = browser.id === 'firefox'
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const system = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)
    const executables = firefox
      ? [...system, path.join(local, 'Programs'), local].map(dir => path.join(dir, 'Mozilla Firefox', browser.exe))
      : [...system, local].map(dir => path.join(dir, ...browser.data, 'Application', browser.exe))
    const root = firefox ? path.join(roaming, 'Mozilla', 'Firefox') : path.join(local, ...browser.data, 'User Data')
    return { root, executables }
  }
  if (platform === 'darwin') {
    const root = path.join(home, 'Library', 'Application Support', ...browser.data)
    const executables = ['/Applications', path.join(home, 'Applications')].map(dir =>
      path.join(dir, `${browser.app}.app`, 'Contents', 'MacOS', firefox ? 'firefox' : browser.app))
    return { root, executables }
  }
  return null
}

function launchBrowser(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function createBrowserImportSources({ platform = process.platform, home = os.homedir(), env = process.env, launch = launchBrowser } = {}) {
  async function discover() {
    const installed = await Promise.all(browsers.map(async browser => {
      const paths = installPaths(browser, platform, home, env)
      if (!paths) return null
      const executables = [...new Set(paths.executables)].filter(executable => path.isAbsolute(executable))
      const files = await Promise.all(executables.map(stat))
      const executable = executables[files.findIndex(file => file?.isFile())]
      if (!executable) return null
      const firefox = browser.id === 'firefox'
      const discovered = await (firefox ? firefoxProfiles(paths.root) : chromiumProfiles(paths.root))
      const profiles = discovered.length ? discovered : [{ key: '', name: '기본 프로필', args: [] }]
      const launchPage = firefox ? browser.url : passwordExportGuide(browser, platform === 'win32')
      return {
        id: browser.id,
        name: browser.name,
        profiles: profiles.map(({ key, name, args }) => ({
          id: createHash('sha256').update(browser.id + '\0' + key).digest('hex'),
          name,
          executable,
          args: [...args, firefox ? '-new-window' : '--new-window', launchPage],
          directory: !firefox && key ? path.join(paths.root, key) : null,
        })),
      }
    }))
    return installed.filter(Boolean)
  }

  async function findProfile(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return null
    return (await discover()).flatMap(browser => browser.profiles).find(profile => profile.id === id)
  }

  return {
    async list() {
      return (await discover()).map(({ id, name, profiles }) => ({
        id, name, profiles: profiles.map(({ id, name }) => ({ id, name })),
      }))
    },
    async listDataSources() {
      return (await discover()).filter(({ id }) => id !== 'firefox').map(({ id, name, profiles }) => ({
        id, name, profiles: profiles.filter(profile => profile.directory).map(({ id, name }) => ({ id, name })),
      })).filter(browser => browser.profiles.length)
    },
    async dataDirectory(id) {
      const profile = await findProfile(id)
      if (!profile?.directory || !(await fs.lstat(profile.directory).catch(() => null))?.isDirectory()) return null
      return profile.directory
    },
    async open(id) {
      const profile = await findProfile(id)
      if (!profile) return false
      await launch(profile.executable, profile.args)
      return true
    },
  }
}

module.exports = { createBrowserImportSources }
