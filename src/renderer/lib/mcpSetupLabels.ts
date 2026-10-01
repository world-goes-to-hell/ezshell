import type { McpSetupOutcome } from '../types'

const SERVER_NAME = 'my-ssh-client'
const TOKEN_ENV_VAR = 'EZSHELL_MCP_TOKEN'
const SHOWN_PROJECTS = 3

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
  switch (outcome.tokenEnv) {
    case 'set':
      return `환경 변수 ${TOKEN_ENV_VAR} 을 설정했습니다. 새로 연 터미널에서 실행한 Claude Code 부터 적용됩니다.`
    case 'failed':
      return `환경 변수를 설정하지 못했습니다 (${outcome.tokenEnvError ?? '알 수 없는 오류'}). ${TOKEN_ENV_VAR} 에 접속 토큰을 직접 넣어 두세요.`
    case 'unsupported':
      return `이 운영체제에서는 ${TOKEN_ENV_VAR} 환경 변수를 직접 설정하세요.`
    default:
      return `Claude Code 를 실행하기 전에 ${TOKEN_ENV_VAR} 환경 변수에 접속 토큰을 넣어 두세요.`
  }
}

function shadowedLine(projects: string[]): string {
  const shown = projects.slice(0, SHOWN_PROJECTS).join(', ')
  const rest = projects.length > SHOWN_PROJECTS ? ` 외 ${projects.length - SHOWN_PROJECTS}곳` : ''
  return `프로젝트 ${projects.length}곳에 예전 등록이 남아 있어 그 프로젝트에서는 예전 등록이 먼저 쓰입니다: ${shown}${rest}`
}

/** What the settings screen shows after "Claude Code 자동 설정" ran */
export function describeSetupOutcome(outcome: McpSetupOutcome): SetupView {
  const lines = [`파일: ${outcome.filePath}`]
  if (outcome.backupPath) lines.push(`백업: ${outcome.backupPath}`)
  if (outcome.scope === 'project') {
    lines.push(tokenEnvLine(outcome))
    lines.push('Claude Code 가 이 프로젝트에서 처음 쓸 때 서버 사용을 승인할지 묻습니다.')
  }
  if (outcome.shadowedProjects.length > 0) {
    lines.push(shadowedLine(outcome.shadowedProjects))
    lines.push(`지우려면 그 프로젝트 폴더에서 claude mcp remove ${SERVER_NAME} -s local 을 실행하세요.`)
  }
  const isWarning = outcome.tokenEnv === 'failed' || outcome.tokenEnv === 'unsupported' || outcome.shadowedProjects.length > 0
  return { title: RESULT_TITLES[outcome.result], tone: isWarning ? 'warning' : 'success', lines }
}

export function conflictQuestion(outcome: McpSetupOutcome): string {
  const url = outcome.existingUrl || '주소 없음'
  return `${outcome.filePath} 에 이미 '${SERVER_NAME}' 항목이 있습니다 (${url}).\n덮어쓸까요? 원래 파일은 백업합니다.`
}
