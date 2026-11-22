import type { McpSetupClient, McpSetupOutcome } from '../types'

const SERVER_NAME = 'ezshell-ssh-mcp'
const TOKEN_ENV_VAR = 'EZSHELL_MCP_TOKEN'
const SHOWN_PROJECTS = 3

export const MCP_SETUP_CLIENTS: Record<McpSetupClient, { label: string; project: string; global: string; projectNote?: string }> = {
  claude: {
    label: 'Claude Code', project: '.mcp.json', global: '~/.claude.json',
    projectNote: 'Claude Code에서 이 프로젝트의 MCP 서버 사용 여부를 처음에 확인합니다.'
  },
  codex: {
    label: 'Codex', project: '.codex/config.toml', global: '~/.codex/config.toml',
    projectNote: 'Codex는 신뢰하는 프로젝트의 설정을 읽습니다.'
  },
  gemini: { label: 'Gemini CLI', project: '.gemini/settings.json', global: '~/.gemini/settings.json' },
  opencode: { label: 'OpenCode', project: 'opencode.jsonc', global: '~/.config/opencode/opencode.jsonc' },
  cursor: { label: 'Cursor', project: '.cursor/mcp.json', global: '~/.cursor/mcp.json' }
}

const RESULT_TITLES: Record<McpSetupOutcome['result'], string> = {
  added: '설정을 추가했습니다',
  replaced: '설정을 바꿨습니다',
  unchanged: '이미 같은 설정이 있습니다',
  conflict: '같은 이름의 설정이 있습니다'
}

export interface SetupView {
  title: string
  tone: 'success' | 'warning'
  lines: string[]
}

function tokenEnvLine(outcome: McpSetupOutcome): string {
  const client = MCP_SETUP_CLIENTS[outcome.client].label
  switch (outcome.tokenEnv) {
    case 'set':
      return `환경 변수 ${TOKEN_ENV_VAR}을 설정했습니다. 새 터미널에서 시작한 ${client}에 적용됩니다.`
    case 'failed':
      return `환경 변수를 설정하지 못했습니다 (${outcome.tokenEnvError ?? '알 수 없는 오류'}). ${TOKEN_ENV_VAR} 에 접속 토큰을 직접 넣어 두세요.`
    case 'unsupported':
      return `이 운영체제에서는 ${TOKEN_ENV_VAR} 환경 변수를 직접 설정하세요.`
    default:
      return `${client} 시작 전에 ${TOKEN_ENV_VAR} 환경 변수에 접속 토큰을 넣어 두세요.`
  }
}

function shadowedLine(projects: string[]): string {
  const shown = projects.slice(0, SHOWN_PROJECTS).join(', ')
  const rest = projects.length > SHOWN_PROJECTS ? ` 외 ${projects.length - SHOWN_PROJECTS}곳` : ''
  return `프로젝트 ${projects.length}곳에 예전 등록이 남아 있어 그 프로젝트에서는 예전 등록이 먼저 쓰입니다: ${shown}${rest}`
}

function legacyLine(projects: string[], legacyName: string): string {
  const shown = projects.slice(0, SHOWN_PROJECTS).join(', ')
  const rest = projects.length > SHOWN_PROJECTS ? ` 외 ${projects.length - SHOWN_PROJECTS}곳` : ''
  return `프로젝트 ${projects.length}곳에 예전 이름(${legacyName})의 등록이 남아 있어 그 프로젝트에서는 도구가 두 이름으로 보입니다: ${shown}${rest}`
}

/** What the settings screen shows after MCP registration. */
export function describeSetupOutcome(outcome: McpSetupOutcome): SetupView {
  const lines = [`파일: ${outcome.filePath}`]
  if (outcome.backupPath) lines.push(`백업: ${outcome.backupPath}`)
  if (outcome.scope === 'project') {
    lines.push(tokenEnvLine(outcome))
    const note = MCP_SETUP_CLIENTS[outcome.client].projectNote
    if (note) lines.push(note)
  }
  if (outcome.shadowedProjects.length > 0) {
    lines.push(shadowedLine(outcome.shadowedProjects))
    lines.push(`지우려면 그 프로젝트 폴더에서 claude mcp remove ${SERVER_NAME} -s local 을 실행하세요.`)
  }
  const renamedFrom = outcome.renamedFrom ?? []
  if (renamedFrom.length > 0) {
    const prefixes = renamedFrom.map(name => `mcp__${name}__`).join(', ')
    lines.push(`예전 이름(${renamedFrom.join(', ')})의 항목을 지우고 ${SERVER_NAME} 로 바꿨습니다. Claude Code 의 권한 허용 목록에 ${prefixes} 로 시작하는 항목이 있으면 mcp__${SERVER_NAME}__ 로 고치세요.`)
  }
  const legacyProjects = outcome.legacyProjects ?? []
  const registrations = outcome.legacyRegistrations ??
    (legacyProjects.length > 0 && outcome.legacyName ? [{ name: outcome.legacyName, projects: legacyProjects }] : [])
  for (const { name, projects } of registrations) {
    lines.push(legacyLine(projects, name))
    lines.push(`지우려면 그 프로젝트 폴더에서 claude mcp remove ${name} -s local 을 실행하세요.`)
  }
  const isWarning = outcome.tokenEnv === 'failed' || outcome.tokenEnv === 'unsupported' || outcome.shadowedProjects.length > 0 || registrations.length > 0
  return { title: RESULT_TITLES[outcome.result], tone: isWarning ? 'warning' : 'success', lines }
}

export function conflictQuestion(outcome: McpSetupOutcome): string {
  const url = outcome.existingUrl || '주소 없음'
  return `${outcome.filePath} 에 이미 '${SERVER_NAME}' 항목이 있습니다 (${url}).\n덮어쓸까요? 원래 파일은 백업합니다.`
}
