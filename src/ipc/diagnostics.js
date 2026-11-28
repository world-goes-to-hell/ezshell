// The diagnostics a bug report needs, as text a person reads (docs/plan/2026-11-28-diagnostics.md): versions,
// the agents' states, recent errors. No message, prompt or secret goes in, and the home folder becomes `~`.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const childProcess = require('child_process')
const os = require('os')

const CLI_TTL_MS = 10 * 60_000
const CLI_TIMEOUT_MS = 8000
const DAY_MS = 24 * 60 * 60_000
const CLIS = { claude: 'Claude Code', codex: 'Codex' }
const VERSION = /\d+\.\d+\.\d+[\w.+-]*/

const megabytes = bytes => `${Math.round(bytes / 1024 / 1024)}MB`
const duration = seconds => {
  const minutes = Math.floor(seconds / 60)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`
}
const stamp = at => {
  const date = new Date(at)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * `agents()` gives the agents (`{ id, kind, role?, status, statusSource?, mcpConnected?, sleeping?, active }`)
 * or null while locked, `codexHookMode()` the saved approval, `shellCount()` the open local shells.
 */
function createDiagnostics({ appVersion, errorLog, agents = () => null, codexHookMode = () => null, shellCount = () => 0,
  home = os.homedir(), exec = childProcess.exec, now = Date.now, platform = process.platform, versions = process.versions }) {
  const cliCache = new Map()

  // Fixed commands only (`claude --version`): the CLIs are .cmd scripts on Windows, which need a shell
  function cliVersion(name) {
    const cached = cliCache.get(name)
    if (cached && now() - cached.at < CLI_TTL_MS) return cached.version
    const version = new Promise(resolve => {
      try {
        exec(`${name} --version`, { timeout: CLI_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
          resolve(error ? null : (String(stdout).match(VERSION)?.[0] ?? null))
        })
      } catch {
        resolve(null)
      }
    })
    cliCache.set(name, { at: now(), version })
    return version
  }

  function masked(text) {
    if (!home) return text
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')])
    let result = text
    for (const variant of variants) result = result.split(variant).join('~')
    return result
  }

  async function header() {
    const [claude, codex] = await Promise.all(Object.keys(CLIS).map(cliVersion))
    return { claude, codex }
  }

  const agentLine = agent => [
    `- ${agent.id}`, agent.role ? `(${agent.role})` : '', agent.kind,
    agent.sleeping ? '잠듦' : agent.status, agent.statusSource ? `출처 ${agent.statusSource}` : '',
    agent.mcpConnected === false ? 'MCP 끊김' : ''
  ].filter(Boolean).join(' ')

  const errorLine = entry => `- ${stamp(entry.at)} ${entry.kind}${entry.window ? ` [${entry.window}]` : ''}${entry.where ? ` ${entry.where}` : ''}: ` +
    entry.message.split('\n').slice(0, 1).join('').slice(0, 300)

  return {
    cliVersion,

    /** The whole report and the number of errors of the last day */
    async report() {
      const cli = await header()
      const list = agents()
      const errors = errorLog.recent(50)
      const lastDay = errors.filter(entry => now() - entry.at < DAY_MS).length
      const memory = process.memoryUsage()
      const lines = [
        `# ezShell 진단 정보 (${stamp(now())})`,
        '',
        '## 버전',
        `- ezShell ${appVersion}`,
        `- Electron ${versions.electron ?? '?'} · Chromium ${versions.chrome ?? '?'} · Node ${versions.node}`,
        `- ${platform} ${os.release()} ${os.arch()}`,
        `- Claude Code ${cli.claude ?? '찾지 못함'} · Codex ${cli.codex ?? '찾지 못함'}`,
        '',
        '## 상태',
        `- 가동 ${duration(process.uptime())} · main 메모리 ${megabytes(memory.rss)} · PC 메모리 ${megabytes(os.freemem())} 남음 / ${megabytes(os.totalmem())}`,
        `- 로컬 셸 ${shellCount()}개 · Codex 훅 승인 ${codexHookMode() ?? '모름'}`,
        '',
        '## 에이전트',
        ...(list === null ? ['- (잠금 중이라 뺌)'] : list.length ? list.map(agentLine) : ['- 없음']),
        '',
        `## 최근 오류 (24시간 ${lastDay}건, 최근 ${errors.length}건까지)`,
        ...(errors.length ? errors.map(errorLine) : ['- 없음']),
        '',
        '### 오류 원문 (최근 5건)',
        ...errors.slice(-5).flatMap(entry => ['```', `${stamp(entry.at)} ${entry.kind}`, entry.message, '```'])
      ]
      return { text: masked(lines.join('\n')), errors: lastDay }
    },

    /** A few lines for a quick capture request about ezShell itself */
    async summary() {
      const cli = await header()
      const list = agents() ?? []
      const errors = errorLog.recent(5)
      return masked([
        `ezShell 상태 (캡처 때 자동 첨부): ezShell ${appVersion}, ${platform} ${os.release()}, Claude Code ${cli.claude ?? '?'}, Codex ${cli.codex ?? '?'}`,
        ...(list.length ? ['에이전트:', ...list.map(agentLine)] : []),
        ...(errors.length ? ['최근 오류:', ...errors.map(errorLine)] : [])
      ].join('\n'))
    }
  }
}

module.exports = { createDiagnostics }
