// Suggestions from a failed run (docs/plan/2026-11-25-local-project-run.md, stage 2: 실패 진단과 제안): what
// main's diagnosis (src/ipc/runDiagnosis.js) found in the logs, in words, and which ones the user may apply.
// Applying is always the user's press after reading it; agents cannot (main checks the window and lock).

import type { RunSuggestion as MainSuggestion } from '../types'

/** A suggestion as main sends it (types/index.ts); a kind this build does not know yet is still shown */
export type RunSuggestion = Omit<MainSuggestion, 'kind' | 'reason'> & { kind: MainSuggestion['kind'] | (string & {}); reason?: string }

const repo = (item: RunSuggestion) => (item.repositoryId ? ` (${item.repositoryId})` : '')

/** The headline of a suggestion: what went wrong, with the name, port or version main found */
export function suggestionTitle(item: RunSuggestion): string {
  switch (item.kind) {
    case 'missingClass': return item.className ? `클래스를 찾지 못함: ${item.className}` : '클래스를 찾지 못함'
    case 'jdkVersion': return item.requiredFeature ? `JDK ${item.requiredFeature} 이상이 필요함` : 'JDK 버전이 맞지 않음'
    case 'jndi': return item.name ? `JNDI 이름을 찾지 못함: ${item.name}` : 'JNDI 이름을 찾지 못함'
    case 'sourceEncoding': return `소스 인코딩이 맞지 않음${item.encoding ? ` (${item.encoding})` : ''}`
    case 'portInUse': return item.port ? `포트 ${item.port} 사용 중` : '포트 사용 중'
    case 'mavenHttpBlocked': return `HTTP 저장소가 차단됨${repo(item)}`
    case 'mavenRepositoryUnavailable':
      return item.reason === 'unknownHost' ? `저장소 주소를 찾을 수 없음${repo(item)}`
        : item.reason === 'notFound' ? `저장소에서 찾지 못함 (404)${repo(item)}`
        : `저장소에 접속할 수 없음${repo(item)}`
    case 'mavenUnauthorized': return `저장소 인증 실패 (401)${repo(item)}`
    case 'mavenTls': return `저장소 TLS 연결 실패${repo(item)}`
    case 'mavenArtifactMissing': return item.artifact ? `의존성을 찾지 못함: ${item.artifact}` : `의존성을 찾지 못함${repo(item)}`
    case 'mavenPluginJdk': return item.requiredFeature ? `빌드 플러그인에 JDK ${item.requiredFeature} 필요` : '빌드 플러그인과 JDK 가 맞지 않음'
    case 'mavenUserMirror': return `사용자 미러가 대신 쓰임${item.mirrorId ? `: ${item.mirrorId}` : ''}${repo(item)}`
    default: return '실행 진단'
  }
}

/** What -s leaves out, shown before the user approves it (main's diagnosis says the same) */
export const USER_SETTINGS_WARNING = '이 프로젝트 전용 settings.xml 을 사용자 설정(-s)으로 지정해 다시 실행합니다. ' +
  '그러면 ~/.m2/settings.xml 의 servers(저장소 인증)·proxies(프록시)·mirrors(미러)·localRepository(로컬 저장소) 설정이 이 실행에는 적용되지 않습니다.'

/** After an applied suggestion the run's content changed: main asks again before the next run */
export const APPLIED_NOTE = '적용했습니다. 다음 실행 때 바뀐 실행 내용을 한 번 더 확인합니다.'

/**
 * The replacement for a blocked or missing Maven repository, as main accepts it: an https:// address or a
 * file:/// folder the user typed. The normalized URL, or why not.
 */
export function replacementUrl(text: string): { url: string } | { error: string } {
  const value = text.trim()
  if (!value) return { error: '대신 쓸 저장소 주소를 입력해 주세요.' }
  if (/^http:\/\//i.test(value)) return { error: 'HTTP 주소는 쓸 수 없습니다. https:// 주소를 입력해 주세요.' }
  // The same rule as main's repositoryUrl (src/runtimes/mavenSettings.js); main sends the value as typed
  if (/[\u0000- \u007f\\?#]/.test(value) || !/^(?:https:\/\/[^/]|file:\/\/\/(?!\/))/i.test(value)) {
    return { error: 'https:// 주소나 이 PC 의 file:/// 폴더 주소를 입력해 주세요 (공백·?·# 없이).' }
  }
  if (/^https:\/\//i.test(value) && value.slice('https://'.length).split('/')[0].includes('@')) {
    return { error: '주소에 아이디·비밀번호를 넣을 수 없습니다.' }
  }
  try { new URL(value) } catch { return { error: '저장소 주소를 확인해 주세요.' } }
  return { url: value }
}

/** Only well-formed suggestions from main (it is the app's own answer, but shown as text only) */
export function cleanSuggestions(value: unknown): RunSuggestion[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is RunSuggestion => !!item && typeof item === 'object'
    && typeof (item as RunSuggestion).id === 'string' && typeof (item as RunSuggestion).kind === 'string'
    && typeof (item as RunSuggestion).message === 'string')
    .map(item => item.apply === 'mavenMirror' || item.apply === 'mavenUserSettings' ? item : { ...item, apply: undefined })
}
